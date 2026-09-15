# Figma Bridge

Figma Bridge is a bidirectional connection between AI agents (Claude Code, Claude Desktop, claude.ai, and Codex) and open Figma files. It avoids the official remote MCP quota by using the public Figma Plugin API inside the file where the Figma Bridge plugin is running.

It works in two modes:

```text
Local (default):  MCP client -> stdio MCP server -> authenticated local control channel -> companion -> loopback WebSocket -> Figma plugin
Relay (optional): MCP client -> HTTPS MCP + OAuth -> Figma Bridge relay <- outbound WSS <- Figma plugin
```

Local mode keeps all design data on your computer. Relay mode removes the local companion and works from any operating system and from hosted clients such as claude.ai, but design data then passes through the relay. The bridge has no Figma personal access token and no arbitrary `eval` tool. Every document operation is a named command with validated inputs. A last-resort typed scripting tool composes only those allowlisted commands; it cannot execute JavaScript.

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
- Prepare several screens for SwiftUI in one call. The handoff saves a compact JSON manifest, screen PNGs, original image fills, non-SF-Symbol vectors as SVG, and reports token candidates, Auto Layout, text, recognized SF Symbols, and shader properties.
- Run a last-resort typed script over local file copies. Named steps can reference earlier results with `{ "$ref": "stepId.path.0.id" }`; scripts retain dry-run, allowlist, Undo, and rollback guarantees and never evaluate JavaScript.
- Delete explicitly identified nodes.
- Export a node or selection as PNG.

Shader properties can be supplied by their stable property-definition ID or by a unique property name returned by `list_shaders`. If Figma's beta discovery API omits an imported shader, `list_shaders` falls back to shader paints and effects found on the current page; `apply_shader` can clone their existing values by ID. It otherwise imports the selected shader when needed and defaults to replacing only existing shaders, preserving ordinary paints and effects.

The public Plugin API does not expose shader source code. When source is required, ask the user to open **Tools → shader menu → View code**. `list_shaders` and `prepare_swiftui_handoff` return the nearest supported Figma file/node link, but Figma currently documents no direct link that opens the View code panel. The official Figma MCP can read and update shader source separately.

Domain-specific generators, such as an exact SDF smooth-union generator, are intentionally not coupled to the transport layer. Add them as focused bridge commands without widening the generic document API.

## Install the Figma plugin

Figma Bridge is a development plugin, so it runs in Figma Desktop on macOS and Windows. Publishing is not available; see [docs/PUBLISHING.md](docs/PUBLISHING.md).

```bash
npm install
npm --prefix figma-plugin install
npm run build
```

In Figma Desktop choose **Plugins → Development → Import plugin from manifest** and select [figma-plugin/manifest.json](figma-plugin/manifest.json). Run **Figma Bridge** in every file the agent should use and keep it open.

## Local mode

```bash
npm run setup
```

Setup installs a versioned runtime under `~/.figma-bridge` (`%USERPROFILE%\.figma-bridge` on Windows) and registers Figma Bridge with every client it finds:

- **Codex:** a plugin in the Nextster marketplace shared with other Nextster bridges under `~/.agent-plugins/nextster` (`NEXTSTER_MARKETPLACE_DIR` overrides it). Setup moves or merges an older `~/.codex/marketplaces/nextster` copy there, keeping other plugins.
- **Claude Code** (CLI and the Code tab of the Claude desktop app): the `figma-bridge@figma-bridge-local` plugin, including the skill.
- **Claude Desktop chat:** only with `npm run setup -- --claude-desktop`. Setup backs up and merges `claude_desktop_config.json`; quit and reopen Claude Desktop afterwards.

The companion starts at sign-in (a LaunchAgent on macOS, a hidden Startup launcher on Windows) and MCP clients also start it on demand. Use `--no-codex`, `--no-claude`, or `--no-autostart` to skip parts, and `npm run uninstall` to remove autostart and the Claude integrations.

