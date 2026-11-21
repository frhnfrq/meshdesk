# Meshdesk

A local 3D workspace built with React, Vite, Three.js and a Node/Express server. The chat agent is Codex or Claude, using your existing CLI sign-in for whichever you pick. Double-click **Start Meshdesk.command**, or run `npm start` and open http://127.0.0.1:8790. `npm run dev` starts development mode.

## Install from GitHub

Requires Node.js 22.12 or newer and Blender. From the cloned app folder:

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:8790. Use **Open project** to open a separate project's `project.meshdesk` file. For AI editing, sign in to the Codex CLI (`codex login`) or Claude Code (`claude auth login`). Choose the agent, model and reasoning level from the pickers under the chat box; the choice is remembered per agent, and switching agents mid-conversation carries the recent chat history across. Optional machine-specific settings go in `config.local.json` (copy `config.example.json`); that file and the local recent-project registry are excluded from Git.

## Working with assets

- Click a library asset to open a tab. Tabs, camera positions, display settings, message drafts, image attachments and references autosave per project and recover after refresh.
- **Selecting several assets.** ⌘/Ctrl-click or Shift-click rows (or tick the box that appears on hover), ⌘A selects everything shown. The bar above the list then sets the status, starts a restyle, or removes or restores the selection; removal asks first and states the count. Right-click a row for the same actions plus Rename (also F2 or double-click the name) and *Reference in a conversation*.
- **Clicking a surface picks its material**, not just one mesh: every surface that uses that material is tinted, the Layers inspector shows that material alone, and a texture preview applies to it only. The picked material goes along with your next message.
- The Layers icon opens material assignments, texture roles, image dimensions and missing maps. *Try a texture* is a temporary preview; *Ask the agent to apply it* drafts the request. *Use a shared material* applies one from the project's material library.
- **Textures embedded in a model are private to it.** They do not appear for other models or in the library's Textures tab (switch its filter to *Model textures* to see them). *Add to library* on a texture makes it available everywhere.
- The History icon lists the model's versions with Rename, Compare, Restore and Export. Compare synchronizes both cameras.
- Current/live previews refresh when an edit completes, keeping your view. If you explicitly select an older version, it remains selected.

## Conversations

Conversations belong to the project, not to one model. The right panel is an inbox: finished conversations newest first, the ones still **Working** pinned at the bottom, and **Settled** ones folded away behind a count. Open one to see the chat; the arrow goes back to the list. Click the title to rename it.

- Whatever is open in the preview (a model, scene, texture or image) is attached to your next message as a chip you can remove. Type **@** to reference any other model, texture, image or scene; click a chip to open that item. *Current view* attaches a screenshot of the preview.
- Several conversations can run at once (up to three). Only one may edit a given model at a time: a second is told which conversation has it, and a model with a proposed change waiting can only be edited by the conversation that proposed it.
- The speech-bubble count beside a model's or scene's name lists the conversations that touched it.
- Upload, paste or drop up to four PNG/JPEG/WebP screenshots. Replies support Markdown and show the steps the agent took.
- Chats saved by earlier versions (one per model or scene) are converted to conversations the first time a project opens; the old files are kept in `Workspace/feedback/migrated`.

### Versions and checkpoints

Every step an agent takes on a model is a **checkpoint**. Checkpoints appear only in the conversation that made them, each with Preview, Compare with the live model, and Restore. A **version** is a milestone you kept: accepting a proposal turns all of its steps into one version, named in the proposal bar (rename it later in History). The version list shows only Original and versions.

**Settle** a conversation when you are done with it: it moves out of the inbox and the files of its unused checkpoints are deleted (the chat keeps the record, marked as removed). Versions, the live model and a pending proposal are never deleted. Projects from earlier versions are converted once: each run of back-to-back iterations collapses to its last step, and the earlier steps become checkpoints in the chat that made them.

## Projects

The project selector switches libraries and conversations. **+** creates an empty project. **Import** adds FBX, GLB, BLEND, OBJ, texture maps, reference images and PureRef boards; byte-identical inputs are detected. Choose several files or a whole folder, or drop them on the library: each file shows its own progress and failures, the library groups assets by the folder they came from, and a model picks up textures from its own folder first when names clash. Images are sorted automatically (textures when they sit beside a model or are named like maps, references otherwise) unless you choose one kind. Import external texture images with models, or before importing them. Blender cannot recover texture images that were not supplied. OBJ files with a separate MTL should be converted to GLB or BLEND with their materials before import; the current importer does not import MTL sidecars.

**Save** downloads a `.meshdesk.zip` snapshot containing source assets, working files, versions, textures, conversations, captures and workspace state. **Open project → Import a project ZIP as a copy** loads an archive as a separate project. Opened archives retain visible conversations but start independent agent threads. Saving waits for active work to finish. Autosave saves workspace state locally; use Save for a portable backup.

