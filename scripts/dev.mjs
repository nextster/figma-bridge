import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchCompanion } from "../plugins/figma-bridge/mcp/autostart.mjs";
import { requestControl, stateDirectory } from "../plugins/figma-bridge/mcp/control.mjs";
import { DEV_LINK_FILE, DEV_LINK_SCHEMA_VERSION, resolveRuntime, usesPosixPermissions, validateCheckout } from "../runtime/runtime-bootstrap.mjs";
import { LAUNCH_AGENT_LABEL, findExecutable, launchAgentPath, runTool, stableNodePath, writePrivateJson } from "./lib/platform.mjs";
import { marketplaceLocations } from "./lib/agent-marketplace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "status";
const stateDir = stateDirectory(process.env);
const pointerPath = path.join(stateDir, DEV_LINK_FILE);
const stableBootstrap = path.join(stateDir, "runtime", "runtime-bootstrap.mjs");
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;

if (command === "link") {
  const checkoutRoot = await validateCheckout(root, { requireCanonical: false });
  if (!clientsReady() || !fs.existsSync(stableBootstrap)) {
    run(process.execPath, [path.join(root, "scripts", "setup.mjs")]);
    if (!clientsReady()) throw new Error("setup completed but no MCP client uses the stable bootstrap");
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (usesPosixPermissions()) fs.chmodSync(stateDir, 0o700);
  const before = pointerStatus();
  writePrivateJson(pointerPath, { schemaVersion: DEV_LINK_SCHEMA_VERSION, checkoutRoot });
  await restartCompanion();
  const status = await developmentStatus();
  process.stdout.write(`${JSON.stringify({ linked: true, idempotent: before.valid && before.checkoutRoot === checkoutRoot, ...status }, null, 2)}\n`);
} else if (command === "unlink") {
  const removed = removePointer();
  await restartCompanion();
  const status = await developmentStatus();
  process.stdout.write(`${JSON.stringify({ unlinked: true, removed, ...status }, null, 2)}\n`);
} else if (command === "status") {
  process.stdout.write(`${JSON.stringify(await developmentStatus(), null, 2)}\n`);
} else {
  throw new Error(`unknown dev command: ${command}`);
}

async function developmentStatus() {
  const git = run("git", ["-C", root, "status", "--short", "--branch"], false).stdout.trim();
  const devLink = pointerStatus();
  const codex = codexStatus();
  const claude = claudeStatus();
  let mcp;
  let companion;
  try { mcp = await resolveRuntime("mcp", { stateDir }); } catch (error) { mcp = { source: "invalid", error: error.message }; }
  try { companion = await resolveRuntime("companion", { stateDir }); } catch (error) { companion = { source: "invalid", error: error.message }; }
  let bridge;
  try { bridge = await requestControl("bridge.status"); } catch (error) { bridge = { error: error.message }; }
  const mismatches = [];
  if (codex.available && !codex.bootstrapReady) mismatches.push("Codex MCP configuration does not use the stable bootstrap");
  if (claude.available && !claude.bootstrapReady) mismatches.push("Claude Code plugin does not use the stable bootstrap");
  if (!codex.bootstrapReady && !claude.bootstrapReady) mismatches.push("No MCP client uses the stable bootstrap; run npm run setup");
  if (devLink.present && !devLink.valid) mismatches.push(devLink.error);
  if (devLink.valid && devLink.checkoutRoot !== root) mismatches.push(`development pointer targets ${devLink.checkoutRoot}`);
  if (mcp.source === "invalid") mismatches.push(mcp.error);
  if (companion.source === "invalid") mismatches.push(companion.error);
  if (bridge.error) mismatches.push(`companion is not reachable: ${bridge.error}`);
  else if (bridge.runtime?.source !== compactRuntime(companion).source) mismatches.push(`companion runs ${bridge.runtime?.source || "unknown"} code; expected ${companion.source}`);
  return {
    mode: devLink.valid ? "checkout" : devLink.present ? "invalid" : "bundled",
    root,
    git,
    stateDir,
    devLink,
    codex,
    claude,
    effective: { mcp: compactRuntime(mcp), companion: compactRuntime(companion) },
    bridge,
    mismatches,
    healthy: mismatches.length === 0
  };
}

function clientsReady() {
  return codexStatus().bootstrapReady || claudeStatus().bootstrapReady;
}

function codexStatus() {
  if (!findExecutable("codex")) return { available: false, installed: false, bootstrapReady: false };
  const result = runTool("codex", ["mcp", "get", "figma-bridge", "--json"], { check: false });
  const config = parseJson(result.stdout);
  const args = config.transport?.args || [];
  return {
    available: true,
    installed: result.status === 0,
    configuredCwd: config.transport?.cwd || null,
    command: config.transport?.command || null,
    args,
    bootstrapReady: path.resolve(String(args[0] || "")) === stableBootstrap && args[1] === "mcp"
  };
}

function claudeStatus() {
  if (!findExecutable("claude")) return { available: false, bootstrapReady: false };
  const configPath = path.join(marketplaceLocations({ env: process.env }).root, "plugins", "figma-bridge", ".mcp.json");
  const config = fs.existsSync(configPath) ? parseJson(fs.readFileSync(configPath, "utf8")) : {};
  const args = config.mcpServers?.["figma-bridge"]?.args || [];
  return {
    available: true,
    configPath,
    args,
    bootstrapReady: path.resolve(String(args[0] || "")) === stableBootstrap && args[1] === "mcp"
  };
}

function pointerStatus() {
  if (!fs.existsSync(pointerPath)) return { present: false, valid: false, pointerPath, checkoutRoot: null };
  try {
    const metadata = fs.lstatSync(pointerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`development pointer must be a regular file: ${pointerPath}`);
    if (usesPosixPermissions()) {
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`development pointer has a different owner: ${pointerPath}`);
      if ((metadata.mode & 0o077) !== 0) throw new Error(`development pointer permissions must be 0600: ${pointerPath}`);
    }
    const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    if (pointer.schemaVersion !== DEV_LINK_SCHEMA_VERSION || typeof pointer.checkoutRoot !== "string") throw new Error("development pointer has an invalid schema");
    return { present: true, valid: true, pointerPath, checkoutRoot: pointer.checkoutRoot };
  } catch (error) {
    return { present: true, valid: false, pointerPath, checkoutRoot: null, error: error.message };
  }
}

