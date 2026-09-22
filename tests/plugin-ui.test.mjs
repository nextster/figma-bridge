import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { proof } from "../companion/src/plugin-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(path.join(root, "figma-plugin/src/bridge-auth.js"), "utf8");

test("plugin HMAC matches node:crypto without WebCrypto, as in Figma's plugin iframe", async () => {
  const context = vm.createContext({ crypto: { getRandomValues: bytes => crypto.randomFillSync(bytes) }, TextEncoder, btoa });
  vm.runInContext(`${authSource}\nglobalThis.auth = FigmaBridgeAuth;`, context);
  for (const length of [0, 1, 54, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const token = crypto.randomBytes(32).toString("base64url");
    const serverNonce = "server-nonce-0123456789";
    const clientNonce = "x".repeat(Math.max(1, length));
    assert.equal(await context.auth.proof(token, "auth/client", serverNonce, clientNonce), proof(token, "auth/client", serverNonce, clientNonce));
  }
  const longKey = "k".repeat(100);
  assert.equal(await context.auth.proof(longKey, "pair/server", "s", "c", "Токен ✓"), proof(longKey, "pair/server", "s", "c", "Токен ✓"));
  assert.match(context.auth.nonce(), /^[A-Za-z0-9_-]{32}$/);
});

test("the plugin UI starts, pairs with the code, and runs commands only after mutual authentication", async () => {
  const ui = loadUi();
  // Startup renders the default mode even before the plugin sends its state.
  assert.equal(ui.tab("local").attributes["aria-selected"], "true");
  assert.ok(ui.posts.some(message => message.type === "ui-ready"));

  // Figma delivers plugin messages from a frame other than parent.
  ui.deliver({ type: "bridge-init", token: "", mode: "local", relayDevice: null, client: { id: "file-1", fileName: "Design", pageName: "Home" } });
  assert.equal(ui.element("status").textContent, "Ready to connect.");
  assert.equal(ui.element("local-view").hidden, false);

  ui.click("local-connect");
  const socket = ui.sockets.at(-1);
  assert.equal(socket.url, "ws://localhost:3847/bridge");
  socket.emit("open");
  assert.deepEqual(socket.sent, []);
  socket.receive({ type: "hello", protocol: 2, nonce: "server-nonce-0123456789" });
  await ui.settle();
  assert.equal(socket.sent.at(-1).type, "pair");

  socket.receive({ type: "pair.code" });
  await ui.settle();
  assert.equal(ui.element("pair-form").hidden, false);

  // Commands that arrive before authentication are ignored.
  socket.receive({ type: "rpc.request", id: "early", command: "nodes.delete", arguments: {} });
  await ui.settle();
  assert.equal(ui.posts.some(message => message.type === "bridge-command"), false);

  ui.element("pair-code").value = "123 456";
  await ui.submit("pair-form");
  const sentProof = socket.sent.at(-1);
  assert.equal(sentProof.type, "pair.proof");
  assert.equal(sentProof.proof, proof("123456", "pair/client", "server-nonce-0123456789", sentProof.nonce));

  const token = "t".repeat(43);
  socket.receive({ type: "pair.ok", token, proof: proof("123456", "pair/server", "server-nonce-0123456789", sentProof.nonce, token) });
  socket.receive({ type: "auth.ok", clientId: "file-1" });
  await ui.settle();
  assert.deepEqual(ui.posts.find(message => message.type === "store-token"), { type: "store-token", token });
  assert.match(ui.element("status").textContent, /^Connected to this computer · Design · Home$/);
  // Once paired, only Unpair is offered: no code field, Connect, or manual token.
  assert.equal(ui.element("pair-form").hidden, true);
  assert.equal(ui.element("local-connect").hidden, true);
  assert.equal(ui.element("manual").hidden, true);
  assert.equal(ui.element("local-unpair").hidden, false);

  socket.receive({ type: "rpc.request", id: "r1", command: "document.pages", arguments: {} });
  await ui.settle();
  assert.deepEqual(ui.posts.find(message => message.type === "bridge-command"), { type: "bridge-command", id: "r1", command: "document.pages", arguments: {} });
});

test("a paired plugin hides pairing and can unpair to pair again", async () => {
  const ui = loadUi();
  const token = crypto.randomBytes(32).toString("base64url");
  ui.deliver({ type: "bridge-init", token, mode: "local", relayDevice: null, client: {} });
  // Paired but the companion is not answering yet: no code field or Connect.
  assert.equal(ui.element("pair-form").hidden, true);
  assert.equal(ui.element("local-connect").hidden, true);
  assert.equal(ui.element("local-unpair").hidden, false);

  const socket = ui.sockets.at(-1);
  socket.emit("open");
  socket.receive({ type: "hello", protocol: 2, nonce: "server-nonce-0123456789" });
  await ui.settle();
  const auth = socket.sent.at(-1);
  socket.receive({ type: "auth.ok", clientId: "c", proof: proof(token, "auth/server", "server-nonce-0123456789", auth.nonce) });
  await ui.settle();
  assert.match(ui.element("status").textContent, /^Connected to this computer/);
  assert.equal(ui.element("pair-form").hidden, true);

  const postsBefore = ui.posts.length;
  ui.click("local-unpair");
  assert.equal(socket.closed, true);
  assert.deepEqual(ui.posts.slice(postsBefore).filter(message => message.type !== "resize"), [{ type: "forget-token" }]);
  assert.equal(ui.element("status").textContent, "Unpaired. Connect to pair this computer again.");
  assert.equal(ui.element("local-unpair").hidden, true);
  assert.equal(ui.element("local-connect").hidden, false);
  assert.equal(ui.element("pair-form").hidden, true);

  // Connect now starts a fresh pairing.
  ui.click("local-connect");
  const pairing = ui.sockets.at(-1);
  assert.notEqual(pairing, socket);
  pairing.emit("open");
  pairing.receive({ type: "hello", protocol: 2, nonce: "server-nonce-0123456789" });
  await ui.settle();
  assert.equal(pairing.sent.at(-1).type, "pair");
  pairing.receive({ type: "pair.code" });
  await ui.settle();
  assert.equal(ui.element("pair-form").hidden, false);
  ui.element("pair-code").value = "123456";
  await ui.submit("pair-form");
  assert.equal(ui.element("pair-form").hidden, true);
});

test("a companion that rejects the saved pairing makes the plugin forget it", async () => {
  const ui = loadUi();
  ui.deliver({ type: "bridge-init", token: "t".repeat(43), mode: "local", relayDevice: null, client: {} });
  const socket = ui.sockets.at(-1);
  socket.emit("open");
  socket.emit("close", { code: 4403, reason: "authentication failed" });
  await ui.settle();
  assert.ok(ui.posts.some(message => message.type === "forget-token"));
  assert.equal(ui.element("local-connect").hidden, false);
  assert.equal(ui.element("local-unpair").hidden, true);
});

test("the plugin UI rejects a companion that cannot prove the pairing code", async () => {
  const ui = loadUi();
  ui.deliver({ type: "bridge-init", token: "", mode: "local", relayDevice: null, client: {} });
  ui.click("local-connect");
  const socket = ui.sockets.at(-1);
  socket.emit("open");
  socket.receive({ type: "hello", protocol: 2, nonce: "server-nonce-0123456789" });
  socket.receive({ type: "pair.code" });
  await ui.settle();
  ui.element("pair-code").value = "654321";
  await ui.submit("pair-form");
  socket.receive({ type: "pair.ok", token: "t".repeat(43), proof: "forged" });
  await ui.settle();
  assert.equal(ui.posts.some(message => message.type === "store-token"), false);
  assert.match(ui.element("status").textContent, /Could not verify this computer/);
  assert.equal(socket.closed, true);
});

test("the plugin UI reconnects with a saved token by proving it, never sending it", async () => {
  const ui = loadUi();
  const token = crypto.randomBytes(32).toString("base64url");
  ui.deliver({ type: "bridge-init", token, mode: "local", relayDevice: null, client: {} });
  const socket = ui.sockets.at(-1);
  socket.emit("open");
  socket.receive({ type: "hello", protocol: 2, nonce: "server-nonce-0123456789" });
  await ui.settle();
  const auth = socket.sent.at(-1);
  assert.equal(auth.type, "auth");
  assert.equal(JSON.stringify(socket.sent).includes(token), false);
  assert.equal(auth.proof, proof(token, "auth/client", "server-nonce-0123456789", auth.nonce));

  socket.receive({ type: "auth.ok", clientId: "c", proof: "wrong" });
  await ui.settle();
  assert.match(ui.element("status").textContent, /Could not verify the Figma Bridge companion/);
});

test("a replaced connection attempt cannot close the connection that replaced it", async () => {
  const ui = loadUi();
  const token = crypto.randomBytes(32).toString("base64url");
  // A second start-up message makes the UI replace its first connection attempt.
  ui.deliver({ type: "bridge-init", token, mode: "local", relayDevice: null, client: { fileName: "Design", pageName: "Home" } });
  ui.deliver({ type: "bridge-init", token, mode: "local", relayDevice: null, client: { fileName: "Design", pageName: "Home" } });
  const [first, second] = ui.sockets;
  assert.equal(first.closed, true);
  second.emit("open");
  second.receive({ type: "hello", protocol: 2, nonce: "server-nonce-0123456789" });
  await ui.settle();
  const auth = second.sent.at(-1);
  second.receive({ type: "auth.ok", clientId: "c", proof: proof(token, "auth/server", "server-nonce-0123456789", auth.nonce) });
  await ui.settle();
  assert.match(ui.element("status").textContent, /^Connected to this computer/);

  // The first attempt's hello timeout fires later and must leave the live connection alone.
  ui.runTimers();
  await ui.settle();
  assert.equal(second.closed, false);
  assert.match(ui.element("status").textContent, /^Connected to this computer/);
});

test("a companion that never says hello is reported as outdated", async () => {
  const ui = loadUi();
  ui.deliver({ type: "bridge-init", token: "t".repeat(43), mode: "local", relayDevice: null, client: {} });
  const socket = ui.sockets.at(-1);
  socket.emit("open");
  ui.runTimers();
  await ui.settle();
  assert.equal(socket.closed, true);
  assert.match(ui.element("status").textContent, /Update the Figma Bridge companion/);
});

function loadUi() {
  const html = fs.readFileSync(path.join(root, "figma-plugin/src/ui.html"), "utf8");
  const [authScript, mainScript] = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(authScript, "/*__FIGMA_BRIDGE_AUTH__*/");

  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const tabs = ["local", "relay"].map(mode => Object.assign(fakeElement(`tab-${mode}`), { dataset: { mode } }));
  const posts = [];
  const sockets = [];
  const listeners = {};
  const timers = [];

  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = {};
      this.closed = false;
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.closed = true; this.readyState = 3; }
    emit(type, event = {}) {
      if (type === "open") this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(event);
    }
    receive(message) { this.emit("message", { data: JSON.stringify(message) }); }
  }

  const context = vm.createContext({
    TextEncoder,
    btoa,
    crypto: { getRandomValues: bytes => crypto.randomFillSync(bytes) },
    WebSocket: FakeWebSocket,
    navigator: { userAgent: "Macintosh" },
    parent: { postMessage: message => posts.push(JSON.parse(JSON.stringify(message.pluginMessage))) },
    window: { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } },
    document: {
      getElementById: element,
      querySelectorAll: selector => (selector === "[data-mode]" ? tabs : []),
      createElement: tag => fakeElement(tag),
      body: { scrollHeight: 320 }
    },
    requestAnimationFrame: fn => fn(),
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay, cancelled: false });
      return timers.length;
    },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    Promise
  });
  vm.runInContext(authSource, context);
  vm.runInContext(mainScript.replace("__FIGMA_BRIDGE_RELAY_URL__", "wss://relay.test/plugin"), context);

  return {
    posts,
    sockets,
    element,
    tab: mode => tabs.find(tab => tab.dataset.mode === mode),
    deliver: pluginMessage => {
      for (const fn of listeners.message || []) fn({ source: {}, data: { pluginMessage } });
    },
    click: id => { for (const fn of element(id).listeners.click || []) fn({}); },
    runTimers: () => {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
    },
    submit: async id => {
      await Promise.all((element(id).listeners.submit || []).map(fn => fn({ preventDefault() {} })));
      await settle();
    },
    settle
  };
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve));
}

function fakeElement(id) {
  const button = { disabled: false };
  return {
    id,
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    dataset: {},
    attributes: {},
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector: () => button,
    replaceChildren() {},
    append() {},
    focus() {}
  };
}
