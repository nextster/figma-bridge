const MAX_NODE_ID_LENGTH = 128;
const MAX_PAINTS = 16;
const MAX_EFFECTS = 16;

type Direction = "NONE" | "HORIZONTAL" | "VERTICAL";
type AxisSizing = "HUG" | "FILL" | "FIXED";
type PrimaryAlignment = "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
type CounterAlignment = "MIN" | "CENTER" | "MAX" | "BASELINE";

export type AutoLayoutOperation = {
  nodeId: string;
  direction?: Direction;
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  primaryAlignment?: PrimaryAlignment;
  counterAlignment?: CounterAlignment;
  primarySizing?: AxisSizing;
  counterSizing?: AxisSizing;
};

export type VisualPropertiesOperation = {
  nodeId: string;
  cornerRadius?: number | { topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number };
  cornerSmoothing?: number;
  fills?: ReadonlyArray<Paint>;
  strokes?: ReadonlyArray<Paint>;
  strokeWeight?: number;
  strokeAlign?: "CENTER" | "INSIDE" | "OUTSIDE";
  dashPattern?: number[];
  effects?: ReadonlyArray<Effect>;
  typography?: TypographyOperation;
};

type TypographyOperation = {
  fontName?: FontName;
  fontSize?: number;
  lineHeight?: LineHeight;
  letterSpacing?: LetterSpacing;
  paragraphSpacing?: number;
  alignHorizontal?: TextNode["textAlignHorizontal"];
  alignVertical?: TextNode["textAlignVertical"];
  textCase?: TextCase;
  textDecoration?: TextDecoration;
  textAutoResize?: TextNode["textAutoResize"];
};

type AutoLayoutTarget = SceneNode & AutoLayoutMixin & LayoutMixin;
type PaintTarget = SceneNode & MinimalFillsMixin;
type StrokeTarget = SceneNode & MinimalStrokesMixin;
type EffectTarget = SceneNode & BlendMixin;

