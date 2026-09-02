import { MAX_EXPORT_BYTES, nodeIds, optionalNumber } from "./validation";

type Json = Record<string, unknown>;
type AssetRequest = {
  key: string;
  kind: "screen-png" | "image-fill" | "vector-svg";
  nodeId: string;
  name: string;
  imageHash?: string;
};

const MAX_SCREENS = 20;
const MAX_HANDOFF_NODES = 5_000;
const MAX_ASSETS = 300;

const SF_SYMBOL_ALIASES: Record<string, string> = {
  "arrow left": "chevron.left",
  "arrow right": "chevron.right",
  back: "chevron.left",
  bell: "bell",
  calendar: "calendar",
  check: "checkmark",
  close: "xmark",
  globe: "globe",
  grid: "square.grid.2x2",
  history: "clock.arrow.circlepath",
  home: "house",
  mic: "mic",
  microphone: "mic",
  more: "ellipsis",
  paintbrush: "paintbrush",
  search: "magnifyingglass",
  settings: "gearshape",
  user: "person.crop.circle",
  x: "xmark"
};
const KNOWN_SF_SYMBOLS = new Set(Object.values(SF_SYMBOL_ALIASES));

/** Collect a compact, implementation-oriented snapshot and an export plan in one plugin call. */
export async function prepareSwiftUIHandoff(args: Json): Promise<Json> {
  assertKnownKeys(args, ["screenIds", "maxNodes", "maxAssets", "includeHidden"], "SwiftUI handoff");
  const screenIds = nodeIds(args.screenIds, "screenIds");
  if (screenIds.length > MAX_SCREENS) throw new Error(`screenIds must contain at most ${MAX_SCREENS} IDs`);
  const maxNodes = Math.round(optionalNumber(args.maxNodes, 1, MAX_HANDOFF_NODES, "maxNodes") ?? 2_000);
  const maxAssets = Math.round(optionalNumber(args.maxAssets, 1, MAX_ASSETS, "maxAssets") ?? 150);
  const includeHidden = args.includeHidden === true;
  const screens = await Promise.all(screenIds.map(requireSceneNode));
  const state = createState(maxNodes, maxAssets, includeHidden);
  for (const screen of screens) addAsset(state, {
    key: `screen:${screen.id}`,
    kind: "screen-png",
    nodeId: screen.id,
    name: screen.name
  });
  const trees = await Promise.all(screens.map(screen => visit(screen, state)));
  const designTokens = await localDesignTokens();

  const fileKey = figma.fileKey || undefined;
  return {
    format: "figma-swiftui-handoff@1",
    file: { name: figma.root.name, key: fileKey },
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    screens: trees.filter(Boolean),
    tokens: tokenSummary(state.tokens),
    designTokens,
    texts: state.texts,
    assets: state.assets.map(asset => asset.public),
    sfSymbols: state.sfSymbols,
    shaders: state.shaders,
    truncated: {
      nodes: state.skippedNodes,
      assets: state.skippedAssets
    },
    figmaUrl: fileKey ? figmaNodeUrl(fileKey, screens[0].id) : undefined,
    shaderSourceAccess: {
      availableThroughPluginApi: false,
      instruction: "Open Tools, find the shader, choose its menu, then View code. The bridge can read applied shader IDs and properties but not source code.",
      deeplink: fileKey ? figmaNodeUrl(fileKey, screens[0].id) : undefined,
      deeplinkScope: "file-and-node-only"
    },
    _assetRequests: state.assets.map(asset => asset.request)
  };
}

/** Internal export command used by the MCP adapter while completing a handoff. */
export async function exportHandoffAsset(args: Json): Promise<Json> {
  assertKnownKeys(args, ["kind", "nodeId", "imageHash", "scale"], "handoff asset export");
  const kind = requiredString(args.kind, "kind");
  if (kind === "image-fill") {
    const imageHash = requiredString(args.imageHash, "imageHash");
    const image = figma.getImageByHash(imageHash);
    if (!image) throw new Error(`image fill is unavailable: ${imageHash}`);
    const bytes = await image.getBytesAsync();
    assertExportSize(bytes, "image fill");
    const detected = detectImage(bytes);
    return { data: figma.base64Encode(bytes), mimeType: detected.mimeType, extension: detected.extension, bytes: bytes.byteLength };
  }

  const node = await requireSceneNode(requiredString(args.nodeId, "nodeId"));
  if (kind === "vector-svg") {
    const bytes = await node.exportAsync({ format: "SVG", svgOutlineText: false, svgIdAttribute: true });
    assertExportSize(bytes, "SVG");
    return { data: figma.base64Encode(bytes), mimeType: "image/svg+xml", extension: "svg", bytes: bytes.byteLength };
  }
  if (kind === "screen-png") {
    const scale = optionalNumber(args.scale, 0.25, 4, "scale") ?? 1;
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    assertExportSize(bytes, "PNG");
    return { data: figma.base64Encode(bytes), mimeType: "image/png", extension: "png", bytes: bytes.byteLength };
  }
  throw new Error(`unsupported handoff asset kind: ${kind}`);
}

