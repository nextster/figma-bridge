# Figma Bridge

Figma Bridge is a local, bidirectional connection between Codex and Figma Desktop. It avoids the official remote MCP quota by using the public Figma Plugin API in the user's open desktop file.

```text
Codex MCP -> stable bootstrap -> Unix socket -> local companion -> authenticated loopback WebSocket -> Figma plugin
```

The bridge is intentionally local. It has no cloud relay, Figma personal access token, or arbitrary `eval` tool. Every document operation is a named command with validated inputs.

## Current tools

- Inspect connection state and open Figma files.
- Snapshot the current page or selection with bounded depth.
- Find and inspect nodes.
- Create frames, rectangles, ellipses, and text.
- Update a safe set of node properties.
- Delete explicitly identified nodes.
- Export a node or selection as PNG.

Domain-specific generators, such as an exact SDF smooth-union generator, are intentionally not coupled to the transport layer. Add them as focused bridge commands without widening the generic document API.

## Install

```bash
npm install
npm --prefix figma-plugin install
npm run verify
npm run setup
```

Then import [figma-plugin/manifest.json](figma-plugin/manifest.json) once through **Figma Desktop -> Plugins -> Development -> Import plugin from manifest** and run **Figma Bridge** in the file Codex should use. Copy the pairing token shown by `npm run bridge -- pair` into the plugin once; Figma stores it in `clientStorage` for later runs.

`npm run setup` installs a private marketplace copy under `~/.figma-bridge/codex-marketplace` and points it at the stable runtime bootstrap. Open a new Codex task after installing or changing MCP code or tools. Restarting Codex is not required.

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