Project assets and state live in their own external project folders. The app’s `.data/projects.json` is only a recent-project registry. See Portable project folders below.

## Models and textures

Every new Blender edit exports:

- `Models/<id>/<name>.fbx` with relative references to separate images.
- `Textures/<id>/*.png` (or original JPEG/EXR) with image pixels preserved.
- A Blender file linked to those external images.
- A GLB preview with embedded images.
- A material manifest recording map roles, color spaces, dimensions and missing maps.

**Export** opens a dialog for the current viewed model/version, a searchable selection, or all active models. Default: **FBX + separate textures + ZIP**. Choose FBX, glTF/GLB, or Blender, with embedded or separate textures. glTF uses `.glb` for embedded images and `.gltf` + `.bin` + images for separate textures. You can download a ZIP or keep the results in the project’s `Exports/<export-id>/` folder.

Before exporting, review missing texture warnings and explicitly choose whether to continue with available maps. Each model gets a readable, collision-safe folder name. The review fixes the saved version; later edits and temporary preview overrides do not change the export. Format, texture and package settings are remembered per project and included in project backups. Exports show each model’s progress, can run while the dialog is closed, and support retrying failed models without re-exporting successful ones. Reopen Export to recover an active job or view its latest result. `export-report.json` records versions, warnings, and failures.

Export conversions run in disposable Blender jobs and never publish a new library version. Separate images use relative links; keep each model’s folder together. Game-engine-specific material/shader setup may still be required. No scale conversion, polygon reduction or texture resizing is applied. Project snapshots retain export preferences but omit generated export packages, which can be regenerated.

Original files are preserved. Rename affects working files and retains the stable ID and its conversations. Remove is recoverable. Blender writes are confined to its job directory; networking and unrelated files are blocked. Only successful exports publish a version. Shell tools in the model chat remain read-only; library changes use app-owned tools.

## Models from pictures (image-to-3D)

Blender scripts are the right tool for anything you could measure with a ruler: props, buildings, vehicles. Characters, creatures and other organic shapes are generated from pictures instead. **Generate a model → From pictures** takes a front view (required) and optional left, back and right views, or one turnaround sheet, which it splits into views (check them with Adjust: the order is a guess for sheets without front, side and back left to right). You then choose a machine and one of its models; the dialog says which model is loaded and how long loading another takes. Each machine runs one generation at a time and queues the rest, loading the right model for each. The result is added to the library as a new model; the agent has the same ability as its `model_from_image` tool and then cleans up, reduces, rigs and animates the mesh in Blender.

Three routes are available under **Project settings → 3D generation**. Switch on any of them and choose a default, or be asked each time:

| Route | Cost | Notes |
|---|---|---|
| Local model | Free | Runs on this computer, shape only, front view only |
| Tripo | Pay as you go, about $0.20–$0.40 per model | Labelled slot for each view |
| Meshy | Credits of a paid Meshy plan | Up to four views, the first is the front |

**Local models.** Meshdesk installs and runs these itself: it checks the graphics hardware, downloads `uv` if the machine has none, builds a private Python environment and fetches the weights into `.data/local-models/`. Nothing touches the system Python, and Delete removes everything again. A model server starts by itself when you generate and stops when Meshdesk quits.

| Model | Licence | Views | Weights | Tested on |
|---|---|---|---|---|
| TripoSG (VAST AI Research) | MIT | Front | 8 GB | Apple Silicon M2 with 24 GB (about 10 minutes per model); Windows 10 with an RTX 3070 Ti 8 GB (about 1 minute) |
| Hunyuan3D 2 multi-view (Tencent) | Tencent Hunyuan 3D 2.0 Community License. Not open source, and not licensed for use in the EU, the UK or South Korea | Front, left, back, right | 5 GB | Windows 10 with an RTX 3070 Ti 8 GB (about 2 minutes per model) |
| TRELLIS (Microsoft), 8 GB half-precision build | MIT. Its compiled parts are prebuilt Windows files from the community project `IgorAherne/trellis-stable-projectorz`, not from Microsoft; installing asks you to agree to that | One or several, **textured** output | 3 GB | Windows 10 with an RTX 3070 Ti 8 GB (about 1 minute per textured model). Windows with NVIDIA only |
| TRELLIS.2 (Microsoft), low-memory mode at 1024 | MIT. Prebuilt Windows files from the community project `visualbruno/ComfyUI-Trellis2`. Its image encoder, DINOv3, is a gated Hugging Face model: add a token with access under Advanced | Front, **textured with PBR materials** | 14 GB | Windows 10 with an RTX 3070 Ti 8 GB and 32 GB of memory (2 to 3 minutes per model, 5.3 GB of video memory). Needs 24 GB of main memory. Windows with NVIDIA only |
| Hunyuan3D 2.1 (Tencent) | Tencent Hunyuan 3D 2.1 Community License, same limits | Front | 8 GB | Apple Silicon M2 with 24 GB (about 11 minutes); Windows 10 with an RTX 3070 Ti 8 GB (about 1.5 minutes, in a low-memory mode that keeps part of the model in main memory; 6.3 GB of video memory) |