type State = ReturnType<typeof createState>;

function createState(maxNodes: number, maxAssets: number, includeHidden: boolean) {
  return {
    maxNodes, maxAssets, includeHidden,
    nodeCount: 0, skippedNodes: 0, skippedAssets: 0,
    assets: [] as Array<{ request: AssetRequest; public: Json }>,
    assetKeys: new Set<string>(),
    texts: [] as Json[],
    sfSymbols: [] as Json[],
    shaders: [] as Json[],
    shaderKeys: new Set<string>(),
    tokens: {
      colors: new Map<string, { value: RGBA; count: number }>(),
      typography: new Map<string, { value: Json; count: number }>(),
      spacing: new Map<string, number>(),
      radii: new Map<string, number>()
    }
  };
}

async function visit(node: SceneNode, state: State, suppressVectorExport = false): Promise<Json | null> {
  if (!state.includeHidden && node.visible === false) return null;
  if (state.nodeCount >= state.maxNodes) {
    state.skippedNodes += 1;
    return null;
  }
  state.nodeCount += 1;
  const result: Json = {
    id: node.id,
    name: node.name,
    type: node.type,
    frame: "x" in node ? { x: round(node.x), y: round(node.y), width: round(node.width), height: round(node.height) } : undefined
  };
  if (node.visible === false) result.visible = false;
  if ("opacity" in node && node.opacity !== 1) result.opacity = round(node.opacity);
  const layout = layoutSummary(node, state);
  if (layout) result.layout = layout;
  const corners = cornerSummary(node, state);
  if (corners !== undefined) result.corners = corners;
  if (node.type === "TEXT") {
    const text = textSummary(node);
    result.text = text;
    state.texts.push({ nodeId: node.id, name: node.name, ...text });
    countTypography(state, text);
  }
  if ("fills" in node && node.fills !== figma.mixed) result.fills = paintsSummary(node, node.fills, "FILL", state);
  if ("strokes" in node) result.strokes = paintsSummary(node, node.strokes, "STROKE", state);
  if ("effects" in node && node.effects.length > 0) result.effects = effectsSummary(node, state);
  if (node.type === "INSTANCE") {
    const mainComponent = await node.getMainComponentAsync();
    result.component = { mainComponentId: mainComponent?.id, properties: node.componentProperties };
  }

  const symbol = iconSized(node) ? recognizeSFSymbol(node.name) : undefined;
  if (symbol) {
    const entry = { nodeId: node.id, nodeName: node.name, symbol: symbol.name, confidence: symbol.confidence, exportSkipped: true };
    state.sfSymbols.push(entry);
    result.sfSymbol = entry;
  } else if (!suppressVectorExport && isVectorAsset(node)) {
    addAsset(state, { key: `vector:${node.id}`, kind: "vector-svg", nodeId: node.id, name: node.name });
  }

  if ("children" in node) {
    const visited = await Promise.all(node.children.map(child => visit(child, state, suppressVectorExport || Boolean(symbol))));
    const children = visited.filter((child): child is Json => child !== null);
    if (children.length > 0) result.children = children;
  }
  return compact(result);
}

function layoutSummary(node: SceneNode, state: State): Json | undefined {
  const result: Json = {};
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    result.mode = node.layoutMode;
    result.gap = node.itemSpacing;
    result.padding = { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft };
    result.primaryAlignment = node.primaryAxisAlignItems;
    result.counterAlignment = node.counterAxisAlignItems;
    result.primarySizing = node.primaryAxisSizingMode;
    result.counterSizing = node.counterAxisSizingMode;
    countNumber(state.tokens.spacing, node.itemSpacing);
    [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].forEach(value => countNumber(state.tokens.spacing, value));
  }
  if ("layoutSizingHorizontal" in node) {
    result.horizontal = node.layoutSizingHorizontal;
    result.vertical = node.layoutSizingVertical;
    if (node.layoutGrow !== 0) result.grow = node.layoutGrow;
    if (node.layoutAlign !== "INHERIT") result.align = node.layoutAlign;
    if (node.layoutPositioning !== "AUTO") result.positioning = node.layoutPositioning;
  }
  if ("constraints" in node) result.constraints = node.constraints;
  return Object.keys(result).length > 0 ? result : undefined;
}

