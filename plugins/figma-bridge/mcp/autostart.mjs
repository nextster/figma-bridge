// Starts the local companion on demand so MCP clients work without a login
// service. The companion owns the loopback port, so concurrent starts are safe:
// only one process can bind it and the others exit.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requestControl, stateDirectory } from "./control.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const START_WAIT_MS = 8000;
const RELAUNCH_INTERVAL_MS = 15_000;

/** Connection failures that prove the request never reached a companion. */
export function isNotRunningError(error) {
  return error?.code === "ENOENT" || error?.code === "ECONNREFUSED";
}

export function companionLauncher({ env = process.env, execPath = process.execPath, moduleDir = moduleDirectory, exists = fs.existsSync } = {}) {
  if (env.FIGMA_BRIDGE_BOOTSTRAP && exists(env.FIGMA_BRIDGE_BOOTSTRAP)) {
    return { command: execPath, args: [env.FIGMA_BRIDGE_BOOTSTRAP, "companion"] };
  }
  const sibling = path.resolve(moduleDir, "..", "..", "..", "companion", "src", "server.mjs");
  if (exists(sibling)) return { command: execPath, args: [sibling] };
  const stable = path.join(stateDirectory(env), "runtime", "runtime-bootstrap.mjs");
  if (exists(stable)) return { command: execPath, args: [stable, "companion"] };
  return null;
}

export function launchCompanion({ command, args }, env = process.env) {
  const directory = stateDirectory(env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(directory, "companion.log"), "a", 0o600);
  try {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true, env });
    child.on("error", () => {});
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

export function createAutostartRequest({
  env = process.env,
  request = requestControl,
  launcher = companionLauncher,
  launch = launchCompanion,
  now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
  let lastLaunch = -Infinity;
  return async function autostartRequest(method, params = {}) {
    try {
      return await request(method, params, { env });
    } catch (error) {
      if (!isNotRunningError(error) || env.FIGMA_BRIDGE_AUTOSTART === "0") throw error;
      const target = launcher({ env });
      if (!target) throw error;
      if (now() - lastLaunch > RELAUNCH_INTERVAL_MS) {
        lastLaunch = now();
        launch(target, env);
      }
      const deadline = now() + START_WAIT_MS;
      let lastError = error;
      while (now() < deadline) {
        await sleep(150);
        try {
          return await request(method, params, { env });
        } catch (retryError) {
          if (!isNotRunningError(retryError)) throw retryError;
          lastError = retryError;
        }
      }
      throw lastError;
    }
  };
}