/** Parse and normalize one exact-node auto-layout operation without mutating Figma. */
export function parseAutoLayoutOperation(args: Record<string, unknown>): AutoLayoutOperation {
  assertKnownKeys(args, [
    "nodeId", "direction", "gap", "padding", "primaryAlignment", "counterAlignment", "primarySizing", "counterSizing"
  ], "auto layout operation");
  const operation: AutoLayoutOperation = { nodeId: nodeId(args.nodeId) };
  if (args.direction !== undefined) operation.direction = enumValue(args.direction, ["NONE", "HORIZONTAL", "VERTICAL"], "direction");
  if (args.gap !== undefined) operation.gap = finiteNumber(args.gap, -10_000, 100_000, "gap");
  if (args.padding !== undefined) operation.padding = padding(args.padding);
  if (args.primaryAlignment !== undefined) {
    operation.primaryAlignment = enumValue(args.primaryAlignment, ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"], "primaryAlignment");
  }
  if (args.counterAlignment !== undefined) {
    operation.counterAlignment = enumValue(args.counterAlignment, ["MIN", "CENTER", "MAX", "BASELINE"], "counterAlignment");
  }
  if (args.primarySizing !== undefined) operation.primarySizing = enumValue(args.primarySizing, ["HUG", "FILL", "FIXED"], "primarySizing");
  if (args.counterSizing !== undefined) operation.counterSizing = enumValue(args.counterSizing, ["HUG", "FILL", "FIXED"], "counterSizing");
  requireMutation(operation, ["nodeId"], "auto layout operation");
  return operation;
}

/** Apply auto-layout properties to one frame-like scene node. */
export async function applyAutoLayout(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const operation = parseAutoLayoutOperation(args);
  const node = await requireSceneNode(operation.nodeId);
  if (!("layoutMode" in node)) throw new Error(`${operation.nodeId} does not support auto layout`);
  const target = node as AutoLayoutTarget;

  if (operation.direction !== undefined) target.layoutMode = operation.direction;
  const direction = target.layoutMode;
  const hasLayoutProperties = Object.keys(operation).some(key => key !== "nodeId" && key !== "direction");
  if ((direction === "NONE" || direction === "GRID") && hasLayoutProperties) {
    throw new Error(`${operation.nodeId} must use HORIZONTAL or VERTICAL auto layout before setting layout properties`);
  }
  if (operation.counterAlignment === "BASELINE" && direction !== "HORIZONTAL") {
    throw new Error("counterAlignment BASELINE is only supported by HORIZONTAL auto layout");
  }

  if (operation.gap !== undefined) target.itemSpacing = operation.gap;
  if (operation.padding) {
    target.paddingTop = operation.padding.top;
    target.paddingRight = operation.padding.right;
    target.paddingBottom = operation.padding.bottom;
    target.paddingLeft = operation.padding.left;
  }
  if (operation.primaryAlignment !== undefined) target.primaryAxisAlignItems = operation.primaryAlignment;
  if (operation.counterAlignment !== undefined) target.counterAxisAlignItems = operation.counterAlignment;
  if (operation.primarySizing !== undefined) setAxisSizing(target, "primary", operation.primarySizing);
  if (operation.counterSizing !== undefined) setAxisSizing(target, "counter", operation.counterSizing);

  return autoLayoutSummary(target);
}

/** Parse and normalize one exact-node visual operation without mutating Figma. */
export function parseVisualPropertiesOperation(args: Record<string, unknown>): VisualPropertiesOperation {
  assertKnownKeys(args, [
    "nodeId", "cornerRadius", "cornerSmoothing", "fills", "strokes", "strokeWeight", "strokeAlign", "dashPattern", "effects", "typography"
  ], "visual properties operation");
  const operation: VisualPropertiesOperation = { nodeId: nodeId(args.nodeId) };
  if (args.cornerRadius !== undefined) operation.cornerRadius = cornerRadius(args.cornerRadius);
  if (args.cornerSmoothing !== undefined) operation.cornerSmoothing = finiteNumber(args.cornerSmoothing, 0, 1, "cornerSmoothing");
  if (args.fills !== undefined) operation.fills = paints(args.fills, "fills");
  if (args.strokes !== undefined) operation.strokes = paints(args.strokes, "strokes");
  if (args.strokeWeight !== undefined) operation.strokeWeight = finiteNumber(args.strokeWeight, 0, 100_000, "strokeWeight");
  if (args.strokeAlign !== undefined) operation.strokeAlign = enumValue(args.strokeAlign, ["CENTER", "INSIDE", "OUTSIDE"], "strokeAlign");
  if (args.dashPattern !== undefined) operation.dashPattern = numberArray(args.dashPattern, 0, 100_000, 32, "dashPattern");
  if (args.effects !== undefined) operation.effects = effects(args.effects);
  if (args.typography !== undefined) operation.typography = typography(args.typography);
  requireMutation(operation, ["nodeId"], "visual properties operation");
  return operation;
}

/** Apply visual properties to one exact scene node, loading fonts before text mutations. */
export async function applyVisualProperties(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const operation = parseVisualPropertiesOperation(args);
  const node = await requireSceneNode(operation.nodeId);

  if (operation.cornerRadius !== undefined) applyCornerRadius(node, operation.cornerRadius);
  if (operation.cornerSmoothing !== undefined) {
    if (!("cornerSmoothing" in node)) throw new Error(`${operation.nodeId} does not support corner smoothing`);
    (node as SceneNode & CornerMixin).cornerSmoothing = operation.cornerSmoothing;
  }
  if (operation.fills !== undefined) {
    if (!("fills" in node)) throw new Error(`${operation.nodeId} does not support fills`);
    (node as PaintTarget).fills = operation.fills;
  }
  if (operation.strokes !== undefined || operation.strokeWeight !== undefined || operation.strokeAlign !== undefined || operation.dashPattern !== undefined) {
    if (!("strokes" in node)) throw new Error(`${operation.nodeId} does not support strokes`);
    const target = node as StrokeTarget;
    if (operation.strokes !== undefined) target.strokes = operation.strokes;
    if (operation.strokeWeight !== undefined) target.strokeWeight = operation.strokeWeight;
    if (operation.strokeAlign !== undefined) target.strokeAlign = operation.strokeAlign;
    if (operation.dashPattern !== undefined) target.dashPattern = operation.dashPattern;
  }
  if (operation.effects !== undefined) {
    if (!("effects" in node)) throw new Error(`${operation.nodeId} does not support effects`);
    (node as EffectTarget).effects = operation.effects;
  }
  if (operation.typography !== undefined) {
    if (node.type !== "TEXT") throw new Error(`${operation.nodeId} is not a text node`);
    await applyTypography(node, operation.typography);
  }

  return visualSummary(node);
}

function setAxisSizing(target: AutoLayoutTarget, axis: "primary" | "counter", sizing: AxisSizing): void {
  const horizontal = (target.layoutMode === "HORIZONTAL") === (axis === "primary");
  if (sizing === "FILL") {
    const parent = target.parent;
    if (!parent || !("layoutMode" in parent) || parent.layoutMode === "NONE" || parent.layoutMode === "GRID") {
      throw new Error(`${axis}Sizing FILL requires the node to be a child of a horizontal or vertical auto-layout container`);
    }
  }
  if (horizontal) target.layoutSizingHorizontal = sizing;
  else target.layoutSizingVertical = sizing;
}

function applyCornerRadius(node: SceneNode, radius: VisualPropertiesOperation["cornerRadius"]): void {
  if (radius === undefined) return;
  if (typeof radius === "number") {
    if (!("cornerRadius" in node)) throw new Error(`${node.id} does not support corner radius`);
    (node as SceneNode & CornerMixin).cornerRadius = radius;
    return;
  }
  if (!("topLeftRadius" in node)) throw new Error(`${node.id} does not support individual corner radii`);
  const target = node as SceneNode & RectangleCornerMixin;
  if (radius.topLeft !== undefined) target.topLeftRadius = radius.topLeft;
  if (radius.topRight !== undefined) target.topRightRadius = radius.topRight;
  if (radius.bottomRight !== undefined) target.bottomRightRadius = radius.bottomRight;
  if (radius.bottomLeft !== undefined) target.bottomLeftRadius = radius.bottomLeft;
}

async function applyTypography(node: TextNode, operation: TypographyOperation): Promise<void> {
  if (operation.fontName) {
    await figma.loadFontAsync(operation.fontName);
  } else {
    const fonts = node.getRangeAllFontNames(0, node.characters.length);
    const fallback = node.fontName === figma.mixed ? [] : [node.fontName];
    const unique = new Map<string, FontName>();
    for (const font of fonts.length > 0 ? fonts : fallback) unique.set(`${font.family}\u0000${font.style}`, font);
    await Promise.all([...unique.values()].map(font => figma.loadFontAsync(font)));
  }
  if (operation.fontName) node.fontName = operation.fontName;
  if (operation.fontSize !== undefined) node.fontSize = operation.fontSize;
  if (operation.lineHeight !== undefined) node.lineHeight = operation.lineHeight;
  if (operation.letterSpacing !== undefined) node.letterSpacing = operation.letterSpacing;
  if (operation.paragraphSpacing !== undefined) node.paragraphSpacing = operation.paragraphSpacing;
  if (operation.alignHorizontal !== undefined) node.textAlignHorizontal = operation.alignHorizontal;
  if (operation.alignVertical !== undefined) node.textAlignVertical = operation.alignVertical;
  if (operation.textCase !== undefined) node.textCase = operation.textCase;
  if (operation.textDecoration !== undefined) node.textDecoration = operation.textDecoration;
  if (operation.textAutoResize !== undefined) node.textAutoResize = operation.textAutoResize;
}

function padding(value: unknown): { top: number; right: number; bottom: number; left: number } {
  if (typeof value === "number") {
    const all = finiteNumber(value, 0, 100_000, "padding");
    return { top: all, right: all, bottom: all, left: all };
  }
  const object = record(value, "padding");
  assertKnownKeys(object, ["all", "horizontal", "vertical", "top", "right", "bottom", "left"], "padding");
  if (Object.keys(object).length === 0) throw new Error("padding must contain at least one value");
  const all = optionalNumber(object.all, 0, 100_000, "padding.all") ?? 0;
  const horizontal = optionalNumber(object.horizontal, 0, 100_000, "padding.horizontal") ?? all;
  const vertical = optionalNumber(object.vertical, 0, 100_000, "padding.vertical") ?? all;
  return {
    top: optionalNumber(object.top, 0, 100_000, "padding.top") ?? vertical,
    right: optionalNumber(object.right, 0, 100_000, "padding.right") ?? horizontal,
    bottom: optionalNumber(object.bottom, 0, 100_000, "padding.bottom") ?? vertical,
    left: optionalNumber(object.left, 0, 100_000, "padding.left") ?? horizontal
  };
}

function cornerRadius(value: unknown): VisualPropertiesOperation["cornerRadius"] {
  if (typeof value === "number") return finiteNumber(value, 0, 100_000, "cornerRadius");
  const object = record(value, "cornerRadius");
  assertKnownKeys(object, ["all", "topLeft", "topRight", "bottomRight", "bottomLeft"], "cornerRadius");
  if (Object.keys(object).length === 0) throw new Error("cornerRadius must contain at least one value");
  const all = optionalNumber(object.all, 0, 100_000, "cornerRadius.all");
  const result = {
    topLeft: optionalNumber(object.topLeft, 0, 100_000, "cornerRadius.topLeft") ?? all,
    topRight: optionalNumber(object.topRight, 0, 100_000, "cornerRadius.topRight") ?? all,
    bottomRight: optionalNumber(object.bottomRight, 0, 100_000, "cornerRadius.bottomRight") ?? all,
    bottomLeft: optionalNumber(object.bottomLeft, 0, 100_000, "cornerRadius.bottomLeft") ?? all
  };
  if (Object.values(result).every(item => item === undefined)) throw new Error("cornerRadius must contain at least one numeric value");
  return result;
}

function paints(value: unknown, name: string): ReadonlyArray<Paint> {
  if (!Array.isArray(value) || value.length > MAX_PAINTS) throw new Error(`${name} must be an array of at most ${MAX_PAINTS} paints`);
  return value.map((item, index) => paint(record(item, `${name}[${index}]`), `${name}[${index}]`));
}

function paint(spec: Record<string, unknown>, name: string): Paint {
  const type = enumValue(spec.type, ["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"], `${name}.type`);
  if (type === "SOLID") {
    assertKnownKeys(spec, ["type", "color", "opacity", "visible"], name);
    const parsed = rgba(spec.color, `${name}.color`, false);
    return {
      type,
      color: { r: parsed.r, g: parsed.g, b: parsed.b },
      opacity: optionalNumber(spec.opacity, 0, 1, `${name}.opacity`) ?? parsed.a,
      visible: optionalBoolean(spec.visible, `${name}.visible`) ?? true
    };
  }
  assertKnownKeys(spec, ["type", "stops", "transform", "opacity", "visible"], name);
  if (!Array.isArray(spec.stops) || spec.stops.length < 2 || spec.stops.length > 32) {
    throw new Error(`${name}.stops must contain 2..32 color stops`);
  }
  const gradientStops = spec.stops.map((item, index) => {
    const stop = record(item, `${name}.stops[${index}]`);
    assertKnownKeys(stop, ["position", "color"], `${name}.stops[${index}]`);
    return {
      position: finiteNumber(stop.position, 0, 1, `${name}.stops[${index}].position`),
      color: rgba(stop.color, `${name}.stops[${index}].color`, true)
    };
  });
  for (let index = 1; index < gradientStops.length; index += 1) {
    if (gradientStops[index].position < gradientStops[index - 1].position) throw new Error(`${name}.stops must be ordered by position`);
  }
  return {
    type,
    gradientStops,
    gradientTransform: gradientTransform(spec.transform, `${name}.transform`),
    opacity: optionalNumber(spec.opacity, 0, 1, `${name}.opacity`) ?? 1,
    visible: optionalBoolean(spec.visible, `${name}.visible`) ?? true
  };
}

function effects(value: unknown): ReadonlyArray<Effect> {
  if (!Array.isArray(value) || value.length > MAX_EFFECTS) throw new Error(`effects must be an array of at most ${MAX_EFFECTS} effects`);
  return value.map((item, index) => effect(record(item, `effects[${index}]`), `effects[${index}]`));
}

function effect(spec: Record<string, unknown>, name: string): Effect {
  const type = enumValue(spec.type, ["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"], `${name}.type`);
  if (type === "LAYER_BLUR" || type === "BACKGROUND_BLUR") {
    assertKnownKeys(spec, ["type", "radius", "visible"], name);
    return {
      type,
      blurType: "NORMAL",
      radius: finiteNumber(spec.radius, 0, 10_000, `${name}.radius`),
      visible: optionalBoolean(spec.visible, `${name}.visible`) ?? true
    };
  }
  assertKnownKeys(spec, ["type", "color", "offset", "radius", "spread", "visible", "blendMode"], name);
  const offset = record(spec.offset, `${name}.offset`);
  assertKnownKeys(offset, ["x", "y"], `${name}.offset`);
  return {
    type,
    color: rgba(spec.color, `${name}.color`, true),
    offset: {
      x: finiteNumber(offset.x, -100_000, 100_000, `${name}.offset.x`),
      y: finiteNumber(offset.y, -100_000, 100_000, `${name}.offset.y`)
    },
    radius: finiteNumber(spec.radius, 0, 10_000, `${name}.radius`),
    ...(spec.spread === undefined ? {} : { spread: finiteNumber(spec.spread, -10_000, 10_000, `${name}.spread`) }),
    visible: optionalBoolean(spec.visible, `${name}.visible`) ?? true,
    blendMode: enumValue(spec.blendMode ?? "NORMAL", BLEND_MODES, `${name}.blendMode`)
  };
}

function typography(value: unknown): TypographyOperation {
  const spec = record(value, "typography");
  assertKnownKeys(spec, [
    "fontFamily", "fontStyle", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "alignHorizontal", "alignVertical",
    "textCase", "textDecoration", "textAutoResize"
  ], "typography");
  if (Object.keys(spec).length === 0) throw new Error("typography must contain at least one property");
  const result: TypographyOperation = {};
  if (spec.fontFamily !== undefined || spec.fontStyle !== undefined) {
    result.fontName = {
      family: boundedString(spec.fontFamily, 1, 200, "typography.fontFamily"),
      style: boundedString(spec.fontStyle ?? "Regular", 1, 200, "typography.fontStyle")
    };
  }
  if (spec.fontSize !== undefined) result.fontSize = finiteNumber(spec.fontSize, 1, 1_000, "typography.fontSize");
  if (spec.lineHeight !== undefined) result.lineHeight = lineHeight(spec.lineHeight);
  if (spec.letterSpacing !== undefined) result.letterSpacing = letterSpacing(spec.letterSpacing);
  if (spec.paragraphSpacing !== undefined) result.paragraphSpacing = finiteNumber(spec.paragraphSpacing, 0, 100_000, "typography.paragraphSpacing");
  if (spec.alignHorizontal !== undefined) result.alignHorizontal = enumValue(spec.alignHorizontal, ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"], "typography.alignHorizontal");
  if (spec.alignVertical !== undefined) result.alignVertical = enumValue(spec.alignVertical, ["TOP", "CENTER", "BOTTOM"], "typography.alignVertical");
  if (spec.textCase !== undefined) result.textCase = enumValue(spec.textCase, ["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"], "typography.textCase");
  if (spec.textDecoration !== undefined) result.textDecoration = enumValue(spec.textDecoration, ["NONE", "UNDERLINE", "STRIKETHROUGH"], "typography.textDecoration");
  if (spec.textAutoResize !== undefined) result.textAutoResize = enumValue(spec.textAutoResize, ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"], "typography.textAutoResize");
  return result;
}

function lineHeight(value: unknown): LineHeight {
  if (typeof value === "string" && value.toUpperCase() === "AUTO") return { unit: "AUTO" };
  if (typeof value === "number") return { unit: "PIXELS", value: finiteNumber(value, 0, 100_000, "typography.lineHeight") };
  const spec = record(value, "typography.lineHeight");
  assertKnownKeys(spec, ["value", "unit"], "typography.lineHeight");
  return {
    value: finiteNumber(spec.value, 0, 100_000, "typography.lineHeight.value"),
    unit: enumValue(spec.unit, ["PIXELS", "PERCENT"], "typography.lineHeight.unit")
  };
}

function letterSpacing(value: unknown): LetterSpacing {
  if (typeof value === "number") return { unit: "PIXELS", value: finiteNumber(value, -100_000, 100_000, "typography.letterSpacing") };
  const spec = record(value, "typography.letterSpacing");
  assertKnownKeys(spec, ["value", "unit"], "typography.letterSpacing");
  return {
    value: finiteNumber(spec.value, -100_000, 100_000, "typography.letterSpacing.value"),
    unit: enumValue(spec.unit, ["PIXELS", "PERCENT"], "typography.letterSpacing.unit")
  };
}

function rgba(value: unknown, name: string, requireAlpha: boolean): RGBA {
  const color = record(value, name);
  assertKnownKeys(color, ["r", "g", "b", "a"], name);
  return {
    r: finiteNumber(color.r, 0, 1, `${name}.r`),
    g: finiteNumber(color.g, 0, 1, `${name}.g`),
    b: finiteNumber(color.b, 0, 1, `${name}.b`),
    a: color.a === undefined && !requireAlpha ? 1 : finiteNumber(color.a, 0, 1, `${name}.a`)
  };
}

function gradientTransform(value: unknown, name: string): Transform {
  if (value === undefined) return [[1, 0, 0], [0, 1, 0]];
  if (!Array.isArray(value) || value.length !== 2 || !value.every(row => Array.isArray(row) && row.length === 3)) {
    throw new Error(`${name} must be a 2x3 numeric matrix`);
  }
  return [
    value[0].map((item: unknown, index: number) => finiteNumber(item, -1_000_000, 1_000_000, `${name}[0][${index}]`)) as [number, number, number],
    value[1].map((item: unknown, index: number) => finiteNumber(item, -1_000_000, 1_000_000, `${name}[1][${index}]`)) as [number, number, number]
  ];
}

async function requireSceneNode(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`scene node not found: ${id}`);
  return node as SceneNode;
}

function autoLayoutSummary(node: AutoLayoutTarget): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    direction: node.layoutMode,
    gap: node.itemSpacing,
    padding: { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft },
    primaryAlignment: node.primaryAxisAlignItems,
    counterAlignment: node.counterAxisAlignItems,
    horizontalSizing: node.layoutSizingHorizontal,
    verticalSizing: node.layoutSizingVertical
  };
}

