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
  // Codex and Claude Code see the same marketplace name and plugin directory.
  const claude = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(claude.name, "nextster");
  assert.deepEqual(claude.plugins.map(plugin => plugin.source), ["./plugins/figma-bridge"]);
  const codexPlugin = JSON.parse(fs.readFileSync(path.join(root, "plugins/figma-bridge/.codex-plugin/plugin.json"), "utf8"));
  const claudePlugin = JSON.parse(fs.readFileSync(path.join(root, "plugins/figma-bridge/.claude-plugin/plugin.json"), "utf8"));
  assert.equal(claudePlugin.name, codexPlugin.name);
  assert.equal(claudePlugin.version, codexPlugin.version);
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

test("plugin UI scripts compile and render relay data as text", () => {
  const html = fs.readFileSync(path.join(root, "figma-plugin/src/ui.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0], "/*__FIGMA_BRIDGE_AUTH__*/");
  for (const script of [...scripts, fs.readFileSync(path.join(root, "figma-plugin/src/bridge-auth.js"), "utf8")]) {
    assert.doesNotThrow(() => new vm.Script(script));
    assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  }
});

test("plugin and companion compute identical authentication proofs", async () => {
  const source = fs.readFileSync(path.join(root, "figma-plugin/src/bridge-auth.js"), "utf8");
  const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder, btoa });
  vm.runInContext(`${source}\nglobalThis.auth = FigmaBridgeAuth;`, context);
  const { proof } = await import("../companion/src/plugin-auth.mjs");
  const token = "t".repeat(43);
  const nonce = context.auth.nonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(await context.auth.proof(token, "auth/client", "server-nonce-0123456789", nonce), proof(token, "auth/client", "server-nonce-0123456789", nonce));
  assert.equal(await context.auth.proof("123456", "pair/server", "s-nonce-0123456789", nonce, token), proof("123456", "pair/server", "s-nonce-0123456789", nonce, token));
  assert.equal(context.auth.equal("abc", "abc"), true);
  assert.equal(context.auth.equal("abc", "abd"), false);
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

test("website install button opens agent apps with a short installation request", async () => {
  const html = fs.readFileSync(path.join(root, "docs/site/install-button.html"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const buttons = ["codex", "claude-desktop", "claude-code", "copy"].map(target => {
    const listeners = {};
    return { dataset: { target }, addEventListener: (type, fn) => { listeners[type] = fn; }, click: () => listeners.click() };
  });
  const clipboard = [];
  const note = { hidden: true, textContent: "" };
  const fallback = { hidden: true, textContent: "" };
  const rootElement = {
    dataset: { repository: "nextster/figma-bridge" },
    querySelector: selector => (selector === "pre" ? fallback : note),
    querySelectorAll: () => buttons
  };
  const location = { href: "" };
  const context = vm.createContext({
    document: { currentScript: { closest: () => rootElement }, hasFocus: () => false },
    navigator: { platform: "Win32", userAgent: "Windows", clipboard: { writeText: async text => { clipboard.push(text); } } },
    window: { location },
    setTimeout: () => {}
  });
  vm.runInContext(script, context);
  await buttons[0].click();
  const prompt = decodeURIComponent(location.href.replace("codex://threads/new?prompt=", ""));
  assert.match(location.href, /^codex:\/\/threads\/new\?prompt=/);
  assert.ok(prompt.length < 1000, `prompt has ${prompt.length} characters`);
  assert.match(prompt, /irm https:\/\/raw\.githubusercontent\.com\/nextster\/figma-bridge\/main\/install\.ps1 \| iex/);
  assert.match(prompt, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/nextster\/figma-bridge\/main\/install\.sh \| sh/);
  await buttons[1].click();
  assert.match(location.href, /^claude:\/\/code\/new\?q=/);
  await buttons[2].click();
  assert.match(location.href, /^claude-cli:\/\/open\?q=/);
  await buttons[3].click();
  assert.equal(clipboard.at(-1), "irm https://raw.githubusercontent.com/nextster/figma-bridge/main/install.ps1 | iex");
  assert.equal(fallback.hidden, false);
});
