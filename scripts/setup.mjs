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
const stableBootstrap = path.join(runtimeRoot, "runtime-bootstrap.mjs");
const developmentLink = path.join(stateDir, "dev-link.json");
const installedMarketplace = path.join(stateDir, "codex-marketplace");
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

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(stateDir, 0o700);
fs.rmSync(developmentLink, { force: true });
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
copyTree(path.join(root, "companion"), path.join(runtime, "companion"));
copyTree(path.join(root, "node_modules", "ws"), path.join(runtime, "node_modules", "ws"));
copyTree(path.join(root, "plugins", "figma-bridge", "mcp"), path.join(runtime, "plugin", "mcp"));
fs.writeFileSync(path.join(runtime, "package.json"), `${JSON.stringify({ name: "figma-bridge-runtime", private: true, type: "module", version: packageJson.version }, null, 2)}\n`, { mode: 0o600 });
fs.copyFileSync(path.join(root, "runtime", "runtime-bootstrap.mjs"), stableBootstrap);
fs.chmodSync(stableBootstrap, 0o600);
writePrivateJson(path.join(runtimeRoot, "current.json"), { schemaVersion: 1, version: packageJson.version, runtimeRoot: runtime });

fs.mkdirSync(path.dirname(launchAgent), { recursive: true });
fs.writeFileSync(launchAgent, plist({
  Label: label,
  ProgramArguments: isolatedProgramArguments(stableBootstrap, "companion"),
  RunAtLoad: true,
  KeepAlive: true,
  StandardOutPath: path.join(stateDir, "companion.log"),
  StandardErrorPath: path.join(stateDir, "companion.error.log")
}), { mode: 0o600 });

run("launchctl", ["bootout", `${domain}/${label}`], false);
waitForUnloaded();
run("launchctl", ["bootstrap", domain, launchAgent]);
run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
waitForControlSocket();

if (!noCodex && commandExists("codex")) {
  installCodexPlugin();
}

process.stdout.write(`Installed Figma Bridge runtime ${packageJson.version}.\n`);
process.stdout.write(`Figma manifest: ${path.join(root, "figma-plugin", "manifest.json")}\n`);
process.stdout.write("Open a new Codex task after installing or changing MCP code or tools; restarting Codex is not required.\n");

function copyTree(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, filter: item => !item.includes(`${path.sep}test${path.sep}`) });
}

function installCodexPlugin() {
  const temporary = `${installedMarketplace}.tmp-${process.pid}`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(path.join(temporary, "plugins"), { recursive: true, mode: 0o700 });
  copyTree(path.join(root, ".agents"), path.join(temporary, ".agents"));
  copyTree(path.join(root, "plugins", "figma-bridge"), path.join(temporary, "plugins", "figma-bridge"));
  const mcpPath = path.join(temporary, "plugins", "figma-bridge", ".mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  mcp.mcpServers["figma-bridge"] = {
    command: process.execPath,
    args: [stableBootstrap, "mcp"],
    cwd: path.join(installedMarketplace, "plugins", "figma-bridge")
  };
  fs.writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });
  fs.rmSync(installedMarketplace, { recursive: true, force: true });
  fs.renameSync(temporary, installedMarketplace);

  const pluginId = "figma-bridge@figma-bridge-repo";
  run("codex", ["plugin", "remove", pluginId, "--json"], false);
  const marketplaces = parseJson(run("codex", ["plugin", "marketplace", "list", "--json"]).stdout);
  const existing = marketplaces.marketplaces?.find(item => item.name === "figma-bridge-repo");
  if (existing && path.resolve(existing.root) !== installedMarketplace) {
    run("codex", ["plugin", "marketplace", "remove", "figma-bridge-repo", "--json"]);
  }
  if (!existing || path.resolve(existing.root) !== installedMarketplace) {
    run("codex", ["plugin", "marketplace", "add", installedMarketplace, "--json"]);
  }
  run("codex", ["plugin", "add", pluginId, "--json"]);
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

function isolatedProgramArguments(bootstrap, kind) {
  return [
    "/usr/bin/env",
    "-i",
    `HOME=${os.homedir()}`,
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    process.execPath,
    bootstrap,
    kind
  ];
}

function writePrivateJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

function waitForUnloaded() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (run("launchctl", ["print", `${domain}/${label}`], false).status !== 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`launchd job did not unload: ${label}`);
}

function waitForControlSocket() {
  const socket = path.join(stateDir, "control.sock");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(socket)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Figma Bridge control socket did not appear: ${socket}`);
}
