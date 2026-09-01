import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("marketplace points to the canonical repository plugin", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "figma-bridge-repo");
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.source.path), ["./plugins/figma-bridge"]);
});

test("Figma plugin network access is loopback-only", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "figma-plugin/manifest.json"), "utf8"));
  assert.deepEqual(manifest.networkAccess.allowedDomains, ["http://127.0.0.1:3847"]);
});

test("repository contains no arbitrary evaluation command", () => {
  const files = [
    "companion/src/server.mjs",
    "figma-plugin/src/code.ts",
    "plugins/figma-bridge/mcp/server.mjs"
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /\beval\s*\(|new Function\s*\(/);
  }
});
