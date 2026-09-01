import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const NAME = "figma-bridge";
const VERSION = "0.1.0";
const PROTOCOL = "2025-06-18";
const socketPath = path.resolve(process.env.FIGMA_BRIDGE_SOCKET || path.join(os.homedir(), ".figma-bridge", "control.sock"));

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const idempotentMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const clientId = { type: "string", minLength: 1, maxLength: 128, description: "Optional Figma client id from list_files. Omit to use the most recently active file." };
const nodeId = { type: "string", minLength: 1, maxLength: 128 };
const depth = { type: "integer", minimum: 0, maximum: 5, description: "Nested child depth. Defaults to 2." };
const maxChildren = { type: "integer", minimum: 1, maximum: 200, description: "Maximum children per node. Defaults to 50." };
const rgb = {
  type: "object",
  additionalProperties: false,
  properties: {
    r: { type: "number", minimum: 0, maximum: 1 },
    g: { type: "number", minimum: 0, maximum: 1 },
    b: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["r", "g", "b"]
};

const tools = [
  tool("status", "Diagnose the local companion and connected Figma plugin instances.", {}, readOnly),
  tool("list_files", "List open Figma files whose Figma Bridge plugin is currently connected.", {}, readOnly),
  tool("snapshot", "Inspect the current Figma page or selection as a bounded node tree.", {
    clientId,
    scope: { type: "string", enum: ["page", "selection"], description: "Defaults to page." },
    depth,
    maxChildren
  }, readOnly),
  tool("get_selection", "Inspect the current Figma selection.", { clientId, depth, maxChildren }, readOnly),
  tool("get_nodes", "Inspect explicitly identified Figma nodes.", { clientId, nodeIds: idArray(), depth, maxChildren }, readOnly, ["nodeIds"]),
  tool("find_nodes", "Find nodes on the current page by name substring and/or node type.", {
    clientId,
    query: { type: "string", maxLength: 200 },
    types: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 40 } },
    limit: { type: "integer", minimum: 1, maximum: 100 }
  }, readOnly),
  tool("create_nodes", "Create frames, rectangles, ellipses, or text in the current Figma page or an explicit parent.", {
    clientId,
    parentId: nodeId,
    nodes: {
      type: "array", minItems: 1, maxItems: 50,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["FRAME", "RECTANGLE", "ELLIPSE", "TEXT"] },
          name: { type: "string", maxLength: 256 },
          x: { type: "number", minimum: -1000000, maximum: 1000000 },
          y: { type: "number", minimum: -1000000, maximum: 1000000 },
          width: { type: "number", minimum: 1, maximum: 100000 },
          height: { type: "number", minimum: 1, maximum: 100000 },
          characters: { type: "string", maxLength: 20000 },
          fontSize: { type: "number", minimum: 1, maximum: 512 },
          fill: rgb
        },
        required: ["type"]
      }
    }
  }, mutation, ["nodes"]),
  tool("update_nodes", "Update safe visual and layout properties on explicitly identified Figma nodes.", {
    clientId,
    updates: {
      type: "array", minItems: 1, maxItems: 50,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          id: nodeId,
          name: { type: "string", maxLength: 256 },
          x: { type: "number", minimum: -1000000, maximum: 1000000 },
          y: { type: "number", minimum: -1000000, maximum: 1000000 },
          width: { type: "number", minimum: 1, maximum: 100000 },
          height: { type: "number", minimum: 1, maximum: 100000 },
          visible: { type: "boolean" },
          opacity: { type: "number", minimum: 0, maximum: 1 },
          characters: { type: "string", maxLength: 20000 },
          fill: rgb
        },
        required: ["id"]
      }
    }
  }, idempotentMutation, ["updates"]),
  tool("delete_nodes", "Permanently delete explicitly identified Figma nodes.", { clientId, nodeIds: idArray() }, destructive, ["nodeIds"]),
  tool("export_png", "Export an explicit node, or the first selected node, as a PNG image.", {
    clientId,
    nodeId,
    scale: { type: "number", minimum: 0.25, maximum: 4, description: "Export scale. Defaults to 1." }
  }, readOnly)
];

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > 8 * 1024 * 1024) process.exit(1);
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim()) void handle(line);
  }
});

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.method === "initialize") {
      return result(message.id, {
        protocolVersion: message.params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
        instructions: "Use Figma Bridge only when its plugin is open in the intended Figma Desktop file. Inspect before mutating, target exact node IDs, and treat delete_nodes as destructive."
      });
    }
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
    if (message.method === "ping") return result(message.id, {});
    if (message.method === "tools/list") return result(message.id, { tools });
    if (message.method === "tools/call") return result(message.id, await callTool(message.params?.name, message.params?.arguments || {}));
    if (message.id != null) error(message.id, -32601, `Unknown method: ${message.method || "<missing>"}`);
  } catch (cause) {
    if (message?.method === "tools/call") result(message.id, textResult(friendlyError(cause), true));
    else error(message?.id ?? null, -32603, friendlyError(cause));
  }
}

async function callTool(name, args) {
  if (name === "status") return textResult(await request("bridge.status"));
  if (name === "list_files") return textResult(await request("clients.list"));
  const map = {
    snapshot: "document.snapshot",
    get_selection: "selection.get",
    get_nodes: "nodes.get",
    find_nodes: "nodes.find",
    create_nodes: "nodes.create",
    update_nodes: "nodes.update",
    delete_nodes: "nodes.delete",
    export_png: "nodes.exportPng"
  };
  const command = map[name];
  if (!command) throw new Error(`Unknown tool: ${name}`);
  const { clientId, ...arguments_ } = args;
  const response = await request("figma.call", { clientId, command, arguments: arguments_ });
  if (name === "export_png") {
    return { content: [
      { type: "text", text: JSON.stringify(response.node) },
      { type: "image", data: response.data, mimeType: response.mimeType || "image/png" }
    ] };
  }
  return textResult(response);
}

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => socket.destroy(new Error(`Figma Bridge timed out: ${method}`)), 35_000);
    socket.setEncoding("utf8");
    socket.once("error", cause => { clearTimeout(timeout); reject(cause); });
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error || "Figma Bridge request failed"));
      } catch (cause) { reject(cause); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
  });
}

function tool(name, description, properties, annotations, required = []) {
  return { name, description, inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) }, annotations };
}

function idArray() {
  return { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: nodeId };
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function friendlyError(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause?.code === "ENOENT" || cause?.code === "ECONNREFUSED") {
    return "Figma Bridge companion is not running. Run `npm run setup` in the figma-bridge checkout, then open the Figma Bridge plugin in Figma Desktop.";
  }
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
}
