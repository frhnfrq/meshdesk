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

- Click a library asset to open a tab. Tabs, camera positions, display settings, chat drafts, image attachments and model references autosave per project and recover after refresh.
- Hover the compact viewing icons for their names. Click a mesh in the preview to select it; its mesh and material names accompany your next chat message.
- The Layers icon opens material assignments, texture roles, image dimensions and missing maps. A preview override is temporary and explicitly marked.
- The History icon lists saved edits with Compare, Restore and Export. Compare synchronizes both cameras. Restore changes the current version and retains all later versions.
- Current/live previews refresh when an edit completes, keeping your view. If you explicitly select an older version, it remains selected.
- Drag the Codex panel edge to resize it. Upload, paste or drop up to four PNG/JPEG/WebP screenshots. Type @ to reference other models. Replies support Markdown and show visible action steps and Codex progress updates.

## Projects

The project selector switches libraries and conversations. **+** creates an empty project. **Import** adds FBX, GLB, BLEND, OBJ, texture maps, reference images and PureRef boards; byte-identical inputs are detected. Import external texture images with models, or before importing them. Blender cannot recover texture images that were not supplied. OBJ files with a separate MTL should be converted to GLB or BLEND with their materials before import; the current importer does not import MTL sidecars.

**Save** downloads a `.meshdesk.zip` snapshot containing source assets, working files, versions, textures, conversations, captures and workspace state. **Open project → Import a project ZIP as a copy** loads an archive as a separate project. Opened archives retain visible chats but start independent Codex threads. Saving waits for active work to finish. Autosave saves workspace state locally; use Save for a portable backup.

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

Original files are preserved. Rename affects working files and retains the stable ID/chat. Remove is recoverable. Blender writes are confined to its job directory; networking and unrelated files are blocked. Only successful exports publish a version. Shell tools in the model chat remain read-only; library changes use app-owned tools.

## Local operation

No cloud hosting configuration or API key is needed. AI replies still use the signed-in Codex or Claude service over the internet (Claude runs through the Claude Agent SDK on your local Claude Code sign-in; API-key environment variables are not forwarded); submitted messages, model context and attached images are sent for inference. These conversations are separate from the desktop chat.

Requires Node 22.12+, a signed-in Codex CLI or Claude Code, and Blender at `/Applications/Blender.app/Contents/MacOS/Blender`. Paths can be customized in `config.local.json`. The server binds only to 127.0.0.1 and uses same-origin checks and a per-start write token. Do not expose it publicly.

`npm test` runs persistence, project isolation, captures, attachments, editing and validation tests. `npm run build` builds the viewer. Environment overrides: `PORT`, `ASSET_LIBRARY_PATH`, `ASSET_REVIEW_DATA`, `CODEX_BIN`, `CLAUDE_BIN`.

## Portable project folders

Projects live outside the app, by default in `~/Projects/MeshdeskProjects/<name>/`:

```
project.meshdesk   Project identity, schema version and relative folder paths
Assets/           Original models, textures, images, boards, catalog and previews
Workspace/        Working library, saved versions, removals, chats, screenshots and tabs
Snapshots/        Portable ZIP backups
Exports/          Model export folders and ZIP packages
```

Use **Open project**, paste the path to `project.meshdesk` (or its containing folder), and click **Open project**. This opens the existing project in place. You can move the entire folder, then open its project file at the new location. Keep the contents together. In Finder, Option–Command–C copies a selected file’s path.

`project.meshdesk` is a small JSON file with `format: "meshdesk-project"`, `schemaVersion: 1`, an ID, a name, dates, and relative `paths.assets`, `paths.workspace`, and `paths.snapshots` values. It contains no executable instructions. The app's `.data/projects.json` only remembers each project's ID, name and absolute project-file location. Removing/reinstalling the application does not remove external project folders.

**Import a project ZIP as a copy** still supports older Meshdesk ZIP archives and new archives containing `project.meshdesk`. Archive imports get a new identity and independent Codex threads; opening an existing project file keeps its identity and conversation threads. Two existing folders with the same ID are not silently treated as independent projects.

From Terminal, `./Start Meshdesk.command "/full/path/project.meshdesk"` opens that project. Finder double-click file association is not installed; use the app’s Open project control or the launcher command.

## Working with the agent

- **Preview before publish.** With *Project settings → Preview edits before they apply* on (the default), every agent edit is a proposal: it appears beside the current model with a list of changed meshes, and nothing goes live until you press **Accept**. **Discard** deletes it.
- **Project context.** *Project settings* holds a brief (art style, platform, budgets) that the agent reads with every message, plus the target engine, a per-model triangle budget and the largest allowed texture.
- **Game-readiness check.** The shield button in the viewport toolbar runs the model through Blender and lists problems (missing UVs, n-gons, loose geometry, scale, pivot, texture sizes, budget). Each finding can be sent to the agent to fix, and *Quick optimise* applies clean-up or triangle reduction directly.
- **Visual diff.** In compare mode, the diff button tints added, changed and removed meshes and lists what changed.
- **Scenes.** The *Scenes* tab of the library arranges models with a sun, ambient light, sky or image environment and a ground. Move, rotate and scale with the gizmo (W / E / R), or ask the agent to lay the scene out. Every model is pivoted at the centre of its base.
- **Engine export presets.** The export dialog has Unity, Unreal and Godot presets (axis, unit scale, file naming) and can write LOD1–LOD3 files beside each model.
- **AI textures.** Set `imageApiKey` in `config.local.json` (or `OPENAI_API_KEY`) to let the agent generate textures. Only the text prompt is sent to the image service.

How the agent edits: it inspects the model in Blender first (`blender_inspect`, read-only), edits, then receives before/after statistics, readiness findings and a four-view render of the result, and corrects its own work before replying.

## Blender isolation and limits

Blender runs once per edit, with no network and write access only to a throwaway job folder: `sandbox-exec` on macOS, `bubblewrap` on Linux. On other systems set `MESHDESK_UNSANDBOXED_BLENDER=1` to accept running agent-written scripts without isolation. A run is stopped after 10 minutes; change that with `MESHDESK_BLENDER_TIMEOUT` (seconds, 30–3600).
