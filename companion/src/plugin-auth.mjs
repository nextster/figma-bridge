// Server side of the plugin authentication in figma-plugin/src/bridge-auth.js.

import crypto from "node:crypto";

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export function randomNonce() {
  return crypto.randomBytes(24).toString("base64url");
}

export function validNonce(value) {
  return typeof value === "string" && NONCE.test(value);
}

export function proof(key, purpose, serverNonce, clientNonce, extra = "") {
  return crypto.createHmac("sha256", key)
    .update(`figma-bridge/${purpose}\n${serverNonce}\n${clientNonce}${extra ? `\n${extra}` : ""}`)
    .digest("base64url");
}

export function proofMatches(expected, actual) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function pairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}
