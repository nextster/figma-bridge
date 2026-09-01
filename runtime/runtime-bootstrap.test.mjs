import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEV_LINK_SCHEMA_VERSION, resolveRuntime } from "./runtime-bootstrap.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("stable bootstrap switches between bundled and checkout entrypoints", async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-bootstrap-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const runtimeRoot = path.join(stateDir, "runtime", "0.1.0");
  await mkdir(path.join(runtimeRoot, "plugin", "mcp"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "companion", "src"), { recursive: true });
  await writeFile(path.join(runtimeRoot, "plugin", "mcp", "server.mjs"), "export {};\n");
  await writeFile(path.join(runtimeRoot, "companion", "src", "server.mjs"), "export {};\n");
  await writePrivate(path.join(stateDir, "runtime", "current.json"), { schemaVersion: 1, runtimeRoot });

  const bundled = await resolveRuntime("mcp", { stateDir });
  assert.equal(bundled.source, "bundled");
  assert.equal(bundled.entrypoint, await realpath(path.join(runtimeRoot, "plugin", "mcp", "server.mjs")));

  await writePrivate(path.join(stateDir, "dev-link.json"), {
    schemaVersion: DEV_LINK_SCHEMA_VERSION,
    checkoutRoot: projectRoot
  });
  const checkout = await resolveRuntime("companion", { stateDir });
  assert.equal(checkout.source, "checkout");
  assert.equal(checkout.checkoutRoot, projectRoot);
  assert.equal(checkout.entrypoint, path.join(projectRoot, "companion", "src", "server.mjs"));
});

test("stable bootstrap rejects a development pointer with broad permissions", async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-bootstrap-mode-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const pointer = path.join(stateDir, "dev-link.json");
  await writeFile(pointer, `${JSON.stringify({ schemaVersion: 1, checkoutRoot: projectRoot })}\n`, { mode: 0o644 });
  await chmod(pointer, 0o644);
  await assert.rejects(resolveRuntime("mcp", { stateDir }), /permissions must be 0600/);
});

async function writePrivate(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}
