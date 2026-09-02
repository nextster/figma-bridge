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
const rgba = {
  ...rgb,
  properties: { ...rgb.properties, a: { type: "number", minimum: 0, maximum: 1 } }
};
const shaderColor = rgba;
const shaderPropertyValue = {
  anyOf: [
    { type: "boolean" },
    { type: "string", maxLength: 20000 },
    { type: "number", minimum: -1000000000, maximum: 1000000000 },
    shaderColor,
    vectorSchema(["x", "y"]),
    vectorSchema(["x", "y", "x2", "y2"]),
    vectorSchema(["x", "y", "radius"]),
    vectorSchema(["x", "y", "radius", "angle"]),
    {
      type: "object", additionalProperties: false,
      properties: { x: { type: "number" }, y: { type: "number" }, color: shaderColor },
      required: ["x", "y", "color"]
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        stops: {
          type: "array", minItems: 2, maxItems: 32,
          items: {
            type: "object", additionalProperties: false,
            properties: { position: { type: "number", minimum: 0, maximum: 1 }, color: shaderColor },
            required: ["position", "color"]
          }
        }
      },
      required: ["stops"]
    }
  ]
};
const shaderProperties = {
  type: "object",
  maxProperties: 64,
  propertyNames: { minLength: 1, maxLength: 256 },
  additionalProperties: shaderPropertyValue
};
const placement = {
  parentId: nodeId,
  index: { type: "integer", minimum: 0, maximum: 100000 },
  x: { type: "number", minimum: -1000000, maximum: 1000000 },
  y: { type: "number", minimum: -1000000, maximum: 1000000 }
};
const componentProperties = {
  type: "object", minProperties: 1, maxProperties: 50,
  additionalProperties: { oneOf: [{ type: "string", maxLength: 200 }, { type: "boolean" }] }
};
const stringProperties = {
  type: "object", minProperties: 1, maxProperties: 20,
  additionalProperties: { type: "string", minLength: 1, maxLength: 100 }
};
const padding = {
  oneOf: [
    { type: "number", minimum: 0, maximum: 100000 },
    {
      type: "object", additionalProperties: false,
      properties: Object.fromEntries(["all", "horizontal", "vertical", "top", "right", "bottom", "left"].map(key => [key, { type: "number", minimum: 0, maximum: 100000 }]))
    }
  ]
};
const paint = {
  type: "object", additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"] },
    color: rgb,
    opacity: { type: "number", minimum: 0, maximum: 1 },
    visible: { type: "boolean" },
    stops: {
      type: "array", minItems: 2, maxItems: 20,
      items: {
        type: "object", additionalProperties: false,
        properties: { position: { type: "number", minimum: 0, maximum: 1 }, color: rgba },
        required: ["position", "color"]
      }
    },
    transform: {
      type: "array", minItems: 2, maxItems: 2,
      items: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } }
    }
  },
  required: ["type"]
};
const effect = {
  type: "object", additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"] },
    color: rgba,
    offset: {
      type: "object", additionalProperties: false,
      properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"]
    },
    radius: { type: "number", minimum: 0, maximum: 100000 },
    spread: { type: "number", minimum: -100000, maximum: 100000 },
    visible: { type: "boolean" },
    blendMode: { type: "string", maxLength: 40 }
  },
  required: ["type", "radius"]
};
const tokenDefinition = {
  type: "object", minProperties: 2, maxProperties: 8,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 256 },
    value: {},
    light: {},
    dark: {},
    values: { type: "object", maxProperties: 8 }
  },
  required: ["name"],
  additionalProperties: true
};

