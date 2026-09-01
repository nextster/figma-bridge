import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requestControl } from "../companion/src/client.mjs";
import { DEV_LINK_FILE, DEV_LINK_SCHEMA_VERSION, resolveRuntime, validateCheckout } from "../runtime/runtime-bootstrap.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "status";
const stateDir = path.join(os.homedir(), ".figma-bridge");
const pointerPath = path.join(stateDir, DEV_LINK_FILE);
const stableBootstrap = path.join(stateDir, "runtime", "runtime-bootstrap.mjs");
const label = "dev.nextster.figma-bridge";
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;

if (command === "link") {
  const checkoutRoot = await validateCheckout(root, { requireCanonical: false });
  let codex = codexStatus();
  if (!codex.bootstrapReady || !fs.existsSync(stableBootstrap)) {
    run(process.execPath, [path.join(root, "scripts", "setup.mjs")]);
    codex = codexStatus();
    if (!codex.bootstrapReady) throw new Error("setup completed but Codex still does not use the stable bootstrap");
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
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
  let mcp;
  let companion;
  try { mcp = await resolveRuntime("mcp", { stateDir }); } catch (error) { mcp = { source: "invalid", error: error.message }; }
  try { companion = await resolveRuntime("companion", { stateDir }); } catch (error) { companion = { source: "invalid", error: error.message }; }
  let bridge;
  try { bridge = await requestControl("bridge.status"); } catch (error) { bridge = { error: error.message }; }
  const mismatches = [];
  if (!codex.bootstrapReady) mismatches.push("Codex MCP configuration does not use the stable bootstrap");
  if (devLink.present && !devLink.valid) mismatches.push(devLink.error);
  if (devLink.valid && devLink.checkoutRoot !== root) mismatches.push(`development pointer targets ${devLink.checkoutRoot}`);
  if (mcp.source === "invalid") mismatches.push(mcp.error);
  if (companion.source === "invalid") mismatches.push(companion.error);
  if (bridge.error) mismatches.push(`companion is not reachable: ${bridge.error}`);
  return {
    mode: devLink.valid ? "checkout" : devLink.present ? "invalid" : "bundled",
    root,
    git,
    stateDir,
    devLink,
    codex,
    effective: { mcp: compactRuntime(mcp), companion: compactRuntime(companion) },
    bridge,
    mismatches,
    healthy: mismatches.length === 0
  };
}

function codexStatus() {
  const result = run("codex", ["mcp", "get", "figma-bridge", "--json"], false);
  const config = parseJson(result.stdout);
  const args = config.transport?.args || [];
  return {
    installed: result.status === 0,
    configuredCwd: config.transport?.cwd || null,
    command: config.transport?.command || null,
    args,
    bootstrapReady: path.resolve(String(args[0] || "")) === stableBootstrap && args[1] === "mcp"
  };
}

function pointerStatus() {
  if (!fs.existsSync(pointerPath)) return { present: false, valid: false, pointerPath, checkoutRoot: null };
  try {
    const metadata = fs.lstatSync(pointerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`development pointer must be a regular file: ${pointerPath}`);
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`development pointer has a different owner: ${pointerPath}`);
    if ((metadata.mode & 0o077) !== 0) throw new Error(`development pointer permissions must be 0600: ${pointerPath}`);
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
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`refusing to remove development pointer owned by another user: ${pointerPath}`);
  fs.unlinkSync(pointerPath);
  return true;
}

function writePrivateJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

async function restartCompanion() {
  const result = run("launchctl", ["kickstart", "-k", `${domain}/${label}`], false);
  if (result.status !== 0) throw new Error(`Figma Bridge LaunchAgent is unavailable; run npm run setup: ${result.stderr || result.stdout}`);
  await waitForSocket();
}

async function waitForSocket() {
  const deadline = Date.now() + 5000;
  const socket = path.join(stateDir, "control.sock");
  while (Date.now() < deadline) {
    if (fs.existsSync(socket)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Figma Bridge control socket did not appear: ${socket}`);
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