function cornerSummary(node: SceneNode, state: State): unknown {
  if (!("cornerRadius" in node)) return undefined;
  if (typeof node.cornerRadius === "number") {
    countNumber(state.tokens.radii, node.cornerRadius);
    return round(node.cornerRadius);
  }
  if (!("topLeftRadius" in node)) return undefined;
  const corners = {
    topLeft: round(node.topLeftRadius), topRight: round(node.topRightRadius),
    bottomRight: round(node.bottomRightRadius), bottomLeft: round(node.bottomLeftRadius)
  };
  Object.values(corners).forEach(value => countNumber(state.tokens.radii, value));
  return corners;
}

function textSummary(node: TextNode): Json {
  return compact({
    value: node.characters.slice(0, 20_000),
    font: node.fontName === figma.mixed ? "mixed" : node.fontName,
    size: node.fontSize === figma.mixed ? "mixed" : round(node.fontSize),
    lineHeight: node.lineHeight === figma.mixed ? "mixed" : node.lineHeight,
    letterSpacing: node.letterSpacing === figma.mixed ? "mixed" : node.letterSpacing,
    align: node.textAlignHorizontal,
    verticalAlign: node.textAlignVertical,
    autoResize: node.textAutoResize,
    case: node.textCase === figma.mixed ? "mixed" : node.textCase,
    decoration: node.textDecoration === figma.mixed ? "mixed" : node.textDecoration,
    styleId: node.textStyleId === figma.mixed ? "mixed" : node.textStyleId || undefined
  });
}

function paintsSummary(node: SceneNode, paints: readonly Paint[], target: "FILL" | "STROKE", state: State): Json[] {
  return paints.slice(0, 16).map((paint, index) => {
    if (paint.type === "SOLID") {
      const value = { ...paint.color, a: paint.opacity ?? 1 };
      countColor(state, value);
      return { type: paint.type, color: value, visible: paint.visible ?? true };
    }
    if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
      paint.gradientStops.forEach(stop => countColor(state, stop.color));
      return { type: paint.type, stops: paint.gradientStops, transform: paint.gradientTransform, opacity: paint.opacity ?? 1, visible: paint.visible ?? true };
    }
    if (paint.type === "IMAGE") {
      if (paint.imageHash) addAsset(state, {
        key: `image:${paint.imageHash}`,
        kind: "image-fill",
        nodeId: node.id,
        name: `${node.name}-${target.toLocaleLowerCase()}-${index + 1}`,
        imageHash: paint.imageHash
      });
      return { type: paint.type, assetKey: paint.imageHash ? `image:${paint.imageHash}` : undefined, scaleMode: paint.scaleMode, opacity: paint.opacity ?? 1, visible: paint.visible ?? true };
    }
    if (paint.type === "SHADER") {
      addShader(state, paint.id, node, target, paint.properties);
      return { type: paint.type, id: paint.id, properties: paint.properties, opacity: paint.opacity ?? 1, visible: paint.visible ?? true };
    }
    return { type: paint.type, visible: paint.visible ?? true };
  });
}

function effectsSummary(node: SceneNode & BlendMixin, state: State): Json[] {
  return node.effects.slice(0, 16).map(effect => {
    if (effect.type === "SHADER") {
      addShader(state, effect.id, node, "EFFECT", effect.properties);
      return { type: effect.type, id: effect.id, properties: effect.properties, visible: effect.visible };
    }
    return compact({
      type: effect.type, color: "color" in effect ? effect.color : undefined,
      offset: "offset" in effect ? effect.offset : undefined,
      radius: "radius" in effect ? effect.radius : undefined,
      spread: "spread" in effect ? effect.spread : undefined,
      blendMode: "blendMode" in effect ? effect.blendMode : undefined,
      visible: effect.visible
    });
  });
}

function addShader(state: State, id: string, node: SceneNode, target: string, properties: unknown): void {
  const key = `${id}\u0000${node.id}\u0000${target}`;
  if (state.shaderKeys.has(key)) return;
  state.shaderKeys.add(key);
  state.shaders.push({ id, nodeId: node.id, nodeName: node.name, target, properties, sourceCodeRequiresManualViewCode: true });
}

