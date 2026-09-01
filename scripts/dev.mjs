import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requestControl } from "../companion/src/client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "status";
const stateDir = path.join(os.homedir(), ".figma-bridge");
const launchAgent = path.join(os.homedir(), "Library", "LaunchAgents", "dev.nextster.figma-bridge.plist");
const label = "dev.nextster.figma-bridge";
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const mcpServer = path.join(root, "plugins", "figma-bridge", "mcp", "server.mjs");

if (command === "link") {
  requireCheckout();
  writeLaunchAgent(isolatedProgramArguments(path.join(root, "companion", "src", "server.mjs")));
  run("launchctl", ["bootout", `${domain}/${label}`], false);
  waitForUnloaded();
  run("launchctl", ["bootstrap", domain, launchAgent]);
  run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
  run("codex", ["mcp", "remove", "figma-bridge"], false);
  run("codex", ["mcp", "add", "figma-bridge", "--", process.execPath, mcpServer]);
  process.stdout.write(`Development linked: ${root}\nNew Codex tasks will use the checkout; existing tasks are unchanged.\n`);
} else if (command === "unlink") {
  const details = run("codex", ["mcp", "get", "figma-bridge", "--json"], false).stdout;
  if (details.includes(mcpServer)) run("codex", ["mcp", "remove", "figma-bridge"]);
  run(process.execPath, [path.join(root, "scripts", "setup.mjs"), "--no-codex"]);
  process.stdout.write("Development override removed; versioned plugin/runtime are active for new tasks.\n");
} else if (command === "status") {
  const git = run("git", ["-C", root, "status", "--short", "--branch"], false).stdout.trim();
  const mcp = run("codex", ["mcp", "get", "figma-bridge", "--json"], false);
  let bridge;
  try { bridge = await requestControl("bridge.status"); } catch (error) { bridge = { error: error.message }; }
  process.stdout.write(`${JSON.stringify({ root, git, developmentMcp: mcp.stdout.includes(mcpServer), bridge }, null, 2)}\n`);
} else {
  throw new Error(`unknown dev command: ${command}`);
}

function requireCheckout() {
  for (const file of ["package.json", "companion/src/server.mjs", "plugins/figma-bridge/.codex-plugin/plugin.json"]) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`incomplete checkout: ${file}`);
  }
  const top = run("git", ["-C", root, "rev-parse", "--show-toplevel"], false).stdout.trim();
  if (top && path.resolve(top) !== root) throw new Error(`checkout is not its Git root: ${root}`);
}

function writeLaunchAgent(arguments_) {
  fs.mkdirSync(path.dirname(launchAgent), { recursive: true });
  const strings = arguments_.map(value => `      <string>${xml(value)}</string>`).join("\n");
  fs.writeFileSync(launchAgent, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>\n${strings}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>${xml(path.join(stateDir, "companion.log"))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(stateDir, "companion.error.log"))}</string>\n</dict></plist>\n`, { mode: 0o600 });
}

function xml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function isolatedProgramArguments(server) {
  return [
    "/usr/bin/env",
    "-i",
    `HOME=${os.homedir()}`,
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    process.execPath,
    server
  ];
}
function waitForUnloaded() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (run("launchctl", ["print", `${domain}/${label}`], false).status !== 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`launchd job did not unload: ${label}`);
}
function run(program, args, check = true) {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (check && result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}
