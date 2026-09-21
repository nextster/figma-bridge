import process from "node:process";
import { createAutostartRequest, isNotRunningError } from "./autostart.mjs";
import { createLocalHandoffStore } from "./local-handoff.mjs";
import { cleanMessage, createMcpHandler, createToolExecutor } from "./tools.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

const request = createAutostartRequest({ env: process.env });
const callTool = createToolExecutor({ request, handoffStore: createLocalHandoffStore({ env: process.env }) });
const handle = createMcpHandler({ callTool, describeError: friendlyError });

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) process.exit(1);
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim()) void respond(line);
  }
});

async function respond(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const response = await handle(message);
  if (response) write(response);
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function friendlyError(cause) {
  if (isNotRunningError(cause)) {
    return "Figma Bridge companion is not running and could not be started. Run `npm run setup` in the figma-bridge checkout, then open the Figma Bridge plugin in Figma Desktop.";
  }
  return cleanMessage(cause);
}
