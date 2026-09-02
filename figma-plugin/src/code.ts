import {
  MAX_EXPORT_BYTES,
  MAX_NODES,
  color,
  nodeIds,
  numberIn,
  optionalNumber,
  optionalString,
  stringIn
} from "./validation";
import {
  auditDocument,
  navigateToNodes,
  overviewDocument,
  searchAndReplaceText
} from "./document-operations";
import {
  applyAutoLayout,
  applyVisualProperties,
  parseAutoLayoutOperation,
  parseVisualPropertiesOperation
} from "./design-operations";
import { applyShader, listShaders } from "./shader-operations";
import {
  createComponentSet,
  createComponents,
  createInstances,
  deleteDesignTokens,
  duplicateNodes,
  executeStructureBatch,
  groupNodes,
  inspectDesignTokens,
  moveNodes,
  reorderNodes,
  setInstanceVariantProperties,
  ungroupNodes,
  upsertDesignTokens,
  type ExternalBatchHandlers
} from "./structure-operations";
import { withUndoTransaction } from "./undo-transaction";

declare const __html__: string;

type CommandMessage = {
  type: "bridge-command";
  id: string;
  command: string;
  arguments?: Record<string, unknown>;
};

figma.showUI(__html__, { width: 360, height: 300, themeColors: true });

void initialize();

async function initialize(): Promise<void> {
  const token = await figma.clientStorage.getAsync("figma-bridge-token");
  figma.ui.postMessage({ type: "bridge-init", token: typeof token === "string" ? token : "", client: clientInfo() });
}

