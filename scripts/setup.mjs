import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchCompanion } from "../plugins/figma-bridge/mcp/autostart.mjs";
import { requestControl, stateDirectory } from "../plugins/figma-bridge/mcp/control.mjs";
import {
  LAUNCH_AGENT_LABEL,
  WINDOWS_STARTUP_FILE,
  claudeDesktopConfigPath,
  findExecutable,
  launchAgentPath,
  launchAgentPlist,
  runTool,
  sleepSync,
  stableNodePath,
  updateClaudeDesktopConfig,
  windowsStartupDirectory,
  windowsStartupScript,
  writePrivateJson
} from "./lib/platform.mjs";
import { installForClients, marketplaceLocations, uninstallFromClients } from "./lib/agent-marketplace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const platform = process.platform;
const stateDir = stateDirectory(process.env);
const runtimeRoot = path.join(stateDir, "runtime");
const runtime = path.join(runtimeRoot, packageJson.version);
const stableBootstrap = path.join(runtimeRoot, "runtime-bootstrap.mjs");
const developmentLink = path.join(stateDir, "dev-link.json");
const nodePath = stableNodePath(process.execPath);
const marketplace = marketplaceLocations({ env: process.env });
// Written by earlier builds that registered Claude Code from a private marketplace.
const legacyClaudeMarketplace = path.join(stateDir, "claude-marketplace");
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const flags = new Set(process.argv.slice(2));
// launchd labels are per login session, not per HOME. Never touch the real
// LaunchAgent from a redirected HOME, such as an isolated test installation.
const launchdAllowed = platform === "darwin" && path.resolve(os.homedir()) === path.resolve(os.userInfo().homedir);

for (const flag of flags) {
  if (!["--uninstall", "--no-codex", "--no-claude", "--no-claude-code", "--no-claude-desktop", "--no-autostart", "--relay"].includes(flag)) {
    throw new Error(`unknown setup option: ${flag}`);
  }
}

if (flags.has("--uninstall")) {
  await uninstall();
  process.exit(0);
}

const relayMode = flags.has("--relay");
const relayMcpUrl = relayMode ? repositoryRelayUrl() : null;

requireFile(path.join(root, "node_modules", "ws", "package.json"), "Run npm install first");
run(process.execPath, [path.join(root, "figma-plugin", "scripts", "build.mjs")]);
if (!relayMode) installRuntime();

if (relayMode) {
  process.stdout.write(`Relay mode: MCP clients will use ${relayMcpUrl}; no local companion is installed.\n`);
} else if (flags.has("--no-autostart")) {
  process.stdout.write("Skipped companion autostart; MCP clients start it on demand.\n");
} else if (platform === "darwin" && launchdAllowed) {
  await installLaunchAgent();
} else if (platform === "win32") {
  await installWindowsStartup();
} else {
  await restartDetachedCompanion();
}

const clients = agentClients();
const configured = [];
if (clients.codex || clients.claude) {
  const result = await installForClients({
    projectDir: root,
    mcpConfig: relayMode ? relayMcpConfig() : localMcpConfig(),
    locations: marketplace,
    codex: clients.codex,
    claude: clients.claude
  });
  if (result.migration.migrated) process.stdout.write(`Moved the Nextster marketplace from ${result.migration.from} to ${result.migration.to}.\n`);
  fs.rmSync(legacyClaudeMarketplace, { recursive: true, force: true });
  if (clients.codex) configured.push("Codex");
  if (clients.claude) configured.push("Claude Code");
}
if (!flags.has("--no-claude") && !flags.has("--no-claude-desktop")) {
  if (installClaudeDesktop()) configured.push("Claude Desktop");
}

process.stdout.write(`Installed Figma Bridge runtime ${packageJson.version}.\n`);
process.stdout.write(`Configured MCP clients: ${configured.length ? configured.join(", ") : "none found"}.\n`);
process.stdout.write(`Figma manifest: ${path.join(root, "figma-plugin", "manifest.json")}\n`);
process.stdout.write("Open a new AI task or session after installing or changing MCP tools; restarting the app is not required, except for Claude Desktop.\n");
if (relayMode) {
  process.stdout.write("Sign in once per client: run `codex mcp login figma-bridge` for Codex, and use /mcp in Claude Code. Approve each connection in the Figma Bridge plugin under Relay -> Connect AI app.\n");
}

function installRuntime() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") fs.chmodSync(stateDir, 0o700);
  fs.rmSync(developmentLink, { force: true });
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  copyTree(path.join(root, "companion"), path.join(runtime, "companion"));
  copyTree(path.join(root, "node_modules", "ws"), path.join(runtime, "node_modules", "ws"));
  copyTree(path.join(root, "plugins", "figma-bridge", "mcp"), path.join(runtime, "plugins", "figma-bridge", "mcp"));
  fs.rmSync(path.join(runtime, "plugin"), { recursive: true, force: true });
  fs.writeFileSync(path.join(runtime, "package.json"), `${JSON.stringify({ name: "figma-bridge-runtime", private: true, type: "module", version: packageJson.version }, null, 2)}\n`, { mode: 0o600 });
  fs.copyFileSync(path.join(root, "runtime", "runtime-bootstrap.mjs"), stableBootstrap);
  if (platform !== "win32") fs.chmodSync(stableBootstrap, 0o600);
  writePrivateJson(path.join(runtimeRoot, "current.json"), { schemaVersion: 1, version: packageJson.version, runtimeRoot: runtime });
}

