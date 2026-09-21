import os from "node:os";
import path from "node:path";
import process from "node:process";
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

export const DEV_LINK_SCHEMA_VERSION = 1;
export const DEV_LINK_FILE = "dev-link.json";

const CHECKOUT_ENTRYPOINTS = Object.freeze({
  mcp: "plugins/figma-bridge/mcp/server.mjs",
  companion: "companion/src/server.mjs"
});
const BUNDLED_ENTRYPOINTS = Object.freeze({
  mcp: "plugins/figma-bridge/mcp/server.mjs",
  companion: "companion/src/server.mjs"
});
const currentFile = fileURLToPath(import.meta.url);

if (isEntrypoint(process.argv[1])) {
  try {
    await launch(process.argv[2]);
  } catch (error) {
    console.error(`Figma Bridge runtime bootstrap: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

export async function launch(kind, options = {}) {
  const resolved = await resolveRuntime(kind, options);
  process.argv.splice(2, 1);
  process.env.FIGMA_BRIDGE_BOOTSTRAP = currentFile;
  process.env.FIGMA_BRIDGE_ACTIVE_SOURCE = resolved.source;
  process.env.FIGMA_BRIDGE_ACTIVE_ENTRYPOINT = resolved.entrypoint;
  if (resolved.checkoutRoot) process.env.FIGMA_BRIDGE_ACTIVE_CHECKOUT = resolved.checkoutRoot;
  else delete process.env.FIGMA_BRIDGE_ACTIVE_CHECKOUT;
  process.chdir(resolved.cwd);
  process.argv[1] = resolved.entrypoint;
  await import(pathToFileURL(resolved.entrypoint).href);
}

export async function resolveRuntime(kind, options = {}) {
  if (!CHECKOUT_ENTRYPOINTS[kind]) {
    throw new Error(`Unknown runtime kind ${JSON.stringify(kind)}; expected mcp or companion`);
  }
  const stateDir = path.resolve(
    options.stateDir || process.env.FIGMA_BRIDGE_STATE_DIR || path.join(os.homedir(), ".figma-bridge")
  );
  const pointerPath = path.join(stateDir, DEV_LINK_FILE);
  const platform = options.platform || process.platform;
  const pointer = await readPrivateJson(pointerPath, { optional: true, label: "development pointer", platform });
  if (pointer) {
    if (pointer.schemaVersion !== DEV_LINK_SCHEMA_VERSION) {
      throw new Error(`Unsupported development pointer schema: ${String(pointer.schemaVersion)}`);
    }
    const checkoutRoot = await validateCheckout(pointer.checkoutRoot, { platform });
    const entrypoint = await resolveContainedFile(checkoutRoot, CHECKOUT_ENTRYPOINTS[kind]);
    return {
      source: "checkout",
      kind,
      pointerPath,
      checkoutRoot,
      entrypoint,
      cwd: kind === "mcp" ? path.join(checkoutRoot, "plugins", "figma-bridge") : checkoutRoot
    };
  }

  const currentPath = path.join(stateDir, "runtime", "current.json");
  const current = await readPrivateJson(currentPath, { label: "runtime pointer", platform });
  if (current.schemaVersion !== 1 || typeof current.runtimeRoot !== "string") {
    throw new Error(`Invalid runtime pointer: ${currentPath}`);
  }
  const runtimeRoot = await validateRuntimeRoot(stateDir, current.runtimeRoot);
  const entrypoint = await resolveContainedFile(runtimeRoot, BUNDLED_ENTRYPOINTS[kind]);
  return {
    source: "bundled",
    kind,
    pointerPath,
    checkoutRoot: null,
    runtimeRoot,
    entrypoint,
    cwd: kind === "mcp" ? path.join(runtimeRoot, "plugins", "figma-bridge") : runtimeRoot
  };
}

export async function validateCheckout(checkoutRoot, options = {}) {
  if (typeof checkoutRoot !== "string" || !path.isAbsolute(checkoutRoot)) {
    throw new Error("Development pointer checkoutRoot must be an absolute path");
  }
  const requested = path.resolve(checkoutRoot);
  const canonical = await realpath(requested).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`Linked checkout no longer exists: ${requested}`);
    throw error;
  });
  if (options.requireCanonical !== false && canonical !== requested) {
    throw new Error(`Linked checkout is not canonical: ${requested} resolves to ${canonical}`);
  }
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Linked checkout must be a real directory: ${canonical}`);
  // Windows reports synthetic POSIX modes; profile ACLs protect checkouts there.
  if (usesPosixPermissions(options.platform)) {
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`Linked checkout is not owned by the current user: ${canonical}`);
    if ((metadata.mode & 0o022) !== 0) throw new Error(`Linked checkout must not be group- or world-writable: ${canonical}`);
  }
  const packageJson = JSON.parse(await readFile(await resolveContainedFile(canonical, "package.json"), "utf8"));
  if (packageJson.name !== "figma-bridge") throw new Error(`Linked checkout is not Figma Bridge: ${canonical}`);
  for (const entrypoint of Object.values(CHECKOUT_ENTRYPOINTS)) await resolveContainedFile(canonical, entrypoint);
  return canonical;
}

async function validateRuntimeRoot(stateDir, requestedRoot) {
  const requested = path.resolve(requestedRoot);
  const runtimeParent = await realpath(path.join(stateDir, "runtime"));
  const canonical = await realpath(requested);
  if (!canonical.startsWith(`${runtimeParent}${path.sep}`)) {
    throw new Error(`Bundled runtime escapes its state directory: ${requested}`);
  }
  return canonical;
}

async function readPrivateJson(filePath, { optional = false, label, platform } = {}) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new Error(`Missing ${label || "private JSON"}: ${filePath}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label || "Private JSON"} must be a regular file: ${filePath}`);
  if (usesPosixPermissions(platform)) {
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`${label || "Private JSON"} is not owned by the current user: ${filePath}`);
    if ((metadata.mode & 0o077) !== 0) throw new Error(`${label || "Private JSON"} permissions must be 0600: ${filePath}`);
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label || "Private JSON"} is invalid JSON: ${errorMessage(error)}`);
  }
}

async function resolveContainedFile(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  const canonical = await realpath(candidate).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`Missing ${relativePath}: ${root}`);
    throw error;
  });
  if (canonical !== candidate || !canonical.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes its root: ${relativePath}`);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Entrypoint must be a regular file: ${canonical}`);
  return canonical;
}

// Module URLs are canonical while argv keeps symlinks, 8.3 names, or drive-letter case.
function isEntrypoint(entry) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(currentFile);
  } catch {
    return false;
  }
}

export function usesPosixPermissions(platform = process.platform) {
  return platform !== "win32";
}

function errorMessage(error) {
  return String(error?.message || error);
}
