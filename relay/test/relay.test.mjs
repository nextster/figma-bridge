import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { createAccountsStore, migrateAccounts } from "../src/accounts-store.mjs";
import { createAssetStore } from "../src/assets.mjs";
import { createMcpEndpoint } from "../src/mcp-http.mjs";
import { createPluginGateway } from "../src/plugin-gateway.mjs";
import { createRateLimiter } from "../src/rate-limit.mjs";

test("plugins register with invites, link devices, and reconnect with device credentials", async t => {
  const relay = await startRelay(t);
  const invite = relay.accounts.createInvite({ note: "test" });

  const first = await connectPlugin(relay);
  first.send({ type: "register", code: invite.code.toLowerCase().replaceAll("-", " "), deviceName: "Desktop", client: { id: "file-a", fileName: "A" } });
  const registered = await first.next("register.ok");
  assert.equal(registered.created, true);
  assert.match(registered.device.secret, /^fbs_/);

  const reuse = await connectPlugin(relay);
  reuse.send({ type: "register", code: invite.code, client: { id: "file-x" } });
  assert.equal((await reuse.next("register.error")).error, "invalid_code");
  reuse.close();

  const link = await first.call("devices.link");
  const second = await connectPlugin(relay);
  second.send({ type: "register", code: link.code, deviceName: "Browser", client: { id: "file-b", fileName: "B" } });
  const linked = await second.next("register.ok");
  assert.equal(linked.created, false);
  assert.equal(linked.accountId, registered.accountId);
  const devices = await second.call("devices.list");
  assert.deepEqual(devices.map(device => device.name), ["Desktop", "Browser"]);
  assert.equal(devices.find(device => device.current).name, "Browser");

  first.close();
  const again = await connectPlugin(relay);
  again.send({ type: "hello", device: registered.device, client: { id: "file-a2", fileName: "A2" } });
  assert.equal((await again.next("hello.ok")).accountId, registered.accountId);

  const stolen = await connectPlugin(relay);
  stolen.send({ type: "hello", device: { id: registered.device.id, secret: `${registered.device.secret}x` } });
  assert.equal((await stolen.closed()).code, 4403);

  const pendingLink = await second.call("devices.link");
  assert.deepEqual(await again.call("devices.revoke", { deviceId: linked.device.id }), { revoked: true, revokedGrants: 1 });
  assert.deepEqual(relay.oauthCalls.at(-1), { method: "revokeDeviceGrants", args: { accountId: registered.accountId, deviceId: linked.device.id } });
  assert.equal((await second.closed()).code, 4403);
  // Link codes minted by a removed device cannot bring it back.
  const rejoin = await connectPlugin(relay);
  rejoin.send({ type: "register", code: pendingLink.code, deviceName: "Figma on macOS" });
  assert.equal((await rejoin.next("register.error")).error, "invalid_code");
  const revoked = await connectPlugin(relay);
  revoked.send({ type: "hello", device: linked.device });
  assert.equal((await revoked.closed()).code, 4403);
});