function visualSummary(node: SceneNode): Record<string, unknown> {
  const result: Record<string, unknown> = { id: node.id, name: node.name, type: node.type };
  if ("cornerRadius" in node) result.cornerRadius = node.cornerRadius === figma.mixed ? "MIXED" : node.cornerRadius;
  if ("cornerSmoothing" in node) result.cornerSmoothing = node.cornerSmoothing;
  if ("fills" in node) result.fillCount = node.fills === figma.mixed ? "MIXED" : node.fills.length;
  if ("strokes" in node) {
    result.strokeCount = node.strokes.length;
    result.strokeWeight = node.strokeWeight === figma.mixed ? "MIXED" : node.strokeWeight;
  }
  if ("effects" in node) result.effectCount = node.effects.length;
  if (node.type === "TEXT") {
    result.typography = {
      fontName: node.fontName === figma.mixed ? "MIXED" : node.fontName,
      fontSize: node.fontSize === figma.mixed ? "MIXED" : node.fontSize,
      lineHeight: node.lineHeight === figma.mixed ? "MIXED" : node.lineHeight,
      letterSpacing: node.letterSpacing === figma.mixed ? "MIXED" : node.letterSpacing,
      paragraphSpacing: node.paragraphSpacing === figma.mixed ? "MIXED" : node.paragraphSpacing,
      alignHorizontal: node.textAlignHorizontal,
      alignVertical: node.textAlignVertical
    };
  }
  return result;
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

function requireMutation(value: object, ignoredKeys: readonly string[], name: string): void {
  if (Object.keys(value).every(key => ignoredKeys.includes(key))) throw new Error(`${name} must contain at least one property to change`);
}

function nodeId(value: unknown): string {
  return boundedString(value, 1, MAX_NODE_ID_LENGTH, "nodeId");
}

function boundedString(value: unknown, minimum: number, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${name} must contain ${minimum}..${maximum} characters`);
  }
  return value;
}

function finiteNumber(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalNumber(value: unknown, minimum: number, maximum: number, name: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, minimum, maximum, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function numberArray(value: unknown, minimum: number, maximum: number, maxItems: number, name: string): number[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array of at most ${maxItems} numbers`);
  return value.map((item, index) => finiteNumber(item, minimum, maximum, `${name}[${index}]`));
}

function enumValue<const T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string") throw new Error(`${name} must be one of ${values.join(", ")}`);
  const normalized = value.toUpperCase();
  if (!(values as readonly string[]).includes(normalized)) throw new Error(`${name} must be one of ${values.join(", ")}`);
  return normalized as T;
}

const BLEND_MODES = [
  "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE",
  "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"
] as const satisfies readonly BlendMode[];
