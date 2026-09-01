import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { WebSocketServer } from "ws";
import { controlSocketPath, stateDirectory } from "./paths.mjs";
import { ensureState } from "./state.mjs";

const VERSION = "0.1.0";
const DEFAULT_PORT = 3847;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_WS_BYTES = 8 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

export async function startBridgeServer(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const state = ensureState(env);
  const socketPath = controlSocketPath(env);
  const port = Number(options.port ?? env.FIGMA_BRIDGE_PORT ?? DEFAULT_PORT);
  const clients = new Map();
  const pending = new Map();
  let activeClientId = null;
  let nextRequestId = 1;

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid FIGMA_BRIDGE_PORT");
  fs.mkdirSync(stateDirectory(env), { recursive: true, mode: 0o700 });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  const httpServer = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(`${JSON.stringify({ ok: true, version: VERSION, clients: clients.size })}\n`);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found\n");
  });
  const websocketServer = new WebSocketServer({ server: httpServer, path: "/bridge", maxPayload: MAX_WS_BYTES });

  websocketServer.on("connection", websocket => {
    let authenticatedClientId = null;
    const authenticationTimeout = setTimeout(() => websocket.close(4401, "authentication required"), 5000);

    websocket.on("message", raw => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        websocket.close(4400, "invalid JSON");
        return;
      }

      if (!authenticatedClientId) {
        if (message.type !== "auth" || !constantTimeEqual(message.token, state.token)) {
          websocket.close(4403, "authentication failed");
          return;
        }
        clearTimeout(authenticationTimeout);
        authenticatedClientId = normalizeClientId(message.client?.id);
        const info = sanitizeClientInfo(message.client, authenticatedClientId);
        clients.set(authenticatedClientId, { websocket, info, connectedAt: new Date().toISOString() });
        activeClientId = authenticatedClientId;
        websocket.send(JSON.stringify({ type: "auth.ok", clientId: authenticatedClientId, version: VERSION }));
        return;
      }

      if (message.type === "client.update") {
        const client = clients.get(authenticatedClientId);
        if (client) client.info = sanitizeClientInfo({ ...client.info, ...message.client }, authenticatedClientId);
        return;
      }

      if (message.type === "rpc.response" && typeof message.id === "string") {
        const entry = pending.get(message.id);
        if (!entry || entry.clientId !== authenticatedClientId) return;
        pending.delete(message.id);
        clearTimeout(entry.timeout);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(cleanError(message.error)));
      }
    });

    websocket.on("close", () => {
      clearTimeout(authenticationTimeout);
      if (!authenticatedClientId) return;
      const current = clients.get(authenticatedClientId);
      if (current?.websocket === websocket) clients.delete(authenticatedClientId);
      if (activeClientId === authenticatedClientId) activeClientId = [...clients.keys()].at(-1) || null;
      for (const [id, entry] of pending) {
        if (entry.clientId !== authenticatedClientId) continue;
        pending.delete(id);
        clearTimeout(entry.timeout);
        entry.reject(new Error("Figma plugin disconnected"));
      }
    });
  });

  const controlServer = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        socket.destroy(new Error("control request exceeded 2 MiB"));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void handleControlLine(socket, line);
      }
    });
  });

  async function handleControlLine(socket, line) {
    let request;
    try {
      request = JSON.parse(line);
      const result = await dispatch(request.method, request.params || {});
      socket.write(`${JSON.stringify({ id: request.id ?? null, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ id: request?.id ?? null, ok: false, error: cleanError(error) })}\n`);
    }
  }

  async function dispatch(method, params) {
    if (method === "bridge.status") {
      return {
        version: VERSION,
        pid: process.pid,
        socketPath,
        websocket: `ws://127.0.0.1:${port}/bridge`,
        clients: publicClients(clients),
        activeClientId
      };
    }
    if (method === "clients.list") return publicClients(clients);
    if (method === "figma.call") {
      if (typeof params.command !== "string" || !params.command) throw new Error("command is required");
      return requestFigma(params.clientId || activeClientId, params.command, params.arguments || {});
    }
    throw new Error(`unknown bridge method: ${method || "<missing>"}`);
  }

  function requestFigma(clientId, command, args) {
    if (!clientId) throw new Error("No Figma plugin is connected. Run Figma Bridge in the target Figma file.");
    const client = clients.get(clientId);
    if (!client || client.websocket.readyState !== client.websocket.OPEN) {
      throw new Error(`Figma client is not connected: ${clientId}`);
    }
    const id = `rpc-${process.pid}-${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Figma command timed out after ${RPC_TIMEOUT_MS} ms: ${command}`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { clientId, resolve, reject, timeout });
      client.websocket.send(JSON.stringify({ type: "rpc.request", id, command, arguments: args }));
    });
  }

  await Promise.all([
    new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, "127.0.0.1", resolve);
    }),
    new Promise((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(socketPath, resolve);
    })
  ]);
  fs.chmodSync(socketPath, 0o600);
  logger.info?.(`Figma Bridge ${VERSION} listening on 127.0.0.1:${port}`);

  async function close() {
    for (const client of clients.values()) client.websocket.close(1001, "bridge shutting down");
    await Promise.all([
      new Promise(resolve => websocketServer.close(() => resolve())),
      new Promise(resolve => httpServer.close(() => resolve())),
      new Promise(resolve => controlServer.close(() => resolve()))
    ]);
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  }

  return { close, port, socketPath, token: state.token };
}

function constantTimeEqual(first, second) {
  if (typeof first !== "string" || typeof second !== "string") return false;
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && cryptoSafeEqual(a, b);
}

function cryptoSafeEqual(first, second) {
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) difference |= first[index] ^ second[index];
  return difference === 0;
}

function normalizeClientId(value) {
  const cleaned = typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128) : "";
  return cleaned || `figma-${Date.now().toString(36)}`;
}

function sanitizeClientInfo(value, id) {
  return {
    id,
    fileName: cleanString(value?.fileName, 256) || "Untitled",
    pageName: cleanString(value?.pageName, 256) || "Unknown page",
    editorType: cleanString(value?.editorType, 32) || "figma"
  };
}

function publicClients(clients) {
  return [...clients.values()].map(client => ({ ...client.info, connectedAt: client.connectedAt }));
}

function cleanString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startBridgeServer();
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
