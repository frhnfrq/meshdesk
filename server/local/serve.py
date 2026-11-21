"""Meshdesk's local image-to-3D server.

Runs one open model on this machine and speaks the small protocol Meshdesk's "local" route expects:

    GET  /health          -> {"status": "healthy", "model": ..., "device": ..., "loaded": bool}
    POST /send            -> {"uid": ...}            body: {"image": <base64 front view>, "views": {"left": <base64>, "back": ..., "right": ...},
                                                         "remove_background": bool, "seed": int, "face_count": int, "texture_size": int}
    GET  /status/{uid}    -> {"status": "processing" | "completed" | "error", "message", "progress", "model_base64"}
    POST /cancel/{uid}    -> {"ok": true}             stops that generation at its next step

Meshdesk installs and starts this for you (Project settings, 3D generation). To run it by hand:

    <install>/venv/bin/python -u serve.py --model hunyuan --root <install> --port 8765

The model loads on the first request and then stays in memory. One generation runs at a time. Shape only: no texture.
"""
import argparse, base64, io, json, os, sys, tempfile, threading, time, traceback, types, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--model", choices=["hunyuan", "hunyuan-mv", "triposg", "trellis", "trellis2"], required=True)
ap.add_argument("--root", required=True, help="the folder Meshdesk installed this model into")
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--port", type=int, default=8765)
ap.add_argument("--steps", type=int, default=0, help="denoising steps; 0 uses the model's usual number")
ap.add_argument("--detail", type=int, default=0, help="mesh resolution; 0 uses the model's usual value")
ap.add_argument("--offload", choices=["model", "layers"], default="layers", help="how a model too big for the card is fitted: one whole part at a time, or the main network split between the card and main memory")
a = ap.parse_args()

