import { withUndoTransaction } from "./undo-transaction";
import { nodeIds, numberIn, optionalNumber, optionalString, stringIn } from "./validation";

const MAX_SHADERS = 200;
const MAX_PROPERTIES = 64;
const SHADER_API_TIMEOUT_MS = 5_000;
const BLEND_MODES = [
  "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN",
  "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT",
  "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"
] as const;

type ShaderTarget = "FILL" | "STROKE" | "EFFECT";
type ApplyMode = "REPLACE_SHADERS" | "APPEND" | "REPLACE_ALL";
type PaintTarget = SceneNode & MinimalFillsMixin;
type StrokeTarget = SceneNode & MinimalStrokesMixin;
type EffectTarget = SceneNode & BlendMixin;

type DocumentShaderOccurrence = {
  id: string;
  type: "fill" | "effect";
  target: ShaderTarget;
  properties?: Readonly<Record<string, ShaderPropertyValue>>;
  sourceNode: { id: string; name: string; type: string };
};

type ApplyShaderOperation = {
  nodeIds: string[];
  shaderId: string;
  target?: ShaderTarget;
  properties: Record<string, unknown>;
  mode: ApplyMode;
  visible: boolean;
  opacity?: number;
  blendMode?: BlendMode;
};

export async function listShaders(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assertShaderApi();
  assertKnownKeys(args, ["query", "type", "limit"], "list shaders");
  const query = optionalString(args.query, 256, "query")?.toLocaleLowerCase();
  const type = args.type === undefined ? undefined : enumValue(args.type, ["fill", "effect"], "type");
  const limit = Math.round(optionalNumber(args.limit, 1, MAX_SHADERS, "limit") ?? 100);
  const occurrences = documentShaderOccurrences();
  let available: Shader[] = [];
  let warning: string | undefined;
  try {
    available = await availableShaders();
  } catch (error) {
    warning = errorMessage(error);
  }
  const knownIds = new Set(available.map(shader => shader.id));
  const documentOnly = occurrences.filter(occurrence => !knownIds.has(occurrence.id));
  const shaders = [
    ...available.map(shaderSummary),
    ...documentOnly.map(documentShaderSummary)
  ].filter(shader => {
    const haystack = [shader.name, shader.id, shader.sourceNode?.name]
      .filter(value => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase();
    return (!query || haystack.includes(query)) && (!type || shader.type === type);
  });
  return {
    shaders: shaders.slice(0, limit),
    total: shaders.length,
    truncated: Math.max(0, shaders.length - limit),
    fallbackScope: documentOnly.length > 0 ? "current-page" : undefined,
    warning
  };
}

export function parseApplyShaderOperation(args: Record<string, unknown>): ApplyShaderOperation {
  assertKnownKeys(args, ["nodeIds", "shaderId", "target", "properties", "mode", "visible", "opacity", "blendMode"], "apply shader");
  const ids = nodeIds(args.nodeIds);
  if (new Set(ids).size !== ids.length) throw new Error("nodeIds must not contain duplicates");
  return {
    nodeIds: ids,
    shaderId: stringIn(args.shaderId, 1, 512, "shaderId"),
    target: args.target === undefined ? undefined : enumValue<ShaderTarget>(args.target, ["FILL", "STROKE", "EFFECT"], "target"),
    properties: propertyRecord(args.properties),
    mode: enumValue<ApplyMode>(args.mode ?? "REPLACE_SHADERS", ["REPLACE_SHADERS", "APPEND", "REPLACE_ALL"], "mode"),
    visible: booleanValue(args.visible ?? true, "visible"),
    opacity: optionalNumber(args.opacity, 0, 1, "opacity"),
    blendMode: args.blendMode === undefined ? undefined : enumValue(args.blendMode, BLEND_MODES, "blendMode")
  };
}

export async function applyShader(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const operation = parseApplyShaderOperation(args);
  assertShaderApi();
  return withUndoTransaction(async () => {
    const occurrence = documentShaderOccurrences().find(item => item.id === operation.shaderId);
    let shader: Shader | undefined;
    let discoveryWarning: string | undefined;
    try {
      const available = await availableShaders();
      const discovered = available.find(item => item.id === operation.shaderId);
      shader = discovered
        ? (discovered.imported ? discovered : await importShader(discovered.id))
        : await importShader(operation.shaderId);
    } catch (error) {
      discoveryWarning = errorMessage(error);
    }
    if (!shader && !occurrence) {
      throw new Error(`shader is unavailable through Figma's API and was not found on the current page: ${operation.shaderId}${discoveryWarning ? ` (${discoveryWarning})` : ""}`);
    }

    const shaderType = shader?.type ?? occurrence!.type;
    const shaderName = shader?.name ?? `Imported shader ${operation.shaderId}`;
    const target = operation.target ?? (shaderType === "effect" ? "EFFECT" : occurrence?.target ?? "FILL");
    if (shaderType === "effect" && target !== "EFFECT") throw new Error(`${shaderName} is an effect shader and requires target EFFECT`);
    if (shaderType === "fill" && target === "EFFECT") throw new Error(`${shaderName} is a fill shader and requires target FILL or STROKE`);
    if (target === "EFFECT" && (operation.opacity !== undefined || operation.blendMode !== undefined)) {
      throw new Error("opacity and blendMode are only supported for shader fills or strokes");
    }

    const requestedProperties = Object.keys(operation.properties).length > 0;
    if (!shader && requestedProperties) {
      throw new Error("Figma did not return shader property definitions; reuse the existing values or edit this shader in Figma");
    }
    const properties = shader
      ? resolveProperties(operation.properties, shader.propertyDefinitions)
      : occurrence?.properties;
    const nodes = await Promise.all(operation.nodeIds.map(requireSceneNode));
    for (const node of nodes) assertTarget(node, target);

    const shaderValue = target === "EFFECT"
      ? { type: "SHADER", id: operation.shaderId, properties, visible: operation.visible } as ShaderEffect
      : {
          type: "SHADER", id: operation.shaderId, properties, visible: operation.visible,
          ...(operation.opacity === undefined ? {} : { opacity: operation.opacity }),
          ...(operation.blendMode === undefined ? {} : { blendMode: operation.blendMode })
        } as ShaderPaint;

    for (const node of nodes) applyToNode(node, target, operation.mode, shaderValue);
    return {
      shader: shader ? shaderSummary(shader) : documentShaderSummary(occurrence!),
      target,
      mode: operation.mode,
      fallback: shader ? undefined : "current-page",
      warning: discoveryWarning,
      nodes: nodes.map(node => ({ id: node.id, name: node.name, type: node.type }))
    };
  });
}

function applyToNode(node: SceneNode, target: ShaderTarget, mode: ApplyMode, shader: ShaderPaint | ShaderEffect): void {
  if (target === "FILL") {
    const paint = shader as ShaderPaint;
    const current = (node as PaintTarget).fills;
    if (current === figma.mixed) throw new Error(`${node.id} has mixed fills`);
    (node as PaintTarget).fills = merge(current, paint, mode);
    return;
  }
  if (target === "STROKE") {
    const paint = shader as ShaderPaint;
    const current = (node as StrokeTarget).strokes;
    (node as StrokeTarget).strokes = merge(current, paint, mode);
    return;
  }
  const current = (node as EffectTarget).effects;
  (node as EffectTarget).effects = merge(current, shader as ShaderEffect, mode);
}

function merge<T extends Paint | Effect>(current: readonly T[], shader: T, mode: ApplyMode): readonly T[] {
  if (mode === "REPLACE_ALL") return [shader];
  if (mode === "APPEND") return [...current, shader];
  return [...current.filter(item => item.type !== "SHADER"), shader];
}

function assertTarget(node: SceneNode, target: ShaderTarget): void {
  if (target === "FILL" && !("fills" in node)) throw new Error(`${node.id} does not support fills`);
  if (target === "STROKE" && !("strokes" in node)) throw new Error(`${node.id} does not support strokes`);
  if (target === "EFFECT" && !("effects" in node)) throw new Error(`${node.id} does not support effects`);
}

function resolveProperties(
  requested: Record<string, unknown>,
  definitions: { readonly [defId: string]: ShaderPropertyDefinition } | undefined
): Record<string, ShaderPropertyValue> | undefined {
  const entries = Object.entries(requested);
  if (entries.length === 0) return undefined;
  if (!definitions) throw new Error("shader property definitions are unavailable after import");
  const result: Record<string, ShaderPropertyValue> = {};
  for (const [key, value] of entries) {
    const direct = definitions[key] ? [key] : [];
    const byName = Object.entries(definitions)
      .filter(([, definition]) => definition.name.toLocaleLowerCase() === key.toLocaleLowerCase())
      .map(([id]) => id);
    const matches = direct.length > 0 ? direct : byName;
    if (matches.length === 0) throw new Error(`unknown shader property: ${key}`);
    if (matches.length > 1) throw new Error(`ambiguous shader property name: ${key}; use its property id`);
    const id = matches[0];
    if (result[id] !== undefined) throw new Error(`shader property supplied more than once: ${key}`);
    result[id] = propertyValue(value, definitions[id], `properties.${key}`);
  }
  return result;
}

function propertyValue(value: unknown, definition: ShaderPropertyDefinition, name: string): ShaderPropertyValue {
  switch (definition.type) {
    case "BOOLEAN": return booleanValue(value, name);
    case "TEXT":
    case "IMAGE":
    case "INSTANCE_SWAP":
    case "SLOT": return stringIn(value, 0, 20_000, name);
    case "NUMBER": return numberIn(value, -1_000_000_000, 1_000_000_000, name);
    case "COLOR": return shaderColor(value, name);
    case "POINT": return numericShape(value, ["x", "y"], name) as ShaderPropertyValue;
    case "LINE": return numericShape(value, ["x", "y", "x2", "y2"], name) as ShaderPropertyValue;
    case "CIRCLE": return numericShape(value, ["x", "y", "radius"], name) as ShaderPropertyValue;
    case "CIRCLE_POINT": return numericShape(value, ["x", "y", "radius", "angle"], name) as ShaderPropertyValue;
    case "COLOR_POINT": {
      const object = record(value, name);
      assertKnownKeys(object, ["x", "y", "color"], name);
      return { x: numberIn(object.x, -1_000_000, 1_000_000, `${name}.x`), y: numberIn(object.y, -1_000_000, 1_000_000, `${name}.y`), color: shaderColor(object.color, `${name}.color`) };
    }
    case "GRADIENT": {
      const object = record(value, name);
      assertKnownKeys(object, ["stops"], name);
      if (!Array.isArray(object.stops) || object.stops.length < 2 || object.stops.length > 32) throw new Error(`${name}.stops must contain 2..32 stops`);
      return { stops: object.stops.map((item, index) => {
        const stop = record(item, `${name}.stops[${index}]`);
        assertKnownKeys(stop, ["position", "color"], `${name}.stops[${index}]`);
        return { position: numberIn(stop.position, 0, 1, `${name}.stops[${index}].position`), color: shaderColor(stop.color, `${name}.stops[${index}].color`) };
      }) };
    }
  }
}

function shaderColor(value: unknown, name: string): RGB | RGBA {
  const object = record(value, name);
  assertKnownKeys(object, ["r", "g", "b", "a"], name);
  const color: RGBA = {
    r: numberIn(object.r, 0, 1, `${name}.r`),
    g: numberIn(object.g, 0, 1, `${name}.g`),
    b: numberIn(object.b, 0, 1, `${name}.b`),
    a: object.a === undefined ? 1 : numberIn(object.a, 0, 1, `${name}.a`)
  };
  return object.a === undefined ? { r: color.r, g: color.g, b: color.b } : color;
}

function numericShape(value: unknown, keys: readonly string[], name: string): Record<string, number> {
  const object = record(value, name);
  assertKnownKeys(object, keys, name);
  return Object.fromEntries(keys.map(key => [key, numberIn(object[key], -1_000_000, 1_000_000, `${name}.${key}`)]));
}

function propertyRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const object = record(value, "properties");
  if (Object.keys(object).length > MAX_PROPERTIES) throw new Error(`properties must contain at most ${MAX_PROPERTIES} entries`);
  return object;
}

