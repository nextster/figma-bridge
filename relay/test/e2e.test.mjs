import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { WebSocket } from "ws";
import { createRelay, openDatabase, relayConfig } from "../src/app.mjs";

const REDIRECT_URL = "http://127.0.0.1:47219/callback";

test("an MCP SDK client reaches a Figma plugin after the user approves it in the plugin", async t => {
  // The issuer must match the listening port, so pick a port before building the relay.
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const db = openDatabase(":memory:");
  const app = createRelay({ config: relayConfig({ FIGMA_BRIDGE_PUBLIC_URL: issuer }), db, logger: { info() {}, error() {}, warn() {} } });
  await new Promise(resolve => app.server.listen(port, "127.0.0.1", resolve));
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    db.close();
  });

  const invite = app.accounts.createInvite();
  const plugin = await connectPlugin(`ws://127.0.0.1:${port}/plugin`, sockets);
  plugin.send({ type: "register", code: invite.code, deviceName: "Figma on macOS", client: { id: "file-1", fileName: "Relay E2E", pageName: "Home" } });
  await plugin.next("register.ok");
  plugin.serve(command => command === "document.pages" ? [{ id: "0:1", name: "Home", current: true }] : { command });

  const provider = memoryProvider();
  const serverUrl = new URL(`${issuer}/mcp`);
  const client = new Client({ name: "relay-e2e", version: "1.0.0" });
  await assert.rejects(client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider })), UnauthorizedError);

  const page = await (await fetch(provider.authorizationUrl)).text();
  const code = /<div class="code"[^>]*>([0-9A-Z]{4}-[0-9A-Z]{4})<\/div>/.exec(page)[1];
  const { request, secret } = JSON.parse(/const payload = (\{[^<]*?\});/.exec(page)[1]);

  const approval = await plugin.call("approval.lookup", { code });
  assert.equal(approval.clientName, "Relay E2E client");
  assert.equal(approval.redirectKind, "loopback");
  assert.deepEqual(await plugin.call("approval.decide", { requestId: approval.requestId, approve: true }), { status: "approved" });

  const status = await (await fetch(`${issuer}/oauth/authorize/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request, secret })
  })).json();
  assert.equal(status.status, "approved");
  const authorizationCode = new URL(status.redirect).searchParams.get("code");

  const transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
  await transport.finishAuth(authorizationCode);
  const connected = new Client({ name: "relay-e2e", version: "1.0.0" });
  await connected.connect(transport);
  t.after(() => connected.close());

  const { tools } = await connected.listTools();
  assert.equal(tools.some(tool => tool.name === "delete_nodes"), true);
  const files = JSON.parse((await connected.callTool({ name: "list_files", arguments: {} })).content[0].text);
  assert.deepEqual(files.map(file => file.fileName), ["Relay E2E"]);
  const pages = JSON.parse((await connected.callTool({ name: "list_pages", arguments: {} })).content[0].text);
  assert.deepEqual(pages, [{ id: "0:1", name: "Home", current: true }]);
  const status2 = JSON.parse((await connected.callTool({ name: "status", arguments: {} })).content[0].text);
  assert.equal(status2.mode, "relay");

  const grants = await plugin.call("grants.list");
  assert.deepEqual(grants.map(grant => grant.clientName), ["Relay E2E client"]);
  assert.deepEqual(await plugin.call("grants.revoke", { grantId: grants[0].grantId }), { revoked: true });
  const revoked = await fetch(serverUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.saved.tokens.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  assert.equal(revoked.status, 401);
});

function memoryProvider() {
  const saved = {};
  return {
    saved,
    authorizationUrl: null,
    redirectUrl: REDIRECT_URL,
    clientMetadata: {
      client_name: "Relay E2E client",
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    },
    clientInformation: () => saved.client,
    saveClientInformation(information) { saved.client = information; },
    tokens: () => saved.tokens,
    saveTokens(tokens) { saved.tokens = tokens; },
    redirectToAuthorization(url) { this.authorizationUrl = url; },
    saveCodeVerifier(verifier) { saved.verifier = verifier; },
    codeVerifier: () => saved.verifier
  };
}

function connectPlugin(url, sockets) {
  const websocket = new WebSocket(url, { origin: "null" });
  sockets.push(websocket);
  const inbox = [];
  const waiters = new Set();
  let handler = null;
  let sequence = 0;
  websocket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === "rpc.request" && handler) {
      websocket.send(JSON.stringify({ type: "rpc.response", id: message.id, ok: true, result: handler(message.command, message.arguments) }));
      return;
    }
    inbox.push(message);
    for (const waiter of waiters) waiter();
  });
  const plugin = {
    send: value => websocket.send(JSON.stringify(value)),
    serve: fn => { handler = fn; },
    next(type, predicate = () => true) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
        const check = () => {
          const index = inbox.findIndex(message => message.type === type && predicate(message));
          if (index < 0) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(inbox.splice(index, 1)[0]);
        };
        waiters.add(check);
        check();
      });
    },
    async call(method, params = {}) {
      const id = `e2e-${sequence++}`;
      plugin.send({ type: "call", id, method, params });
      const result = await plugin.next("call.result", message => message.id === id);
      if (!result.ok) throw new Error(result.error);
      return result.result;
    }
  };
  return new Promise((resolve, reject) => {
    websocket.once("open", () => resolve(plugin));
    websocket.once("error", reject);
  });
}

async function freePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
