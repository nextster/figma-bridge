import os from "node:os";
import path from "node:path";

export function stateDirectory(env = process.env) {
  return path.resolve(env.FIGMA_BRIDGE_STATE_DIR || path.join(os.homedir(), ".figma-bridge"));
}

export function controlSocketPath(env = process.env) {
  return path.resolve(env.FIGMA_BRIDGE_SOCKET || path.join(stateDirectory(env), "control.sock"));
}

export function stateFilePath(env = process.env) {
  return path.join(stateDirectory(env), "state.json");
}
