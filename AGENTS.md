# Figma Bridge Agent Notes

## Product decision

- This project is the supported Codex-to-Figma editing path. Keep the official Figma Plugin API as the primary write surface.
- Figma does not allow plugins to run globally or in the background. The plugin must be launched and kept open in every file that Codex should access. Pairing is stored in Figma `clientStorage`, so it normally happens only once per local plugin installation.
- Switching pages, Figma workspaces, browser tabs, or macOS Spaces does not require restarting Codex, Figma, or the companion. A different file still needs its own running plugin instance.
- Do not pursue Electron injection, undocumented Figma internals, or Accessibility-driven auto-launch unless Artem explicitly asks for that less reliable desktop-automation layer. The accepted default is the per-file plugin lifecycle.

## Architecture

- `companion/` is the only process that listens on localhost and owns the Unix control socket.
- `figma-plugin/` runs inside Figma Desktop. Its UI iframe owns the WebSocket; the main plugin thread owns all Figma document access.
- `plugins/figma-bridge/` is the canonical Codex plugin source.
- Never add arbitrary JavaScript evaluation. Add narrow, validated commands instead.
- Bind only to loopback, keep the shared token owner-only, and redact it from diagnostics and logs.
- The Figma development manifest must keep `allowedDomains: ["none"]` and `devAllowedDomains: ["ws://localhost:3847"]`. Figma rejects the numeric loopback URL in this manifest field. The companion itself remains bound to `127.0.0.1`.
- `runtime/runtime-bootstrap.mjs` is the stable installed entrypoint. The owner-only `~/.figma-bridge/dev-link.json` selects checkout code without rewriting Codex MCP configuration or its plugin cache.

## Current command surface

- Read: bridge status, connected files, whole-file overview, page/selection snapshots, exact node lookup, bounded name/type and whole-file text search, token/style inspection, and document audit.
- Write: create and update basic nodes, Auto Layout, gradients/strokes/effects/typography, components/variants/instances, structural operations, whole-file text replacement, and local variables/styles with modes. Allowlisted batches default to dry-run and execute as one Undo step with rollback.
- Shaders: list available owned/subscribed/imported shaders and apply shader fills, strokes, or effects to exact nodes with validated property values and rollback.
- Output: export an exact node or the first selected node as PNG, capped at 8 MiB; prepare bounded multi-screen SwiftUI handoffs with locally saved PNGs, original image fills, SVG vectors, and SF Symbol candidates.
- Scripting: named, allowlisted operations may reference earlier results and execute transactionally. `run_script` is explicitly last-resort and must never become JavaScript evaluation.
- Not implemented yet: writing image fills, creating arbitrary vectors, prototyping, and whole-file duplication.

## Development

Run `npm run verify` before finishing changes. After MCP schemas or skill instructions change, run `npm run dev:link`, verify `npm run dev:status`, and test from a new Codex task. Existing tasks keep their initialized MCP tool list.

`npm run dev:link` is expected to be idempotent and leave both MCP and companion on the checkout. `npm run dev:unlink` returns both to the versioned bundled runtime. Neither operation requires restarting the Codex app.

When changing companion restart behavior, preserve Unix-socket ownership checks: an old process must not unlink the socket created by its replacement.

## Release boundary

`npm run setup` installs a versioned companion runtime and the LaunchAgent. `dev:link` may point new Codex tasks and the companion at this checkout, but must not replace the versioned production installation.

## Verified handoff

- On 2026-09-02 the plugin imported successfully after the localhost manifest fix, paired with the local companion, and appeared through MCP with its real file and page names.
- The stable bootstrap was verified through MCP `initialize`, `tools/list`, and `status`; the checkout/bundled link cycle and repeated `dev:link` passed.
- A successful API mutation is not visual verification. Export the affected frame and inspect the PNG before claiming visual completion.