Besides the weights, the Python environment takes about 2 GB on a Mac and 7 GB on an NVIDIA machine. Packages are stored once and shared, so a second model adds little more than its weights. Models go in `.data/local-models/`; set `MESHDESK_MODELS_DIR` (or `modelsDirectory` in `config.local.json`) to keep them on another drive. Models already installed in the old folder keep working after the change; new ones go to the new folder. A machine with several models installed offers them in a **Model** list beside **Generate on**.

**Using another computer's graphics card.** A laptop can generate on a desktop that also runs Meshdesk. On the desktop, install a local model and switch on **Share this computer's model**; it shows a name and a pairing code. On the laptop, under **Other computers**, press **Find computers**, pick the desktop and enter the code once. From the laptop's **3D generation** page you can then install, cancel and remove models on the desktop as well. It also appears beside “This computer” in the **Generate on** list: the model is made on the desktop and arrives in the laptop’s library, with live progress. On an RTX 3070 Ti, TripoSG takes about a minute per model. Discovery is a broadcast on UDP port 8793 and the shared server listens on TCP port 8792, so the desktop's firewall must allow Meshdesk (Node) on the private network. The shared server accepts only generation requests that carry the code and locks an address out after ten wrong codes; Meshdesk's main server stays bound to 127.0.0.1. Traffic is plain HTTP, so use it only on a network you trust.

Needs an Apple Silicon Mac with 16 GB of memory or an NVIDIA graphics card. Recipes are in `server/local-models.mjs`: each pins its source code, packages and weights to exact versions, and is shown as experimental on a platform until someone has run it there. An NVIDIA machine gets the newest PyTorch build its driver supports, and the install stops with a clear message if the card cannot be used. Hunyuan3D on NVIDIA and everything on Linux are not yet tested by the authors; reports and fixes are welcome. Large weight files download as eight pieces at once, because Hugging Face limits each connection on some networks. Both models are public; a Hugging Face token (under Advanced, or `HF_TOKEN`) is only needed for models that ask for an account. The local route can instead point at a Hunyuan3D API server on another machine.

Hosted routes send the pictures you choose to that service. API keys are stored in `.data/generators.json`, readable only by your user, and are never sent to the viewer. `TRIPO_API_KEY` and `MESHY_API_KEY` in the environment also work.

## Local operation

No cloud hosting configuration or API key is needed. AI replies still use the signed-in Codex or Claude service over the internet (Claude runs through the Claude Agent SDK on your local Claude Code sign-in; API-key environment variables are not forwarded); submitted messages, model context and attached images are sent for inference. These conversations are separate from the desktop chat.

Requires Node 22.12+, a signed-in Codex CLI or Claude Code, and Blender at `/Applications/Blender.app/Contents/MacOS/Blender`. Paths can be customized in `config.local.json`. The server binds only to 127.0.0.1 and uses same-origin checks and a per-start write token. Do not expose it publicly.

`npm test` runs image-to-3D, local model, sharing, conversation, version, library, batch, style guide, shared material, consistency, handoff, project isolation and validation tests. `npm run build` builds the viewer. Environment overrides: `PORT`, `ASSET_LIBRARY_PATH`, `ASSET_REVIEW_DATA`, `CODEX_BIN`, `CLAUDE_BIN`.

## Portable project folders

Projects live outside the app, by default in `~/Projects/MeshdeskProjects/<name>/`:

```
project.meshdesk   Project identity, schema version and relative folder paths
Assets/           Original models, textures, images, boards, catalog and previews
Workspace/        Working library, versions and checkpoints, conversations, scenes, style guide, shared materials, batches, handoff history, screenshots and tabs
Snapshots/        Portable ZIP backups
Exports/          Model export folders and ZIP packages
```

Use **Open project**, paste the path to `project.meshdesk` (or its containing folder), and click **Open project**. This opens the existing project in place. You can move the entire folder, then open its project file at the new location. Keep the contents together. In Finder, Option–Command–C copies a selected file’s path.

`project.meshdesk` is a small JSON file with `format: "meshdesk-project"`, `schemaVersion: 1`, an ID, a name, dates, and relative `paths.assets`, `paths.workspace`, and `paths.snapshots` values. It contains no executable instructions. The app's `.data/projects.json` only remembers each project's ID, name and absolute project-file location. Removing/reinstalling the application does not remove external project folders.