figma.ui.onmessage = async (message: CommandMessage | { type: "save-token" | "store-token"; token: string } | { type: "ui-ready" }) => {
  if (message.type === "ui-ready") {
    await initialize();
    return;
  }
  if (message.type === "save-token" || message.type === "store-token") {
    const token = stringIn(message.token, 40, 200, "Pairing token");
    await figma.clientStorage.setAsync("figma-bridge-token", token);
    if (message.type === "save-token") figma.ui.postMessage({ type: "token-saved", token, client: clientInfo() });
    return;
  }
  if (message.type !== "bridge-command") return;
  try {
    const result = await dispatch(message.command, message.arguments || {});
    figma.ui.postMessage({ type: "bridge-response", id: message.id, ok: true, result });
    figma.ui.postMessage({ type: "client-update", client: clientInfo() });
  } catch (error) {
    figma.ui.postMessage({
      type: "bridge-response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

figma.on("selectionchange", () => figma.ui.postMessage({ type: "client-update", client: clientInfo() }));
figma.on("currentpagechange", () => figma.ui.postMessage({ type: "client-update", client: clientInfo() }));

function clientInfo(): Record<string, string> {
  return {
    id: `${figma.fileKey || "local"}:${figma.currentPage.id}`,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    editorType: figma.editorType
  };
}

async function dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "document.pages":
      return listPages();
    case "document.setCurrentPage":
      return setCurrentPage(args);
    case "document.snapshot":
      return snapshot(args);
    case "document.overview":
      return overviewDocument(args);
    case "document.searchReplaceText":
      return searchAndReplaceText(args);
    case "document.navigate":
      return navigateToNodes(args);
    case "document.audit":
      return auditDocument(args);
    case "selection.get":
      return figma.currentPage.selection.map(node => serializeNode(node, boundedDepth(args.depth), boundedChildren(args.maxChildren)));
    case "nodes.get":
      return getNodes(args);
    case "nodes.find":
      return findNodes(args);
    case "nodes.create":
      return createNodes(args);
    case "nodes.update":
      return updateNodes(args);
    case "nodes.delete":
      return deleteNodes(args);
    case "nodes.exportPng":
      return exportPng(args);
    case "nodes.autoLayout":
      return applyAutoLayout(args);
    case "nodes.visual":
      return applyVisualProperties(args);
    case "shaders.list":
      return listShaders(args);
    case "shaders.apply":
      return applyShader(args);
    case "components.create":
      return createComponents(args);
    case "components.createSet":
      return createComponentSet(args);
    case "instances.create":
      return createInstances(args);
    case "instances.setProperties":
      return setInstanceVariantProperties(args);
    case "nodes.duplicate":
      return duplicateNodes(args);
    case "nodes.move":
      return moveNodes(args);
    case "nodes.reorder":
      return reorderNodes(args);
    case "nodes.group":
      return groupNodes(args);
    case "nodes.ungroup":
      return ungroupNodes(args);
    case "designTokens.upsert":
      return upsertDesignTokens(args);
    case "designTokens.inspect":
      return inspectDesignTokens(args);
    case "designTokens.delete":
      return deleteDesignTokens(args);
    case "batch.execute":
      return executeStructureBatch(args, batchHandlers());
    default:
      throw new Error(`Unsupported Figma command: ${command}`);
  }
}

function batchHandlers(): ExternalBatchHandlers {
  return {
    applyAutoLayout: {
      plan: async args => {
        const operation = parseAutoLayoutOperation(args);
        await sceneNode(operation.nodeId);
        return { summary: `Apply auto layout to ${operation.nodeId}`, affectedNodeIds: [operation.nodeId] };
      },
      execute: applyAutoLayout
    },
    applyVisualProperties: {
      plan: async args => {
        const operation = parseVisualPropertiesOperation(args);
        await sceneNode(operation.nodeId);
        return { summary: `Apply visual properties to ${operation.nodeId}`, affectedNodeIds: [operation.nodeId] };
      },
      execute: applyVisualProperties
    },
    searchReplaceText: {
      plan: async args => {
        const result = await searchAndReplaceText({ ...args, dryRun: true });
        const matches = Array.isArray(result.matches) ? result.matches : [];
        return {
          summary: `Replace ${String(result.occurrenceCount || 0)} text occurrence(s)`,
          affectedNodeIds: matches.flatMap(match =>
            match && typeof match === "object" && typeof (match as Record<string, unknown>).id === "string"
              ? [(match as Record<string, unknown>).id as string]
              : [])
        };
      },
      execute: args => searchAndReplaceText({ ...args, dryRun: false, commitUndo: false })
    }
  };
}

function listPages(): unknown[] {
  return figma.root.children.map(page => ({
    id: page.id,
    name: page.name,
    current: page.id === figma.currentPage.id
  }));
}

async function setCurrentPage(args: Record<string, unknown>): Promise<unknown> {
  const pageId = stringIn(args.pageId, 1, 128, "pageId");
  const page = figma.root.children.find(candidate => candidate.id === pageId);
  if (!page) throw new Error(`Figma page not found: ${pageId}`);
  await figma.setCurrentPageAsync(page);
  return { id: page.id, name: page.name, current: true };
}

function snapshot(args: Record<string, unknown>): unknown {
  const depth = boundedDepth(args.depth);
  const maxChildren = boundedChildren(args.maxChildren);
  const scope = args.scope === "selection" ? "selection" : "page";
  const roots = scope === "selection" ? figma.currentPage.selection : [figma.currentPage];
  return {
    fileName: figma.root.name,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    scope,
    selectionIds: figma.currentPage.selection.map(node => node.id),
    nodes: roots.map(node => serializeNode(node, depth, maxChildren))
  };
}

async function getNodes(args: Record<string, unknown>): Promise<unknown[]> {
  const ids = nodeIds(args.nodeIds);
  const depth = boundedDepth(args.depth);
  const maxChildren = boundedChildren(args.maxChildren);
  const nodes = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)));
  return nodes.map((node, index) => node && node.type !== "DOCUMENT"
    ? serializeNode(node as SceneNode | PageNode, depth, maxChildren)
    : { id: ids[index], missing: true });
}

