// Codex registration through the Nextster marketplace shared by all bridge
// installers. Adapted from Chromium Bridge's scripts/agent-clients.mjs so both
// installers migrate and register the shared root the same way.

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";

export const MARKETPLACE_NAME = "nextster";
export const PLUGIN_NAME = "figma-bridge";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

const CODEX_MANIFEST = [".agents", "plugins", "marketplace.json"];
const OBSOLETE_CODEX_REGISTRATIONS = [
  ["plugin", "remove", "figma-bridge@figma-bridge-repo", "--json"],
  ["plugin", "marketplace", "remove", "figma-bridge-repo", "--json"]
];
const TRANSIENT_WINDOWS_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const README = `# Nextster agent plugins

This directory is a local plugin marketplace named \`${MARKETPLACE_NAME}\`. It is shared by
Codex and Claude Code and is managed by the installers of Nextster bridges such as
Chromium Bridge, Figma Bridge, and Telegram Bridge.

- \`.agents/plugins/marketplace.json\` is the Codex marketplace manifest.
- \`.claude-plugin/marketplace.json\` is the Claude Code marketplace manifest.
- \`plugins/<name>/\` holds each installed plugin.

Rerun a bridge installer to update its plugin, or its uninstaller to remove it. Manual
edits are overwritten on the next installation.
`;

// A neutral location shared by every Nextster bridge and by both agent clients.
// Earlier releases kept a Codex-only copy under CODEX_HOME/marketplaces.
export function marketplaceLocations({ env = process.env, homedir = os.homedir() } = {}) {
  return {
    root: path.resolve(env.NEXTSTER_MARKETPLACE_DIR || path.join(homedir, ".agent-plugins", MARKETPLACE_NAME)),
    legacyRoot: path.resolve(path.join(env.CODEX_HOME || path.join(homedir, ".codex"), "marketplaces", MARKETPLACE_NAME))
  };
}

/**
 * Detaches Codex from the legacy root before it moves, migrates it, installs
 * this plugin, and registers the shared root. A failure after detaching
 * restores whichever root still has a manifest so sibling plugins keep working.
 */
export async function installCodexPlugin({ projectDir, mcpConfig, locations, codexPath = "codex", run }) {
  const { root, legacyRoot } = locations;
  const detached = await detachCodexMarketplace({ codexPath, root, legacyRoot, run });
  try {
    const migration = await migrateLegacyMarketplace({ root, legacyRoot });
    const installed = await installSharedPlugin({ root, projectDir, mcpConfig });
    const registration = await registerCodex({ codexPath, root, run });
    return { root, detached, migration, pluginPath: installed.pluginPath, registration };
  } catch (error) {
    await restoreCodexMarketplace({ codexPath, root, legacyRoot, run });
    throw error;
  }
}

export async function migrateLegacyMarketplace({ root, legacyRoot }) {
  if (samePath(root, legacyRoot) || !existsSync(legacyRoot)) return { migrated: false };
  if ((await lstat(legacyRoot)).isSymbolicLink()) return { migrated: false, reason: "legacy path is a symlink" };

  if (!existsSync(root)) {
    await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    await moveDirectory(legacyRoot, root);
    await removeEmptyDirectory(path.dirname(legacyRoot));
    return { migrated: true, moved: true, from: legacyRoot, to: root };
  }

  // A legacy root that reappears after migration was rewritten by a bridge
  // installer that still targets it, so its copies of other plugins are newer.
  // Root-level files such as README.md and .claude-plugin stay untouched.
  const legacyManifest = await readManifest(path.join(legacyRoot, ...CODEX_MANIFEST));
  const manifest = await readManifest(path.join(root, ...CODEX_MANIFEST));
  const imported = [];
  for (const entry of legacyManifest.plugins) {
    if (entry.name === PLUGIN_NAME || !isPluginName(entry.name)) continue;
    const source = path.join(legacyRoot, "plugins", entry.name);
    const destination = path.join(root, "plugins", entry.name);
    if (existsSync(source)) {
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await moveDirectory(source, destination);
    }
    manifest.plugins = [...manifest.plugins.filter(item => item.name !== entry.name), entry];
    imported.push(entry.name);
  }
  await writeJson(path.join(root, ...CODEX_MANIFEST), manifest);
  await rm(legacyRoot, { recursive: true, force: true });
  await removeEmptyDirectory(path.dirname(legacyRoot));
  return { migrated: true, merged: true, from: legacyRoot, to: root, imported };
}

export async function installSharedPlugin({ root, projectDir, mcpConfig }) {
  const pluginsDir = path.join(root, "plugins");
  const destination = path.join(pluginsDir, PLUGIN_NAME);
  const temporaryDir = path.join(pluginsDir, `.${PLUGIN_NAME}.tmp-${process.pid}`);
  const source = path.join(projectDir, "plugins", PLUGIN_NAME);
  await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
  await rm(temporaryDir, { recursive: true, force: true });
  await cp(source, temporaryDir, {
    recursive: true,
    filter: item => {
      const segments = path.relative(source, item).split(path.sep);
      return !segments.includes("test") && segments[0] !== ".claude-plugin";
    }
  });
  await writeJson(path.join(temporaryDir, ".mcp.json"), mcpConfig);
  await rm(destination, { recursive: true, force: true });
  await renameWithRetry(temporaryDir, destination);
  const readme = path.join(root, "README.md");
  if (!existsSync(readme)) await writeFile(readme, README, { mode: 0o600 });

  const sourceMarketplace = JSON.parse(await readFile(path.join(projectDir, ...CODEX_MANIFEST), "utf8"));
  const entry = sourceMarketplace.plugins?.find(item => item.name === PLUGIN_NAME);
  if (sourceMarketplace.name !== MARKETPLACE_NAME || !entry) throw new Error("Invalid Nextster marketplace source");
  const manifestPath = path.join(root, ...CODEX_MANIFEST);
  const manifest = await readManifest(manifestPath);
  manifest.interface = { ...(manifest.interface || {}), displayName: "Nextster" };
  manifest.plugins = [...manifest.plugins.filter(item => item.name !== PLUGIN_NAME), entry];
  await writeJson(manifestPath, manifest);
  return { root, pluginPath: destination };
}

