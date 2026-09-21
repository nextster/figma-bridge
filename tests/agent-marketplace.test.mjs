import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import {
  detachCodexMarketplace,
  installForClients,
  marketplaceLocations,
  migrateLegacyMarketplace,
  registerClaudeCode,
  registerCodex,
  restoreCodexMarketplace,
  uninstallFromClients
} from "../scripts/lib/agent-marketplace.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpConfig = { mcpServers: { "figma-bridge": { command: "node", args: ["/runtime/runtime-bootstrap.mjs", "mcp"] } } };

test("the shared marketplace defaults to ~/.agent-plugins/nextster", () => {
  assert.deepEqual(marketplaceLocations({ env: {}, homedir: "/home/example" }), {
    root: "/home/example/.agent-plugins/nextster",
    legacyRoot: "/home/example/.codex/marketplaces/nextster"
  });
  assert.deepEqual(marketplaceLocations({ env: { NEXTSTER_MARKETPLACE_DIR: "/opt/market", CODEX_HOME: "/opt/codex" }, homedir: "/home/example" }), {
    root: "/opt/market",
    legacyRoot: "/opt/codex/marketplaces/nextster"
  });
});

test("a legacy marketplace moves to the shared root when the root is new", async t => {
  const { shared, legacy } = await roots(t);
  await writeManifest(legacy, [{ name: "figma-bridge" }, { name: "telegram-bridge" }]);
  await writePlugin(legacy, "telegram-bridge", "legacy");

  const result = await migrateLegacyMarketplace({ root: shared, legacyRoot: legacy });
  assert.equal(result.moved, true);
  await assert.rejects(access(legacy));
  await assert.rejects(access(path.dirname(legacy)));
  assert.equal(await readFile(path.join(shared, "plugins", "telegram-bridge", "marker.txt"), "utf8"), "legacy");
});

