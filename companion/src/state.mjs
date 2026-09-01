import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDirectory, stateFilePath } from "./paths.mjs";

const TOKEN_BYTES = 32;

export function ensureState(env = process.env) {
  const directory = stateDirectory(env);
  const file = stateFilePath(env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);

  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed.version !== 1 || typeof parsed.token !== "string" || parsed.token.length < 40) {
      throw new Error(`invalid Figma Bridge state: ${file}`);
    }
    fs.chmodSync(file, 0o600);
    return parsed;
  }

  const state = {
    version: 1,
    token: crypto.randomBytes(TOKEN_BYTES).toString("base64url"),
    createdAt: new Date().toISOString()
  };
  const temporary = path.join(directory, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return state;
}