async function installLaunchAgent() {
  const plistPath = launchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  run("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], false);
  waitForUnloaded();
  await stopCompanion();
  fs.writeFileSync(plistPath, launchAgentPlist({ nodePath, bootstrap: stableBootstrap, stateDir }), { mode: 0o600 });
  run("launchctl", ["bootstrap", domain, plistPath]);
  run("launchctl", ["kickstart", "-k", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  await waitForCompanion();
}

async function installWindowsStartup() {
  const directory = windowsStartupDirectory(process.env);
  fs.mkdirSync(directory, { recursive: true });
  // Windows Script Host reads UTF-16LE with a BOM regardless of the ANSI code page.
  const script = windowsStartupScript({ nodePath, bootstrap: stableBootstrap });
  fs.writeFileSync(path.join(directory, WINDOWS_STARTUP_FILE), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, "utf16le")]));
  await restartDetachedCompanion();
}

async function restartDetachedCompanion() {
  await stopCompanion();
  launchCompanion({ command: nodePath, args: [stableBootstrap, "companion"] }, process.env);
  await waitForCompanion();
}

async function stopCompanion() {
  if (!await reachable("bridge.shutdown")) return;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!await reachable("bridge.status")) return;
    await delay(100);
  }
  throw new Error("The running Figma Bridge companion did not stop");
}

function agentClients() {
  const client = (name, skipped) => !skipped && findExecutable(name) ? { path: name, run: toolRunner } : null;
  return {
    codex: client("codex", flags.has("--no-codex")),
    claude: client("claude", flags.has("--no-claude") || flags.has("--no-claude-code"))
  };
}

async function toolRunner(command, args) {
  const result = runTool(command, args, { check: false });
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`), {
      stderr: result.stderr,
      stdout: result.stdout
    });
  }
  return { stdout: result.stdout };
}

// Claude Desktop is configured whenever it is installed. Its config file only
// launches local servers, so relay mode points to the Connectors settings.
function installClaudeDesktop() {
  const configPath = claudeDesktopConfigPath({ platform });
  if (!configPath || !fs.existsSync(path.dirname(configPath))) return false;
  if (relayMode) {
    process.stdout.write(`Claude Desktop and claude.ai: add ${relayMcpUrl} under Settings -> Connectors -> Add custom connector.\n`);
    return false;
  }
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const updated = updateClaudeDesktopConfig(existing, { command: nodePath, args: [stableBootstrap, "mcp"] });
  if (existing !== updated) {
    if (existing) fs.copyFileSync(configPath, `${configPath}.figma-bridge-backup`);
    fs.writeFileSync(configPath, updated);
    process.stdout.write(`Updated ${configPath}. Quit and reopen Claude Desktop to load Figma Bridge.\n`);
  }
  return true;
}

async function uninstall() {
  if (launchdAllowed && fs.existsSync(launchAgentPath())) {
    run("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], false);
    fs.rmSync(launchAgentPath(), { force: true });
  }
  if (platform === "win32") fs.rmSync(path.join(windowsStartupDirectory(process.env), WINDOWS_STARTUP_FILE), { force: true });
  try { await stopCompanion(); } catch (error) { process.stderr.write(`${error.message}\n`); }
  const clients = agentClients();
  await uninstallFromClients({ locations: marketplace, codex: clients.codex, claude: clients.claude });
  fs.rmSync(legacyClaudeMarketplace, { recursive: true, force: true });
  const desktopConfig = claudeDesktopConfigPath({ platform });
  if (desktopConfig && fs.existsSync(desktopConfig)) {
    const existing = fs.readFileSync(desktopConfig, "utf8");
    const updated = updateClaudeDesktopConfig(existing, null);
    if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(JSON.parse(updated))) {
      fs.copyFileSync(desktopConfig, `${desktopConfig}.figma-bridge-backup`);
      fs.writeFileSync(desktopConfig, updated);
    }
  }
  process.stdout.write("Figma Bridge autostart and client registrations were removed. Pairing state and versioned runtimes were preserved.\n");
}

function relayMcpConfig() {
  return { mcpServers: { "figma-bridge": { type: "http", url: relayMcpUrl } } };
}

function repositoryRelayUrl() {
  const configured = process.env.FIGMA_BRIDGE_RELAY_MCP_URL;
  const url = configured || JSON.parse(fs.readFileSync(path.join(root, "plugins", "figma-bridge", ".mcp.json"), "utf8")).mcpServers?.["figma-bridge"]?.url;
  if (typeof url !== "string" || !/^https:\/\/[^/]+\/mcp$/.test(url)) throw new Error("Set FIGMA_BRIDGE_RELAY_MCP_URL to https://<relay-host>/mcp");
  return url;
}

// Absolute paths only: Claude Code ignores cwd, and GUI clients may lack node on PATH.
function localMcpConfig() {
  return { mcpServers: { "figma-bridge": { command: nodePath, args: [stableBootstrap, "mcp"] } } };
}


function copyTree(source, destination, { exclude = [] } = {}) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: item => {
      const relative = path.relative(source, item);
      if (!relative) return true;
      const segments = relative.split(path.sep);
      return !segments.includes("test") && !exclude.includes(segments[0]);
    }
  });
}

function requireFile(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing. ${hint}`);
}

function run(command, args, check = true) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (check && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  return result;
}

async function reachable(method) {
  try {
    await requestControl(method, {}, { timeoutMs: 1500 });
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitForUnloaded() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (run("launchctl", ["print", `${domain}/${LAUNCH_AGENT_LABEL}`], false).status !== 0) return;
    sleepSync(100);
  }
  throw new Error(`launchd job did not unload: ${LAUNCH_AGENT_LABEL}`);
}

async function waitForCompanion() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await reachable("bridge.status")) return;
    await delay(100);
  }
  throw new Error(`Figma Bridge companion did not start; see ${path.join(stateDir, "companion.log")}`);
}