test("a reappearing legacy root merges newer sibling plugins without touching shared root files", async t => {
  const { shared, legacy } = await roots(t);
  await writeManifest(shared, [{ name: "chromium-bridge" }, { name: "telegram-bridge", version: "old" }]);
  await writePlugin(shared, "chromium-bridge", "shared");
  await writePlugin(shared, "telegram-bridge", "stale");
  await mkdir(path.join(shared, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(shared, ".claude-plugin", "marketplace.json"), "{\"name\":\"nextster\",\"plugins\":[{\"name\":\"chromium-bridge\"}]}\n");
  await writeFile(path.join(shared, "README.md"), "chromium readme\n");
  await writeManifest(legacy, [{ name: "figma-bridge", version: "legacy" }, { name: "telegram-bridge", version: "new" }, { name: "../escape" }]);
  await writePlugin(legacy, "telegram-bridge", "fresh");
  await mkdir(path.join(legacy, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(legacy, ".claude-plugin", "marketplace.json"), "{}\n");
  await writeFile(path.join(legacy, "README.md"), "legacy readme\n");

  const result = await migrateLegacyMarketplace({ root: shared, legacyRoot: legacy });
  assert.deepEqual(result.imported, ["telegram-bridge"]);
  await assert.rejects(access(legacy));
  assert.equal(await readFile(path.join(shared, "plugins", "telegram-bridge", "marker.txt"), "utf8"), "fresh");
  assert.equal(await readFile(path.join(shared, "plugins", "chromium-bridge", "marker.txt"), "utf8"), "shared");
  assert.equal(await readFile(path.join(shared, "README.md"), "utf8"), "chromium readme\n");
  assert.match(await readFile(path.join(shared, ".claude-plugin", "marketplace.json"), "utf8"), /chromium-bridge/);
  assert.deepEqual((await manifest(shared)).plugins.map(item => [item.name, item.version]), [["chromium-bridge", undefined], ["telegram-bridge", "new"]]);
});

test("a symlinked legacy root is left alone", async t => {
  const { base, shared, legacy } = await roots(t);
  const target = path.join(base, "elsewhere");
  await writeManifest(target, [{ name: "telegram-bridge" }]);
  await mkdir(path.dirname(legacy), { recursive: true });
  await symlink(target, legacy);
  assert.deepEqual(await migrateLegacyMarketplace({ root: shared, legacyRoot: legacy }), { migrated: false, reason: "legacy path is a symlink" });
});

test("Codex detaches legacy or manifest-less registrations and refuses unrelated roots", async t => {
  const { base, shared, legacy } = await roots(t);
  await mkdir(legacy, { recursive: true });

  const legacyCodex = fakeCodex({ marketplaces: [{ name: "nextster", root: legacy }] });
  assert.deepEqual(await detachCodexMarketplace({ root: shared, legacyRoot: legacy, run: legacyCodex.run }), { detachedFrom: legacy, recovered: false });
  assert.deepEqual(legacyCodex.state.marketplaces, []);

  const empty = path.join(base, "empty-root");
  await mkdir(empty);
  const emptyCodex = fakeCodex({ marketplaces: [{ name: "nextster", root: empty }] });
  assert.deepEqual(await detachCodexMarketplace({ root: shared, legacyRoot: legacy, run: emptyCodex.run }), { detachedFrom: empty, recovered: false });

  const brokenCodex = fakeCodex({ marketplaces: [{ name: "nextster", root: path.join(base, "gone") }], brokenRegistry: true });
  assert.deepEqual(await detachCodexMarketplace({ root: shared, legacyRoot: legacy, run: brokenCodex.run }), { detachedFrom: null, recovered: true });

  const unrelated = path.join(base, "unrelated");
  await writeManifest(unrelated, [{ name: "other" }]);
  const unrelatedCodex = fakeCodex({ marketplaces: [{ name: "nextster", root: unrelated }] });
  await assert.rejects(detachCodexMarketplace({ root: shared, legacyRoot: legacy, run: unrelatedCodex.run }), /already points to/);
  assert.deepEqual(unrelatedCodex.state.marketplaces.map(item => item.root), [unrelated]);

  const failingCodex = fakeCodex({ failList: "network unavailable" });
  await assert.rejects(detachCodexMarketplace({ root: shared, legacyRoot: legacy, run: failingCodex.run }), /network unavailable/);
});

test("Codex registration compares roots by realpath and reinstalls the plugin", async t => {
  const { base, shared } = await roots(t);
  await writeManifest(shared, []);
  const alias = path.join(base, "alias");
  await symlink(shared, alias);
  const codex = fakeCodex({ marketplaces: [{ name: "nextster", root: alias }], installed: ["figma-bridge@nextster"] });
  await registerCodex({ root: shared, run: codex.run });
  assert.equal(codex.calls.some(call => call.startsWith("plugin marketplace add")), false);
  assert.deepEqual(codex.calls.slice(-2), ["plugin remove figma-bridge@nextster --json", "plugin add figma-bridge@nextster --json"]);
  assert.deepEqual(codex.state.installed, ["figma-bridge@nextster"]);
});

test("setup moves the legacy marketplace, installs the plugin, and re-registers Codex", async t => {
  const { shared, legacy } = await roots(t);
  await writeManifest(legacy, [{ name: "figma-bridge" }, { name: "telegram-bridge" }]);
  await writePlugin(legacy, "telegram-bridge", "legacy");
  const codex = fakeCodex({ marketplaces: [{ name: "nextster", root: legacy }], installed: ["figma-bridge@nextster", "telegram-bridge@nextster"] });

  const result = await installForClients({ projectDir, mcpConfig, locations: { root: shared, legacyRoot: legacy }, codex: { path: "codex", run: codex.run } });
  assert.equal(result.migration.moved, true);
  assert.deepEqual(codex.state.marketplaces.map(item => item.root), [shared]);
  assert.deepEqual(codex.state.installed.sort(), ["figma-bridge@nextster", "telegram-bridge@nextster"]);
  assert.deepEqual((await manifest(shared)).plugins.map(item => item.name), ["telegram-bridge", "figma-bridge"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(shared, "plugins", "figma-bridge", ".mcp.json"), "utf8")), mcpConfig);
  // One plugin directory serves both clients.
  await access(path.join(shared, "plugins", "figma-bridge", ".claude-plugin", "plugin.json"));
  await access(path.join(shared, "plugins", "figma-bridge", ".codex-plugin", "plugin.json"));
  await assert.rejects(access(path.join(shared, "plugins", "figma-bridge", "test")));
  await assert.rejects(access(path.join(shared, "plugins", "figma-bridge", "mcp")));
  const claudeManifest = JSON.parse(await readFile(path.join(shared, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(claudeManifest.name, "nextster");
  assert.deepEqual(claudeManifest.plugins.map(item => [item.name, item.source]), [["figma-bridge", "./plugins/figma-bridge"]]);
  assert.match(await readFile(path.join(shared, "README.md"), "utf8"), /Nextster agent plugins/);
  assert.equal(await readFile(path.join(shared, "plugins", "telegram-bridge", "marker.txt"), "utf8"), "legacy");
});

test("setup keeps an existing shared root's README and other bridges' Claude entries", async t => {
  const { shared, legacy } = await roots(t);
  await writeManifest(shared, [{ name: "chromium-bridge" }]);
  await writePlugin(shared, "chromium-bridge", "shared");
  await mkdir(path.join(shared, ".claude-plugin"), { recursive: true });
  const claudeManifest = "{\"name\":\"nextster\",\"plugins\":[{\"name\":\"chromium-bridge\"}]}\n";
  await writeFile(path.join(shared, ".claude-plugin", "marketplace.json"), claudeManifest);
  await writeFile(path.join(shared, "README.md"), "chromium readme\n");
  const codex = fakeCodex({ marketplaces: [{ name: "nextster", root: shared }], installed: ["chromium-bridge@nextster"] });

  await installForClients({ projectDir, mcpConfig, locations: { root: shared, legacyRoot: legacy }, codex: { path: "codex", run: codex.run } });
  assert.equal(await readFile(path.join(shared, "README.md"), "utf8"), "chromium readme\n");
  const mergedClaude = JSON.parse(await readFile(path.join(shared, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.deepEqual(mergedClaude.plugins.map(item => item.name), ["chromium-bridge", "figma-bridge"]);
  assert.equal(JSON.stringify(mergedClaude.plugins[0]), JSON.stringify(JSON.parse(claudeManifest).plugins[0]));
  assert.deepEqual((await manifest(shared)).plugins.map(item => item.name), ["chromium-bridge", "figma-bridge"]);
  assert.equal(codex.calls.includes("plugin marketplace remove nextster --json"), false);
  assert.deepEqual(codex.state.installed.sort(), ["chromium-bridge@nextster", "figma-bridge@nextster"]);
});

test("a failed plugin install after detaching restores the Codex registration", async t => {
  const { shared, legacy } = await roots(t);
  await writeManifest(legacy, [{ name: "telegram-bridge" }]);
  const codex = fakeCodex({ marketplaces: [{ name: "nextster", root: legacy }], failAdd: "figma-bridge@nextster" });

  await assert.rejects(installForClients({ projectDir, mcpConfig, locations: { root: shared, legacyRoot: legacy }, codex: { path: "codex", run: codex.run } }), /figma-bridge@nextster failed/);
  assert.deepEqual(codex.state.marketplaces.map(item => item.root), [shared]);

  const { shared: movedShared, legacy: movedLegacy } = await roots(t);
  await writeManifest(movedLegacy, [{ name: "telegram-bridge" }]);
  const interrupted = fakeCodex({ marketplaces: [{ name: "nextster", root: movedLegacy }], installed: ["telegram-bridge@nextster"] });
  await assert.rejects(installForClients({ projectDir: path.join(movedShared, "no-project"), mcpConfig, locations: { root: movedShared, legacyRoot: movedLegacy }, codex: { path: "codex", run: interrupted.run } }));
  assert.deepEqual(interrupted.state.marketplaces.map(item => item.root), [movedShared]);
  assert.deepEqual(interrupted.state.installed, ["telegram-bridge@nextster"]);

  const restoreOnly = fakeCodex({ marketplaces: [] });
  assert.equal((await restoreCodexMarketplace({ root: path.join(shared, "missing"), legacyRoot: shared, run: restoreOnly.run })).root, shared);
  assert.deepEqual(restoreOnly.state.marketplaces.map(item => item.root), [shared]);
});

test("Claude Code registers the shared marketplace, drops the old private one, and keeps siblings after a move", async t => {
  const { shared } = await roots(t);
  const claude = fakeClaude({ marketplaces: [{ name: "nextster", source: "directory", path: "/old/shared" }, { name: "figma-bridge-local", source: "directory", path: "/home/.figma-bridge/claude-marketplace" }], installed: [{ id: "chromium-bridge@nextster", scope: "user" }, { id: "figma-bridge@figma-bridge-local", scope: "user" }, { id: "figma-bridge@nextster", scope: "project" }] });
  const result = await registerClaudeCode({ root: shared, run: claude.run });
  assert.equal(result.repointedFrom, "/old/shared");
  assert.deepEqual(claude.state.marketplaces.map(item => [item.name, item.path]), [["nextster", shared]]);
  assert.deepEqual(claude.state.installed.map(item => item.id).sort(), ["chromium-bridge@nextster", "figma-bridge@nextster", "figma-bridge@nextster"]);

  const refresh = fakeClaude({ marketplaces: [{ name: "nextster", source: "directory", path: shared }], installed: [{ id: "figma-bridge@nextster", scope: "user" }] });
  await registerClaudeCode({ root: shared, run: refresh.run });
  assert.ok(refresh.calls.includes("plugin marketplace update nextster"));
  assert.deepEqual(refresh.calls.slice(-2), ["plugin uninstall figma-bridge@nextster --scope user", "plugin install figma-bridge@nextster --scope user"]);

  const github = fakeClaude({ marketplaces: [{ name: "nextster", source: "github", path: "nextster/figma-bridge" }] });
  await assert.rejects(registerClaudeCode({ root: shared, run: github.run }), /already uses github source/);
});

test("uninstall removes only this plugin and releases empty registrations", async t => {
  const { shared, legacy } = await roots(t);
  const codex = fakeCodex({ marketplaces: [], installed: [] });
  const claude = fakeClaude({ marketplaces: [], installed: [] });
  await installForClients({ projectDir, mcpConfig, locations: { root: shared, legacyRoot: legacy }, codex: { path: "codex", run: codex.run }, claude: { path: "claude", run: claude.run } });
  assert.deepEqual(claude.state.installed.map(item => item.id), ["figma-bridge@nextster"]);

  const result = await uninstallFromClients({ locations: { root: shared, legacyRoot: legacy }, codex: { path: "codex", run: codex.run }, claude: { path: "claude", run: claude.run } });
  assert.equal(result.removal.empty, true);
  await assert.rejects(access(shared));
  assert.deepEqual(codex.state.marketplaces, []);
  assert.deepEqual(claude.state.marketplaces, []);
  assert.deepEqual(codex.state.installed, []);
  assert.deepEqual(claude.state.installed, []);
});

async function roots(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "figma-bridge-market-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, shared: path.join(base, "agent-plugins", "nextster"), legacy: path.join(base, "codex", "marketplaces", "nextster") };
}

async function writeManifest(root, plugins) {
  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
  await writeFile(path.join(root, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({ name: "nextster", interface: { displayName: "Nextster" }, plugins })}\n`);
}

async function writePlugin(root, name, marker) {
  await mkdir(path.join(root, "plugins", name), { recursive: true });
  await writeFile(path.join(root, "plugins", name, "marker.txt"), marker);
}

async function manifest(root) {
  return JSON.parse(await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
}

// A stateful stand-in for the Claude Code CLI's plugin commands.
function fakeClaude({ marketplaces = [], installed = [] } = {}) {
  const state = { marketplaces: [...marketplaces], installed: [...installed] };
  const calls = [];
  const fail = message => { throw Object.assign(new Error(message), { stderr: message }); };
  async function run(command, args) {
    assert.equal(command, "claude");
    const line = args.join(" ");
    calls.push(line);
    if (line === "plugin marketplace list --json") return { stdout: JSON.stringify(state.marketplaces) };
    if (line === "plugin list --json") return { stdout: JSON.stringify(state.installed) };
    if (args[1] === "marketplace" && args[2] === "update") {
      if (!state.marketplaces.some(item => item.name === args[3])) fail(`marketplace ${args[3]} not found`);
      return { stdout: "" };
    }
    if (args[1] === "marketplace" && args[2] === "remove") {
      if (!state.marketplaces.some(item => item.name === args[3])) fail(`marketplace ${args[3]} not found`);
      state.marketplaces = state.marketplaces.filter(item => item.name !== args[3]);
      state.installed = state.installed.filter(item => !item.id.endsWith(`@${args[3]}`) || item.scope !== "user");
      return { stdout: "" };
    }
    if (args[1] === "marketplace" && args[2] === "add") {
      state.marketplaces.push({ name: "nextster", source: "directory", path: args[3] });
      return { stdout: "" };
    }
    if (args[1] === "uninstall") {
      const before = state.installed.length;
      state.installed = state.installed.filter(item => !(item.id === args[2] && (item.scope || "user") === "user"));
      if (before === state.installed.length) fail(`plugin ${args[2]} is not installed`);
      return { stdout: "" };
    }
    if (args[1] === "install") {
      const marketplace = args[2].split("@")[1];
      if (!state.marketplaces.some(item => item.name === marketplace)) fail(`marketplace ${marketplace} not found`);
      state.installed.push({ id: args[2], scope: "user" });
      return { stdout: "" };
    }
    fail(`unexpected claude command: ${line}`);
  }
  return { run, state, calls };
}

// A stateful stand-in for the Codex CLI's marketplace and plugin registry.
function fakeCodex({ marketplaces = [], installed = [], brokenRegistry = false, failList = null, failAdd = null } = {}) {
  const state = { marketplaces: [...marketplaces], installed: [...installed], broken: brokenRegistry };
  const calls = [];
  const fail = message => { throw Object.assign(new Error(message), { stderr: message }); };
  async function run(command, args) {
    assert.equal(command, "codex");
    const line = args.join(" ");
    calls.push(line);
    if (line === "plugin marketplace list --json") {
      if (failList) fail(failList);
      if (state.broken) fail(`failed to load marketplace(s):\n- \`nextster\` at ${state.marketplaces[0]?.root}: marketplace root does not contain a supported manifest`);
      return { stdout: JSON.stringify({ marketplaces: state.marketplaces }) };
    }
    if (line === "plugin marketplace remove nextster --json") {
      state.marketplaces = state.marketplaces.filter(item => item.name !== "nextster");
      state.broken = false;
      return { stdout: "{}" };
    }
    if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
      if (state.marketplaces.some(item => item.name === "nextster")) fail("marketplace nextster already exists");
      state.marketplaces.push({ name: "nextster", root: args[3] });
      return { stdout: "{}" };
    }
    if (args[0] === "plugin" && args[1] === "remove") {
      const before = state.installed.length;
      state.installed = state.installed.filter(id => id !== args[2]);
      if (before === state.installed.length) fail(`plugin ${args[2]} is not installed`);
      return { stdout: "{}" };
    }
    if (args[0] === "plugin" && args[1] === "add") {
      if (args[2] === failAdd) fail(`codex plugin add ${args[2]} failed`);
      if (!state.marketplaces.some(item => item.name === "nextster")) fail("marketplace nextster is not configured");
      state.installed.push(args[2]);
      return { stdout: JSON.stringify({ installed: true }) };
    }
    fail(`unexpected codex command: ${line}`);
  }
  return { run, state, calls };
}