const tools = [
  tool("status", "Diagnose the local companion and connected Figma plugin instances.", {}, readOnly),
  tool("list_files", "List open Figma files whose Figma Bridge plugin is currently connected.", {}, readOnly),
  tool("list_pages", "List every page in a connected Figma file and identify the current page.", { clientId }, readOnly),
  tool("set_current_page", "Switch the connected Figma plugin to an exact page ID from list_pages without editing the document.", {
    clientId,
    pageId: nodeId
  }, idempotentMutation, ["pageId"]),
  tool("snapshot", "Inspect the current Figma page or selection as a bounded node tree.", {
    clientId,
    scope: { type: "string", enum: ["page", "selection"], description: "Defaults to page." },
    depth,
    maxChildren
  }, readOnly),
  tool("document_overview", "Inspect all pages, top-level frames, components, component sets, and file statistics in one bounded call.", {
    clientId,
    maxTopLevelFrames: { type: "integer", minimum: 1, maximum: 1000 },
    maxComponents: { type: "integer", minimum: 1, maximum: 1000 }
  }, readOnly),
  tool("search_text", "Search literal text across every page without changing the file.", {
    clientId,
    query: { type: "string", minLength: 1, maxLength: 1000 },
    caseSensitive: { type: "boolean" },
    wholeWord: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 5000 }
  }, readOnly, ["query"]),
  tool("replace_text", "Preview or apply a literal whole-file text replacement. dryRun defaults to true.", {
    clientId,
    query: { type: "string", minLength: 1, maxLength: 1000 },
    replacement: { type: "string", maxLength: 20000 },
    caseSensitive: { type: "boolean" },
    wholeWord: { type: "boolean" },
    dryRun: { type: "boolean", description: "Defaults to true. Set false only after reviewing the preview." },
    limit: { type: "integer", minimum: 1, maximum: 5000 }
  }, mutation, ["query", "replacement"]),
  tool("navigate_to_nodes", "Switch to the containing page, select exact nodes, and focus them in Figma.", {
    clientId, nodeIds: idArray(), select: { type: "boolean" }, focus: { type: "boolean" }
  }, idempotentMutation, ["nodeIds"]),
  tool("audit_document", "Audit the whole file for weak names, unresolved instances, repeated colors, and inconsistent Auto Layout spacing.", {
    clientId, limit: { type: "integer", minimum: 1, maximum: 5000 }
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
  tool("set_auto_layout", "Set Auto Layout direction, gap, padding, alignment, and HUG/FILL/FIXED sizing on one exact node.", {
    clientId, nodeId,
    direction: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL"] },
    gap: { type: "number", minimum: -10000, maximum: 100000 },
    padding,
    primaryAlignment: { type: "string", enum: ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"] },
    counterAlignment: { type: "string", enum: ["MIN", "CENTER", "MAX", "BASELINE"] },
    primarySizing: { type: "string", enum: ["HUG", "FILL", "FIXED"] },
    counterSizing: { type: "string", enum: ["HUG", "FILL", "FIXED"] }
  }, idempotentMutation, ["nodeId"]),
  tool("set_visual_properties", "Set corner radii, fills or gradients, strokes, effects, and typography on one exact node.", {
    clientId, nodeId,
    cornerRadius: { oneOf: [{ type: "number", minimum: 0, maximum: 100000 }, { type: "object", additionalProperties: false, properties: Object.fromEntries(["all", "topLeft", "topRight", "bottomRight", "bottomLeft"].map(key => [key, { type: "number", minimum: 0, maximum: 100000 }])) }] },
    cornerSmoothing: { type: "number", minimum: 0, maximum: 1 },
    fills: { type: "array", maxItems: 16, items: paint },
    strokes: { type: "array", maxItems: 16, items: paint },
    strokeWeight: { type: "number", minimum: 0, maximum: 100000 },
    strokeAlign: { type: "string", enum: ["CENTER", "INSIDE", "OUTSIDE"] },
    dashPattern: { type: "array", maxItems: 32, items: { type: "number", minimum: 0, maximum: 100000 } },
    effects: { type: "array", maxItems: 16, items: effect },
    typography: { type: "object", maxProperties: 12, additionalProperties: true }
  }, idempotentMutation, ["nodeId"]),
  tool("list_shaders", "List shader fills and effects available to the connected file, including property definitions for imported shaders.", {
    clientId,
    query: { type: "string", maxLength: 256 },
    type: { type: "string", enum: ["fill", "effect"] },
    limit: { type: "integer", minimum: 1, maximum: 200 }
  }, readOnly),
  tool("apply_shader", "Import an available shader when needed and apply it to fills, strokes, or effects on exact nodes as one Undo transaction.", {
    clientId,
    nodeIds: idArray(),
    shaderId: { type: "string", minLength: 1, maxLength: 512 },
    target: { type: "string", enum: ["FILL", "STROKE", "EFFECT"], description: "Defaults to FILL for fill shaders and EFFECT for effect shaders." },
    properties: shaderProperties,
    mode: { type: "string", enum: ["REPLACE_SHADERS", "APPEND", "REPLACE_ALL"], description: "Defaults to REPLACE_SHADERS, preserving non-shader paints or effects." },
    visible: { type: "boolean" },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    blendMode: { type: "string", maxLength: 40 }
  }, mutation, ["nodeIds", "shaderId"]),
  tool("create_components", "Create empty components or convert exact scene nodes to components.", {
    clientId,
    components: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, properties: { nodeId, name: { type: "string", maxLength: 256 }, ...placement, width: { type: "number", minimum: 1, maximum: 100000 }, height: { type: "number", minimum: 1, maximum: 100000 }, variantProperties: stringProperties } } }
  }, mutation, ["components"]),
  tool("create_component_set", "Combine exact component IDs into a component set of variants.", {
    clientId, componentIds: idArray(), parentId: nodeId, index: placement.index, name: { type: "string", maxLength: 256 }
  }, mutation, ["componentIds"]),
  tool("create_instances", "Create instances from exact local component IDs and optionally set component properties.", {
    clientId,
    instances: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, properties: { componentId: nodeId, name: { type: "string", maxLength: 256 }, ...placement, properties: componentProperties }, required: ["componentId"] } }
  }, mutation, ["instances"]),
  tool("set_instance_properties", "Set variant or component properties on exact instances.", {
    clientId,
    updates: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, properties: { instanceId: nodeId, properties: componentProperties }, required: ["instanceId", "properties"] } }
  }, idempotentMutation, ["updates"]),
  tool("duplicate_nodes", "Duplicate exact nodes, optionally into another parent and position.", {
    clientId,
    items: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, properties: { nodeId, name: { type: "string", maxLength: 256 }, parentId: nodeId, index: placement.index, offsetX: placement.x, offsetY: placement.y }, required: ["nodeId"] } }
  }, mutation, ["items"]),
  tool("move_nodes", "Move or reparent exact nodes while optionally preserving their absolute position.", {
    clientId,
    moves: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, properties: { nodeId, parentId: nodeId, index: placement.index, preserveAbsolutePosition: { type: "boolean" } }, required: ["nodeId", "parentId"] } }
  }, mutation, ["moves"]),
  tool("reorder_nodes", "Move listed immediate children to the front of a parent in the supplied order.", {
    clientId, parentId: nodeId, nodeIds: idArray()
  }, mutation, ["parentId", "nodeIds"]),
  tool("group_nodes", "Group exact nodes under an optional parent.", {
    clientId, nodeIds: idArray(), parentId: nodeId, index: placement.index, name: { type: "string", maxLength: 256 }
  }, mutation, ["nodeIds"]),
  tool("ungroup_nodes", "Ungroup exact group-like containers.", { clientId, nodeIds: idArray() }, mutation, ["nodeIds"]),
  tool("upsert_design_tokens", "Create or update local color and spacing variables, Light/Dark modes, paint styles, and variable-bound typography styles.", {
    clientId,
    collectionName: { type: "string", maxLength: 256 },
    modes: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
    colors: { type: "array", maxItems: 100, items: tokenDefinition },
    spacing: { type: "array", maxItems: 100, items: tokenDefinition },
    typography: { type: "array", maxItems: 100, items: tokenDefinition }
  }, idempotentMutation),
  tool("list_design_tokens", "Inspect local variable collections, modes, variables, paint styles, and text styles.", {
    clientId,
    collectionName: { type: "string", minLength: 1, maxLength: 256 },
    limit: { type: "integer", minimum: 1, maximum: 1000 }
  }, readOnly),
  tool("delete_design_tokens", "Permanently delete exact local variable collections, variables, paint styles, or text styles.", {
    clientId,
    collectionIds: idArray(),
    variableIds: idArray(),
    paintStyleIds: idArray(),
    textStyleIds: idArray()
  }, destructive),
  tool("batch", "Preview or execute an allowlisted batch as one Undo step. dryRun defaults to true; set false only after reviewing the preview.", {
    clientId,
    dryRun: { type: "boolean" },
    operations: {
      type: "array", minItems: 1, maxItems: 100,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["createComponents", "createComponentSet", "createInstances", "setInstanceVariantProperties", "duplicateNodes", "moveNodes", "reorderNodes", "groupNodes", "ungroupNodes", "upsertDesignTokens", "applyAutoLayout", "applyVisualProperties", "searchReplaceText"] },
          args: { type: "object" }
        },
        required: ["kind", "args"]
      }
    }
  }, mutation, ["operations"]),
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
    list_pages: "document.pages",
    set_current_page: "document.setCurrentPage",
    snapshot: "document.snapshot",
    document_overview: "document.overview",
    search_text: "document.searchReplaceText",
    replace_text: "document.searchReplaceText",
    navigate_to_nodes: "document.navigate",
    audit_document: "document.audit",
    get_selection: "selection.get",
    get_nodes: "nodes.get",
    find_nodes: "nodes.find",
    create_nodes: "nodes.create",
    update_nodes: "nodes.update",
    set_auto_layout: "nodes.autoLayout",
    set_visual_properties: "nodes.visual",
    list_shaders: "shaders.list",
    apply_shader: "shaders.apply",
    create_components: "components.create",
    create_component_set: "components.createSet",
    create_instances: "instances.create",
    set_instance_properties: "instances.setProperties",
    duplicate_nodes: "nodes.duplicate",
    move_nodes: "nodes.move",
    reorder_nodes: "nodes.reorder",
    group_nodes: "nodes.group",
    ungroup_nodes: "nodes.ungroup",
    upsert_design_tokens: "designTokens.upsert",
    list_design_tokens: "designTokens.inspect",
    delete_design_tokens: "designTokens.delete",
    batch: "batch.execute",
    delete_nodes: "nodes.delete",
    export_png: "nodes.exportPng"
  };
  const command = map[name];
  if (!command) throw new Error(`Unknown tool: ${name}`);
  const { clientId, ...arguments_ } = args;
  if (name === "search_text") arguments_.dryRun = true;
  const response = await request("figma.call", { clientId, command, arguments: arguments_ });
  if (name === "export_png") {
    return { content: [
      { type: "text", text: JSON.stringify(response.node) },
      { type: "image", data: response.data, mimeType: response.mimeType || "image/png" }
    ] };
  }
  return textResult(response);
}

function vectorSchema(keys) {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(keys.map(key => [key, { type: "number", minimum: -1000000, maximum: 1000000 }])),
    required: keys
  };
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
