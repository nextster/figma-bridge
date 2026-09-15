// Registry of authenticated Figma plugin connections and the RPC exchange with
// them. Used by the local companion (one hub) and the relay (one hub per account).

import crypto from "node:crypto";

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
// Bounds memory when a plugin stops reading: commands queue on the socket and
// in the pending map until they time out.
export const DEFAULT_MAX_PENDING = 64;
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export function createFigmaHub({ rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS, maxPending = DEFAULT_MAX_PENDING, maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES } = {}) {
  const clients = new Map();
  const pending = new Map();
  const waiters = new Set();
  let activeClientId = null;
  const requestPrefix = `rpc-${crypto.randomBytes(6).toString("hex")}`;
  let nextRequestId = 1;

  function register(websocket, rawClient) {
    const clientId = normalizeClientId(rawClient?.id);
    const info = sanitizeClientInfo(rawClient, clientId);
    clients.set(clientId, { websocket, info, connectedAt: new Date().toISOString() });
    activeClientId = clientId;
    for (const wake of waiters) wake();
    return clientId;
  }

  /** Handles post-authentication plugin messages. Returns true when consumed. */
  function handleMessage(clientId, websocket, message) {
    const client = clients.get(clientId);
    if (message.type === "client.update") {
      if (client?.websocket === websocket) client.info = sanitizeClientInfo({ ...client.info, ...message.client }, clientId);
      return true;
    }
    if (message.type === "rpc.response" && typeof message.id === "string") {
      const entry = pending.get(message.id);
      if (!entry || entry.clientId !== clientId || entry.websocket !== websocket) return true;
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(cleanError(message.error)));
      return true;
    }
    return false;
  }

  function unregister(clientId, websocket) {
    const current = clients.get(clientId);
    if (current?.websocket === websocket) clients.delete(clientId);
    if (activeClientId === clientId && !clients.has(clientId)) activeClientId = [...clients.keys()].at(-1) || null;
    for (const [id, entry] of pending) {
      if (entry.websocket !== websocket) continue;
      pending.delete(id);
      clearTimeout(entry.timeout);
      entry.reject(new Error("Figma plugin disconnected"));
    }
  }

  async function request(clientId, command, args, { waitForClientMs = 0 } = {}) {
    if (!clientId && clients.size === 0 && waitForClientMs > 0) await waitForClient(waitForClientMs);
    const targetId = clientId || activeClientId;
    if (!targetId) throw new Error("No Figma plugin is connected. Run Figma Bridge in the target Figma file.");
    const client = clients.get(targetId);
    if (!client || client.websocket.readyState !== client.websocket.OPEN) {
      throw new Error(`Figma client is not connected: ${targetId}`);
    }
    if (pending.size >= maxPending) throw new Error("Too many Figma commands are waiting; try again when earlier commands finish");
    if ((client.websocket.bufferedAmount || 0) > maxBufferedBytes) throw new Error("The Figma plugin is not accepting commands right now; try again shortly");
    const id = `${requestPrefix}-${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Figma command timed out after ${rpcTimeoutMs} ms: ${command}`));
      }, rpcTimeoutMs);
      pending.set(id, { clientId: targetId, websocket: client.websocket, resolve, reject, timeout });
      client.websocket.send(JSON.stringify({ type: "rpc.request", id, command, arguments: args }));
    });
  }

  function waitForClient(timeoutMs) {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  function publicClients() {
    return [...clients.values()].map(client => ({ ...client.info, connectedAt: client.connectedAt }));
  }

  function closeAll(code, reason) {
    for (const client of clients.values()) client.websocket.close(code, reason);
  }

  return {
    register,
    handleMessage,
    unregister,
    request,
    publicClients,
    closeAll,
    get activeClientId() { return activeClientId; },
    get size() { return clients.size; }
  };
}

export function normalizeClientId(value) {
  const cleaned = typeof value === "string" ? value.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128) : "";
  return cleaned || `figma-${crypto.randomBytes(6).toString("hex")}`;
}

export function sanitizeClientInfo(value, id) {
  return {
    id,
    fileName: cleanString(value?.fileName, 256) || "Untitled",
    pageName: cleanString(value?.pageName, 256) || "Unknown page",
    editorType: cleanString(value?.editorType, 32) || "figma"
  };
}

export function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function cleanString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
