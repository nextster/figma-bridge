import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { requestControl } from "../../plugins/figma-bridge/mcp/control.mjs";
import { createFigmaHub } from "../src/hub.mjs";
import { proof } from "../src/plugin-auth.mjs";
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
  await waitUntil(() => received.some(message => message.type === "hello"));
  const hello = received.find(message => message.type === "hello");
  assert.equal(JSON.stringify(hello).includes(server.token), false);
  // Commands sent before authentication would be ignored by the plugin; the companion sends none.
  assert.equal(received.some(message => message.type === "rpc.request"), false);
  websocket.send(JSON.stringify({
    type: "auth",
    nonce: "client-nonce-0123456789",
    proof: proof(server.token, "auth/client", hello.nonce, "client-nonce-0123456789"),
    client: { id: "file:page", fileName: "Bridge Test", pageName: "Home", editorType: "figma" }
  }));
  await waitUntil(() => received.some(message => message.type === "auth.ok"));
  // The companion proves it knows the token too, so a squatter cannot impersonate it.
  assert.equal(received.find(message => message.type === "auth.ok").proof, proof(server.token, "auth/server", hello.nonce, "client-nonce-0123456789"));

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

test("a wrong token proof and a replayed proof are rejected", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-bad-auth-"));
  const port = await freePort();
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory };
  const server = await startBridgeServer({ env, port, logger: { info() {} } });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const first = await connect(port);
  first.send(JSON.stringify({ type: "auth", nonce: "client-nonce-0123456789", proof: proof("wrong", "auth/client", first.hello.nonce, "client-nonce-0123456789") }));
  assert.equal((await once(first, "close"))[0], 4403);

  // A proof captured from one connection is useless on the next, which has a new nonce.
  const captured = proof(server.token, "auth/client", first.hello.nonce, "client-nonce-0123456789");
  const second = await connect(port);
  assert.notEqual(second.hello.nonce, first.hello.nonce);
  second.send(JSON.stringify({ type: "auth", nonce: "client-nonce-0123456789", proof: captured }));
  assert.equal((await once(second, "close"))[0], 4403);

  const legacy = await connect(port);
  legacy.send(JSON.stringify({ type: "auth", token: server.token }));
  assert.equal((await once(legacy, "close"))[0], 4403);
});

test("pairing reveals the token only to a plugin that enters the code shown on the computer", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-pair-"));
  const port = await freePort();
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory };
  const dialogs = [];
  let clock = 0;
  const server = await startBridgeServer({
    env,
    port,
    logger: { info() {}, error() {} },
    showPairingCode({ code, origin }) {
      let cancel;
      const cancelled = new Promise(resolve => { cancel = resolve; });
      const dialog = { code, origin, dismissed: false, cancel: () => cancel(true) };
      dialogs.push(dialog);
      return { cancelled, dismiss: () => { dialog.dismissed = true; } };
    }
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  // A wrong code ends the attempt without revealing the token.
  const guesser = await connect(port, "null");
  guesser.send(JSON.stringify({ type: "pair", client: { id: "guess" } }));
  assert.equal((await guesser.next("pair.code")).type, "pair.code");
  guesser.send(JSON.stringify({ type: "pair.proof", nonce: "client-nonce-0123456789", proof: proof("000000" === dialogs[0].code ? "111111" : "000000", "pair/client", guesser.hello.nonce, "client-nonce-0123456789") }));
  const [code, reason] = await once(guesser, "close");
  assert.equal(code, 4403);
  assert.equal(reason.toString(), "pairing failed");
  assert.equal(guesser.received.some(message => message.token), false);

  // Dialogs are rate limited, so a page cannot prompt in a loop.
  const tooSoon = await connect(port, "null");
  tooSoon.send(JSON.stringify({ type: "pair" }));
  assert.equal((await once(tooSoon, "close"))[0], 4403);
  await new Promise(resolve => setTimeout(resolve, 10_050));

  const plugin = await connect(port, "null");
  plugin.send(JSON.stringify({ type: "pair", client: { id: "paired:file", fileName: "Paired", pageName: "Home", editorType: "figma" } }));
  await plugin.next("pair.code");
  const dialog = dialogs.at(-1);
  assert.match(dialog.code, /^\d{6}$/);
  assert.equal(dialog.origin, "null");
  plugin.send(JSON.stringify({
    type: "pair.proof",
    nonce: "client-nonce-0123456789",
    proof: proof(dialog.code, "pair/client", plugin.hello.nonce, "client-nonce-0123456789"),
    client: { id: "paired:file", fileName: "Paired", pageName: "Home", editorType: "figma" }
  }));
  const paired = await plugin.next("pair.ok");
  assert.equal(paired.token, server.token);
  assert.equal(paired.proof, proof(dialog.code, "pair/server", plugin.hello.nonce, "client-nonce-0123456789", server.token));
  await plugin.next("auth.ok");
  assert.equal(dialog.dismissed, true);
  const status = await requestControl("bridge.status", {}, { env });
  assert.equal(status.clients[0].fileName, "Paired");
  assert.equal(JSON.stringify(status).includes(server.token), false);
  plugin.close();
  void clock;
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
    showPairingCode() {
      approvalCalls += 1;
      return { cancelled: new Promise(() => {}), dismiss() {} };
    }
  });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const websocket = await connect(port, "https://example.com");
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

