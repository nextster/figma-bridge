import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("marketplace points to the canonical repository plugin", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
  assert.equal(marketplace.name, "nextster");
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.source.path), ["./plugins/figma-bridge"]);
});

test("Figma plugin network access is limited to the companion and the relay", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "figma-plugin/manifest.json"), "utf8"));
  const build = fs.readFileSync(path.join(root, "figma-plugin/scripts/build.mjs"), "utf8");
  const relayUrl = /DEFAULT_RELAY_URL = "([^"]+)"/.exec(build)[1];
  assert.deepEqual(manifest.networkAccess.allowedDomains, [new URL(relayUrl).origin.replace(/^https?:/, "wss:")]);
  // Figma rejects numeric loopback URLs here; the companion still binds loopback addresses only.
  assert.deepEqual(manifest.networkAccess.devAllowedDomains, ["ws://localhost:3847", "ws://localhost:8787"]);
  assert.match(manifest.networkAccess.reasoning, /relay/);
});

test("plugin UI script compiles and renders relay data as text", () => {
  const html = fs.readFileSync(path.join(root, "figma-plugin/src/ui.html"), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
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
