#!/usr/bin/env node
import process from "node:process";
import { ensureState, requestControl } from "../../plugins/figma-bridge/mcp/control.mjs";

const command = process.argv[2] || "status";

try {
  if (command === "pair") {
    const state = ensureState();
    process.stdout.write(`${state.token}\n`);
  } else if (command === "status") {
    const status = await requestControl("bridge.status");
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else if (command === "files") {
    const clients = await requestControl("clients.list");
    process.stdout.write(`${JSON.stringify(clients, null, 2)}\n`);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`figma-bridge: ${error.message}\n`);
  process.exitCode = 1;
}