function shaderSummary(shader: Shader): Record<string, unknown> {
  return {
    id: shader.id,
    name: shader.name,
    type: shader.type,
    imported: shader.imported,
    propertyDefinitions: shader.propertyDefinitions
      ? Object.fromEntries(Object.entries(shader.propertyDefinitions).map(([id, definition]) => [id, {
          name: definition.name,
          type: definition.type,
          description: definition.description,
          defaultValue: definition.defaultValue
        }]))
      : undefined
  };
}

function documentShaderSummary(occurrence: DocumentShaderOccurrence): Record<string, any> {
  return {
    id: occurrence.id,
    name: null,
    type: occurrence.type,
    imported: true,
    propertyDefinitions: undefined,
    properties: occurrence.properties,
    sourceNode: occurrence.sourceNode,
    sourceTarget: occurrence.target,
    source: "document-fallback"
  };
}

function documentShaderOccurrences(): DocumentShaderOccurrence[] {
  const found = new Map<string, DocumentShaderOccurrence>();
  for (const node of figma.currentPage.findAll()) {
    const sourceNode = { id: node.id, name: node.name, type: node.type };
    if ("fills" in node && node.fills !== figma.mixed) {
      collectShaderValues(found, node.fills, "fill", "FILL", sourceNode);
    }
    if ("strokes" in node) collectShaderValues(found, node.strokes, "fill", "STROKE", sourceNode);
    if ("effects" in node) collectShaderValues(found, node.effects, "effect", "EFFECT", sourceNode);
  }
  return [...found.values()];
}