In the plugin choose **This computer → Connect to this computer**, then type the 6-digit code that the Figma Bridge dialog shows on your computer. Figma stores the resulting token in `clientStorage`. Manual token entry through `npm run bridge -- pair` remains available for troubleshooting. Open a new agent task or session after installing or changing MCP tools.

## Relay mode

The relay is an invite-only service. The reference deployment is `https://figma-bridge.fly.dev`; see [docs/RELAY.md](docs/RELAY.md) to deploy your own and create invites.

1. In the plugin choose **Relay**, enter your invite code, and keep the plugin open. To add another Figma installation to the same account, choose **Link another Figma** and enter the shown code there.
2. Add the MCP server to your client:
   - **Claude Code:** `claude plugin marketplace add nextster/figma-bridge`, then `claude plugin install figma-bridge@figma-bridge`, and authenticate with `/mcp`. From a checkout, `npm run setup -- --relay` installs the same plugin locally. Without the skill: `claude mcp add --transport http figma-bridge https://figma-bridge.fly.dev/mcp`.
   - **Codex:** `codex mcp add figma-bridge --url https://figma-bridge.fly.dev/mcp`, or `npm run setup -- --relay` for the plugin with the skill followed by `codex mcp login figma-bridge`.
   - **claude.ai and Claude Desktop chat:** **Settings → Connectors → Add custom connector** with `https://figma-bridge.fly.dev/mcp`.
3. The client opens a Figma Bridge page in your browser with a code. In the plugin choose **Connect AI app**, enter the code, check the app name, and choose **Allow**. The browser returns to the client.

Connected apps and devices can be revoked from the plugin. In relay mode `prepare_swiftui_handoff` returns download links that expire after 30 minutes instead of writing files; agents should download what they need immediately.

## Development loop

```bash
npm run dev:link
npm run dev:status
npm run verify
npm run dev:unlink
```

`dev:link` writes an owner-only `~/.figma-bridge/dev-link.json`. The installed stable bootstrap then makes new agent sessions load the checkout MCP adapter and restarts the companion from the checkout. It does not rewrite client configuration or plugin caches. `dev:unlink` removes the pointer and returns both processes to the bundled runtime.

Already open sessions keep their initialized MCP process and tool schema. Use a new task or session after MCP changes; the apps themselves do not need a restart.

Run the relay locally with `FIGMA_BRIDGE_PUBLIC_URL=http://localhost:8787 PORT=8787 FIGMA_BRIDGE_DB=./relay.db npm run relay`, and build the plugin against it with `FIGMA_BRIDGE_RELAY_URL=ws://localhost:8787/plugin npm run build`. Windows checks are manual for now; follow [docs/WINDOWS-TESTING.md](docs/WINDOWS-TESTING.md).

## Security model

Local mode:

- HTTP/WebSocket binds to `127.0.0.1` and `::1` only.
- MCP adapters reach the companion through an owner-only Unix socket on macOS and Linux, or a named pipe with a random per-install name on Windows. Every control request and response is authenticated with an HMAC key from the owner-only state file, and requests are fresh and single-use.
- First pairing requires the 6-digit code from a dialog on the computer. Afterwards the plugin and companion prove knowledge of a random owner-only token to each other with HMAC before the plugin accepts commands, so a process squatting on the port learns nothing.
- Tokens are never returned by MCP status or written to logs.

Relay mode:

- MCP clients authenticate with OAuth 2.1 (dynamic client registration, PKCE S256, rotating refresh tokens with reuse detection). Redirects are limited to loopback apps and the Claude callbacks.
- A connection is approved only by typing the code from the authorization page into a plugin that belongs to the account; the relay never pushes approval prompts.
- Accounts are created from invites; plugin installations authenticate as devices with hashed secrets, and every tool call reaches only the Figma files of the account that owns the grant.
- The relay stores accounts, devices, and OAuth grants, but not design data. Handoff assets are kept in memory for 30 minutes behind unguessable download links.

Both modes:

- Commands are allowlisted and size-limited.
- `run_script` is declarative, requires an explicit last-resort acknowledgement, and is intended only for disposable local copies. It does not widen the command allowlist.
- Node deletion is exposed as a destructive MCP tool and requires exact node IDs.
