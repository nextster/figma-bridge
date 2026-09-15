# Figma Bridge Agent Notes

## Product decision

- This project is the supported agent-to-Figma editing path for Claude (Claude Code, the Code tab, Claude Desktop chat, claude.ai) and Codex on macOS and Windows. Keep the official Figma Plugin API as the primary write surface.
- Local mode is the default and keeps design data on the user's computer. On 2026-09-15 Artem approved an optional hosted relay: in relay mode design data passes through the relay, which must not persist it. Relay signups are invite-only unless Artem decides otherwise.
- Figma does not allow plugins to run globally or in the background. The plugin must be launched and kept open in every file that an agent should access. Local pairing and relay device credentials are stored in Figma `clientStorage`, so they normally happen once per plugin installation.
- Switching pages, Figma workspaces, browser tabs, or desktop Spaces does not require restarting the agent, Figma, the companion, or the relay connection. A different file still needs its own running plugin instance.
- Do not pursue Electron injection, undocumented Figma internals, or Accessibility-driven auto-launch unless Artem explicitly asks for that less reliable desktop-automation layer. The accepted default is the per-file plugin lifecycle.
- The plugin stays a development plugin. Private publishing needs a Figma Organization or Enterprise plan that this project does not use, and Figma's Community review guidelines reject plugins that expose MCP or programmatic AI access. Do not submit it to Community. See docs/PUBLISHING.md.

## Architecture

- `plugins/figma-bridge/mcp/tools.mjs` is the single transport-independent tool surface, JSON-RPC handler, and handoff flow. The stdio server and the relay must not diverge from it.
- `companion/` is the only local process that listens on loopback (`127.0.0.1` and `::1`) and owns the control endpoint. `companion/src/hub.mjs` holds plugin connections and RPC for both the companion and the relay.
- `plugins/figma-bridge/mcp/control.mjs` is the local control channel: a 0600 Unix socket on POSIX and a random named pipe on Windows, with HMAC-authenticated, fresh, single-use requests and responses. MCP adapters start the companion on demand through `autostart.mjs`.
- `relay/` is the hosted service: invite-only accounts and devices (`accounts-store.mjs`), the OAuth 2.1 authorization server (`oauth*.mjs`), the plugin WebSocket gateway, the Streamable HTTP MCP endpoint, and in-memory handoff downloads. It runs as exactly one Fly.io machine because routing is in memory.
- `figma-plugin/` runs inside Figma Desktop. Its UI iframe owns the WebSocket to either the companion or the relay; the main plugin thread owns all Figma document access and `clientStorage`.
- `plugins/figma-bridge/` is the canonical plugin source for both Codex (`.codex-plugin`) and Claude Code (`.claude-plugin`); keep the two manifests in the same directory and version. Its `.mcp.json` points to the relay. `npm run setup` installs one copy with absolute stdio paths into the shared `~/.agent-plugins/nextster` marketplace (both `.agents/plugins/marketplace.json` and `.claude-plugin/marketplace.json`), mirroring Chromium Bridge's installer, and configures Claude Desktop by default.
- Never add arbitrary JavaScript evaluation. Add narrow, validated commands instead.
- Keep tokens, device secrets, OAuth secrets, and control secrets owner-only or hashed, and redact them from diagnostics and logs.
- The Figma manifest allows only `wss://figma-bridge.fly.dev` in `allowedDomains` and `ws://localhost:3847` plus `ws://localhost:8787` in `devAllowedDomains`. Figma rejects numeric loopback URLs in these fields. Changing the relay host requires matching `figma-plugin/scripts/build.mjs`, the manifest, `plugins/figma-bridge/.mcp.json`, and `fly.toml`.
- `runtime/runtime-bootstrap.mjs` is the stable installed entrypoint. The owner-only `~/.figma-bridge/dev-link.json` selects checkout code without rewriting client MCP configuration or plugin caches.
- Relay approval must never push unsolicited prompts: an OAuth request is approved only after a plugin of the account looks up the code shown on the authorization page and the user allows it.

## Current command surface

- Read: bridge status, connected files, whole-file overview, page/selection snapshots, exact node lookup, bounded name/type and whole-file text search, token/style inspection, and document audit.
- Write: create and update basic nodes, Auto Layout, gradients/strokes/effects/typography, components/variants/instances, structural operations, whole-file text replacement, and local variables/styles with modes. Allowlisted batches default to dry-run and execute as one Undo step with rollback.
- Shaders: list available owned/subscribed/imported shaders and apply shader fills, strokes, or effects to exact nodes with validated property values and rollback.
- Output: export an exact node or the first selected node as PNG, capped at 8 MiB; prepare bounded multi-screen SwiftUI handoffs with PNGs, original image fills, SVG vectors, and SF Symbol candidates, saved locally in local mode or behind 30-minute download links in relay mode.
- Scripting: named, allowlisted operations may reference earlier results and execute transactionally. `run_script` is explicitly last-resort and must never become JavaScript evaluation.
- Not implemented yet: writing image fills, creating arbitrary vectors, prototyping, and whole-file duplication.

## Development

Run `npm run verify` before finishing changes. After MCP schemas or skill instructions change, run `npm run dev:link`, verify `npm run dev:status`, and test from a new agent task or session. Existing sessions keep their initialized MCP tool list.

Windows code paths must stay unit-testable on macOS: pass `platform`, `env`, and filesystem probes explicitly instead of reading globals deep inside helpers. GitHub Actions does not run Windows yet; Artem tests Windows manually with docs/WINDOWS-TESTING.md.

Never run setup, uninstall, or dev scripts against the real launchd session from a redirected `HOME`; launchd labels are per login session, not per home directory.

`npm run dev:link` is expected to be idempotent and leave both MCP and companion on the checkout. `npm run dev:unlink` returns both to the versioned bundled runtime. Neither operation requires restarting the agent app.

When changing companion restart behavior, preserve control-endpoint ownership: the loopback port is the single-instance lock, a failed start must release it, and an old process must not unlink the socket created by its replacement.

## Release boundary

`npm run setup` installs a versioned companion runtime, autostart (LaunchAgent on macOS, Startup launcher on Windows), and client registrations. `dev:link` may point new agent sessions and the companion at this checkout, but must not replace the versioned production installation. Deploying the relay, pushing, publishing, and changing repository visibility require Artem's explicit confirmation.

## Verified handoff

- On 2026-09-02 the plugin imported successfully after the localhost manifest fix, paired with the local companion, and appeared through MCP with its real file and page names.
- The stable bootstrap was verified through MCP `initialize`, `tools/list`, and `status`; the checkout/bundled link cycle and repeated `dev:link` passed.
- A successful API mutation is not visual verification. Export the affected frame and inspect the PNG before claiming visual completion.
