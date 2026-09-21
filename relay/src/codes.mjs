import crypto from "node:crypto";

// Crockford base32 without I, L, O, and U, so codes survive being read aloud or retyped.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let index = 0; index < length; index += 1) code += CODE_ALPHABET[bytes[index] & 31];
  return code;
}

export function formatCode(code) {
  return code.match(/.{1,4}/g).join("-");
}

export function normalizeCode(value) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[\s-]+/g, "").replaceAll("O", "0").replace(/[IL]/g, "1");
}

export function randomToken(prefix, bytes = 32) {
  return `${prefix}${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function secretMatches(value, expectedHash) {
  if (typeof value !== "string" || typeof expectedHash !== "string") return false;
  const actual = Buffer.from(hashSecret(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
