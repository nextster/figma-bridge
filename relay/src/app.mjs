import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { SERVER_VERSION } from "../../plugins/figma-bridge/mcp/tools.mjs";
import { createAccountsStore, migrateAccounts } from "./accounts-store.mjs";
import { createAssetStore } from "./assets.mjs";
import { createMcpEndpoint } from "./mcp-http.mjs";
import { createOAuthServer } from "./oauth.mjs";
import { createOAuthStore, migrateOAuth } from "./oauth-store.mjs";
import { createPluginGateway } from "./plugin-gateway.mjs";
import { clientAddress, createRateLimiter } from "./rate-limit.mjs";

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrateAccounts(db);
  migrateOAuth(db);
  return db;
}

/**
 * Builds the relay HTTP server without listening, so tests can bind a random
 * loopback port.
 */
export function createRelay({ config, db, logger = console, now = () => Date.now() }) {
  const clientIp = request => clientAddress(request, { trustProxy: config.trustProxy });
  const limiter = createRateLimiter({ now });
  const accounts = createAccountsStore(db, { now });
  let gateway;
  const oauth = createOAuthServer({
    issuer: config.publicUrl,
    store: createOAuthStore(db, { now: () => new Date(now()) }),
    now: () => new Date(now()),
    extraRedirectUris: config.extraRedirectUris,
    clientIp,
    logger,
    onGrantRevoked: ({ accountId, clientName, reason }) => gateway?.notifyAccount(accountId, { kind: "grant_revoked", clientName, reason })
  });
  gateway = createPluginGateway({ accounts, oauth, signup: config.signup, limiter, clientIp, logger, version: SERVER_VERSION });
  const assets = createAssetStore({ issuer: oauth.issuer, now });
  const mcp = createMcpEndpoint({
    oauth,
    gateway,
    assets,
    limiter,
    allowedOrigins: [new URL(oauth.issuer).origin, "https://claude.ai", "https://claude.com"],
    logger
  });

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    applySecurityHeaders(response);
    let url;
    try {
      url = new URL(request.url || "/", oauth.issuer);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    try {
      if (url.pathname === "/healthz") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(`${JSON.stringify({ ok: true, version: SERVER_VERSION })}\n`);
      } else if (url.pathname === "/mcp") {
        await mcp(request, response);
      } else if (assets.handle(request, response, url)) {
        // Served.
      } else if (await oauth.handle(request, response)) {
        // Served.
      } else if (url.pathname === "/" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end("Figma Bridge relay. Connect MCP clients to /mcp and the Figma Bridge plugin to /plugin.\n");
      } else {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
      }
    } catch (error) {
      logger.error?.(`Figma Bridge relay request failed: ${request.method} ${url.pathname}: ${error?.message || error}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("Internal error\n");
      } else {
        response.destroy();
      }
    } finally {
      // Asset paths are capability URLs, so their tokens never reach logs.
      if (config.logRequests) logger.info?.(`${request.method} ${url.pathname.startsWith("/assets/") ? "/assets/…" : url.pathname} ${response.statusCode} ${Date.now() - started}ms`);
    }
  });

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try { pathname = new URL(request.url || "/", oauth.issuer).pathname; } catch { pathname = ""; }
    if (pathname !== "/plugin") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    gateway.handleUpgrade(request, socket, head);
  });

  const pruneInterval = setInterval(() => accounts.prune(), 10 * 60_000);
  pruneInterval.unref();

  return {
    server,
    accounts,
    oauth,
    gateway,
    async close() {
      clearInterval(pruneInterval);
      assets.close();
      await gateway.close();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

export function relayConfig(env = process.env) {
  const publicUrl = (env.FIGMA_BRIDGE_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!publicUrl) throw new Error("FIGMA_BRIDGE_PUBLIC_URL is required, for example https://figma-bridge.fly.dev");
  const signup = env.FIGMA_BRIDGE_SIGNUP || "invite";
  if (!["invite", "open", "closed"].includes(signup)) throw new Error("FIGMA_BRIDGE_SIGNUP must be invite, open, or closed");
  const trustProxy = env.FIGMA_BRIDGE_TRUST_PROXY || "";
  if (trustProxy && trustProxy !== "fly") throw new Error("FIGMA_BRIDGE_TRUST_PROXY supports only fly");
  return {
    publicUrl,
    signup,
    trustProxy,
    port: Number(env.PORT || 8080),
    host: env.HOST || "0.0.0.0",
    database: env.FIGMA_BRIDGE_DB || "/data/figma-bridge.db",
    extraRedirectUris: (env.FIGMA_BRIDGE_OAUTH_REDIRECT_URIS || "").split(",").map(value => value.trim()).filter(Boolean),
    logRequests: env.FIGMA_BRIDGE_LOG_REQUESTS === "true"
  };
}

function applySecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("strict-transport-security", "max-age=31536000");
}