**Import a project ZIP as a copy** still supports older Meshdesk ZIP archives and new archives containing `project.meshdesk`. Archive imports get a new identity and independent Codex threads; opening an existing project file keeps its identity and conversation threads. Two existing folders with the same ID are not silently treated as independent projects.

From Terminal, `./Start Meshdesk.command "/full/path/project.meshdesk"` opens that project. Finder double-click file association is not installed; use the app’s Open project control or the launcher command.

## Restyling a whole asset set

1. **Style guide** (**Style** in the header): a full page with a moodboard of up to eight reference images (drop or upload images, or pick them from the library), a colour palette, texel density, largest texture, material rules and notes. The agent gets it with every message (and sees the first three reference images when a conversation starts), and it is added to texture generation prompts.
2. **Status.** Each model is *Not started*, *In progress*, *Needs review* or *Approved*. Set it from the model's title bar, the selection bar or the right-click menu. An agent edit moves a model to *Needs review*; accepting on the review board approves it. The library shows a badge, a status filter and a progress bar.
3. **Batch restyle.** Select models and choose **Restyle**, with an optional instruction. Each model gets its own conversation and comes back as its own proposal, two at a time in the background; batch edits are always proposals, even when edits normally apply straight away.
4. **Review board** (**Review** in the header). The queue shows each batch with per-model progress, failures, and Cancel. Below it, every model that needs review has a before/after card with **Accept**, **Discard** (or **Revert** when the change was already applied) and **Note**, which sends your comment back to the conversation that made the change. Tick several cards to accept or discard them together.
5. **Shared materials** (the *Materials* tab of the library): named materials with a colour, roughness, metallic, optional maps and a tiling size. Apply one to a model's material from the Layers inspector, or let the agent do it (`material_list`, `material_create`, `material_apply`; it is told to prefer them to one-off materials). When you change a shared material, *Update N as proposals* re-applies it to every model that uses it.
6. **Consistency** (second tab of the review board): checks models in Blender against the style guide — off-palette colours, texel density, texture size, triangle budget, and materials that are not from the shared library. Results are remembered per model version. *Fix this* starts a conversation about that model; the same check for one model is in the shield inspector.
7. **Handoff** (third tab): one package of every *Approved* model in the project's engine preset (FBX for Unity and Unreal, GLB for Godot), the scenes you tick (a scene file plus `layout.json` naming the exported model for each object), `manifest.json` (triangles, materials, textures and version per model) and `CHANGELOG.md` listing what is new, updated and removed since the previous handoff.

In a scene, **Original / Current** switches every model between how it was imported and how it is now.

## Working with the agent

- **Preview before publish.** With *Project settings → Preview edits before they apply* on (the default), every agent edit is a proposal: it appears beside the current model with a list of changed meshes, and nothing goes live until you press **Accept**. **Discard** deletes it.
- **Project context.** *Project settings* holds a brief (art style, platform, budgets) that the agent reads with every message, plus the target engine, a per-model triangle budget and the largest allowed texture.
- **Game-readiness check.** The shield button in the viewport toolbar runs the model through Blender and lists problems (missing UVs, n-gons, loose geometry, scale, pivot, texture sizes, budget). Each finding can be sent to the agent to fix, and *Quick optimise* applies clean-up or triangle reduction directly.
- **Visual diff.** In compare mode, the diff button tints added, changed and removed meshes and lists what changed.
- **Scenes.** The *Scenes* tab of the library arranges models with a sun, ambient light, sky or image environment and a ground. Move, rotate and scale with the gizmo (W / E / R), or ask the agent to lay the scene out. The agent can look at a scene itself (`scene_render` draws it in Blender from any angle), so it checks its layout before replying. Every model is pivoted at the centre of its base.
- **Engine export presets.** The export dialog has Unity, Unreal and Godot presets (axis, unit scale, file naming) and can write LOD1–LOD3 files beside each model.
- **AI textures.** Set `imageApiKey` in `config.local.json` (or `OPENAI_API_KEY`) to let the agent generate textures. Only the text prompt is sent to the image service.

How the agent edits: it inspects the model in Blender first (`blender_inspect`, read-only), edits, then receives before/after statistics, readiness findings and a four-view render of the result, and corrects its own work before replying.

## Blender isolation and limits

Blender runs once per edit, with no network and write access only to a throwaway job folder: `sandbox-exec` on macOS, `bubblewrap` on Linux. On other systems set `MESHDESK_UNSANDBOXED_BLENDER=1` to accept running agent-written scripts without isolation. A run is stopped after 10 minutes; change that with `MESHDESK_BLENDER_TIMEOUT` (seconds, 30–3600).
