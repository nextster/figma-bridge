import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { stateDirectory } from "./control.mjs";
import { safeStem } from "./tools.mjs";

/** Saves SwiftUI handoff assets as owner-only files on the local disk. */
export function createLocalHandoffStore({ env = process.env } = {}) {
  return {
    async open({ fileName, outputDirectory }) {
      const directory = await handoffDirectory(env, outputDirectory, fileName);
      const usedNames = new Set();
      return {
        async save({ name, extension, bytes }) {
          const destination = path.join(directory, await uniqueFilename(directory, name, extension, usedNames));
          await fs.writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
          return { path: destination };
        },
        describe() {
          return { outputDirectory: directory };
        },
        async saveManifest(handoff) {
          const manifestPath = path.join(directory, await uniqueFilename(directory, "handoff", "json", usedNames));
          await fs.writeFile(manifestPath, `${JSON.stringify({ ...handoff, manifestPath }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
          return { manifestPath };
        }
      };
    }
  };
}

async function handoffDirectory(env, requested, fileName) {
  if (requested !== undefined) {
    if (typeof requested !== "string" || !path.isAbsolute(requested)) throw new Error("outputDirectory must be an absolute path");
    const resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new Error("outputDirectory must be a dedicated subdirectory");
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    return resolved;
  }
  const root = path.join(stateDirectory(env), "handoffs");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(root, `${safeStem(fileName)}-${stamp}`);
  await fs.mkdir(directory, { mode: 0o700 });
  return directory;
}

async function uniqueFilename(directory, name, extension, used) {
  const stem = safeStem(name);
  let candidate = `${stem}.${extension}`;
  let index = 2;
  while (used.has(candidate) || await exists(path.join(directory, candidate))) candidate = `${stem}-${index++}.${extension}`;
  used.add(candidate);
  return candidate;
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
