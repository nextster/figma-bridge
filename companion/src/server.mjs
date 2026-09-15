import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  controlEndpoint,
  createControlServer,
  ensureState,
  isPipeEndpoint,
  rotateControlId,
  stateDirectory
} from "../../plugins/figma-bridge/mcp/control.mjs";
import { cleanError, createFigmaHub } from "./hub.mjs";
import { pairingCode, proof, proofMatches, randomNonce, validNonce } from "./plugin-auth.mjs";

const VERSION = "0.2.0";
const DEFAULT_PORT = 3847;
// Plugin exports are capped at 8 MiB raw, which is about 10.7 MiB as base64 JSON.
const MAX_WS_BYTES = 12 * 1024 * 1024;
const STARTUP_CLIENT_WAIT_MS = 4000;
const STARTUP_WINDOW_MS = 15_000;
const AUTH_TIMEOUT_MS = 5000;
const PAIRING_TTL_MS = 2 * 60_000;
const PAIRING_MIN_INTERVAL_MS = 10_000;
const PAIRING_WINDOW_MS = 10 * 60_000;
const PAIRING_MAX_PER_WINDOW = 5;

export async function startBridgeServer(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const logger = options.logger || console;
  const port = Number(options.port ?? env.FIGMA_BRIDGE_PORT ?? DEFAULT_PORT);
  const showPairingCode = options.showPairingCode || createPairingDialog({ platform, env, logger });
  const startedAt = Date.now();
  const hub = createFigmaHub();
  const pairingStarts = [];
  let pairingInProgress = false;

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid FIGMA_BRIDGE_PORT");

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });
  const httpServers = [];
  // Owning the loopback port is the single-instance lock. Bind it before
  // touching state or the control endpoint so a second companion cannot
  // replace the endpoint of a running one.
  httpServers.push(await listenHttp("127.0.0.1"));
  const ipv6 = await listenHttp("::1").catch(async error => {
    // Another process on [::1] would receive plugin connections for
    // "localhost", so only a missing IPv6 stack is tolerated.
    if (error?.code === "EADDRINUSE") {
      await Promise.all(httpServers.map(server => new Promise(resolve => server.close(() => resolve()))));
      throw error;
    }
    logger.info?.(`Figma Bridge IPv6 loopback unavailable: ${error.code || cleanError(error)}`);
    return null;
  });
  if (ipv6) httpServers.push(ipv6);

  let state;
  let endpoint;
  let controlServer;
  let ownedSocket = null;
  try {
    // A fresh pipe name per start keeps a name seen earlier from being squatted.
    state = rotateControlId(ensureState(env, platform), env, platform);
    endpoint = controlEndpoint({ env, platform, state });
    controlServer = createControlServer({ secret: state.controlSecret, dispatch });
    if (!isPipeEndpoint(endpoint)) {
      fs.mkdirSync(stateDirectory(env), { recursive: true, mode: 0o700 });
      fs.rmSync(endpoint, { force: true });
    }
    await new Promise((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(endpoint, resolve);
    });
    if (!isPipeEndpoint(endpoint)) {
      fs.chmodSync(endpoint, 0o600);
      ownedSocket = fs.statSync(endpoint);
    }
  } catch (error) {
    // Release the port so a failed start does not leave a process that blocks the next one.
    await Promise.all(httpServers.map(server => new Promise(resolve => server.close(() => resolve()))));
    controlServer?.close();
    throw error;
  }
  logger.info?.(`Figma Bridge ${VERSION} listening on 127.0.0.1:${port}${ipv6 ? ` and [::1]:${port}` : ""}`);

  websocketServer.on("connection", (websocket, request) => {
    const serverNonce = randomNonce();
    let authenticatedClientId = null;
    let pairing = null;
    let authenticationTimeout = setTimeout(() => websocket.terminate(), AUTH_TIMEOUT_MS);
    websocket.on("error", () => websocket.terminate());
    websocket.on("message", raw => void handleMessage(raw));
    // The plugin proves it knows the token (or the pairing code) against this
    // nonce before the companion reveals anything or sends commands.
    websocket.send(JSON.stringify({ type: "hello", protocol: 2, nonce: serverNonce, version: VERSION }));

    async function handleMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        websocket.close(4400, "invalid JSON");
        return;
      }
      if (authenticatedClientId) {
        hub.handleMessage(authenticatedClientId, websocket, message);
        return;
      }

      if (message.type === "auth") {
        if (!validNonce(message.nonce) || !proofMatches(proof(state.token, "auth/client", serverNonce, message.nonce), message.proof)) {
          websocket.close(4403, "authentication failed");
          return;
        }
        authenticate(message.client);
        send({ type: "auth.ok", clientId: authenticatedClientId, version: VERSION, proof: proof(state.token, "auth/server", serverNonce, message.nonce) });
        return;
      }

      if (message.type === "pair") {
        if (pairing || !isAllowedPairingOrigin(request.headers.origin) || !startPairing()) {
          websocket.close(4403, "pairing unavailable");
          return;
        }
        clearTimeout(authenticationTimeout);
        authenticationTimeout = setTimeout(() => websocket.close(4408, "pairing expired"), PAIRING_TTL_MS);
        pairing = { code: pairingCode(), dialog: null };
        try {
          pairing.dialog = showPairingCode({ code: pairing.code, origin: request.headers.origin || "" });
        } catch (error) {
          logger.error?.(`Figma Bridge pairing dialog failed: ${cleanError(error)}`);
          websocket.close(4403, "pairing unavailable");
          return;
        }
        pairing.dialog?.cancelled?.then(cancelled => {
          if (cancelled && !authenticatedClientId) websocket.close(4403, "pairing cancelled");
        }, error => logger.error?.(`Figma Bridge pairing dialog failed: ${cleanError(error)}`));
        send({ type: "pair.code", expiresInMs: PAIRING_TTL_MS });
        return;
      }

      if (message.type === "pair.proof" && pairing?.code) {
        const { code } = pairing;
        pairing.code = null;
        // One guess per dialog: a wrong code ends the pairing attempt.
        if (!validNonce(message.nonce) || !proofMatches(proof(code, "pair/client", serverNonce, message.nonce), message.proof)) {
          websocket.close(4403, "pairing failed");
          return;
        }
        pairing.dialog?.dismiss?.();
        authenticate(message.client);
        send({ type: "pair.ok", token: state.token, proof: proof(code, "pair/server", serverNonce, message.nonce, state.token) });
        send({ type: "auth.ok", clientId: authenticatedClientId, version: VERSION });
        return;
      }

      websocket.close(4401, "authentication required");
    }

    function authenticate(client) {
      clearTimeout(authenticationTimeout);
      authenticatedClientId = hub.register(websocket, client);
    }

    function send(value) {
      if (websocket.readyState === websocket.OPEN) websocket.send(JSON.stringify(value));
    }

    websocket.on("close", () => {
      clearTimeout(authenticationTimeout);
      if (pairing) {
        pairing.dialog?.dismiss?.();
        pairingInProgress = false;
      }
      if (authenticatedClientId) hub.unregister(authenticatedClientId, websocket);
    });
  });

  // Any local web page can open a WebSocket with Origin "null", so pairing
  // dialogs are serialized and rate limited.
  function startPairing() {
    const now = Date.now();
    while (pairingStarts.length && now - pairingStarts[0] > PAIRING_WINDOW_MS) pairingStarts.shift();
    if (pairingInProgress || pairingStarts.length >= PAIRING_MAX_PER_WINDOW) return false;
    if (pairingStarts.length && now - pairingStarts.at(-1) < PAIRING_MIN_INTERVAL_MS) return false;
    pairingStarts.push(now);
    pairingInProgress = true;
    return true;
  }

  async function dispatch(method, params) {
    if (method === "bridge.status") {
      return {
        version: VERSION,
        pid: process.pid,
        platform,
        runtime: { source: env.FIGMA_BRIDGE_ACTIVE_SOURCE || "direct", entrypoint: env.FIGMA_BRIDGE_ACTIVE_ENTRYPOINT || null },
        controlEndpoint: endpoint,
        websocket: `ws://localhost:${port}/bridge`,
        clients: hub.publicClients(),
        activeClientId: hub.activeClientId
      };
    }
    if (method === "clients.list") return hub.publicClients();
    if (method === "figma.call") {
      if (typeof params.command !== "string" || !params.command) throw new Error("command is required");
      const waitForClientMs = Date.now() - startedAt < STARTUP_WINDOW_MS ? STARTUP_CLIENT_WAIT_MS : 0;
      return hub.request(params.clientId, params.command, params.arguments || {}, { waitForClientMs });
    }
    if (method === "bridge.shutdown") {
      setImmediate(() => void close().then(() => options.onShutdown?.()));
      return { stopping: true, pid: process.pid };
    }
    throw new Error(`unknown bridge method: ${method || "<missing>"}`);
  }

  function listenHttp(host) {
    const server = http.createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(`${JSON.stringify({ ok: true, version: VERSION, clients: hub.size })}\n`);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found\n");
    });
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url || "/", "http://localhost").pathname !== "/bridge") {
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, websocket => websocketServer.emit("connection", websocket, request));
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host, ipv6Only: host === "::1" }, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }

  let closing = null;
  function close() {
    closing ||= (async () => {
      hub.closeAll(1001, "bridge shutting down");
      for (const client of websocketServer.clients) client.terminate();
      await Promise.all([
        new Promise(resolve => websocketServer.close(() => resolve())),
        ...httpServers.map(server => new Promise(resolve => server.close(() => resolve()))),
        new Promise(resolve => controlServer.close(() => resolve()))
      ]);
      if (!ownedSocket) return;
      try {
        const currentSocket = fs.statSync(endpoint);
        if (currentSocket.dev === ownedSocket.dev && currentSocket.ino === ownedSocket.ino) fs.unlinkSync(endpoint);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    })();
    return closing;
  }

  return { close, port, controlEndpoint: endpoint, socketPath: endpoint, token: state.token, controlSecret: state.controlSecret };
}

