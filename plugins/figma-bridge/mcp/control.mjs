// Owner-only control channel between MCP adapters and the local companion.
//
// POSIX uses a 0600 Unix socket in the state directory. Windows uses a named
// pipe whose name contains a random per-install id. Pipes are not protected by
// file permissions, so every request and response is authenticated with an
// HMAC keyed by a secret that lives only in the owner's state file. Requests
// carry a nonce and timestamp and are rejected when replayed or stale.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const CONTROL_PROTOCOL = 2;
const STATE_VERSION = 1;
const TOKEN_BYTES = 32;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_REMEMBERED_NONCES = 10_000;
const PIPE_PREFIX = "\\\\.\\pipe\\";

export function stateDirectory(env = process.env) {
  return path.resolve(env.FIGMA_BRIDGE_STATE_DIR || path.join(os.homedir(), ".figma-bridge"));
}

export function stateFilePath(env = process.env) {
  return path.join(stateDirectory(env), "state.json");
}

/** Reads the state file without creating it. Returns null when it is missing. */
export function readState(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(stateFilePath(env), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (parsed.version !== STATE_VERSION || typeof parsed.token !== "string" || parsed.token.length < 40) {
    throw new Error(`invalid Figma Bridge state: ${stateFilePath(env)}`);
  }
  return parsed;
}

/**
 * Creates the owner-only state file on first use and adds control-channel
 * credentials to states written by older versions.
 */
export function ensureState(env = process.env, platform = process.platform) {
  const directory = stateDirectory(env);
  const file = stateFilePath(env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") fs.chmodSync(directory, 0o700);

  let state = readState(env);
  if (!state) {
    const created = {
      version: STATE_VERSION,
      token: randomSecret(),
      controlSecret: randomSecret(),
      controlId: crypto.randomBytes(16).toString("hex"),
      createdAt: new Date().toISOString()
    };
    const temporary = temporaryPath(directory);
    fs.writeFileSync(temporary, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    try {
      // link() fails when another process created the state first; that state wins.
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    state = readState(env);
  }
  if (!validControlCredentials(state)) {
    state = {
      ...state,
      controlSecret: randomSecret(),
      controlId: crypto.randomBytes(16).toString("hex")
    };
    const temporary = temporaryPath(directory);
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  }
  if (platform !== "win32") fs.chmodSync(file, 0o600);
  return state;
}

/** Assigns a new random pipe id; called by the companion that owns the port. */
export function rotateControlId(state, env = process.env, platform = process.platform) {
  const next = { ...state, controlId: crypto.randomBytes(16).toString("hex") };
  const directory = stateDirectory(env);
  const temporary = temporaryPath(directory);
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, stateFilePath(env));
  if (platform !== "win32") fs.chmodSync(stateFilePath(env), 0o600);
  return next;
}

export function controlEndpoint({ env = process.env, platform = process.platform, state } = {}) {
  const override = env.FIGMA_BRIDGE_SOCKET;
  if (override) return override.startsWith(PIPE_PREFIX) ? override : path.resolve(override);
  if (platform === "win32") {
    if (!validControlCredentials(state)) throw new Error("Figma Bridge state has no control credentials");
    return `${PIPE_PREFIX}figma-bridge-${state.controlId}`;
  }
  const socketPath = path.join(stateDirectory(env), "control.sock");
  // sockaddr_un limits Unix socket paths to 104 bytes on macOS and 108 on Linux.
  if (Buffer.byteLength(socketPath) > 103) throw new Error(`Figma Bridge control socket path is too long: ${socketPath}. Set FIGMA_BRIDGE_SOCKET to a shorter owner-only path.`);
  return socketPath;
}

export function isPipeEndpoint(endpoint) {
  return typeof endpoint === "string" && endpoint.startsWith(PIPE_PREFIX);
}

/**
 * Creates the companion side of the channel. dispatch(method, params) returns
 * the result or throws; errors are returned as authenticated failures.
 */
export function createControlServer({ secret, dispatch, now = Date.now }) {
  if (typeof secret !== "string" || secret.length < 40) throw new Error("control secret is required");
  const seenNonces = new Map();

  return net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void handleLine(socket, line);
      }
    });
  });

  async function handleLine(socket, line) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ v: CONTROL_PROTOCOL, error: "invalid control request" })}\n`);
      return;
    }
    const verified = verifyRequest(envelope);
    if (!verified.ok) {
      socket.end(`${JSON.stringify({ v: CONTROL_PROTOCOL, error: verified.error })}\n`);
      return;
    }
    let request;
    let response;
    try {
      request = JSON.parse(envelope.body);
      const result = await dispatch(request.method, request.params || {});
      response = { id: request.id ?? null, ok: true, result };
    } catch (error) {
      response = { id: request?.id ?? null, ok: false, error: cleanError(error) };
    }
    if (socket.destroyed) return;
    const body = JSON.stringify(response);
    socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL, body, mac: mac(secret, "res", envelope.nonce, body) })}\n`);
  }

  function verifyRequest(envelope) {
    if (!envelope || envelope.v !== CONTROL_PROTOCOL) return { ok: false, error: "unsupported control protocol" };
    const { nonce, ts, body } = envelope;
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !Number.isSafeInteger(ts) || typeof body !== "string") {
      return { ok: false, error: "invalid control request" };
    }
    if (!macMatches(envelope.mac, mac(secret, "req", nonce, `${ts}\n${body}`))) return { ok: false, error: "control authentication failed" };
    const current = now();
    if (Math.abs(current - ts) > MAX_CLOCK_SKEW_MS) return { ok: false, error: "stale control request" };
    for (const [seen, expiresAt] of seenNonces) {
      if (expiresAt > current && seenNonces.size < MAX_REMEMBERED_NONCES) break;
      seenNonces.delete(seen);
    }
    if (seenNonces.has(nonce)) return { ok: false, error: "replayed control request" };
    seenNonces.set(nonce, current + 2 * MAX_CLOCK_SKEW_MS);
    return { ok: true };
  }
}

