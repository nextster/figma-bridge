// Short-lived downloads for SwiftUI handoff assets. The relay cannot write to
// the user's disk, so each handoff gets an unguessable capability URL that
// expires quickly. Assets live in memory with global and per-account caps.

import crypto from "node:crypto";
import { safeExtension, safeStem } from "../../plugins/figma-bridge/mcp/tools.mjs";

const MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["json", "application/json"]
]);

export function createAssetStore({
  issuer,
  ttlMs = 30 * 60_000,
  // The relay VM has 512 MiB; one full handoff is at most 64 MiB.
  maxBytes = 128 * 1024 * 1024,
  maxBytesPerAccount = 64 * 1024 * 1024,
  maxSessionsPerAccount = 20,
  now = () => Date.now()
}) {
  const sessions = new Map();

  function prune() {
    const timestamp = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(token);
    }
  }

  function usage(accountId) {
    let total = 0;
    let account = 0;
    let accountSessions = 0;
    for (const session of sessions.values()) {
      total += session.bytes;
      if (session.accountId === accountId) {
        account += session.bytes;
        accountSessions += 1;
      }
    }
    return { total, account, accountSessions };
  }

  function storeFor(accountId) {
    return {
      async open({ fileName }) {
        prune();
        if (usage(accountId).accountSessions >= maxSessionsPerAccount) throw new Error("Too many active handoff downloads; wait for earlier links to expire");
        const token = crypto.randomBytes(32).toString("base64url");
        const session = { accountId, expiresAt: now() + ttlMs, bytes: 0, files: new Map(), label: safeStem(fileName) };
        sessions.set(token, session);
        const base = `${issuer}/assets/${token}`;

        function add(name, extension, bytes) {
          const current = usage(accountId);
          if (current.total + bytes.byteLength > maxBytes || current.account + bytes.byteLength > maxBytesPerAccount) {
            throw new Error("Relay handoff storage limit reached");
          }
          const stem = safeStem(name);
          const cleanExtension = safeExtension(extension);
          let filename = `${stem}.${cleanExtension}`;
          for (let index = 2; session.files.has(filename); index += 1) filename = `${stem}-${index}.${cleanExtension}`;
          session.files.set(filename, { bytes, mimeType: MIME_TYPES.get(cleanExtension) || "application/octet-stream" });
          session.bytes += bytes.byteLength;
          return { filename, url: `${base}/${encodeURIComponent(filename)}` };
        }

        return {
          async save({ name, extension, bytes }) {
            return { url: add(name, extension, bytes).url };
          },
          describe() {
            return { downloadsExpireAt: new Date(session.expiresAt).toISOString() };
          },
          async saveManifest(handoff) {
            // Reserve the name first: an asset may already be called handoff.json.
            const reserved = add("handoff", "json", Buffer.alloc(0));
            const manifest = Buffer.from(`${JSON.stringify({ ...handoff, manifestUrl: reserved.url }, null, 2)}\n`);
            session.files.set(reserved.filename, { bytes: manifest, mimeType: "application/json" });
            session.bytes += manifest.byteLength;
            return { manifestUrl: reserved.url };
          }
        };
      }
    };
  }

  /** Serves GET/HEAD /assets/<token>/<filename>. Returns false for other paths. */
  function handle(request, response, url) {
    if (!url.pathname.startsWith("/assets/")) return false;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return true;
    }
    const [, , token, encodedName, ...rest] = url.pathname.split("/");
    let filename = "";
    try { filename = decodeURIComponent(encodedName || ""); } catch { filename = ""; }
    const session = sessions.get(token || "");
    const file = rest.length === 0 && session && session.expiresAt > now() ? session.files.get(filename) : null;
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found or expired\n");
      return true;
    }
    response.writeHead(200, {
      "content-type": file.mimeType,
      "content-length": file.bytes.byteLength,
      // SVG from the relay origin must never run script next to the OAuth pages.
      "content-disposition": `attachment; filename="${filename}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer"
    });
    response.end(request.method === "HEAD" ? undefined : file.bytes);
    return true;
  }

  const interval = setInterval(prune, 60_000);
  interval.unref();

  return { storeFor, handle, close: () => clearInterval(interval) };
}