// Codex fails every plugin command once a registered marketplace root loses its
// manifest, so the legacy registration is detached before its directory moves.
// Codex keeps installed plugin state by marketplace name, so re-adding the
// shared marketplace at its new root preserves sibling bridge plugins.
export async function detachCodexMarketplace({ codexPath = "codex", root, legacyRoot, run }) {
  let marketplaces;
  let recovered = false;
  try {
    marketplaces = await runJson(run, codexPath, ["plugin", "marketplace", "list", "--json"]);
  } catch (error) {
    // An interrupted migration can leave nextster registered at a root without
    // a manifest; other failures are not ours to repair.
    if (!String(error?.stderr || error?.message || error).includes(`\`${MARKETPLACE_NAME}\``)) throw error;
    await run(codexPath, ["plugin", "marketplace", "remove", MARKETPLACE_NAME, "--json"]);
    marketplaces = await runJson(run, codexPath, ["plugin", "marketplace", "list", "--json"]);
    recovered = true;
  }
  const existing = marketplaces.marketplaces?.find(item => item.name === MARKETPLACE_NAME);
  if (!existing || samePath(existing.root, root)) return { detachedFrom: null, recovered };
  if (!samePath(existing.root, legacyRoot) && existsSync(path.join(existing.root, ...CODEX_MANIFEST))) {
    throw new Error(`Codex marketplace ${MARKETPLACE_NAME} already points to ${existing.root}; expected ${root}`);
  }
  await run(codexPath, ["plugin", "marketplace", "remove", MARKETPLACE_NAME, "--json"]);
  return { detachedFrom: existing.root, recovered };
}

// Restores a Codex registration after setup fails between detach and re-add.
export async function restoreCodexMarketplace({ codexPath = "codex", root, legacyRoot, run }) {
  const target = [root, legacyRoot].find(candidate => existsSync(path.join(candidate, ...CODEX_MANIFEST)));
  if (!target) return { restored: false };
  return { restored: true, root: target, result: await runOptional(run, codexPath, ["plugin", "marketplace", "add", target, "--json"]) };
}

export async function registerCodex({ codexPath = "codex", root, run }) {
  const removedObsolete = [];
  for (const command of OBSOLETE_CODEX_REGISTRATIONS) removedObsolete.push(await runOptional(run, codexPath, command));
  const marketplaces = await runJson(run, codexPath, ["plugin", "marketplace", "list", "--json"]);
  const existing = marketplaces.marketplaces?.find(item => item.name === MARKETPLACE_NAME);
  if (existing && !samePath(existing.root, root)) {
    throw new Error(`Codex marketplace ${MARKETPLACE_NAME} already points to ${existing.root}; expected ${root}`);
  }
  if (!existing) await run(codexPath, ["plugin", "marketplace", "add", root, "--json"]);
  await runOptional(run, codexPath, ["plugin", "remove", PLUGIN_ID, "--json"]);
  const installed = await runJson(run, codexPath, ["plugin", "add", PLUGIN_ID, "--json"]);
  return { pluginId: PLUGIN_ID, marketplaceRoot: root, removedObsolete, installed };
}

export async function renameWithRetry(from, to, { platform = process.platform, attempts = 20, delayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      // Antivirus scanners and the search indexer briefly lock paths on Windows.
      if (platform !== "win32" || attempt >= attempts || !TRANSIENT_WINDOWS_ERRORS.has(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

export function samePath(left, right) {
  const canonical = value => {
    const resolved = path.resolve(String(value || ""));
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function runJson(run, command, args) {
  const { stdout } = await run(command, args);
  return JSON.parse(stdout);
}

async function runOptional(run, command, args) {
  try {
    const { stdout } = await run(command, args);
    return { command: args, ok: true, output: stdout };
  } catch (error) {
    return { command: args, ok: false, reason: String(error?.stderr || error?.message || error).trim() };
  }
}

async function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return { name: MARKETPLACE_NAME, interface: { displayName: "Nextster" }, plugins: [] };
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== MARKETPLACE_NAME || !Array.isArray(manifest.plugins)) {
    throw new Error(`Invalid shared marketplace at ${manifestPath}`);
  }
  return manifest;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await renameWithRetry(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function moveDirectory(source, destination) {
  try {
    await renameWithRetry(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true, preserveTimestamps: true });
    await rm(source, { recursive: true, force: true });
  }
}

async function removeEmptyDirectory(directory) {
  await rmdir(directory).catch(() => {});
}

// Manifest entries name directories; refuse anything that could escape plugins/.
function isPluginName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== "." && name !== "..";
}
