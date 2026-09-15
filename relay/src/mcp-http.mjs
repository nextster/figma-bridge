// Streamable HTTP MCP endpoint. Stateless: every POST carries a bearer token,
// is answered with a JSON body, and is routed to the Figma plugins of the
// account that owns the OAuth grant.

import { SERVER_VERSION, createMcpHandler, createToolExecutor } from "../../plugins/figma-bridge/mcp/tools.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createMcpEndpoint({ oauth, gateway, assets, limiter, allowedOrigins = [], logger = console }) {
  const origins = new Set(allowedOrigins);

  return async function handle(request, response) {
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      sendJson(response, 403, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Origin not allowed" } });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      response.end();
      return;
    }

    const grant = await authenticate(request);
    if (!grant) {
      response.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": `Bearer resource_metadata="${oauth.resourceMetadataUrl}", error="invalid_token"`
      });
      response.end(`${JSON.stringify({ error: "invalid_token", error_description: "A valid Figma Bridge access token is required" })}\n`);
      return;
    }

    if (limiter && !limiter.allow(`mcp:${grant.grantId}`, 600, 60_000)) {
      response.writeHead(429, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60" });
      response.end(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests" } })}\n`);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(request, MAX_BODY_BYTES));
    } catch (error) {
      const tooLarge = error?.code === "body_too_large";
      sendJson(response, tooLarge ? 413 : 400, { jsonrpc: "2.0", id: null, error: { code: tooLarge ? -32600 : -32700, message: tooLarge ? "Request too large" : "Parse error" } });
      return;
    }

    const handleMessage = handlerFor(grant.accountId);
    const messages = Array.isArray(payload) ? payload : [payload];
    if (messages.length === 0 || messages.length > 32) {
      sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid batch" } });
      return;
    }
    const responses = [];
    for (const message of messages) {
      // Client-sent responses and notifications need no reply.
      if (message && typeof message === "object" && message.method === undefined && (message.result !== undefined || message.error !== undefined)) continue;
      const result = await handleMessage(message);
      if (result) responses.push(result);
    }
    if (responses.length === 0) {
      response.writeHead(202, { "cache-control": "no-store" });
      response.end();
      return;
    }
    sendJson(response, 200, Array.isArray(payload) ? responses : responses[0]);
  };

  async function authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !/^Bearer\s+/i.test(header)) return null;
    try {
      return await oauth.verifyAccessToken(header.replace(/^Bearer\s+/i, "").trim());
    } catch (error) {
      logger.error?.(`Figma Bridge relay token verification failed: ${error?.message || error}`);
      return null;
    }
  }

  function handlerFor(accountId) {
    const request = async (method, params = {}) => {
      if (method === "bridge.status") {
        return {
          mode: "relay",
          version: SERVER_VERSION,
          clients: gateway.clients(accountId),
          activeClientId: gateway.activeClientId(accountId)
        };
      }
      if (method === "clients.list") return gateway.clients(accountId);
      if (method === "figma.call") return gateway.request(accountId, params.clientId, params.command, params.arguments || {});
      throw new Error(`unknown bridge method: ${method}`);
    };
    const callTool = createToolExecutor({ request, handoffStore: assets.storeFor(accountId), localFiles: false });
    return createMcpHandler({ callTool, localFiles: false, remote: true });
  }
}

export function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        request.destroy();
        reject(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}
