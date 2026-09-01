import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(pluginRoot, "mcp", "server.mjs");

test("MCP exposes bounded Figma tools and forwards calls", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-mcp-"));
  const socketPath = path.join(directory, "control.sock");
  const requests = [];
  const control = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      const result = request.method === "bridge.status"
        ? { version: "0.1.0", clients: [] }
        : request.method === "clients.list"
          ? [{ id: "file:page", fileName: "Test" }]
          : request.params.command === "nodes.exportPng"
            ? { node: { id: "1:2", type: "FRAME" }, mimeType: "image/png", data: "aGVsbG8=" }
            : { forwarded: request.params };
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(socketPath, resolve);
  });

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, FIGMA_BRIDGE_SOCKET: socketPath },
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
  write(child, 4, "tools/call", { name: "snapshot", arguments: { clientId: "file:page", depth: 1 } });
  write(child, 5, "tools/call", { name: "export_png", arguments: { nodeId: "1:2" } });
  await waitUntil(() => responses.length === 5);

  const byId = id => responses.find(response => response.id === id);
  const tools = byId(2).result.tools;
  assert.equal(tools.length, 10);
  assert.equal(tools.find(tool => tool.name === "delete_nodes").annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === "snapshot").annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "update_nodes").annotations.idempotentHint, true);
  assert.match(byId(3).result.content[0].text, /0.1.0/);
  assert.equal(byId(5).result.content[1].type, "image");
  assert.deepEqual(requests.at(-2).params, {
    clientId: "file:page",
    command: "document.snapshot",
    arguments: { depth: 1 }
  });
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
