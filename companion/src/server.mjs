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
  stateDirectory
} from "../../plugins/figma-bridge/mcp/control.mjs";
import { cleanError, createFigmaHub } from "./hub.mjs";

const VERSION = "0.2.0";
const DEFAULT_PORT = 3847;
const MAX_WS_BYTES = 8 * 1024 * 1024;
const STARTUP_CLIENT_WAIT_MS = 4000;
const STARTUP_WINDOW_MS = 15_000;

export async function startBridgeServer(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const logger = options.logger || console;
  const port = Number(options.port ?? env.FIGMA_BRIDGE_PORT ?? DEFAULT_PORT);
  const approvePairing = options.approvePairing || createPairingApprover({ platform, env, logger });
  const startedAt = Date.now();
  const hub = createFigmaHub();
  let pairingInProgress = false;

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid FIGMA_BRIDGE_PORT");

  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });
  const httpServers = [];
  // Owning the loopback port is the single-instance lock. Bind it before
  // touching state or the control endpoint so a second companion cannot
  // replace the endpoint of a running one.
  httpServers.push(await listenHttp("127.0.0.1"));
  const ipv6 = await listenHttp("::1").catch(error => {
    logger.info?.(`Figma Bridge IPv6 loopback unavailable: ${error.code || cleanError(error)}`);
    return null;
  });
  if (ipv6) httpServers.push(ipv6);

  let state;
  let endpoint;
  let controlServer;
  let ownedSocket = null;
  try {
    state = ensureState(env, platform);
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
    let authenticatedClientId = null;
    let pairingPending = false;
    const authenticationTimeout = setTimeout(() => websocket.close(4401, "authentication required"), 5000);

    websocket.on("message", raw => void handleMessage(raw));

    async function handleMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        websocket.close(4400, "invalid JSON");
        return;
      }

      if (!authenticatedClientId) {
        if (message.type === "pair") {
          if (pairingPending || pairingInProgress || !isAllowedPairingOrigin(request.headers.origin)) {
            websocket.close(4403, "pairing unavailable");
            return;
          }
          pairingPending = true;
          pairingInProgress = true;
          clearTimeout(authenticationTimeout);
          let approved = false;
          try {
            approved = await approvePairing({ origin: request.headers.origin || "", client: message.client || {} });
          } catch (error) {
            logger.error?.(`Figma Bridge pairing approval failed: ${cleanError(error)}`);
          } finally {
            pairingInProgress = false;
          }
          if (!approved || websocket.readyState !== websocket.OPEN) {
            websocket.close(4403, "pairing denied");
            return;
          }
          authenticatedClientId = hub.register(websocket, message.client);
          websocket.send(JSON.stringify({ type: "pair.ok", token: state.token }));
          websocket.send(JSON.stringify({ type: "auth.ok", clientId: authenticatedClientId, version: VERSION }));
          return;
        }
        if (message.type !== "auth" || !constantTimeEqual(message.token, state.token)) {
          websocket.close(4403, "authentication failed");
          return;
        }
        clearTimeout(authenticationTimeout);
        authenticatedClientId = hub.register(websocket, message.client);
        websocket.send(JSON.stringify({ type: "auth.ok", clientId: authenticatedClientId, version: VERSION }));
        return;
      }

      hub.handleMessage(authenticatedClientId, websocket, message);
    }

    websocket.on("close", () => {
      clearTimeout(authenticationTimeout);
      if (authenticatedClientId) hub.unregister(authenticatedClientId, websocket);
    });
  });

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

const PAIRING_PROMPT = "Figma Bridge wants to connect the open Figma plugin to your AI app. Approve only if you just clicked Connect in Figma.";

/** Returns the platform's native approval dialog command, or null when none exists. */
export function pairingDialogCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    const script = `display dialog "${PAIRING_PROMPT}" with title "Figma Bridge" buttons {"Cancel", "Connect"} default button "Connect" cancel button "Cancel" with icon note giving up after 30`;
    return {
      command: "/usr/bin/osascript",
      args: ["-e", script],
      approved: (code, output) => code === 0 && output.includes("button returned:Connect") && !output.includes("gave up:true")
    };
  }
  if (platform === "win32") {
    // WScript.Shell.Popup: 1 = OK/Cancel, 32 = question icon, 4096 = system modal; 30 s timeout returns -1.
    const script = [
      "$shell = New-Object -ComObject WScript.Shell",
      `$result = $shell.Popup('${PAIRING_PROMPT.replaceAll("'", "''")}', 30, 'Figma Bridge', 4129)`,
      "[Console]::Out.Write([string]$result)"
    ].join("\n");
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    return {
      command: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      approved: (code, output) => code === 0 && output.trim() === "1"
    };
  }
  return null;
}

function createPairingApprover({ platform, env, logger }) {
  const dialog = pairingDialogCommand(platform, env);
  if (!dialog) {
    return async () => {
      logger.error?.("Automatic pairing needs a desktop approval dialog, which is unavailable on this platform. Run `npm run bridge -- pair` and paste the token into the plugin.");
      return false;
    };
  }
  return () => new Promise((resolve, reject) => {
    const child = spawn(dialog.command, dialog.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-4096); });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", code => resolve(dialog.approved(code, output)));
  });
}

function constantTimeEqual(first, second) {
  if (typeof first !== "string" || typeof second !== "string") return false;
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