function collectShaderValues(
  found: Map<string, DocumentShaderOccurrence>,
  values: readonly Paint[] | readonly Effect[],
  type: "fill" | "effect",
  target: ShaderTarget,
  sourceNode: { id: string; name: string; type: string }
): void {
  for (const value of values) {
    if (value.type !== "SHADER" || found.has(value.id)) continue;
    found.set(value.id, { id: value.id, type, target, properties: value.properties, sourceNode });
  }
}

async function requireSceneNode(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`scene node not found: ${id}`);
  return node as SceneNode;
}

function assertShaderApi(): void {
  if (typeof figma.listAvailableShaders !== "function" || typeof figma.importShaderById !== "function") {
    throw new Error("this Figma version does not expose the Shader Plugin API; update Figma Desktop");
  }
}

function availableShaders(): Promise<Shader[]> {
  return withApiTimeout(figma.listAvailableShaders(), "listAvailableShaders");
}

function importShader(id: string): Promise<Shader> {
  return withApiTimeout(figma.importShaderById(id), "importShaderById");
}

function withApiTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `Figma ${method} did not respond within ${SHADER_API_TIMEOUT_MS / 1000} seconds`
    )), SHADER_API_TIMEOUT_MS);
    promise.then(
      value => { clearTimeout(timeout); resolve(value); },
      error => { clearTimeout(timeout); reject(error); }
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unsupported properties: ${unknown.join(", ")}`);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string") throw new Error(`${name} must be one of ${values.join(", ")}`);
  const normalized = value.toUpperCase();
  const match = values.find(candidate => candidate.toUpperCase() === normalized);
  if (!match) throw new Error(`${name} must be one of ${values.join(", ")}`);
  return match;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}
