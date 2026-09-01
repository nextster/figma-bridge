import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const stateDir = path.join(os.homedir(), ".figma-bridge");
const runtimeRoot = path.join(stateDir, "runtime");
const runtime = path.join(runtimeRoot, packageJson.version);
const launchAgent = path.join(os.homedir(), "Library", "LaunchAgents", "dev.nextster.figma-bridge.plist");
const label = "dev.nextster.figma-bridge";
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const uninstall = process.argv.includes("--uninstall");
const noCodex = process.argv.includes("--no-codex");

if (uninstall) {
  run("launchctl", ["bootout", `${domain}/${label}`], false);
  if (fs.existsSync(launchAgent)) fs.unlinkSync(launchAgent);
  process.stdout.write("Figma Bridge LaunchAgent removed. Pairing state and versioned runtimes were preserved.\n");
  process.exit(0);
}

requireFile(path.join(root, "node_modules", "ws", "package.json"), "Run npm install first");
run(process.execPath, [path.join(root, "figma-plugin", "scripts", "build.mjs")]);

fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
copyTree(path.join(root, "companion"), path.join(runtime, "companion"));
copyTree(path.join(root, "node_modules", "ws"), path.join(runtime, "node_modules", "ws"));
fs.writeFileSync(path.join(runtime, "package.json"), `${JSON.stringify({ name: "figma-bridge-runtime", private: true, type: "module", version: packageJson.version }, null, 2)}\n`, { mode: 0o600 });

fs.mkdirSync(path.dirname(launchAgent), { recursive: true });
fs.writeFileSync(launchAgent, plist({
  Label: label,
  ProgramArguments: isolatedProgramArguments(path.join(runtime, "companion", "src", "server.mjs")),
  RunAtLoad: true,
  KeepAlive: true,
  StandardOutPath: path.join(stateDir, "companion.log"),
  StandardErrorPath: path.join(stateDir, "companion.error.log")
}), { mode: 0o600 });

run("launchctl", ["bootout", `${domain}/${label}`], false);
waitForUnloaded();
run("launchctl", ["bootstrap", domain, launchAgent]);
run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);

if (!noCodex && commandExists("codex")) {
  const marketplaces = run("codex", ["plugin", "marketplace", "list", "--json"], false);
  if (!marketplaces.stdout.includes(path.resolve(root))) {
    run("codex", ["plugin", "marketplace", "add", root]);
  }
  run("codex", ["plugin", "add", "figma-bridge@figma-bridge-repo"]);
}

process.stdout.write(`Installed Figma Bridge runtime ${packageJson.version}.\n`);
process.stdout.write(`Figma manifest: ${path.join(root, "figma-plugin", "manifest.json")}\n`);
process.stdout.write("Open a new Codex task after installing or changing MCP tools.\n");

function copyTree(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, filter: item => !item.includes(`${path.sep}test${path.sep}`) });
}

function plist(value) {
  const body = Object.entries(value).map(([key, item]) => `  <key>${escapeXml(key)}</key>\n${plistValue(item)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function plistValue(value) {
  if (Array.isArray(value)) return `  <array>\n${value.map(item => `    <string>${escapeXml(item)}</string>`).join("\n")}\n  </array>`;
  if (value === true) return "  <true/>";
  return `  <string>${escapeXml(String(value))}</string>`;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function requireFile(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing. ${hint}`);
}

function run(command, args, check = true) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (check && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

function commandExists(command) {
  return spawnSync("/usr/bin/which", [command], { encoding: "utf8" }).status === 0;
}

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