function findNodes(args: Record<string, unknown>): unknown[] {
  const query = optionalString(args.query, 200, "query")?.toLocaleLowerCase() || "";
  const types = Array.isArray(args.types)
    ? new Set(args.types.slice(0, 30).map(value => stringIn(value, 1, 40, "type").toUpperCase()))
    : null;
  const limit = Math.round(optionalNumber(args.limit, 1, MAX_NODES, "limit") || 50);
  const matches: SceneNode[] = [];
  for (const node of figma.currentPage.findAll()) {
    if (types && !types.has(node.type)) continue;
    if (query && !node.name.toLocaleLowerCase().includes(query)) continue;
    matches.push(node);
    if (matches.length >= limit) break;
  }
  return matches.map(node => serializeNode(node, 0, 0));
}

async function createNodes(args: Record<string, unknown>): Promise<unknown[]> {
  if (!Array.isArray(args.nodes) || args.nodes.length < 1 || args.nodes.length > 50) {
    throw new Error("nodes must contain 1..50 creation specs");
  }
  const parent = await resolveParent(optionalString(args.parentId, 128, "parentId"));
  const created: SceneNode[] = [];
  for (const raw of args.nodes) {
    if (!raw || typeof raw !== "object") throw new Error("each node spec must be an object");
    const spec = raw as Record<string, unknown>;
    const type = stringIn(spec.type, 1, 20, "type").toUpperCase();
    let node: FrameNode | RectangleNode | EllipseNode | TextNode;
    if (type === "FRAME") node = figma.createFrame();
    else if (type === "RECTANGLE") node = figma.createRectangle();
    else if (type === "ELLIPSE") node = figma.createEllipse();
    else if (type === "TEXT") {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      node = figma.createText();
      node.fontName = { family: "Inter", style: "Regular" };
      node.characters = optionalString(spec.characters, 20_000, "characters") || "Text";
      node.fontSize = optionalNumber(spec.fontSize, 1, 512, "fontSize") || 16;
    } else throw new Error(`unsupported node type: ${type}`);

    node.name = optionalString(spec.name, 256, "name") || titleCase(type);
    if ("resize" in node && type !== "TEXT") {
      node.resize(
        optionalNumber(spec.width, 1, 100_000, "width") || 100,
        optionalNumber(spec.height, 1, 100_000, "height") || 100
      );
    }
    node.x = optionalNumber(spec.x, -1_000_000, 1_000_000, "x") || 0;
    node.y = optionalNumber(spec.y, -1_000_000, 1_000_000, "y") || 0;
    const fill = color(spec.fill);
    if (fill && "fills" in node) node.fills = [{ type: "SOLID", color: fill }];
    parent.appendChild(node);
    created.push(node);
  }
  figma.currentPage.selection = created;
  return created.map(node => serializeNode(node, 0, 0));
}

async function updateNodes(args: Record<string, unknown>): Promise<unknown[]> {
  if (!Array.isArray(args.updates) || args.updates.length < 1 || args.updates.length > 50) {
    throw new Error("updates must contain 1..50 entries");
  }
  const results: unknown[] = [];
  for (const raw of args.updates) {
    if (!raw || typeof raw !== "object") throw new Error("each update must be an object");
    const update = raw as Record<string, unknown>;
    const id = stringIn(update.id, 1, 128, "id");
    const node = await sceneNode(id);
    const name = optionalString(update.name, 256, "name");
    if (name !== undefined) node.name = name;
    const x = optionalNumber(update.x, -1_000_000, 1_000_000, "x");
    const y = optionalNumber(update.y, -1_000_000, 1_000_000, "y");
    if (x !== undefined && "x" in node) node.x = x;
    if (y !== undefined && "y" in node) node.y = y;
    const width = optionalNumber(update.width, 1, 100_000, "width");
    const height = optionalNumber(update.height, 1, 100_000, "height");
    if ((width !== undefined || height !== undefined) && "resize" in node && "width" in node && "height" in node) {
      node.resize(width || node.width, height || node.height);
    }
    if (typeof update.visible === "boolean") node.visible = update.visible;
    const opacity = optionalNumber(update.opacity, 0, 1, "opacity");
    if (opacity !== undefined && "opacity" in node) node.opacity = opacity;
    const fill = color(update.fill);
    if (fill && "fills" in node) node.fills = [{ type: "SOLID", color: fill }];
    const characters = optionalString(update.characters, 20_000, "characters");
    if (characters !== undefined) {
      if (node.type !== "TEXT") throw new Error(`${id} is not a text node`);
      await figma.loadFontAsync(node.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : node.fontName);
      node.characters = characters;
    }
    results.push(serializeNode(node, 0, 0));
  }
  return results;
}