function isAllowedPairingOrigin(origin) {
  return origin === "null" || origin === "https://www.figma.com";
}

/** Returns the platform's native pairing-code dialog, or null when none exists. */
export function pairingDialogCommand(platform = process.platform, env = process.env, code = "000000") {
  if (!/^\d{6}$/.test(code)) throw new Error("pairing code must be six digits");
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const prompt = `Figma Bridge pairing code: ${spaced}. Enter it in the Figma Bridge plugin. If you did not just click Connect in Figma, choose Cancel.`;
  if (platform === "darwin") {
    const script = `display dialog "${prompt}" with title "Figma Bridge" buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel" with icon note giving up after 120`;
    return {
      command: "/usr/bin/osascript",
      args: ["-e", script],
      cancelled: (exitCode, output) => exitCode !== 0 && !output.includes("gave up:true")
    };
  }
  if (platform === "win32") {
    // WScript.Shell.Popup: 1 = OK/Cancel, 64 = information icon, 4096 = system modal; Cancel returns 2.
    const script = [
      "$shell = New-Object -ComObject WScript.Shell",
      `$result = $shell.Popup('${prompt}', 120, 'Figma Bridge', 4161)`,
      "[Console]::Out.Write([string]$result)"
    ].join("\n");
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    return {
      command: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      cancelled: (exitCode, output) => exitCode === 0 && output.trim() === "2"
    };
  }
  return null;
}

function createPairingDialog({ platform, env, logger }) {
  return ({ code }) => {
    const dialog = pairingDialogCommand(platform, env, code);
    if (!dialog) {
      logger.error?.("Automatic pairing needs a desktop dialog, which is unavailable on this platform. Run `npm run bridge -- pair` and paste the token into the plugin.");
      throw new Error("no pairing dialog on this platform");
    }
    const child = spawn(dialog.command, dialog.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-4096); });
    const cancelled = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve(signal ? false : dialog.cancelled(exitCode, output)));
    });
    return { cancelled, dismiss: () => { if (child.exitCode === null) child.kill(); } };
  };
}

export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  let server;
  try {
    server = await startBridgeServer({ onShutdown: () => process.exit(0) });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      console.error("Figma Bridge companion is already running.");
      process.exit(0);
    }
    throw error;
  }
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
