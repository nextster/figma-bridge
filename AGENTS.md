# Figma Bridge Agent Notes

## Architecture

- `companion/` is the only process that listens on localhost and owns the Unix control socket.
- `figma-plugin/` runs inside Figma Desktop. Its UI iframe owns the WebSocket; the main plugin thread owns all Figma document access.
- `plugins/figma-bridge/` is the canonical Codex plugin source.
- Never add arbitrary JavaScript evaluation. Add narrow, validated commands instead.
- Bind only to loopback, keep the shared token owner-only, and redact it from diagnostics and logs.

## Development

Run `npm run verify` before finishing changes. After MCP schemas or skill instructions change, run `npm run dev:link`, verify `npm run dev:status`, and test from a new Codex task. Existing tasks keep their initialized MCP tool list.

## Release boundary

`npm run setup` installs a versioned companion runtime and the LaunchAgent. `dev:link` may point new Codex tasks and the companion at this checkout, but must not replace the versioned production installation.