async function deleteNodes(args: Record<string, unknown>): Promise<{ deleted: string[] }> {
  const ids = nodeIds(args.nodeIds);
  const nodes = await Promise.all(ids.map(sceneNode));
  return withUndoTransaction(async () => {
    for (const node of nodes) node.remove();
    return { deleted: ids };
  });
}

async function exportPng(args: Record<string, unknown>): Promise<unknown> {
  const scale = optionalNumber(args.scale, 0.25, 4, "scale") || 1;
  const id = optionalString(args.nodeId, 128, "nodeId");
  const node = id ? await sceneNode(id) : figma.currentPage.selection[0];
  if (!node || !("exportAsync" in node)) throw new Error("Select an exportable node or provide nodeId");
  const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new Error("PNG exceeds the 8 MiB bridge limit; lower scale or export a smaller node");
  return { node: serializeNode(node, 0, 0), mimeType: "image/png", data: figma.base64Encode(bytes) };
}

async function resolveParent(id?: string): Promise<PageNode | FrameNode | GroupNode | ComponentNode | InstanceNode | SectionNode> {
  if (!id) return figma.currentPage;
  const node = await figma.getNodeByIdAsync(id);
  if (!node || !("appendChild" in node)) throw new Error(`parent cannot contain children: ${id}`);
  return node as PageNode | FrameNode | GroupNode | ComponentNode | InstanceNode | SectionNode;
}

async function sceneNode(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`scene node not found: ${id}`);
  return node as SceneNode;
}

function serializeNode(node: SceneNode | PageNode, depth: number, maxChildren: number): Record<string, unknown> {
  const result: Record<string, unknown> = { id: node.id, name: node.name, type: node.type };
  if ("visible" in node) result.visible = node.visible;
  if ("x" in node) result.x = round(node.x);
  if ("y" in node) result.y = round(node.y);
  if ("width" in node) result.width = round(node.width);
  if ("height" in node) result.height = round(node.height);
  if ("opacity" in node) result.opacity = round(node.opacity);
  if (node.type === "TEXT") result.characters = node.characters.slice(0, 20_000);
  if ("fills" in node && node.fills !== figma.mixed) result.fills = summarizePaints(node.fills);
  if ("strokes" in node) result.strokes = summarizePaints(node.strokes);
  if ("effects" in node) result.effects = summarizeEffects(node.effects);
  if (depth > 0 && "children" in node) {
    result.children = node.children.slice(0, maxChildren).map(child => serializeNode(child, depth - 1, maxChildren));
    if (node.children.length > maxChildren) result.childrenTruncated = node.children.length - maxChildren;
  }
  return result;
}

function summarizePaints(paints: readonly Paint[]): unknown[] {
  return paints.slice(0, 8).map(paint => paint.type === "SOLID"
    ? { type: paint.type, color: paint.color, opacity: paint.opacity ?? 1, visible: paint.visible ?? true }
    : paint.type === "SHADER"
      ? { type: paint.type, id: paint.id, properties: paint.properties, opacity: paint.opacity ?? 1, visible: paint.visible ?? true, blendMode: paint.blendMode ?? "NORMAL" }
    : { type: paint.type, visible: paint.visible ?? true });
}

function summarizeEffects(effects: readonly Effect[]): unknown[] {
  return effects.slice(0, 8).map(effect => effect.type === "SHADER"
    ? { type: effect.type, id: effect.id, properties: effect.properties, visible: effect.visible }
    : { type: effect.type, visible: effect.visible });
}

function boundedDepth(value: unknown): number {
  return Math.round(optionalNumber(value, 0, 5, "depth") ?? 2);
}

function boundedChildren(value: unknown): number {
  return Math.round(optionalNumber(value, 1, 200, "maxChildren") ?? 50);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLocaleLowerCase();
}
