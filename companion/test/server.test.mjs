import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { WebSocket } from "ws";
import { requestControl } from "../src/client.mjs";
import { startBridgeServer } from "../src/server.mjs";

test("authenticated Figma client serves control RPC without exposing the token", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-"));
  const port = await freePort();
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory, FIGMA_BRIDGE_PORT: String(port) };
  const server = await startBridgeServer({ env, port, logger: { info() {} } });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const websocket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  t.after(() => websocket.close());
  const received = [];
  websocket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    if (message.type === "rpc.request") {
      websocket.send(JSON.stringify({
        type: "rpc.response",
        id: message.id,
        ok: true,
        result: { command: message.command, arguments: message.arguments }
      }));
    }
  });
  await once(websocket, "open");
  websocket.send(JSON.stringify({
    type: "auth",
    token: server.token,
    client: { id: "file:page", fileName: "Bridge Test", pageName: "Home", editorType: "figma" }
  }));
  await waitUntil(() => received.some(message => message.type === "auth.ok"));

  const status = await requestControl("bridge.status", { ignored: true }, { socketPath: server.socketPath });
  assert.equal(status.clients.length, 1);
  assert.equal(status.clients[0].fileName, "Bridge Test");
  assert.equal(JSON.stringify(status).includes(server.token), false);

  const response = await requestControl("figma.call", {
    command: "document.snapshot",
    arguments: { depth: 1 }
  }, { socketPath: server.socketPath });
  assert.deepEqual(response, { command: "document.snapshot", arguments: { depth: 1 } });
});

test("wrong pairing token is rejected", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-bad-auth-"));
  const port = await freePort();
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory };
  const server = await startBridgeServer({ env, port, logger: { info() {} } });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const websocket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await once(websocket, "open");
  websocket.send(JSON.stringify({ type: "auth", token: "wrong", client: { id: "bad" } }));
  const [code] = await once(websocket, "close");
  assert.equal(code, 4403);
});

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    emitter.once("error", reject);
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
