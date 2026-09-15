# Manual Windows test

GitHub Actions does not run on Windows yet. Use this checklist on a Windows 10 or 11 computer with Node.js 22.13 or newer, Git, Figma Desktop, and at least one of Claude Code, Claude Desktop, or Codex.

## Local mode

1. Clone the repository into a path that contains a space or non-ASCII characters, for example `C:\Users\<you>\Code\figma bridge`.
2. In PowerShell run `npm install`, `npm --prefix figma-plugin install`, and `npm run verify`.
3. Run `npm run setup`. Expect `Configured MCP clients:` to list the installed clients and no errors about `.cmd` files.
4. Check `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Figma Bridge companion.vbs` exists and that `npm run bridge -- status` prints `"platform": "win32"` and a `\\.\pipe\figma-bridge-…` control endpoint.
5. In Figma Desktop import `figma-plugin\manifest.json`, run Figma Bridge, choose **This computer → Connect to this computer**, and type the 6-digit code from the Figma Bridge popup into the plugin. Expect `Connected to this computer`.
6. In a new Claude Code or Codex session ask for `list_files`, `snapshot`, and `export_png`. Expect the open file and an image.
7. Stop the companion with `npm run bridge -- stop`, then call `status` from the agent again. Expect the MCP server to start the companion within a few seconds.
8. Sign out and back in. Expect the plugin to reconnect without a console window appearing.
9. If Claude Desktop is installed, check that setup reported `Claude Desktop`, restart it, and repeat step 6 in a chat.
10. Run `npm run uninstall` and confirm the Startup launcher and the Claude plugin are gone.

## Relay mode

1. Get an invite code from the relay operator.
2. In the plugin choose **Relay**, enter the invite, and expect `Connected to relay`.
3. Add the relay to Codex (`codex mcp add figma-bridge --url https://figma-bridge.fly.dev/mcp`) or Claude Code (`claude mcp add --transport http figma-bridge https://figma-bridge.fly.dev/mcp`, then `/mcp`).
4. On the browser page note the code, enter it in the plugin under **Connect AI app**, check the app name, and choose **Allow**. Expect the browser to return to the client.
5. Repeat step 6 of local mode.

Record failures with the command, the full error text, and `%USERPROFILE%\.figma-bridge\companion.log`.