function removePointer() {
  if (!fs.existsSync(pointerPath)) return false;
  const metadata = fs.lstatSync(pointerPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`refusing to remove non-regular development pointer: ${pointerPath}`);
  if (usesPosixPermissions() && typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`refusing to remove development pointer owned by another user: ${pointerPath}`);
  fs.unlinkSync(pointerPath);
  return true;
}

async function restartCompanion() {
  // Stop whichever companion owns the port, including one started on demand
  // by an MCP client, so the replacement loads the newly selected runtime.
  if (await reachable("bridge.shutdown")) {
    const stopDeadline = Date.now() + 5000;
    while (await reachable("bridge.status")) {
      if (Date.now() > stopDeadline) throw new Error("The running Figma Bridge companion did not stop");
      await delay(100);
    }
  }
  if (process.platform === "darwin" && path.resolve(os.homedir()) === path.resolve(os.userInfo().homedir) && fs.existsSync(launchAgentPath())) {
    const result = run("launchctl", ["kickstart", "-k", `${domain}/${LAUNCH_AGENT_LABEL}`], false);
    if (result.status !== 0) throw new Error(`Figma Bridge LaunchAgent is unavailable; run npm run setup: ${result.stderr || result.stdout}`);
  } else {
    launchCompanion({ command: stableNodePath(process.execPath), args: [stableBootstrap, "companion"] }, process.env);
  }
  await waitForCompanion();
}

async function waitForCompanion() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await reachable("bridge.status")) return;
    await delay(100);
  }
  throw new Error(`Figma Bridge companion did not start; see ${path.join(stateDir, "companion.log")}`);
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

function compactRuntime(value) {
  return {
    source: value.source,
    entrypoint: value.entrypoint || null,
    checkoutRoot: value.checkoutRoot || null,
    runtimeRoot: value.runtimeRoot || null,
    error: value.error || null
  };
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

function run(program, args, check = true) {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (check && result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}