ROOT = Path(a.root).resolve()
os.environ.setdefault("U2NET_HOME", str(ROOT / "u2net"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
if sys.platform == "darwin": os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

tasks, lock, state = {}, threading.Lock(), {"run": None, "remover": None, "device": "not loaded yet"}
cancelled = set()


class Cancelled(Exception):
    """Raised from a progress report once the generation has been cancelled, which unwinds the model's own loop."""


def say(uid, message, progress=None):
    tasks[uid] = {"status": "processing", "message": message, **({"progress": int(progress)} if progress is not None else {})}


def cutout(img, remove_background=True):
    """The subject on a transparent background: kept as it is when the picture already has one."""
    if img.mode in ("RGBA", "LA") and img.convert("RGBA").getextrema()[3][0] < 250: return img.convert("RGBA")
    if not remove_background: return img.convert("RGBA")
    from rembg import new_session, remove
    if state["remover"] is None: state["remover"] = new_session("u2net")
    return remove(img.convert("RGB"), session=state["remover"]).convert("RGBA")


def on_white(img, padding=0.1):
    """Crops to the subject, pads it to a square and puts it on white, the way TripoSG was trained to see pictures."""
    from PIL import Image
    box = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not box: raise ValueError("The picture is empty once its background is removed.")
    subject = img.crop(box); w, h = subject.size; side = int(max(w, h) * (1 + 2 * padding))
    canvas = Image.new("RGBA", (side, side), (255, 255, 255, 255)); canvas.alpha_composite(subject, ((side - w) // 2, (side - h) // 2))
    return canvas.convert("RGB")


def load_hunyuan():
    weights = ROOT / "weights" / "Hunyuan3D-2.1"
    port, repo = ROOT / "src" / "port", ROOT / "src" / "Hunyuan3D-2.1"
    sys.path.insert(0, str(port))
    import backend as backend_mod, compat_patches   # must come before torch: they set the device policy
    import torch
    B = backend_mod.detect(); compat_patches.apply(B); print(backend_mod.describe(B), flush=True)
    for p in (repo, repo / "hy3dshape", repo / "hy3dpaint"): sys.path.insert(0, str(p))
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
    compat_patches.patch_scheduler_timestep_lookup()
    small = B.kind == "cuda" and torch.cuda.get_device_properties(0).total_memory < 12 * 2**30
    # On a small card the whole model does not fit at once, so it is loaded into main memory and moved over a part at a time.
    # Reading the 7 GB checkpoint the usual way holds it in memory beside the model being built from it, about 20 GB at
    # the peak, which on a 32 GB machine spills into the page file. Reading it straight from disk as needed avoids that.
    stock_load = torch.load
    if small:
        def load_from_disk(file, *args, **kwargs):
            try: return stock_load(file, *args, **{"mmap": True, **kwargs})
            except Exception: return stock_load(file, *args, **kwargs)
        torch.load = load_from_disk
        # The pipeline builds each part at full precision, fills it, and only then halves it, so for a moment both sizes
        # exist. Halving the empty part before it is filled gives the same result without that second copy.
        stock_fill = torch.nn.Module.load_state_dict

        def halve_then_fill(module, *args, **kwargs):
            module.half(); return stock_fill(module, *args, **kwargs)
        torch.nn.Module.load_state_dict = halve_then_fill
    build = lambda: Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(str(weights), subfolder="hunyuan3d-dit-v2-1", use_safetensors=False, variant="fp16", device="cpu" if small else B.device, dtype=B.dtype)
    if small:
        # Better still, build the empty parts at half precision in the first place, so the full-size version (13 GB) is
        # never made. If a part cannot be built that way, fall back to the ordinary build.
        try:
            torch.set_default_dtype(torch.float16); pipe = build(); print("built at half precision", flush=True)
        except Exception as error:
            torch.set_default_dtype(torch.float32); print("half-precision build not possible:", str(error)[:160], flush=True); pipe = build()
        finally: torch.set_default_dtype(torch.float32)
    else: pipe = build()
    torch.load = stock_load
    if small: torch.nn.Module.load_state_dict = stock_fill
    if small: pipe.model.to(torch.float16); pipe.conditioner.to(torch.float16); pipe.vae.to(torch.float16); import gc; gc.collect()
    if small and a.offload == "layers":
        # The main network alone is about 6.6 GB, too much for an 8 GB card once it starts working. Keep as many of its
        # blocks on the card as leave room to work, and bring the rest over from main memory each time they are needed.
        from accelerate import dispatch_model, infer_auto_device_map
        pipe.conditioner.to("cuda"); pipe.vae.to("cuda"); pipe.device = torch.device("cuda")
        room = int(torch.cuda.get_device_properties(0).total_memory * 0.5)
        placement = infer_auto_device_map(pipe.model, max_memory={0: room, "cpu": "64GiB"}, no_split_module_classes=["HunYuanDiTBlock"])
        dispatch_model(pipe.model, device_map=placement, main_device=0)
        on_card = sum(1 for where in placement.values() if where == 0)
        print(f"low-memory mode: {on_card} of {len(placement)} parts of the main network stay on the card", flush=True)
    elif small:   # one whole part on the card at a time
        # Upstream's offload reads two attributes its own pipeline class never sets; supply them.
        if not hasattr(pipe, "components"): pipe.components = {"conditioner": pipe.conditioner, "model": pipe.model, "vae": pipe.vae}
        if not hasattr(pipe, "_exclude_from_cpu_offload"): pipe._exclude_from_cpu_offload = []
        pipe.enable_model_cpu_offload(device="cuda")
    else: pipe.to(B.device)
    state["device"] = f"{B.kind} ({B.gpu_name})" + (f", low-memory mode ({a.offload})" if small else "")
    steps, detail = a.steps or 30, a.detail or 256

    def run(img, seed, report):
        gen = torch.Generator().manual_seed(seed)
        with torch.inference_mode():
            res = pipe(image=img, num_inference_steps=steps, guidance_scale=5.0, octree_resolution=detail, generator=gen,
                       callback=lambda i, t, outputs: report(f"Generating: step {i + 1} of {steps}" if i + 1 < steps else "Building the mesh (a few minutes, no step count)", 5 + 57 * (i + 1) / steps), callback_steps=1)
        mesh = res[0] if isinstance(res, (list, tuple)) else res
        return mesh[0] if isinstance(mesh, (list, tuple)) else mesh
    return run


def load_hunyuan_mv():
    """Hunyuan3D 2 multi-view: builds the shape from a front view plus any of left, back and right."""
    os.environ["HY3DGEN_MODELS"] = str(ROOT / "weights")
    sys.path.insert(0, str(ROOT / "src" / "Hunyuan3D-2"))
    import torch
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
    if torch.cuda.is_available(): device, name = "cuda", torch.cuda.get_device_name(0)
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available(): device, name = "mps", "Apple GPU"
    else: device, name = "cpu", "CPU"
    pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained("tencent/Hunyuan3D-2mv", subfolder="hunyuan3d-dit-v2-mv", variant="fp16", use_safetensors=True, device=device,
                                                            dtype=torch.float32 if device == "cpu" else torch.float16)
    state["device"] = f"{device} ({name})"
    steps, detail = a.steps or 30, a.detail or 380

    def run(views, seed, report):
        with torch.inference_mode():
            res = pipe(image=views, num_inference_steps=steps, octree_resolution=detail, num_chunks=20000, generator=torch.manual_seed(seed), output_type="trimesh",
                       callback=lambda i, t, outputs: report(f"Generating: step {i + 1} of {steps}" if i + 1 < steps else "Building the mesh", 5 + 75 * (i + 1) / steps), callback_steps=1)
        mesh = res[0] if isinstance(res, (list, tuple)) else res
        return mesh[0] if isinstance(mesh, (list, tuple)) else mesh
    run.views = ["front", "left", "back", "right"]
    return run


def load_trellis():
    """TRELLIS (the 8 GB half-precision build): shape and colour together, from one picture or several."""
    os.environ["ATTN_BACKEND"] = "xformers"; os.environ["SPCONV_ALGO"] = "native"
    os.environ.setdefault("TORCH_HOME", str(ROOT / "torch-hub"))
    sys.path.insert(0, str(ROOT / "src" / "trellis"))
    import torch
    # The pipeline fetches its image encoder's code from GitHub by name. Pin that to one commit so it cannot change underneath us.
    hub_load = torch.hub.load
    torch.hub.load = lambda repo, *args, **kwargs: hub_load("facebookresearch/dinov2:7764ea0f912e53c92e82eb78a2a1631e92725fc8" if repo == "facebookresearch/dinov2" else repo, *args, **{"trust_repo": True, **kwargs})
    from trellis.pipelines import TrellisImageTo3DPipeline
    from trellis.utils import postprocessing_utils
    pipe = TrellisImageTo3DPipeline.from_pretrained(str(ROOT / "weights" / "TRELLIS-image-large"))
    pipe.to(torch.float16); pipe.models["image_cond_model"].half()   # half precision; parts move to the card one at a time
    state["device"] = f"cuda ({torch.cuda.get_device_name(0)}), half precision"

    def run(views, seed, report, faces=0, size=0):
        images = [views["front"], *[views[v] for v in ("left", "back", "right") if v in views]]
        report("Generating the shape and colour" + (f" from {len(images)} views" if len(images) > 1 else ""), 10)
        with torch.inference_mode():
            out = pipe.run_multi_image(images, seed=seed, formats=["mesh", "gaussian"]) if len(images) > 1 else pipe.run(images[0], seed=seed, formats=["mesh", "gaussian"])
        total = int(out["mesh"][0].faces.shape[0]); keep = min(total, faces or 150000)
        report("Baking the texture", 70)
        return postprocessing_utils.to_glb(out["gaussian"][0], out["mesh"][0], simplify=max(0.0, min(0.99, 1 - keep / max(1, total))), texture_size=size or 1024, verbose=False)
    run.views = ["front", "left", "back", "right"]; run.finished = True   # comes back textured and already reduced; reducing again would lose the texture
    return run


def load_trellis2():
    """TRELLIS.2 in its low-memory mode at 1024 resolution: shape with PBR materials from one picture."""
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    os.environ["ATTN_BACKEND"] = "xformers"; os.environ["SPARSE_ATTN_BACKEND"] = "xformers"; os.environ["SPARSE_CONV_BACKEND"] = "flex_gemm"
    sys.path.insert(0, str(ROOT / "src" / "TRELLIS.2"))
    import torch
    weights = ROOT / "weights"; home = weights / "TRELLIS.2-4B"
    # torch.segment_reduce has no CUDA version in PyTorch's Windows builds ("missing kernel for cuda"). TRELLIS.2 uses it
    # to total and average over each sample's points, so do the same thing with operations that do run on the card.
    stock_reduce = torch.segment_reduce

    def segment_reduce(data, reduce, *, lengths=None, **kwargs):
        if not data.is_cuda or lengths is None or kwargs: return stock_reduce(data, reduce, lengths=lengths, **kwargs)
        count = lengths.numel(); index = torch.repeat_interleave(torch.arange(count, device=data.device), lengths.to(data.device))
        out = torch.zeros((count, *data.shape[1:]), dtype=data.dtype, device=data.device)
        if reduce == "sum": return out.index_add_(0, index, data)
        return out.index_reduce_(0, index, data, {"mean": "mean", "max": "amax", "min": "amin", "prod": "prod"}[reduce], include_self=False)
    torch.segment_reduce = segment_reduce
    # The stock settings fetch three things from Hugging Face by name. Point them at the copies installed here instead.
    # It runs at 1024 (measured at 5.3 GB of video memory on an 8 GB card) and falls back to 512 only if the 1024 parts are missing.
    config = json.loads((home / "pipeline.json").read_text()); args = config["args"]
    fine = a.detail != 512 and all((home / (v + ".safetensors")).exists() for k, v in args["models"].items() if "1024" in k)
    kind = "1024_cascade" if fine else "512"
    # Every part named here is held in main memory, about 2.6 GB each, so leave out the ones this resolution never uses.
    args["models"] = {k: v for k, v in args["models"].items() if (k != "tex_slat_flow_model_512" if fine else "1024" not in k)}
    args["models"]["sparse_structure_decoder"] = (weights / "TRELLIS-image-large" / "ckpts" / "ss_dec_conv3d_16l8_fp16").as_posix()
    args["image_cond_model"]["args"]["model_name"] = (weights / "dinov3-vitl16-pretrain-lvd1689m").as_posix()
    args["default_pipeline_type"] = kind; args["low_vram"] = True
    (home / "pipeline.meshdesk.json").write_text(json.dumps(config))
    # Its own background remover is a separate gated 5 GB model. Pictures reach it already cut out, so it is never used.
    import trellis2.pipelines.rembg as remover
    remover.BiRefNet = lambda **kwargs: None
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    import o_voxel
    pipe = Trellis2ImageTo3DPipeline.from_pretrained(home.as_posix(), "pipeline.meshdesk.json"); pipe.cuda()
    state["device"] = f"cuda ({torch.cuda.get_device_name(0)}), low-memory mode at {'1024' if fine else '512'}"

    def run(img, seed, report, faces=0, size=0):
        report("Generating the shape and materials", 10)
        mesh = pipe.run(img, seed=seed, pipeline_type=kind)[0]
        mesh.simplify(16777216)
        report("Baking the textures", 75)
        return o_voxel.postprocess.to_glb(vertices=mesh.vertices, faces=mesh.faces, attr_volume=mesh.attrs, coords=mesh.coords, attr_layout=mesh.layout, voxel_size=mesh.voxel_size,
                                          aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]], decimation_target=faces or 150000, texture_size=size or (4096 if fine else 2048), remesh=True, remesh_band=1, remesh_project=0, verbose=False)
    run.finished = True
    return run


def load_triposg():
    import torch, numpy as np, trimesh
    try: import diso  # noqa: F401  (CUDA-only fast surface extractor; optional)
    except Exception:
        stub = types.ModuleType("diso"); stub.DiffDMC = None; sys.modules["diso"] = stub
    sys.path.insert(0, str(ROOT / "src" / "TripoSG"))
    import triposg.inference_utils as utils
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline

    def expand_edge_region_fast(edge_coords, grid_size):
        """Upstream's function with its hard-coded 'cuda' replaced by the device the model is on."""
        grid = torch.zeros(grid_size, grid_size, grid_size, device=edge_coords.device, dtype=torch.float32, requires_grad=False)
        grid[edge_coords[:, 0], edge_coords[:, 1], edge_coords[:, 2]] = 1
        k = 5 if grid_size < 512 else 3
        low = torch.nonzero(torch.nn.functional.max_pool3d(grid[None, None], kernel_size=k, stride=1, padding=k // 2).squeeze(), as_tuple=False).to(torch.int16)
        x, y, z = low[:, 0] * 2, low[:, 1] * 2, low[:, 2] * 2
        return torch.stack([torch.cat((x, x, x, x, x + 1, x + 1, x + 1, x + 1)), torch.cat((y, y, y + 1, y + 1, y, y, y + 1, y + 1)), torch.cat((z, z + 1, z, z + 1, z, z + 1, z, z + 1))], dim=1)
    utils.expand_edge_region_fast = expand_edge_region_fast

    if torch.cuda.is_available(): device, dtype, name = "cuda", torch.float16, torch.cuda.get_device_name(0)
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available(): device, dtype, name = "mps", torch.float16, "Apple GPU"
    else: device, dtype, name = "cpu", torch.float32, "CPU"
    pipe = TripoSGPipeline.from_pretrained(str(ROOT / "weights" / "TripoSG")).to(device, dtype)
    state["device"] = f"{device} ({name})"
    steps, depth = a.steps or 50, a.detail or 9

    # On a Mac the graphics work is queued and runs behind the program, so without waiting for it the steps appear to
    # finish in seconds and the time then vanishes into the next stage. Waiting after each step and each batch of points
    # makes the progress shown the real thing. Measured on an M2: steps about half the time, mesh building the rest.
    wait = torch.mps.synchronize if device == "mps" else (lambda: None)
    mesh = {"done": 0, "total": 0, "passes": 0, "report": None, "shown": -1}
    decode = pipe.vae.decode

    def counted_decode(z, sampled_points, *args, **kwargs):
        points = sampled_points.shape[1]; mesh["passes"] += 1
        mesh["total"] = points * 1.35 if mesh["passes"] == 1 else mesh["done"] + points   # the second pass is usually about a third of the first
        return decode(z, sampled_points, *args, **kwargs)
    pipe.vae.decode = counted_decode

    def answered(module, inputs, output):
        wait(); mesh["done"] += inputs[1].shape[1]; percent = int(48 + 46 * min(1.0, mesh["done"] / max(1, mesh["total"])))
        if mesh["report"] and percent != mesh["shown"]: mesh["shown"] = percent; mesh["report"](f"Building the mesh (pass {min(mesh['passes'], 2)} of 2)", percent)
    pipe.vae.decoder.register_forward_hook(answered)

    def run(img, seed, report):
        mesh.update(done=0, total=0, passes=0, report=report, shown=-1)

        def step(pipeline, i, t, kwargs):
            wait(); report(f"Generating: step {i + 1} of {steps}", 4 + 44 * (i + 1) / steps); return kwargs
        gen = torch.Generator(device="cpu" if device == "mps" else device).manual_seed(seed)
        with torch.no_grad():
            out = pipe(image=on_white(img), generator=gen, num_inference_steps=steps, guidance_scale=7.0, use_flash_decoder=False,
                       dense_octree_depth=8, hierarchical_octree_depth=depth, callback_on_step_end=step).samples[0]
        if out[0] is None: raise RuntimeError("The model produced no surface for this picture.")
        return trimesh.Trimesh(out[0].astype(np.float32), np.ascontiguousarray(out[1]))
    return run


def simplify(mesh, faces):
    """Brings a dense result down to the project's triangle budget. Left alone when no tool for it is installed."""
    try: mesh.merge_vertices()   # some models return every triangle with its own corners; weld them so reducing does not open cracks
    except Exception: pass
    if not faces or len(mesh.faces) <= faces: return mesh
    try:
        import pymeshlab, trimesh
        ms = pymeshlab.MeshSet(); ms.add_mesh(pymeshlab.Mesh(vertex_matrix=mesh.vertices, face_matrix=mesh.faces))
        ms.meshing_merge_close_vertices(); ms.meshing_decimation_quadric_edge_collapse(targetfacenum=int(faces))
        m = ms.current_mesh(); return trimesh.Trimesh(vertices=m.vertex_matrix(), faces=m.face_matrix())
    except Exception as error:
        print("could not reduce the mesh:", error, flush=True); return mesh


def work(uid, params):
    def check():
        if uid in cancelled: raise Cancelled()
    try:
        with lock:
            check()
            from PIL import Image
            if state["run"] is None:
                say(uid, "Loading the model (the first run takes a minute or two)", 1); t0 = time.time()
                state["run"] = LOADERS[a.model]()
                print(f"model loaded in {time.time() - t0:.0f}s on {state['device']}", flush=True)
            check(); say(uid, "Preparing the picture", 3)
            clean = lambda data: cutout(Image.open(io.BytesIO(base64.b64decode(data))), params.get("remove_background", True))
            img = clean(params["image"]); wanted = getattr(state["run"], "views", None)
            if wanted:   # a multi-view model takes every view it was given, each in its own slot
                img = {"front": img, **{view: clean(data) for view, data in (params.get("views") or {}).items() if view in wanted and view != "front" and data}}
            t0 = time.time()
            def report(message, progress):   # every model reports its steps through here, so this is where a cancel takes effect
                check(); say(uid, message, progress)
            check()
            size = int(params.get("texture_size") or 0)
            size = size if size in (512, 1024, 2048, 4096) else 0   # anything else falls back to the model's own size
            if getattr(state["run"], "finished", False): mesh = state["run"](img, int(params.get("seed", 42)), report, int(params.get("face_count") or 0), size)
            else:
                mesh = state["run"](img, int(params.get("seed", 42)), report)
                check(); say(uid, "Finishing the mesh", 94)
                mesh = simplify(mesh, int(params.get("face_count") or 0))
            print(f"{uid}: {len(mesh.vertices):,} vertices, {len(mesh.faces):,} faces in {time.time() - t0:.0f}s", flush=True)
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "model.glb"; mesh.export(str(path)); data = path.read_bytes()
            tasks[uid] = {"status": "completed", "model_base64": base64.b64encode(data).decode()}
    except Cancelled:
        print(f"{uid}: cancelled", flush=True); tasks[uid] = {"status": "error", "message": "Cancelled.", "cancelled": True}
    except Exception as error:
        traceback.print_exc(); tasks[uid] = {"status": "error", "message": (str(error) or type(error).__name__)[:400]}
    finally:
        cancelled.discard(uid)
        try:
            import torch
            if torch.cuda.is_available(): torch.cuda.empty_cache()
        except Exception: pass


LOADERS = {"hunyuan": load_hunyuan, "hunyuan-mv": load_hunyuan_mv, "triposg": load_triposg, "trellis": load_trellis, "trellis2": load_trellis2}
VIEWS = ["front", "left", "back", "right"] if a.model in ("hunyuan-mv", "trellis") else ["front"]


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"status": "healthy", "worker_id": "meshdesk-local", "model": a.model, "device": state["device"], "loaded": state["run"] is not None, "busy": lock.locked(), "texture": a.model in ("trellis", "trellis2"), "views": VIEWS})
        if self.path.startswith("/status/"):
            uid = self.path.rsplit("/", 1)[-1]; task = tasks.get(uid)
            if not task: return self.reply(404, {"status": "error", "message": "Unknown task."})
            self.reply(200, task)
            if task["status"] in ("completed", "error"): tasks.pop(uid, None)
            return
        self.reply(404, {"error": "Not found."})

    def do_POST(self):
        if self.path.startswith("/cancel/"):
            uid = self.path.rsplit("/", 1)[-1]
            if uid in tasks and tasks[uid]["status"] == "processing": cancelled.add(uid)
            return self.reply(200, {"ok": True})
        if self.path != "/send": return self.reply(404, {"error": "Not found."})
        try:
            params = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            base64.b64decode(params["image"], validate=True)
        except Exception:
            return self.reply(400, {"error": "Send JSON with a base64 image."})
        uid = str(uuid.uuid4()); say(uid, "Waiting for the previous generation" if lock.locked() else "Starting", 0)
        threading.Thread(target=work, args=(uid, params), daemon=True).start()
        self.reply(200, {"uid": uid})

    def log_message(self, *args): pass


print(f"Meshdesk local model server: {a.model} on http://{a.host}:{a.port}", flush=True)
ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
