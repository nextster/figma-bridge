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
import { installCodexPlugin as installSharedCodexPlugin, marketplaceLocations } from "./lib/agent-marketplace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const platform = process.platform;
const stateDir = stateDirectory(process.env);
const runtimeRoot = path.join(stateDir, "runtime");
const runtime = path.join(runtimeRoot, packageJson.version);
const stableBootstrap = path.join(runtimeRoot, "runtime-bootstrap.mjs");
const developmentLink = path.join(stateDir, "dev-link.json");
const nodePath = stableNodePath(process.execPath);
const codexMarketplace = marketplaceLocations({ env: process.env });
const claudeMarketplace = path.join(stateDir, "claude-marketplace");
const CLAUDE_MARKETPLACE_NAME = "figma-bridge-local";
const CLAUDE_PLUGIN_ID = `figma-bridge@${CLAUDE_MARKETPLACE_NAME}`;
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const flags = new Set(process.argv.slice(2));
// launchd labels are per login session, not per HOME. Never touch the real
// LaunchAgent from a redirected HOME, such as an isolated test installation.
const launchdAllowed = platform === "darwin" && path.resolve(os.homedir()) === path.resolve(os.userInfo().homedir);

for (const flag of flags) {
  if (!["--uninstall", "--no-codex", "--no-claude", "--claude-desktop", "--no-autostart", "--relay"].includes(flag)) {
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

const configured = [];
if (!flags.has("--no-codex") && findExecutable("codex")) {
  await installCodexPlugin();
  configured.push("Codex");
}
if (!flags.has("--no-claude") && findExecutable("claude")) {
  installClaudeCodePlugin();
  configured.push("Claude Code");
}
if (flags.has("--claude-desktop") && relayMode) {
  process.stdout.write(`Claude Desktop and claude.ai: add ${relayMcpUrl} under Settings -> Connectors -> Add custom connector.\n`);
} else if (flags.has("--claude-desktop")) {
  installClaudeDesktop();
  configured.push("Claude Desktop");
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

async function installCodexPlugin() {
  const destination = path.join(codexMarketplace.root, "plugins", "figma-bridge");
  const result = await installSharedCodexPlugin({
    projectDir: root,
    mcpConfig: relayMode ? relayMcpConfig() : localMcpConfig({ cwd: destination }),
    locations: codexMarketplace,
    run: codexRunner
  });
  if (result.migration.migrated) process.stdout.write(`Moved the Nextster marketplace from ${result.migration.from} to ${result.migration.to}.\n`);
}

async function codexRunner(command, args) {
  const result = runTool(command, args, { check: false });
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`), {
      stderr: result.stderr,
      stdout: result.stdout
    });
  }
  return { stdout: result.stdout };
}

function installClaudeCodePlugin() {
  const pluginDestination = path.join(claudeMarketplace, "plugins", "figma-bridge");
  const temporary = path.join(stateDir, `.claude-marketplace.tmp-${process.pid}`);
  fs.rmSync(temporary, { recursive: true, force: true });
  copyTree(path.join(root, "plugins", "figma-bridge"), path.join(temporary, "plugins", "figma-bridge"), { exclude: [".codex-plugin", "mcp"] });
  const pluginManifest = claudePluginManifest();
  fs.mkdirSync(path.join(temporary, "plugins", "figma-bridge", ".claude-plugin"), { recursive: true });
  writePrivateJson(path.join(temporary, "plugins", "figma-bridge", ".claude-plugin", "plugin.json"), pluginManifest);
  writePrivateJson(path.join(temporary, "plugins", "figma-bridge", ".mcp.json"), relayMode ? relayMcpConfig() : localMcpConfig({ cwd: pluginDestination }));
  fs.mkdirSync(path.join(temporary, ".claude-plugin"), { recursive: true });
  writePrivateJson(path.join(temporary, ".claude-plugin", "marketplace.json"), {
    name: CLAUDE_MARKETPLACE_NAME,
    owner: { name: "Figma Bridge local setup" },
    plugins: [{
      name: "figma-bridge",
      source: "./plugins/figma-bridge",
      description: pluginManifest.description,
      version: pluginManifest.version
    }]
  });
  fs.rmSync(claudeMarketplace, { recursive: true, force: true });
  fs.renameSync(temporary, claudeMarketplace);

  const marketplaces = parseJson(runTool("claude", ["plugin", "marketplace", "list", "--json"]).stdout);
  const existing = Array.isArray(marketplaces) ? marketplaces.find(item => item.name === CLAUDE_MARKETPLACE_NAME) : null;
  if (existing) runTool("claude", ["plugin", "marketplace", "update", CLAUDE_MARKETPLACE_NAME]);
  else runTool("claude", ["plugin", "marketplace", "add", claudeMarketplace, "--scope", "user"]);
  const installed = parseJson(runTool("claude", ["plugin", "list", "--json"]).stdout);
  const present = Array.isArray(installed) && installed.some(item => item.id === CLAUDE_PLUGIN_ID || `${item.name}@${item.marketplace}` === CLAUDE_PLUGIN_ID);
  if (present) runTool("claude", ["plugin", "update", CLAUDE_PLUGIN_ID]);
  else runTool("claude", ["plugin", "install", CLAUDE_PLUGIN_ID, "--scope", "user"]);
}

function installClaudeDesktop() {
  const configPath = claudeDesktopConfigPath({ platform });
  if (!configPath) throw new Error("Claude Desktop is not available on this platform");
  if (!fs.existsSync(path.dirname(configPath))) throw new Error(`Claude Desktop configuration directory was not found: ${path.dirname(configPath)}`);
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const updated = updateClaudeDesktopConfig(existing, { command: nodePath, args: [stableBootstrap, "mcp"] });
  if (existing === updated) return;
  if (existing) fs.copyFileSync(configPath, `${configPath}.figma-bridge-backup-${Date.now()}`);
  fs.writeFileSync(configPath, updated);
  process.stdout.write(`Updated ${configPath}. Quit and reopen Claude Desktop to load Figma Bridge.\n`);
}

async function uninstall() {
  if (launchdAllowed && fs.existsSync(launchAgentPath())) {
    run("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], false);
    fs.rmSync(launchAgentPath(), { force: true });
  }
  if (platform === "win32") fs.rmSync(path.join(windowsStartupDirectory(process.env), WINDOWS_STARTUP_FILE), { force: true });
  try { await stopCompanion(); } catch (error) { process.stderr.write(`${error.message}\n`); }
  if (fs.existsSync(claudeMarketplace) && findExecutable("claude")) {
    runTool("claude", ["plugin", "uninstall", CLAUDE_PLUGIN_ID, "--scope", "user"], { check: false });
    runTool("claude", ["plugin", "marketplace", "remove", CLAUDE_MARKETPLACE_NAME], { check: false });
    fs.rmSync(claudeMarketplace, { recursive: true, force: true });
  }
  const desktopConfig = claudeDesktopConfigPath({ platform });
  if (desktopConfig && fs.existsSync(desktopConfig)) {
    const existing = fs.readFileSync(desktopConfig, "utf8");
    const updated = updateClaudeDesktopConfig(existing, null);
    if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(JSON.parse(updated))) {
      fs.copyFileSync(desktopConfig, `${desktopConfig}.figma-bridge-backup-${Date.now()}`);
      fs.writeFileSync(desktopConfig, updated);
    }
  }
  process.stdout.write("Figma Bridge autostart and Claude integrations were removed. Codex plugin entries, pairing state, and versioned runtimes were preserved.\n");
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

function localMcpConfig({ cwd }) {
  return { mcpServers: { "figma-bridge": { command: nodePath, args: [stableBootstrap, "mcp"], cwd } } };
}

function claudePluginManifest() {
  const codexManifest = JSON.parse(fs.readFileSync(path.join(root, "plugins", "figma-bridge", ".codex-plugin", "plugin.json"), "utf8"));
  const repositoryManifest = path.join(root, "plugins", "figma-bridge", ".claude-plugin", "plugin.json");
  const base = fs.existsSync(repositoryManifest) ? JSON.parse(fs.readFileSync(repositoryManifest, "utf8")) : {};
  return {
    ...base,
    name: "figma-bridge",
    version: packageJson.version,
    description: base.description || codexManifest.description,
    author: base.author || codexManifest.author,
    license: base.license || codexManifest.license,
    keywords: base.keywords || codexManifest.keywords
  };
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

function parseJson(value) {
  try { return JSON.parse(value); } catch { return {}; }
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
