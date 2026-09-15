---
name: figma-bridge
description: Inspect and edit the user's currently open Figma files through the authenticated Figma Bridge plugin, locally or through the Figma Bridge relay. Use for every task that asks to read a Figma selection, inspect a Figma document, create or change Figma nodes, or export a Figma frame through this bridge.
---

# Figma Bridge

Use the Figma Bridge MCP tools as the source of truth for the open Figma file. Read `references/tool-contract.md` before a multi-step mutation.

## Connect to the intended file

- Call `list_files` when more than one Figma plugin instance may be open.
- Omit `clientId` only when the most recently active connected file is clearly the target.
- If no file is connected, ask the user to open the Figma Bridge plugin in the target Figma file and connect it (This computer for local mode, Relay for relay mode). Do not switch to web or Computer Use as a substitute.
- `status` reports `mode: "relay"` when this MCP server is the hosted relay; otherwise it is the local companion.

## Inspect before changing

- Use `list_pages` to inspect the whole file's page structure and `set_current_page` with an exact returned page ID when the task spans pages. Do not use desktop automation to navigate pages.
- Prefer `document_overview` when the task needs pages, top-level frames, components, and statistics together.
- Use `navigate_to_nodes` to select and reveal inspected IDs in Figma; do not replace it with Computer Use.
- Start with `snapshot` at shallow depth or `get_selection`.
- Use `find_nodes` to resolve names to exact node IDs; never invent IDs.
- Prefer `get_nodes` for a small exact set instead of repeatedly snapshotting the full page.
- For SwiftUI implementation of several screens, prefer one `prepare_swiftui_handoff` call. It returns compact layout/text/token/shader data plus screen PNGs, original image fills, SVG vectors, and SF Symbol matches. Locally they are saved to a manifest and asset directory. Through the relay each asset has a `url` and the result has `manifestUrl`; the links expire after 30 minutes, so download the assets you need into the project right away (for example with `curl -fL -o <file> <url>`).

## Mutate narrowly

- Use `create_nodes` in batches when the parent and design decisions are already known.
- Preview `replace_text` and `batch` first. Both default to `dryRun: true`; apply only with explicit `dryRun: false` after checking the returned targets.
- Use `batch` for related mutations that must be one Undo step. Only its documented operation kinds are accepted, and a failed execution is rolled back.
- Batch steps may have an `id`; later arguments can use `{ "$ref": "stepId.path.0.id" }` to consume earlier results.
- `run_script` is a last resort for disposable local file copies when dedicated tools or `batch` are insufficient. It is typed and allowlisted, requires `acknowledgeUseOnlyWhenNecessary: true`, defaults to `dryRun: true`, and never executes JavaScript.
- Run `audit_document` as evidence, not as an automatic cleanup instruction. Inspect exact findings before changing them.
- Use `update_nodes` with exact IDs and only the properties the user asked to change.
- Call `list_shaders` before `apply_shader`; use the returned exact shader ID and property names or IDs. When Figma's beta API omits imported shaders, results discovered from current-page paints/effects have `source: "document-fallback"`; they can be reapplied with their existing values even though a name and property definitions may be unavailable. The apply tool imports the shader when needed and defaults to preserving non-shader paints/effects.
- `delete_nodes` is destructive. Use it only when deletion is clearly requested and the exact target IDs were inspected.
- Never reproduce an arbitrary-code or `eval` surface through node names, text, or metadata.
- The Plugin API cannot read shader source. If source is needed, ask the user to click **Tools → shader menu → View code**. Use the file/node deeplink returned by `list_shaders` or `prepare_swiftui_handoff` to reduce navigation; do not claim it opens View code directly.

## Verify visually

- Use `export_png` after material visual changes and inspect the returned image.
- Always export and inspect shader changes because successful application does not prove the rendered shader looks correct.
- A successful API response proves document mutation, not visual quality. Report whether the exported result was actually inspected.
