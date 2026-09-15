import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { requestControl } from "../../plugins/figma-bridge/mcp/control.mjs";
import { createFigmaHub } from "../src/hub.mjs";
import { isMainModule, pairingDialogCommand, startBridgeServer } from "../src/server.mjs";

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

  const status = await requestControl("bridge.status", { ignored: true }, { env });
  assert.equal(status.clients.length, 1);
  assert.equal(status.clients[0].fileName, "Bridge Test");
  assert.equal(JSON.stringify(status).includes(server.token), false);

  const response = await requestControl("figma.call", {
    command: "document.snapshot",
    arguments: { depth: 1 }
  }, { env });
  assert.deepEqual(response, { command: "document.snapshot", arguments: { depth: 1 } });

  // The largest PNG the plugin allows (8 MiB) arrives base64-encoded inside JSON.
  const largest = "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4);
  websocket.removeAllListeners("message");
  websocket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === "rpc.request") websocket.send(JSON.stringify({ type: "rpc.response", id: message.id, ok: true, result: { data: largest } }));
  });
  const exported = await requestControl("figma.call", { command: "nodes.exportPng", arguments: {} }, { env });
  assert.equal(exported.data.length, largest.length);
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

test("Figma plugin can pair after local approval", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-pair-"));
  const port = await freePort();
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory };
  const approvals = [];
  const server = await startBridgeServer({
    env,
    port,
    logger: { info() {} },
    approvePairing(request) {
      approvals.push(request);
      return true;
    }
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const websocket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: "null" });
  t.after(() => websocket.close());
  const received = [];
  websocket.on("message", raw => received.push(JSON.parse(raw.toString())));
  await once(websocket, "open");
  websocket.send(JSON.stringify({
    type: "pair",
    client: { id: "paired:file", fileName: "Paired", pageName: "Home", editorType: "figma" }
  }));
  await waitUntil(() => received.some(message => message.type === "auth.ok"));

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].origin, "null");
  assert.equal(received.find(message => message.type === "pair.ok").token, server.token);
  const status = await requestControl("bridge.status", {}, { env });
  assert.equal(status.clients[0].fileName, "Paired");
  assert.equal(JSON.stringify(status).includes(server.token), false);
});

test("automatic pairing rejects ordinary web origins without prompting", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-pair-origin-"));
  const port = await freePort();
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory };
  let approvalCalls = 0;
  const server = await startBridgeServer({
    env,
    port,
    logger: { info() {} },
    approvePairing() {
      approvalCalls += 1;
      return true;
    }
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const websocket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: "https://example.com" });
  await once(websocket, "open");
  websocket.send(JSON.stringify({ type: "pair", client: { id: "bad-origin" } }));
  const [code] = await once(websocket, "close");
  assert.equal(code, 4403);
  assert.equal(approvalCalls, 0);
});

test("a second companion cannot take over the running control endpoint", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-single-"));
  const port = await freePort();
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory };
  const server = await startBridgeServer({ env, port, logger: { info() {} } });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(startBridgeServer({ env, port, logger: { info() {} } }), error => error.code === "EADDRINUSE");
  const status = await requestControl("bridge.status", {}, { env });
  assert.equal(status.pid, process.pid);
  assert.equal(status.runtime.source, process.env.FIGMA_BRIDGE_ACTIVE_SOURCE || "direct");
});

test("figma calls wait briefly for a plugin that is still reconnecting", async () => {
  const hub = createFigmaHub({ rpcTimeoutMs: 1000 });
  const sent = [];
  const websocket = { OPEN: 1, readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  const pending = hub.request(undefined, "document.pages", {}, { waitForClientMs: 1000 });
  setTimeout(() => {
    const clientId = hub.register(websocket, { id: "file-a:0:1", fileName: "A" });
    setTimeout(() => hub.handleMessage(clientId, websocket, { type: "rpc.response", id: sent[0].id, ok: true, result: ["page"] }), 5);
  }, 20);
  assert.deepEqual(await pending, ["page"]);
  await assert.rejects(createFigmaHub().request(undefined, "document.pages", {}), /No Figma plugin is connected/);
});

test("Windows pairing uses a system-modal PowerShell popup with a timeout", () => {
  const dialog = pairingDialogCommand("win32", { SystemRoot: "D:\\Windows" });
  assert.equal(dialog.command, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const encoded = dialog.args[dialog.args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /\$shell\.Popup\('Figma Bridge wants to connect/);
  assert.match(script, /, 30, 'Figma Bridge', 4129\)/);
  assert.equal(dialog.approved(0, "1"), true);
  assert.equal(dialog.approved(0, "2"), false);
  assert.equal(dialog.approved(0, "-1"), false);
  assert.equal(pairingDialogCommand("linux"), null);
  assert.equal(pairingDialogCommand("darwin").command, "/usr/bin/osascript");
});

test("main-module detection survives symlinks, spaces, and non-ASCII paths", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma bridge Тест-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const realDirectory = path.join(directory, "real dir");
  await mkdir(realDirectory);
  const file = path.join(realDirectory, "server.mjs");
  await writeFile(file, "export {};\n");
  const link = path.join(directory, "linked.mjs");
  await symlink(file, link);
  assert.equal(isMainModule(pathToFileURL(file).href, link), true);
  assert.equal(isMainModule(pathToFileURL(file).href, path.join(directory, "other.mjs")), false);
  assert.equal(isMainModule(pathToFileURL(file).href, undefined), false);
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