function addAsset(state: State, request: AssetRequest): void {
  if (state.assetKeys.has(request.key)) return;
  if (state.assets.length >= state.maxAssets) {
    state.skippedAssets += 1;
    return;
  }
  state.assetKeys.add(request.key);
  state.assets.push({
    request,
    public: compact({ key: request.key, kind: request.kind, nodeId: request.nodeId, name: request.name, export: "pending" })
  });
}

function recognizeSFSymbol(name: string): { name: string; confidence: "exact" | "alias" } | undefined {
  const normalized = name.trim().toLocaleLowerCase().replace(/^icon[\s/_-]*/, "").replace(/[\s/_-]+/g, " ");
  const alias = SF_SYMBOL_ALIASES[normalized];
  if (alias) return { name: alias, confidence: "alias" };
  if (KNOWN_SF_SYMBOLS.has(normalized)) return { name: normalized, confidence: "exact" };
  return undefined;
}

async function localDesignTokens(): Promise<Json> {
  const [collections, variables, paintStyles, textStyles] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync()
  ]);
  return {
    collections: collections.slice(0, 100).map(collection => ({ id: collection.id, name: collection.name, modes: collection.modes })),
    variables: variables.slice(0, 500).map(variable => ({
      id: variable.id, name: variable.name, type: variable.resolvedType,
      collectionId: variable.variableCollectionId, valuesByMode: variable.valuesByMode
    })),
    paintStyles: paintStyles.slice(0, 200).map(style => ({ id: style.id, name: style.name })),
    textStyles: textStyles.slice(0, 200).map(style => ({ id: style.id, name: style.name }))
  };
}

function isVectorAsset(node: SceneNode): boolean {
  return (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") && iconSized(node);
}

function iconSized(node: SceneNode): boolean {
  return "width" in node && "height" in node && node.width > 0 && node.height > 0 && node.width <= 256 && node.height <= 256;
}

function countColor(state: State, value: RGBA): void {
  const rounded = { r: round(value.r), g: round(value.g), b: round(value.b), a: round(value.a) };
  const key = `${rounded.r},${rounded.g},${rounded.b},${rounded.a}`;
  const existing = state.tokens.colors.get(key);
  state.tokens.colors.set(key, { value: rounded, count: (existing?.count ?? 0) + 1 });
}

function countTypography(state: State, value: Json): void {
  const token = compact({ font: value.font, size: value.size, lineHeight: value.lineHeight, letterSpacing: value.letterSpacing });
  const key = JSON.stringify(token);
  const existing = state.tokens.typography.get(key);
  state.tokens.typography.set(key, { value: token, count: (existing?.count ?? 0) + 1 });
}

function countNumber(map: Map<string, number>, value: number): void {
  const key = String(round(value));
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tokenSummary(tokens: State["tokens"]): Json {
  return {
    colors: [...tokens.colors.values()].sort((a, b) => b.count - a.count),
    typography: [...tokens.typography.values()].sort((a, b) => b.count - a.count),
    spacing: [...tokens.spacing].map(([value, count]) => ({ value: Number(value), count })).sort((a, b) => b.count - a.count),
    radii: [...tokens.radii].map(([value, count]) => ({ value: Number(value), count })).sort((a, b) => b.count - a.count)
  };
}

function detectImage(bytes: Uint8Array): { mimeType: string; extension: string } {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { mimeType: "image/png", extension: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mimeType: "image/jpeg", extension: "jpg" };
  if (String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a" || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a") return { mimeType: "image/gif", extension: "gif" };
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  return { mimeType: "application/octet-stream", extension: "bin" };
}

function figmaNodeUrl(fileKey: string, nodeId: string): string {
  return `https://www.figma.com/design/${encodeURIComponent(fileKey)}?node-id=${encodeURIComponent(nodeId.replace(":", "-"))}`;
}

function assertExportSize(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw new Error(`${label} exceeds the 8 MiB bridge limit`);
}

function assertKnownKeys(value: Json, allowed: string[], name: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`${name} contains unsupported field: ${key}`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function requireSceneNode(id: string): Promise<SceneNode> {
  return figma.getNodeByIdAsync(id).then(node => {
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`scene node not found: ${id}`);
    return node as SceneNode;
  });
}

function compact<T extends Json>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
