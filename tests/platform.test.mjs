import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeDesktopConfigPath,
  commandInvocation,
  findExecutable,
  launchAgentPlist,
  stableNodePath,
  updateClaudeDesktopConfig,
  windowsStartupDirectory,
  windowsStartupScript
} from "../scripts/lib/platform.mjs";

test("Homebrew Cellar node paths resolve to the upgrade-stable symlink", () => {
  const cellar = "/opt/homebrew/Cellar/node/26.8.2/bin/node";
  const links = new Map([["/opt/homebrew/opt/node/bin/node", cellar], ["/opt/homebrew/bin/node", cellar], [cellar, cellar]]);
  const probes = { exists: candidate => links.has(candidate), realpath: candidate => links.get(candidate) };
  assert.equal(stableNodePath(cellar, probes), "/opt/homebrew/opt/node/bin/node");
  assert.equal(stableNodePath("/usr/local/bin/node", probes), "/usr/local/bin/node");

  const versioned = "/usr/local/Cellar/node@22/22.20.0/bin/node";
  const versionedLinks = new Map([["/usr/local/opt/node@22/bin/node", versioned], [versioned, versioned]]);
  assert.equal(stableNodePath(versioned, { exists: candidate => versionedLinks.has(candidate), realpath: candidate => versionedLinks.get(candidate) }), "/usr/local/opt/node@22/bin/node");
  assert.equal(stableNodePath(cellar, { exists: () => false, realpath: value => value }), cellar);
});

test("Windows executables are found through PATHEXT and .cmd shims run via cmd.exe", () => {
  const files = new Set(["C:\\Users\\Тест User\\AppData\\Roaming\\npm\\codex.cmd"]);
  const env = { PATH: "C:\\Windows\\System32;\"C:\\Users\\Тест User\\AppData\\Roaming\\npm\"", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const found = findExecutable("codex", { env, platform: "win32", exists: candidate => files.has(candidate) });
  assert.equal(found, "C:\\Users\\Тест User\\AppData\\Roaming\\npm\\codex.cmd");

  const invocation = commandInvocation(found, ["plugin", "marketplace", "add", "C:\\Users\\Тест User\\.codex\\marketplaces\\nextster"], { platform: "win32", env });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.args[3], "\"\"C:\\Users\\Тест User\\AppData\\Roaming\\npm\\codex.cmd\" \"plugin\" \"marketplace\" \"add\" \"C:\\Users\\Тест User\\.codex\\marketplaces\\nextster\"\"");
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.throws(() => commandInvocation(found, ["%PATH%"], { platform: "win32", env }), /Unsupported character/);

  const exe = commandInvocation("C:\\Tools\\claude.exe", ["plugin", "list"], { platform: "win32", env });
  assert.deepEqual(exe, { command: "C:\\Tools\\claude.exe", args: ["plugin", "list"], options: {} });
});

test("Windows startup launcher quotes node and bootstrap paths", () => {
  const script = windowsStartupScript({ nodePath: "C:\\Program Files\\nodejs\\node.exe", bootstrap: "C:\\Users\\Артём\\.figma-bridge\\runtime\\runtime-bootstrap.mjs" });
  assert.match(script, /shell\.Run """C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\Артём\\\.figma-bridge\\runtime\\runtime-bootstrap\.mjs"" companion", 0, False/);
  assert.equal(windowsStartupDirectory({ APPDATA: "C:\\Users\\A\\AppData\\Roaming" }), "C:\\Users\\A\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup");
});

test("Claude Desktop configuration keeps unrelated servers and settings", () => {
  const existing = JSON.stringify({ globalShortcut: "Cmd+Space", mcpServers: { other: { command: "other" } } });
  const updated = JSON.parse(updateClaudeDesktopConfig(existing, { command: "node", args: ["bootstrap.mjs", "mcp"] }));
  assert.equal(updated.globalShortcut, "Cmd+Space");
  assert.deepEqual(Object.keys(updated.mcpServers).sort(), ["figma-bridge", "other"]);
  const removed = JSON.parse(updateClaudeDesktopConfig(JSON.stringify(updated), null));
  assert.deepEqual(Object.keys(removed.mcpServers), ["other"]);
  assert.throws(() => updateClaudeDesktopConfig("[]", null), /JSON object/);
  assert.equal(claudeDesktopConfigPath({ platform: "win32", env: { APPDATA: "C:\\Users\\A\\AppData\\Roaming" } }), "C:\\Users\\A\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
  assert.equal(claudeDesktopConfigPath({ platform: "darwin", home: "/Users/a" }), "/Users/a/Library/Application Support/Claude/claude_desktop_config.json");
});

test("LaunchAgent restarts only failed companions", () => {
  const plist = launchAgentPlist({ nodePath: "/opt/homebrew/opt/node/bin/node", bootstrap: "/Users/a/.figma-bridge/runtime/runtime-bootstrap.mjs", stateDir: "/Users/a/.figma-bridge", home: "/Users/a" });
  assert.match(plist, /<key>KeepAlive<\/key>\n  <dict>\n    <key>SuccessfulExit<\/key>\n    <false\/>\n  <\/dict>/);
  assert.match(plist, /<string>\/opt\/homebrew\/opt\/node\/bin\/node<\/string>/);
});