/**
 * Sends one authenticated request. Reads the state file for credentials unless
 * endpoint and secret are supplied explicitly.
 */
export function requestControl(method, params = {}, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  let secret = options.secret;
  let endpoint = options.endpoint;
  if (!secret || !endpoint) {
    const state = readState(env);
    if (!state || !validControlCredentials(state)) {
      const error = new Error("Figma Bridge companion has not initialized its state yet");
      error.code = "ENOENT";
      return Promise.reject(error);
    }
    secret ||= state.controlSecret;
    endpoint ||= controlEndpoint({ env, platform, state });
  }
  const timeoutMs = options.timeoutMs || 35_000;
  const nonce = crypto.randomBytes(18).toString("base64url");
  const ts = Date.now();
  const body = JSON.stringify({ id: 1, method, params });

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error(`Figma Bridge request timed out: ${method}`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", error => finish(error));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("Figma Bridge response exceeded 64 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const envelope = JSON.parse(buffer.slice(0, newline));
        if (typeof envelope.body !== "string" || !macMatches(envelope.mac, mac(secret, "res", nonce, envelope.body))) {
          finish(new Error("Figma Bridge control response failed authentication"));
          return;
        }
        const response = JSON.parse(envelope.body);
        if (response.ok) finish(null, response.result);
        else finish(new Error(response.error || "Figma Bridge request failed"));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("end", () => finish(new Error("Figma Bridge closed the control connection")));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ v: CONTROL_PROTOCOL, nonce, ts, body, mac: mac(secret, "req", nonce, `${ts}\n${body}`) })}\n`);
    });
  });
}

export function isConnectionError(error) {
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code);
}

function validControlCredentials(state) {
  return typeof state?.controlSecret === "string" && state.controlSecret.length >= 40 &&
    typeof state.controlId === "string" && /^[a-f0-9]{32}$/.test(state.controlId);
}

function mac(secret, direction, nonce, payload) {
  return crypto.createHmac("sha256", secret).update(`figma-bridge-control\n${direction}\n${nonce}\n${payload}`).digest("base64url");
}

function macMatches(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomSecret() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function temporaryPath(directory) {
  return path.join(directory, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
}
