# Figma Bridge

Figma Bridge is a local, bidirectional connection between Codex and Figma Desktop. It avoids the official remote MCP quota by using the public Figma Plugin API in the user's open desktop file.

```text
Codex MCP -> stable bootstrap -> Unix socket -> local companion -> authenticated loopback WebSocket -> Figma plugin
```

The bridge is intentionally local. It has no cloud relay, Figma personal access token, or arbitrary `eval` tool. Every document operation is a named command with validated inputs.

## Current tools

- Inspect connection state and open Figma files.
- List and switch pages without desktop automation.
- Snapshot the current page or selection with bounded depth.
- Summarize every page, top-level frame, component, component set, and file statistic in one bounded call.
- Find and inspect nodes.
- Create frames, rectangles, ellipses, and text.
- Configure Auto Layout, including gap, padding, alignment, and HUG/FILL/FIXED sizing.
- Create components, variant sets, and instances; update instance properties.
- Duplicate, move, reorder, group, and ungroup exact nodes.
- Update corner radii, solid or gradient paints, strokes, effects, and typography.
- List available Figma shaders and apply imported shader fills, strokes, or effects to exact nodes with validated properties.
- Create or update local variables and paint/text styles with named modes such as Light and Dark.
- Inspect existing local variable collections, modes, variables, paint styles, and text styles.
- Delete exact local token/style IDs when cleanup is explicitly required.
- Search and preview or apply literal text replacement across the whole file.
- Select and focus exact nodes in Figma without desktop automation.
- Audit naming, unresolved instances, repeated colors, and inconsistent Auto Layout spacing.
- Preview allowlisted batches with `dryRun` and apply them as one Undo step with rollback on failure.
- Delete explicitly identified nodes.
- Export a node or selection as PNG.

Shader properties can be supplied by their stable property-definition ID or by a unique property name returned by `list_shaders`. `apply_shader` imports the selected shader into the current file when needed and defaults to replacing only existing shaders, preserving ordinary paints and effects.

Domain-specific generators, such as an exact SDF smooth-union generator, are intentionally not coupled to the transport layer. Add them as focused bridge commands without widening the generic document API.

## Install

```bash
npm install
npm --prefix figma-plugin install
npm run verify
npm run setup
```

Then import [figma-plugin/manifest.json](figma-plugin/manifest.json) once through **Figma Desktop -> Plugins -> Development -> Import plugin from manifest** and run **Figma Bridge** in the file Codex should use. Click **Connect to Codex** and approve the local macOS dialog. Figma stores the resulting token in `clientStorage` for later runs. Manual token entry through `npm run bridge -- pair` remains available for troubleshooting.

`npm run setup` adds Figma Bridge to the shared Nextster marketplace under `~/.codex/marketplaces/nextster` and points it at the stable runtime bootstrap. It preserves other Nextster plugins already present there. Open a new Codex task after installing or changing MCP code or tools. Restarting Codex is not required.

## Development loop

```bash
npm run dev:link
npm run dev:status
npm run verify
npm run dev:unlink
```

`dev:link` writes an owner-only `~/.figma-bridge/dev-link.json`. The installed stable bootstrap then makes new Codex tasks load the checkout MCP adapter and restarts the companion from the checkout. It does not rewrite Codex configuration or the versioned plugin cache. `dev:unlink` removes the pointer and returns both processes to the bundled runtime.

Already open Codex tasks keep their initialized MCP process and tool schema. Use a new task after MCP changes; neither Codex nor the app server needs a restart.

## Security model

- HTTP/WebSocket binds to `127.0.0.1` only.
- MCP clients use an owner-only Unix socket under `~/.figma-bridge`.
- The Figma plugin authenticates with a random owner-only token.
- Tokens are never returned by MCP status or written to logs.
- Commands are allowlisted and size-limited.
- Node deletion is exposed as a destructive MCP tool and requires exact node IDs.