test("MCP requests require a token and reach only the grant owner's Figma files", async t => {
  const relay = await startRelay(t);
  const alice = await registeredPlugin(relay, "Alice file");
  const bob = await registeredPlugin(relay, "Bob file");
  relay.tokens.set("token-alice", { grantId: "g1", accountId: alice.accountId, clientId: "c1", clientName: "Claude" });
  relay.tokens.set("token-bob", { grantId: "g2", accountId: bob.accountId, clientId: "c2", clientName: "Codex" });
  alice.serve(async (command, args) => {
    if (command === "nodes.exportPng") return { node: { id: "1:2" }, mimeType: "image/png", data: Buffer.from("png").toString("base64") };
    if (command === "handoff.prepareSwiftUI") {
      return {
        file: { name: "Alice file" },
        assets: [{ key: "screen", kind: "screen-png" }, { key: "vector", kind: "svg" }],
        _assetRequests: [{ key: "screen", kind: "screen-png", nodeId: "1:2", name: "Home" }, { key: "vector", kind: "svg", nodeId: "1:3", name: "Icon" }]
      };
    }
    if (command === "handoff.exportAsset") {
      return args.kind === "svg"
        ? { data: Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64"), mimeType: "image/svg+xml", extension: "svg" }
        : { data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png", extension: "png" };
    }
    return { command, args };
  });

  const unauthorized = await mcp(relay, null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers["www-authenticate"], /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await mcp(relay, "token-alice", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await mcp(relay, "token-alice", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await rawRequest(relay, { method: "GET", path: "/mcp", headers: { authorization: "Bearer token-alice" } })).status, 405);

  const initialized = await mcp(relay, "token-alice", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(initialized.body.result.protocolVersion, "2025-06-18");
  const tools = (await mcp(relay, "token-alice", { jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools;
  assert.equal(tools.find(tool => tool.name === "prepare_swiftui_handoff").inputSchema.properties.outputDirectory, undefined);

  const aliceFiles = JSON.parse((await callTool(relay, "token-alice", "list_files")).content[0].text);
  const bobFiles = JSON.parse((await callTool(relay, "token-bob", "list_files")).content[0].text);
  assert.deepEqual(aliceFiles.map(file => file.fileName), ["Alice file"]);
  assert.deepEqual(bobFiles.map(file => file.fileName), ["Bob file"]);
  const crossAccount = await callTool(relay, "token-bob", "list_pages", { clientId: aliceFiles[0].id });
  assert.equal(crossAccount.isError, true);
  assert.match(crossAccount.content[0].text, /not connected/);

  assert.deepEqual(JSON.parse((await callTool(relay, "token-alice", "snapshot", { depth: 1 })).content[0].text), { command: "document.snapshot", args: { depth: 1 } });
  assert.equal((await callTool(relay, "token-alice", "export_png", { nodeId: "1:2" })).content[1].type, "image");
  const rejectedDirectory = await callTool(relay, "token-alice", "prepare_swiftui_handoff", { screenIds: ["1:2"], outputDirectory: "/tmp/x" });
  assert.equal(rejectedDirectory.isError, true);

  const handoff = JSON.parse((await callTool(relay, "token-alice", "prepare_swiftui_handoff", { screenIds: ["1:2"] })).content[0].text);
  const png = handoff.assets.find(asset => asset.key === "screen").export;
  const svg = handoff.assets.find(asset => asset.key === "vector").export;
  assert.match(png.url, /\/assets\/[A-Za-z0-9_-]{43}\/Home\.png$/);
  const pngDownload = await rawRequest(relay, { method: "GET", path: new URL(png.url).pathname });
  assert.equal(pngDownload.status, 200);
  assert.equal(pngDownload.text, "png-bytes");
  const svgDownload = await rawRequest(relay, { method: "GET", path: new URL(svg.url).pathname });
  assert.equal(svgDownload.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.match(svgDownload.headers["content-disposition"], /^attachment;/);
  const manifest = await rawRequest(relay, { method: "GET", path: new URL(handoff.manifestUrl).pathname });
  assert.equal(JSON.parse(manifest.text).assets.length, 2);

  relay.advance(31 * 60_000);
  assert.equal((await rawRequest(relay, { method: "GET", path: new URL(png.url).pathname })).status, 404);
});

test("plugin account calls are scoped to the authenticated device", async t => {
  const relay = await startRelay(t);
  const plugin = await registeredPlugin(relay, "File");
  assert.deepEqual(await plugin.call("approval.lookup", { code: "ABCD-EFGH" }), { requestId: "r1", clientName: "Claude Code" });
  assert.deepEqual(relay.oauthCalls.at(-1), { method: "lookupApproval", args: { code: "ABCD-EFGH", ip: "127.0.0.1", accountId: plugin.accountId, deviceId: plugin.device.id } });
  await plugin.call("approval.decide", { requestId: "r1", approve: true });
  assert.deepEqual(relay.oauthCalls.at(-1).args, { requestId: "r1", approve: true, accountId: plugin.accountId, deviceId: plugin.device.id });
  await assert.rejects(plugin.call("approval.decide", { requestId: "r1", approve: "yes" }), /invalid_request/);
  await assert.rejects(plugin.call("admin.everything"), /invalid_request/);
  await plugin.call("grants.revoke", { grantId: "g1" });
  assert.deepEqual(relay.oauthCalls.at(-1).args, { grantId: "g1", accountId: plugin.accountId });

  const stranger = await connectPlugin(relay, { origin: "https://evil.example" }).catch(error => error);
  assert.match(String(stranger.message), /403/);
});

test("anonymous plugin sockets cannot send large frames or pile up", async t => {
  const relay = await startRelay(t);
  const big = await connectPlugin(relay);
  big.send({ type: "register", code: "x".repeat(100 * 1024) });
  assert.equal((await big.closed()).code, 1009);

  const held = [];
  for (let index = 0; index < 8; index += 1) held.push(await connectPlugin(relay));
  await assert.rejects(connectPlugin(relay), /unexpected 403/);
  held[0].close();
  await held[0].closed();
  const replacement = await connectPlugin(relay);
  replacement.close();

  // Authenticated devices may still send full-size exports.
  const plugin = await registeredPlugin(relay, "Large export");
  relay.tokens.set("token-large", { grantId: "g-large", accountId: plugin.accountId, clientId: "c", clientName: "Claude" });
  const payload = "A".repeat(10 * 1024 * 1024);
  plugin.serve(() => ({ node: { id: "1:2" }, mimeType: "image/png", data: payload }));
  const exported = await callTool(relay, "token-large", "export_png", { nodeId: "1:2" });
  assert.equal(exported.content[1].data.length, payload.length);
});

test("a handoff asset named handoff.json cannot replace the manifest", async t => {
  const relay = await startRelay(t);
  const plugin = await registeredPlugin(relay, "Shadow");
  relay.tokens.set("token-shadow", { grantId: "g-shadow", accountId: plugin.accountId, clientId: "c", clientName: "Claude" });
  plugin.serve((command) => command === "handoff.prepareSwiftUI"
    ? { file: { name: "Shadow" }, assets: [{ key: "a" }], _assetRequests: [{ key: "a", kind: "svg", nodeId: "1:2", name: "handoff" }] }
    : { data: Buffer.from("{\"forged\":true}").toString("base64"), mimeType: "application/json", extension: "json" });
  const handoff = JSON.parse((await callTool(relay, "token-shadow", "prepare_swiftui_handoff", { screenIds: ["1:2"] })).content[0].text);
  assert.notEqual(handoff.assets[0].export.url, handoff.manifestUrl);
  const manifest = await rawRequest(relay, { method: "GET", path: new URL(handoff.manifestUrl).pathname });
  assert.equal(JSON.parse(manifest.text).manifestUrl, handoff.manifestUrl);
});

async function startRelay(t) {
  const db = new DatabaseSync(":memory:");
  migrateAccounts(db);
  let offset = 0;
  const now = () => Date.now() + offset;
  const accounts = createAccountsStore(db, { now });
  const tokens = new Map();
  const oauthCalls = [];
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const oauth = {
    issuer,
    resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource/mcp`,
    async verifyAccessToken(token) { return tokens.get(token) || null; },
    async lookupApproval(args) { oauthCalls.push({ method: "lookupApproval", args }); return { requestId: "r1", clientName: "Claude Code" }; },
    async decideApproval(args) { oauthCalls.push({ method: "decideApproval", args }); return { status: args.approve ? "approved" : "denied" }; },
    async listGrants() { return []; },
    async revokeGrant(args) { oauthCalls.push({ method: "revokeGrant", args }); return true; },
    revokeDeviceGrants(args) { oauthCalls.push({ method: "revokeDeviceGrants", args }); return 1; }
  };
  const limiter = createRateLimiter({ now });
  const gateway = createPluginGateway({ accounts, oauth, limiter, clientIp: () => "127.0.0.1", logger: { error() {} }, version: "test" });
  const assets = createAssetStore({ issuer, now });
  const endpoint = createMcpEndpoint({ oauth, gateway, assets, allowedOrigins: [issuer], logger: { error() {} } });
  server.on("request", async (request, response) => {
    const url = new URL(request.url, issuer);
    if (url.pathname === "/mcp") await endpoint(request, response);
    else if (!assets.handle(request, response, url)) {
      response.writeHead(404);
      response.end();
    }
  });
  server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  const relay = { server, issuer, accounts, tokens, oauthCalls, sockets: [], advance: milliseconds => { offset += milliseconds; } };
  t.after(async () => {
    for (const socket of relay.sockets) socket.terminate();
    assets.close();
    await gateway.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  return relay;
}

async function registeredPlugin(relay, fileName) {
  const invite = relay.accounts.createInvite();
  const plugin = await connectPlugin(relay);
  plugin.send({ type: "register", code: invite.code, deviceName: fileName, client: { id: `client-${fileName.replace(/\W/g, "")}`, fileName } });
  const registered = await plugin.next("register.ok");
  return Object.assign(plugin, { accountId: registered.accountId, device: registered.device });
}

function connectPlugin(relay, { origin = "null" } = {}) {
  const websocket = new WebSocket(`${relay.issuer.replace("http", "ws")}/plugin`, { origin });
  relay.sockets.push(websocket);
  const inbox = [];
  const waiters = [];
  let handler = null;
  let callId = 0;
  websocket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === "rpc.request" && handler) {
      Promise.resolve(handler(message.command, message.arguments)).then(
        result => websocket.send(JSON.stringify({ type: "rpc.response", id: message.id, ok: true, result })),
        error => websocket.send(JSON.stringify({ type: "rpc.response", id: message.id, ok: false, error: error.message }))
      );
      return;
    }
    inbox.push(message);
    for (const waiter of [...waiters]) waiter();
  });
  const closed = new Promise(resolve => websocket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const plugin = {
    send: value => websocket.send(JSON.stringify(value)),
    close: () => websocket.close(),
    closed: () => closed,
    serve: fn => { handler = fn; },
    next(type, predicate = () => true) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
        const check = () => {
          const index = inbox.findIndex(message => message.type === type && predicate(message));
          if (index < 0) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(inbox.splice(index, 1)[0]);
        };
        waiters.push(check);
        check();
      });
    },
    async call(method, params = {}) {
      const id = `call-${callId++}`;
      plugin.send({ type: "call", id, method, params });
      const result = await plugin.next("call.result", message => message.id === id);
      if (!result.ok) throw new Error(result.error);
      return result.result;
    }
  };
  return new Promise((resolve, reject) => {
    websocket.once("open", () => resolve(plugin));
    websocket.once("unexpected-response", (request, response) => reject(new Error(`unexpected ${response.statusCode}`)));
    websocket.once("error", reject);
  });
}

async function callTool(relay, token, name, args = {}) {
  const response = await mcp(relay, token, { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "tools/call", params: { name, arguments: args } });
  assert.equal(response.status, 200);
  return response.body.result;
}

async function mcp(relay, token, body, headers = {}) {
  const response = await rawRequest(relay, {
    method: "POST",
    path: "/mcp",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body)
  });
  return { ...response, body: response.text ? JSON.parse(response.text) : null };
}

function rawRequest(relay, { method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${relay.issuer}${path}`, { method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(body);
  });
}
