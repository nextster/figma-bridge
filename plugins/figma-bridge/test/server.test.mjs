import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createControlServer, ensureState } from "../mcp/control.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");

test("MCP exposes bounded Figma tools and forwards calls", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-mcp-"));
  const socketPath = path.join(directory, "control.sock");
  const requests = [];
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory, FIGMA_BRIDGE_SOCKET: socketPath, FIGMA_BRIDGE_AUTOSTART: "0" };
  const state = ensureState(env);
  const control = createControlServer({
    secret: state.controlSecret,
    async dispatch(method, params) {
      requests.push({ method, params });
      if (method === "bridge.status") return { version: "0.1.0", clients: [] };
      if (method === "clients.list") return [{ id: "file:page", fileName: "Test" }];
      if (params.command === "handoff.prepareSwiftUI") {
        return { file: { name: "Test" }, assets: [{ key: "screen:1:2", kind: "screen-png" }], _assetRequests: [{ key: "screen:1:2", kind: "screen-png", nodeId: "1:2", name: "Screen" }] };
      }
      if (params.command === "handoff.exportAsset") return { data: "aGVsbG8=", mimeType: "image/png", extension: "png", bytes: 5 };
      if (params.command === "nodes.exportPng") return { node: { id: "1:2", type: "FRAME" }, mimeType: "image/png", data: "aGVsbG8=" };
      return { forwarded: params };
    }
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(socketPath, resolve);
  });

  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    child.kill();
    control.close();
    await rm(directory, { recursive: true, force: true });
  });
  const responses = [];
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  write(child, 1, "initialize", { protocolVersion: "2025-06-18" });
  write(child, 2, "tools/list", {});
  write(child, 3, "tools/call", { name: "status", arguments: {} });
  write(child, 4, "tools/call", { name: "list_pages", arguments: { clientId: "file:page" } });
  write(child, 5, "tools/call", { name: "set_current_page", arguments: { clientId: "file:page", pageId: "5:5056" } });
  write(child, 6, "tools/call", { name: "snapshot", arguments: { clientId: "file:page", depth: 1 } });
  write(child, 7, "tools/call", { name: "export_png", arguments: { nodeId: "1:2" } });
  write(child, 8, "tools/call", { name: "document_overview", arguments: { clientId: "file:page", maxComponents: 25 } });
  write(child, 9, "tools/call", { name: "search_text", arguments: { clientId: "file:page", query: "Hello" } });
  write(child, 10, "tools/call", { name: "set_auto_layout", arguments: { clientId: "file:page", nodeId: "1:2", direction: "VERTICAL", gap: 8 } });
  write(child, 11, "tools/call", { name: "upsert_design_tokens", arguments: { clientId: "file:page", colors: [{ name: "Background", light: { r: 1, g: 1, b: 1 }, dark: { r: 0, g: 0, b: 0 } }] } });
  write(child, 12, "tools/call", { name: "batch", arguments: { clientId: "file:page", dryRun: true, operations: [{ kind: "applyAutoLayout", args: { nodeId: "1:2", gap: 8 } }] } });
  write(child, 13, "tools/call", { name: "list_design_tokens", arguments: { clientId: "file:page", collectionName: "Tokens" } });
  write(child, 14, "tools/call", { name: "delete_design_tokens", arguments: { clientId: "file:page", collectionIds: ["VariableCollectionId:1:2"] } });
  write(child, 15, "tools/call", { name: "list_shaders", arguments: { clientId: "file:page", type: "fill" } });
  write(child, 16, "tools/call", { name: "apply_shader", arguments: { clientId: "file:page", nodeIds: ["1:2"], shaderId: "shader:glass", properties: { Frost: 0.4 } } });
  write(child, 17, "tools/call", { name: "prepare_swiftui_handoff", arguments: { clientId: "file:page", screenIds: ["1:2"], outputDirectory: directory } });
  await waitUntil(() => responses.length === 17);

  const byId = id => responses.find(response => response.id === id);
  const tools = byId(2).result.tools;
  assert.equal(tools.length, 36);
  assert.equal(tools.find(tool => tool.name === "delete_nodes").annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === "snapshot").annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "update_nodes").annotations.idempotentHint, true);
  assert.equal(tools.find(tool => tool.name === "set_current_page").annotations.idempotentHint, true);
  assert.equal(tools.find(tool => tool.name === "document_overview").annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "replace_text").inputSchema.properties.dryRun.type, "boolean");
  assert.equal(tools.find(tool => tool.name === "batch").inputSchema.properties.operations.maxItems, 100);
  assert.equal(tools.find(tool => tool.name === "prepare_swiftui_handoff").inputSchema.properties.screenIds.maxItems, 20);
  assert.equal(tools.find(tool => tool.name === "run_script").inputSchema.properties.acknowledgeUseOnlyWhenNecessary.const, true);
  assert.equal(tools.find(tool => tool.name === "delete_design_tokens").annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === "list_shaders").annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "apply_shader").inputSchema.properties.properties.maxProperties, 64);
  assert.match(byId(3).result.content[0].text, /0.1.0/);
  assert.equal(byId(7).result.content[1].type, "image");
  assert.deepEqual(requests.find(request => request.params?.command === "document.pages").params, {
    clientId: "file:page",
    command: "document.pages",
    arguments: {}
  });
  assert.deepEqual(requests.find(request => request.params?.command === "document.setCurrentPage").params, {
    clientId: "file:page",
    command: "document.setCurrentPage",
    arguments: { pageId: "5:5056" }
  });
  assert.deepEqual(requests.find(request => request.params?.command === "document.snapshot").params, {
    clientId: "file:page",
    command: "document.snapshot",
    arguments: { depth: 1 }
  });
  assert.deepEqual(requests.find(request => request.params?.command === "document.overview").params.arguments, { maxComponents: 25 });
  assert.deepEqual(requests.find(request => request.params?.command === "document.searchReplaceText").params.arguments, { query: "Hello", dryRun: true });
  assert.deepEqual(requests.find(request => request.params?.command === "nodes.autoLayout").params.arguments, { nodeId: "1:2", direction: "VERTICAL", gap: 8 });
  assert.equal(requests.find(request => request.params?.command === "designTokens.upsert").params.arguments.colors[0].name, "Background");
  assert.equal(requests.find(request => request.params?.command === "batch.execute").params.arguments.dryRun, true);
  assert.deepEqual(requests.find(request => request.params?.command === "designTokens.inspect").params.arguments, { collectionName: "Tokens" });
  assert.deepEqual(requests.find(request => request.params?.command === "designTokens.delete").params.arguments, { collectionIds: ["VariableCollectionId:1:2"] });
  assert.deepEqual(requests.find(request => request.params?.command === "shaders.list").params.arguments, { type: "fill" });
  assert.deepEqual(requests.find(request => request.params?.command === "shaders.apply").params.arguments, { nodeIds: ["1:2"], shaderId: "shader:glass", properties: { Frost: 0.4 } });
  const handoff = JSON.parse(byId(17).result.content[0].text);
  assert.equal(handoff.assets[0].export.path, path.join(directory, "Screen.png"));
  assert.equal(handoff.manifestPath, path.join(directory, "handoff.json"));
});

function write(child, id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for MCP responses");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