test("an occupied IPv6 loopback port stops the companion instead of sharing localhost", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-ipv6-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  const squatter = net.createServer();
  const listening = await new Promise(resolve => {
    squatter.once("error", () => resolve(false));
    squatter.listen({ port, host: "::1", ipv6Only: true }, () => resolve(true));
  });
  if (!listening) {
    t.skip("IPv6 loopback is unavailable");
    return;
  }
  t.after(() => new Promise(resolve => squatter.close(resolve)));
  await assert.rejects(startBridgeServer({ env: { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory }, port, logger: { info() {} } }), error => error.code === "EADDRINUSE");
  // The IPv4 listener was released, so a later start can succeed.
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
  await new Promise(resolve => probe.close(resolve));
});

test("the control pipe id changes on every companion start", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-rotate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, FIGMA_BRIDGE_STATE_DIR: directory };
  const ids = [];
  for (let run = 0; run < 2; run += 1) {
    const server = await startBridgeServer({ env, port: await freePort(), logger: { info() {} } });
    ids.push(JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")).controlId);
    assert.equal((await requestControl("bridge.status", {}, { env })).pid, process.pid);
    await server.close();
  }
  assert.notEqual(ids[0], ids[1]);
});

test("Windows pairing shows the code in a system-modal PowerShell popup with a timeout", () => {
  const dialog = pairingDialogCommand("win32", { SystemRoot: "D:\\Windows" }, "123456");
  assert.equal(dialog.command, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const encoded = dialog.args[dialog.args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /\$shell\.Popup\('Figma Bridge pairing code: 123 456\./);
  assert.match(script, /, 120, 'Figma Bridge', 4161\)/);
  assert.equal(dialog.cancelled(0, "2"), true);
  assert.equal(dialog.cancelled(0, "1"), false);
  assert.equal(dialog.cancelled(0, "-1"), false);
  assert.equal(pairingDialogCommand("linux", {}, "123456"), null);
  const mac = pairingDialogCommand("darwin", {}, "654321");
  assert.equal(mac.command, "/usr/bin/osascript");
  assert.match(mac.args[1], /pairing code: 654 321/);
  assert.equal(mac.cancelled(1, ""), true);
  assert.equal(mac.cancelled(0, "button returned:OK, gave up:true"), false);
  assert.throws(() => pairingDialogCommand("darwin", {}, "12\"; do shell script \"x"), /six digits/);
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

async function connect(port, origin) {
  const websocket = new WebSocket(`ws://127.0.0.1:${port}/bridge`, origin ? { origin } : {});
  websocket.received = [];
  const waiters = new Set();
  websocket.on("message", raw => {
    websocket.received.push(JSON.parse(raw.toString()));
    for (const wake of waiters) wake();
  });
  websocket.next = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
    const check = () => {
      const message = websocket.received.find(item => item.type === type);
      if (!message) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(message);
    };
    waiters.add(check);
    check();
  });
  await once(websocket, "open");
  websocket.hello = await websocket.next("hello");
  return websocket;
}

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
