# Goal: Meshdesk as a restyling tool for a whole asset set

Turn Meshdesk from a per-model editor into a tool for restyling a whole game's asset set consistently, reviewing it, and handing it to the dev team.

## Context

- Repo: `/Users/farhan/Projects/meshdesk` (Node/Express server in `server/*.mjs`, React 19 + Vite + three.js in `src/`). Test project: `/Users/farhan/MeshDeskProjects/metro-hustle`.
- Run: `npx vite build` then `npm start` (port 8790). Server changes need a rebuild and restart. Tests: `npm test` (34 pass today).
- Agents: Codex (app-server JSON-RPC) and Claude (Agent SDK) share tools in `server/edit-tools.mjs`; bump `TOOLS_VERSION` when tools change. Conversation logic is in `server/conversations.mjs`, the chat UI in `src/components/ConversationPanel.jsx`, the app shell in `src/App.jsx`.
- Follow the existing code style. Keep existing features working (scenes, proposals, export, texture tools, model generation).
- Existing project data must migrate automatically: current per-model and per-scene chats become conversations, and current versions stay reachable.

## Testing rules

- For every live agent test, use only Codex with the GPT 6 Astra model. Claude is not connected, so do not run Claude turns; keep the Claude code path working and covered by non-live tests only, and list it as not verified live.
- Test batch features (batch restyle, review board, shared-material updates, consistency fixes) on three assets only, to limit usage.

## How to work

Work through the phases in order. Each phase must end with the app building, tests passing, and the feature checked in the running app in the browser. Add tests for new server logic. Do not commit or push unless asked.

## Phase 1 — Conversations (replace per-model chat)

- Conversations are project-level, not tied to one model or scene. Each has a title (auto-named from the first message, renamable), an agent, a status and a last-activity time.
- The right panel becomes an inbox that drills into a chat. List layout: recently finished conversations at the top, newest first; a "Working" group pinned at the bottom; a "Settled" group collapsed behind a count. Include search, new conversation, and settle/unsettle. Opening a conversation shows the chat with a back arrow to the list. The Inspector stays as a tab; the preview stays in the centre.
- References: the asset or scene open in the preview is auto-attached to the next message as a removable chip. Typing @ opens a picker for any model, texture, reference image or scene. Clicking a chip opens that item in the preview. Keep the button that attaches a screenshot of the current preview.
- Several conversations can run at once, but only one may edit a given model at a time; a second gets a clear "busy in <conversation>" message.
- Every asset and scene shows a link to the conversations that touched it.

## Phase 2 — Versions and checkpoints

- Checkpoint: every agent iteration. Shown only in the chat where it was made, with preview and restore.
- Version: a deliberate milestone. Accepting a conversation's work on a model squashes its checkpoints into one named version (renamable). The model's version dropdown lists only Original and versions, never checkpoints.
- Keep before/after compare between any two versions, and between a checkpoint and the live version.
- Prune checkpoint files of settled conversations (keep the record in the chat, mark it as no longer restorable). Never prune versions.
- Migrate existing models: collapse each run of intermediate iterations into a sensible version list without losing the live result.

## Phase 3 — Library and textures

- Multi-select in list and grid (click, shift-click, ⌘-click, select all), with bulk remove, restore and set status. Rename inline and from a right-click menu. Removal asks for confirmation and states the count.
- Import accepts multiple files or a whole folder (picker and drag-drop), matches textures to models by folder and name, and shows per-file progress and failures.
- Textures embedded in a model are private to it. The preview-override list shows only that model's textures plus shared library textures. Add "Add to library" to promote an embedded texture to a shared one.
- Per-material texturing: clicking a part in the viewport selects its material and highlights everything using it. The preview override and the inspector then apply to that material only, and the selected material is passed to the agent as context.

## Phase 4 — Style guide and asset status

- Style guide per project: palette, texel density, max texture size, material rules, free-text notes, and reference images from the library. Editable in project settings, injected into every agent turn and every texture generation.
- Asset status: Not started, In progress, Needs review, Approved. Set manually or automatically (an agent edit moves it to Needs review; accept leaves it for the user to approve). Library shows a status badge, a filter and a project progress bar.

## Phase 5 — Batch restyle and review board

- Batch restyle: select assets, give one instruction, and each asset is restyled in the background against the style guide as its own proposal. Show a queue with progress, per-asset failure, and cancel.
- Review board: a grid of before/after thumbnails for everything in Needs review. Per asset: accept, discard, or send a note back to the agent. Include accept-all for a selection.
- Scenes get a toggle between original and current versions of every model.

## Phase 6 — Shared materials, consistency, handoff

- Shared materials: a library of named materials (colour, PBR maps, tiling) that models reference. Changing one offers to update every model using it, as proposals. Agents get tools to list, create and apply them, and are told to prefer them over one-off textures.
- Consistency check: per asset and project-wide report against the style guide (off-palette colours, texel density, texture size, triangle budget, materials not from the shared library), with a "fix this" action that starts a conversation.
- Handoff export: one package of all Approved assets and chosen scenes, using the project's engine preset, with a manifest (triangles, materials, textures, version per asset) and a changelog since the previous handoff.

## When done

Report per phase: what was built, what was verified in the app, and what was not verified or was left out. Update `README.md` to match.
