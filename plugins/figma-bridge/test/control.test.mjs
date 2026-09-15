import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { companionLauncher, createAutostartRequest } from "../mcp/autostart.mjs";
import { controlEndpoint, createControlServer, ensureState, requestControl } from "../mcp/control.mjs";

test("control requests and responses are authenticated, fresh, and single-use", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-control-"));
  const endpoint = path.join(directory, "control.sock");
  const secret = crypto.randomBytes(32).toString("base64url");
  const calls = [];
  const server = createControlServer({ secret, dispatch: async (method, params) => { calls.push({ method, params }); return { ok: method }; } });
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  assert.deepEqual(await requestControl("bridge.status", { a: 1 }, { endpoint, secret }), { ok: "bridge.status" });
  await assert.rejects(requestControl("bridge.status", {}, { endpoint, secret: crypto.randomBytes(32).toString("base64url") }), /control response failed authentication/);

  const nonce = crypto.randomBytes(18).toString("base64url");
  const ts = Date.now();
  const body = JSON.stringify({ id: 1, method: "figma.call", params: {} });
  const mac = crypto.createHmac("sha256", secret).update(`figma-bridge-control\nreq\n${nonce}\n${ts}\n${body}`).digest("base64url");
  const envelope = `${JSON.stringify({ v: 2, nonce, ts, body, mac })}\n`;
  assert.match(await rawExchange(endpoint, envelope), /"mac"/);
  assert.match(await rawExchange(endpoint, envelope), /replayed control request/);

  const staleTs = Date.now() - 5 * 60_000;
  const staleNonce = crypto.randomBytes(18).toString("base64url");
  const staleMac = crypto.createHmac("sha256", secret).update(`figma-bridge-control\nreq\n${staleNonce}\n${staleTs}\n${body}`).digest("base64url");
  assert.match(await rawExchange(endpoint, `${JSON.stringify({ v: 2, nonce: staleNonce, ts: staleTs, body, mac: staleMac })}\n`), /stale control request/);
  assert.equal(calls.filter(call => call.method === "figma.call").length, 1);
});

test("state gains control credentials and Windows uses an unguessable named pipe", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { FIGMA_BRIDGE_STATE_DIR: directory };
  await writeFile(path.join(directory, "state.json"), `${JSON.stringify({ version: 1, token: "t".repeat(43), createdAt: "2026-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
  const state = ensureState(env);
  assert.equal(state.token, "t".repeat(43));
  assert.match(state.controlId, /^[a-f0-9]{32}$/);
  assert.equal(JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")).controlSecret, state.controlSecret);
  assert.deepEqual(ensureState(env), state);

  assert.equal(controlEndpoint({ env, platform: "win32", state }), `\\\\.\\pipe\\figma-bridge-${state.controlId}`);
  assert.equal(controlEndpoint({ env, platform: "darwin", state }), path.join(directory, "control.sock"));
  assert.equal(controlEndpoint({ env: { ...env, FIGMA_BRIDGE_SOCKET: "\\\\.\\pipe\\custom" }, platform: "win32", state }), "\\\\.\\pipe\\custom");
});

test("autostart launches the companion once and retries only unsent requests", async () => {
  let attempts = 0;
  let launches = 0;
  let clock = 0;
  const notRunning = Object.assign(new Error("missing"), { code: "ENOENT" });
  const autostart = createAutostartRequest({
    env: {},
    request: async () => {
      attempts += 1;
      if (attempts < 3) throw notRunning;
      return "ready";
    },
    launcher: () => ({ command: "node", args: ["companion"] }),
    launch: () => { launches += 1; },
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; }
  });
  assert.equal(await autostart("bridge.status"), "ready");
  assert.equal(launches, 1);

  const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  const noRetry = createAutostartRequest({ env: {}, request: async () => { throw reset; }, launch: () => { throw new Error("must not launch"); } });
  await assert.rejects(noRetry("figma.call"), /reset/);
  const disabled = createAutostartRequest({ env: { FIGMA_BRIDGE_AUTOSTART: "0" }, request: async () => { throw notRunning; }, launch: () => { throw new Error("must not launch"); } });
  await assert.rejects(disabled("bridge.status"), /missing/);
});

test("autostart prefers the stable bootstrap that launched the MCP server", () => {
  const files = new Set(["/state/runtime/runtime-bootstrap.mjs", "/checkout/companion/src/server.mjs", "/bootstrap.mjs"]);
  const exists = candidate => files.has(candidate);
  assert.deepEqual(
    companionLauncher({ env: { FIGMA_BRIDGE_BOOTSTRAP: "/bootstrap.mjs", FIGMA_BRIDGE_STATE_DIR: "/state" }, execPath: "node", moduleDir: "/checkout/plugins/figma-bridge/mcp", exists }),
    { command: "node", args: ["/bootstrap.mjs", "companion"] }
  );
  assert.deepEqual(
    companionLauncher({ env: { FIGMA_BRIDGE_STATE_DIR: "/state" }, execPath: "node", moduleDir: "/checkout/plugins/figma-bridge/mcp", exists }),
    { command: "node", args: ["/checkout/companion/src/server.mjs"] }
  );
  assert.deepEqual(
    companionLauncher({ env: { FIGMA_BRIDGE_STATE_DIR: "/state" }, execPath: "node", moduleDir: "/cache/figma-bridge/mcp", exists }),
    { command: "node", args: ["/state/runtime/runtime-bootstrap.mjs", "companion"] }
  );
});

function rawExchange(endpoint, line) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        socket.destroy();
        resolve(buffer);
      }
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(line));
  });
}
