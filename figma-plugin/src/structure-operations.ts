import { withUndoTransaction } from "./undo-transaction";

const MAX_ITEMS = 100;
const MAX_NAME = 256;

type Json = Record<string, unknown>;
type ContainerNode = BaseNode & ChildrenMixin;
type BatchKind =
  | "createComponents"
  | "createComponentSet"
  | "createInstances"
  | "setInstanceVariantProperties"
  | "duplicateNodes"
  | "moveNodes"
  | "reorderNodes"
  | "groupNodes"
  | "ungroupNodes"
  | "upsertDesignTokens";

type PlannedOperation = {
  index: number;
  kind: string;
  summary: string;
  affectedNodeIds: string[];
  creates: number;
};

export type ExternalBatchHandler = {
  plan: (args: Json) => Promise<{ summary: string; affectedNodeIds?: string[]; creates?: number }>;
  execute: (args: Json) => Promise<unknown>;
};

export type ExternalBatchHandlers = Record<string, ExternalBatchHandler>;

export async function createComponents(args: Json): Promise<unknown> {
  const specs = records(args.components, "components");
  const created: ComponentNode[] = [];

  for (const [index, spec] of specs.entries()) {
    const sourceId = optionalString(spec.nodeId, 128, `components[${index}].nodeId`);
    let component: ComponentNode;
    if (sourceId) {
      component = figma.createComponentFromNode(await sceneNode(sourceId));
    } else {
      component = figma.createComponent();
      const width = optionalNumber(spec.width, 1, 100_000, `components[${index}].width`) ?? 100;
      const height = optionalNumber(spec.height, 1, 100_000, `components[${index}].height`) ?? 100;
      component.resize(width, height);
    }

    const variantName = variantPropertiesName(spec.variantProperties, `components[${index}].variantProperties`);
    component.name = variantName || optionalString(spec.name, MAX_NAME, `components[${index}].name`) || component.name;
    component.x = optionalNumber(spec.x, -1_000_000, 1_000_000, `components[${index}].x`) ?? component.x;
    component.y = optionalNumber(spec.y, -1_000_000, 1_000_000, `components[${index}].y`) ?? component.y;
    const parentId = optionalString(spec.parentId, 128, `components[${index}].parentId`);
    if (parentId) insert(await containerNode(parentId), component, optionalIndex(spec.index, `components[${index}].index`));
    created.push(component);
  }

  return { components: created.map(summarizeNode) };
}

export async function createComponentSet(args: Json): Promise<unknown> {
  const componentIds = strings(args.componentIds, "componentIds");
  const components = await Promise.all(componentIds.map(async id => {
    const node = await sceneNode(id);
    if (node.type !== "COMPONENT") throw new Error(`${id} is not a component`);
    return node;
  }));
  const parentId = optionalString(args.parentId, 128, "parentId");
  const parent = parentId ? await containerNode(parentId) : figma.currentPage;
  const set = figma.combineAsVariants(components, parent, optionalIndex(args.index, "index"));
  set.name = optionalString(args.name, MAX_NAME, "name") || set.name;
  return { componentSet: summarizeNode(set), variants: set.children.map(summarizeNode) };
}

export async function createInstances(args: Json): Promise<unknown> {
  const specs = records(args.instances, "instances");
  const created: InstanceNode[] = [];
  for (const [index, spec] of specs.entries()) {
    const componentId = requiredString(spec.componentId, 128, `instances[${index}].componentId`);
    const component = await sceneNode(componentId);
    if (component.type !== "COMPONENT") throw new Error(`${componentId} is not a component`);
    const instance = component.createInstance();
    const parentId = optionalString(spec.parentId, 128, `instances[${index}].parentId`);
    if (parentId) insert(await containerNode(parentId), instance, optionalIndex(spec.index, `instances[${index}].index`));
    instance.name = optionalString(spec.name, MAX_NAME, `instances[${index}].name`) || instance.name;
    instance.x = optionalNumber(spec.x, -1_000_000, 1_000_000, `instances[${index}].x`) ?? instance.x;
    instance.y = optionalNumber(spec.y, -1_000_000, 1_000_000, `instances[${index}].y`) ?? instance.y;
    const properties = componentProperties(spec.properties, `instances[${index}].properties`);
    if (properties) instance.setProperties(properties);
    created.push(instance);
  }
  return { instances: created.map(instanceSummary) };
}

export async function setInstanceVariantProperties(args: Json): Promise<unknown> {
  const updates = records(args.updates, "updates");
  const changed: InstanceNode[] = [];
  for (const [index, update] of updates.entries()) {
    const instanceId = requiredString(update.instanceId, 128, `updates[${index}].instanceId`);
    const instance = await sceneNode(instanceId);
    if (instance.type !== "INSTANCE") throw new Error(`${instanceId} is not an instance`);
    const properties = componentProperties(update.properties, `updates[${index}].properties`, true);
    instance.setProperties(properties!);
    changed.push(instance);
  }
  return { instances: changed.map(instanceSummary) };
}

export async function duplicateNodes(args: Json): Promise<unknown> {
  const items = records(args.items, "items");
  const clones: SceneNode[] = [];
  for (const [index, item] of items.entries()) {
    const nodeId = requiredString(item.nodeId, 128, `items[${index}].nodeId`);
    const node = await sceneNode(nodeId);
    if (!("clone" in node) || typeof node.clone !== "function") throw new Error(`${nodeId} cannot be duplicated`);
    const clone = node.clone() as SceneNode;
    const parentId = optionalString(item.parentId, 128, `items[${index}].parentId`);
    if (parentId) insert(await containerNode(parentId), clone, optionalIndex(item.index, `items[${index}].index`));
    clone.name = optionalString(item.name, MAX_NAME, `items[${index}].name`) || clone.name;
    if ("x" in clone) clone.x += optionalNumber(item.offsetX, -1_000_000, 1_000_000, `items[${index}].offsetX`) ?? 0;
    if ("y" in clone) clone.y += optionalNumber(item.offsetY, -1_000_000, 1_000_000, `items[${index}].offsetY`) ?? 0;
    clones.push(clone);
  }
  return { nodes: clones.map(summarizeNode) };
}

export async function moveNodes(args: Json): Promise<unknown> {
  const moves = records(args.moves, "moves");
  const moved: SceneNode[] = [];
  for (const [entryIndex, move] of moves.entries()) {
    const nodeId = requiredString(move.nodeId, 128, `moves[${entryIndex}].nodeId`);
    const parentId = requiredString(move.parentId, 128, `moves[${entryIndex}].parentId`);
    const node = await sceneNode(nodeId);
    const parent = await containerNode(parentId);
    if (node.id === parent.id || isDescendant(parent, node)) throw new Error(`cannot move ${nodeId} into itself or its descendant`);
    const preserve = optionalBoolean(move.preserveAbsolutePosition, `moves[${entryIndex}].preserveAbsolutePosition`) ?? true;
    const absoluteTransform = "absoluteTransform" in node ? node.absoluteTransform : undefined;
    insert(parent, node, optionalIndex(move.index, `moves[${entryIndex}].index`));
    if (preserve && absoluteTransform && "relativeTransform" in node) {
      node.relativeTransform = relativeToParent(absoluteTransform, parentAbsoluteTransform(parent));
    }
    moved.push(node);
  }
  return { nodes: moved.map(summarizeNode) };
}

export async function reorderNodes(args: Json): Promise<unknown> {
  const parentId = requiredString(args.parentId, 128, "parentId");
  const parent = await containerNode(parentId);
  const nodeIds = strings(args.nodeIds, "nodeIds");
  const unique = new Set(nodeIds);
  if (unique.size !== nodeIds.length) throw new Error("nodeIds must not contain duplicates");
  const childrenById = new Map(parent.children.map(node => [node.id, node]));
  for (const id of nodeIds) if (!childrenById.has(id)) throw new Error(`${id} is not an immediate child of ${parentId}`);
  nodeIds.forEach((id, index) => parent.insertChild(index, childrenById.get(id)!));
  return { parentId, orderedNodeIds: parent.children.map(node => node.id) };
}

export async function groupNodes(args: Json): Promise<unknown> {
  const nodeIds = strings(args.nodeIds, "nodeIds");
  const nodes = await Promise.all(nodeIds.map(sceneNode));
  const parentId = optionalString(args.parentId, 128, "parentId");
  const defaultParent = nodes[0]?.parent;
  const parent = parentId
    ? await containerNode(parentId)
    : defaultParent && "children" in defaultParent
      ? defaultParent as ContainerNode
      : figma.currentPage;
  const group = figma.group(nodes, parent, optionalIndex(args.index, "index"));
  group.name = optionalString(args.name, MAX_NAME, "name") || group.name;
  return { group: summarizeNode(group), children: group.children.map(summarizeNode) };
}

export async function ungroupNodes(args: Json): Promise<unknown> {
  const nodeIds = strings(args.nodeIds, "nodeIds");
  const ungrouped: SceneNode[] = [];
  for (const id of nodeIds) {
    const node = await sceneNode(id);
    if (!("children" in node)) throw new Error(`${id} cannot be ungrouped`);
    ungrouped.push(...figma.ungroup(node as SceneNode & ChildrenMixin));
  }
  return { nodes: ungrouped.map(summarizeNode) };
}

export async function upsertDesignTokens(args: Json): Promise<unknown> {
  const manageUndo = optionalBoolean(args.commitUndo, "commitUndo") ?? true;
  return manageUndo
    ? withUndoTransaction(() => upsertDesignTokensUnsafe(args))
    : upsertDesignTokensUnsafe(args);
}

async function upsertDesignTokensUnsafe(args: Json): Promise<unknown> {
  const collectionName = optionalString(args.collectionName, MAX_NAME, "collectionName") || "Design tokens";
  const requestedModes = args.modes === undefined ? ["Light", "Dark"] : strings(args.modes, "modes", 8);
  if (requestedModes.length < 1) throw new Error("modes must contain at least one mode");

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find(candidate => candidate.name === collectionName);
  if (!collection) collection = figma.variables.createVariableCollection(collectionName);
  const modeIds = ensureModes(collection, requestedModes);
  const localVariables = await figma.variables.getLocalVariablesAsync();
  const variablesByName = new Map(localVariables
    .filter(variable => variable.variableCollectionId === collection.id)
    .map(variable => [variable.name, variable]));
  const paintStyles = await figma.getLocalPaintStylesAsync();
  const textStyles = await figma.getLocalTextStylesAsync();
  const variables: Variable[] = [];
  const styles: BaseStyle[] = [];

  const colors = optionalRecords(args.colors, "colors");
  for (const [index, spec] of colors.entries()) {
    const name = requiredString(spec.name, MAX_NAME, `colors[${index}].name`);
    const variable = upsertVariable(variablesByName, name, collection, "COLOR");
    variable.scopes = ["ALL_FILLS", "STROKE_COLOR"];
    setModeValues(variable, modeIds, spec, value => rgba(value, `colors[${index}]`));
    variables.push(variable);

    let style = paintStyles.find(candidate => candidate.name === name);
    if (!style) style = figma.createPaintStyle();
    style.name = name;
    style.paints = [figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", variable)];
    styles.push(style);
  }

  const spacing = optionalRecords(args.spacing, "spacing");
  for (const [index, spec] of spacing.entries()) {
    const name = requiredString(spec.name, MAX_NAME, `spacing[${index}].name`);
    const variable = upsertVariable(variablesByName, name, collection, "FLOAT");
    variable.scopes = ["GAP", "WIDTH_HEIGHT"];
    setModeValues(variable, modeIds, spec, value => number(value, -1_000_000, 1_000_000, `spacing[${index}]`));
    variables.push(variable);
  }

  const typography = optionalRecords(args.typography, "typography");
  for (const [index, spec] of typography.entries()) {
    const name = requiredString(spec.name, MAX_NAME, `typography[${index}].name`);
    const values = typographyModeValues(spec, modeIds, `typography[${index}]`);
    const fields: Array<[string, VariableResolvedDataType, VariableScope, VariableBindableTextField]> = [
      ["fontFamily", "STRING", "FONT_FAMILY", "fontFamily"],
      ["fontStyle", "STRING", "FONT_STYLE", "fontStyle"],
      ["fontSize", "FLOAT", "FONT_SIZE", "fontSize"],
      ["lineHeight", "FLOAT", "LINE_HEIGHT", "lineHeight"],
      ["letterSpacing", "FLOAT", "LETTER_SPACING", "letterSpacing"]
    ];
    const fieldVariables = new Map<string, Variable>();
    for (const [field, resolvedType, scope] of fields) {
      const variableName = `${name}/${field}`;
      const variable = upsertVariable(variablesByName, variableName, collection, resolvedType);
      variable.scopes = [scope];
      for (const mode of modeIds) variable.setValueForMode(mode.modeId, values.get(mode.name)![field]);
      variables.push(variable);
      fieldVariables.set(field, variable);
    }

    let style = textStyles.find(candidate => candidate.name === name);
    if (!style) style = figma.createTextStyle();
    const fallback = values.get(modeIds[0].name)!;
    const fonts = [...new Map([...values.values()].map(value => {
      const font = { family: value.fontFamily as string, style: value.fontStyle as string };
      return [`${font.family}\u0000${font.style}`, font] as const;
    })).values()];
    await Promise.all(fonts.map(font => figma.loadFontAsync(font)));
    style.name = name;
    style.fontName = { family: fallback.fontFamily as string, style: fallback.fontStyle as string };
    style.fontSize = fallback.fontSize as number;
    style.lineHeight = { unit: "PIXELS", value: fallback.lineHeight as number };
    style.letterSpacing = { unit: "PIXELS", value: fallback.letterSpacing as number };
    for (const [field, , , bindable] of fields) style.setBoundVariable(bindable, fieldVariables.get(field)!);
    styles.push(style);
  }

  return {
    collection: { id: collection.id, name: collection.name, modes: collection.modes },
    variables: variables.map(variableSummary),
    styles: styles.map(style => ({ id: style.id, name: style.name, type: style.type }))
  };
}

export async function inspectDesignTokens(args: Json): Promise<unknown> {
  const collectionName = optionalString(args.collectionName, MAX_NAME, "collectionName");
  const limit = optionalIndex(args.limit, "limit") ?? 200;
  if (limit < 1 || limit > 1_000) throw new Error("limit must be between 1 and 1000");
  const collections = (await figma.variables.getLocalVariableCollectionsAsync())
    .filter(collection => !collectionName || collection.name === collectionName);
  const collectionIds = new Set(collections.map(collection => collection.id));
  const allVariables = await figma.variables.getLocalVariablesAsync();
  const variables = allVariables
    .filter(variable => collectionIds.has(variable.variableCollectionId))
    .slice(0, limit);
  const paintStyles = (await figma.getLocalPaintStylesAsync()).slice(0, limit);
  const textStyles = (await figma.getLocalTextStylesAsync()).slice(0, limit);
  return {
    collections: collections.map(collection => ({ id: collection.id, name: collection.name, modes: collection.modes })),
    variables: variables.map(variableSummary),
    variablesTruncated: Math.max(0, allVariables.filter(variable => collectionIds.has(variable.variableCollectionId)).length - variables.length),
    paintStyles: paintStyles.map(style => ({ id: style.id, name: style.name })),
    textStyles: textStyles.map(style => ({ id: style.id, name: style.name }))
  };
}

export async function deleteDesignTokens(args: Json): Promise<unknown> {
  const collectionIds = args.collectionIds === undefined ? [] : strings(args.collectionIds, "collectionIds");
  const variableIds = args.variableIds === undefined ? [] : strings(args.variableIds, "variableIds");
  const paintStyleIds = args.paintStyleIds === undefined ? [] : strings(args.paintStyleIds, "paintStyleIds");
  const textStyleIds = args.textStyleIds === undefined ? [] : strings(args.textStyleIds, "textStyleIds");
  if (collectionIds.length + variableIds.length + paintStyleIds.length + textStyleIds.length === 0) {
    throw new Error("provide at least one exact collection, variable, paint style, or text style ID");
  }

  const collections = new Map((await figma.variables.getLocalVariableCollectionsAsync()).map(item => [item.id, item]));
  const variables = new Map((await figma.variables.getLocalVariablesAsync()).map(item => [item.id, item]));
  const paintStyles = new Map((await figma.getLocalPaintStylesAsync()).map(item => [item.id, item]));
  const textStyles = new Map((await figma.getLocalTextStylesAsync()).map(item => [item.id, item]));
  const selectedCollections = exactItems(collectionIds, collections, "variable collection");
  const selectedVariables = exactItems(variableIds, variables, "variable");
  const selectedPaintStyles = exactItems(paintStyleIds, paintStyles, "paint style");
  const selectedTextStyles = exactItems(textStyleIds, textStyles, "text style");

  return withUndoTransaction(async () => {
    selectedVariables.forEach(item => item.remove());
    selectedPaintStyles.forEach(item => item.remove());
    selectedTextStyles.forEach(item => item.remove());
    selectedCollections.forEach(item => item.remove());
    return { deleted: { collectionIds, variableIds, paintStyleIds, textStyleIds } };
  });
}

export async function planStructureBatch(args: Json, externalHandlers: ExternalBatchHandlers = {}): Promise<unknown> {
  const operations = parseBatchOperations(args);
  const planned: PlannedOperation[] = [];
  for (const [index, operation] of operations.entries()) {
    if (isBatchKind(operation.kind)) planned.push(await planOperation(index, operation.kind, operation.args));
    else {
      const handler = externalHandlers[operation.kind];
      if (!handler) throw new Error(`unsupported batch operation: ${operation.kind}`);
      const external = await handler.plan(operation.args);
      planned.push(plannedOperation(index, operation.kind, external.summary, external.affectedNodeIds || [], external.creates || 0));
    }
  }
  return {
    dryRun: true,
    operationCount: planned.length,
    creates: planned.reduce((sum, item) => sum + item.creates, 0),
    affectedNodeIds: [...new Set(planned.flatMap(item => item.affectedNodeIds))],
    operations: planned
  };
}

export async function executeStructureBatch(args: Json, externalHandlers: ExternalBatchHandlers = {}): Promise<unknown> {
  const plan = await planStructureBatch(args, externalHandlers) as Json;
  if (optionalBoolean(args.dryRun, "dryRun") ?? true) return plan;
  const operations = parseBatchOperations(args);
  const results: unknown[] = [];

  return withUndoTransaction(async () => {
    for (const operation of operations) {
      if (isBatchKind(operation.kind)) results.push(await executeOperation(operation.kind, operation.args));
      else {
        const handler = externalHandlers[operation.kind];
        if (!handler) throw new Error(`unsupported batch operation: ${operation.kind}`);
        results.push(await handler.execute(operation.args));
      }
    }
    return { ...plan, dryRun: false, results };
  });
}

async function executeOperation(kind: BatchKind, args: Json): Promise<unknown> {
  switch (kind) {
    case "createComponents": return createComponents(args);
    case "createComponentSet": return createComponentSet(args);
    case "createInstances": return createInstances(args);
    case "setInstanceVariantProperties": return setInstanceVariantProperties(args);
    case "duplicateNodes": return duplicateNodes(args);
    case "moveNodes": return moveNodes(args);
    case "reorderNodes": return reorderNodes(args);
    case "groupNodes": return groupNodes(args);
    case "ungroupNodes": return ungroupNodes(args);
    case "upsertDesignTokens": return upsertDesignTokens({ ...args, commitUndo: false });
  }
}

async function planOperation(index: number, kind: BatchKind, args: Json): Promise<PlannedOperation> {
  switch (kind) {
    case "createComponents": {
      const specs = records(args.components, "components");
      const ids = specs.map(item => optionalString(item.nodeId, 128, "nodeId")).filter(isString);
      await Promise.all(ids.map(sceneNode));
      await Promise.all(specs.map(async (item, itemIndex) => {
        const parentId = optionalString(item.parentId, 128, `components[${itemIndex}].parentId`);
        if (parentId) await containerNode(parentId);
        optionalNumber(item.width, 1, 100_000, `components[${itemIndex}].width`);
        optionalNumber(item.height, 1, 100_000, `components[${itemIndex}].height`);
        optionalNumber(item.x, -1_000_000, 1_000_000, `components[${itemIndex}].x`);
        optionalNumber(item.y, -1_000_000, 1_000_000, `components[${itemIndex}].y`);
        optionalIndex(item.index, `components[${itemIndex}].index`);
        variantPropertiesName(item.variantProperties, `components[${itemIndex}].variantProperties`);
      }));
      return planned(index, kind, `Create ${specs.length} component(s)`, ids, specs.length);
    }
    case "createComponentSet": {
      const ids = strings(args.componentIds, "componentIds");
      const nodes = await Promise.all(ids.map(sceneNode));
      if (nodes.some(node => node.type !== "COMPONENT")) throw new Error("componentIds must contain only components");
      const parentId = optionalString(args.parentId, 128, "parentId");
      if (parentId) await containerNode(parentId);
      optionalIndex(args.index, "index");
      return planned(index, kind, `Combine ${ids.length} component(s) as variants`, ids, 1);
    }
    case "createInstances": {
      const specs = records(args.instances, "instances");
      const ids = specs.map(item => requiredString(item.componentId, 128, "componentId"));
      const nodes = await Promise.all(ids.map(sceneNode));
      if (nodes.some(node => node.type !== "COMPONENT")) throw new Error("componentId must identify a component");
      await Promise.all(specs.map(async (item, itemIndex) => {
        const parentId = optionalString(item.parentId, 128, `instances[${itemIndex}].parentId`);
        if (parentId) await containerNode(parentId);
        componentProperties(item.properties, `instances[${itemIndex}].properties`);
        optionalIndex(item.index, `instances[${itemIndex}].index`);
      }));
      return planned(index, kind, `Create ${specs.length} instance(s)`, ids, specs.length);
    }
    case "setInstanceVariantProperties": {
      const updates = records(args.updates, "updates");
      const ids = updates.map(item => requiredString(item.instanceId, 128, "instanceId"));
      const nodes = await Promise.all(ids.map(sceneNode));
      if (nodes.some(node => node.type !== "INSTANCE")) throw new Error("instanceId must identify an instance");
      updates.forEach(item => componentProperties(item.properties, "properties", true));
      return planned(index, kind, `Update ${ids.length} instance(s)`, ids, 0);
    }
    case "duplicateNodes": {
      const items = records(args.items, "items");
      const ids = items.map(item => requiredString(item.nodeId, 128, "nodeId"));
      const nodes = await Promise.all(ids.map(sceneNode));
      if (nodes.some(node => !("clone" in node))) throw new Error("one or more nodes cannot be duplicated");
      await Promise.all(items.map(async (item, itemIndex) => {
        const parentId = optionalString(item.parentId, 128, `items[${itemIndex}].parentId`);
        if (parentId) await containerNode(parentId);
        optionalIndex(item.index, `items[${itemIndex}].index`);
      }));
      return planned(index, kind, `Duplicate ${ids.length} node(s)`, ids, ids.length);
    }
    case "moveNodes": {
      const moves = records(args.moves, "moves");
      const ids = moves.map(item => requiredString(item.nodeId, 128, "nodeId"));
      const nodes = await Promise.all(ids.map(sceneNode));
      const parents = await Promise.all(moves.map(item => containerNode(requiredString(item.parentId, 128, "parentId"))));
      nodes.forEach((node, moveIndex) => {
        if (node.id === parents[moveIndex].id || isDescendant(parents[moveIndex], node)) {
          throw new Error(`cannot move ${node.id} into itself or its descendant`);
        }
        optionalIndex(moves[moveIndex].index, `moves[${moveIndex}].index`);
        optionalBoolean(moves[moveIndex].preserveAbsolutePosition, `moves[${moveIndex}].preserveAbsolutePosition`);
      });
      return planned(index, kind, `Move ${ids.length} node(s)`, ids, 0);
    }
    case "reorderNodes": {
      const ids = strings(args.nodeIds, "nodeIds");
      const parentId = requiredString(args.parentId, 128, "parentId");
      const parent = await containerNode(parentId);
      if (ids.some(id => !parent.children.some(child => child.id === id))) throw new Error("all nodeIds must be immediate children of parentId");
      return planned(index, kind, `Reorder ${ids.length} node(s)`, ids, 0);
    }
    case "groupNodes": {
      const ids = strings(args.nodeIds, "nodeIds");
      await Promise.all(ids.map(sceneNode));
      const parentId = optionalString(args.parentId, 128, "parentId");
      if (parentId) await containerNode(parentId);
      optionalIndex(args.index, "index");
      return planned(index, kind, `Group ${ids.length} node(s)`, ids, 1);
    }
    case "ungroupNodes": {
      const ids = strings(args.nodeIds, "nodeIds");
      const nodes = await Promise.all(ids.map(sceneNode));
      if (nodes.some(node => !("children" in node))) throw new Error("all nodeIds must identify containers");
      return planned(index, kind, `Ungroup ${ids.length} container(s)`, ids, 0);
    }
    case "upsertDesignTokens": {
      validateDesignTokenArgs(args);
      const count = optionalRecords(args.colors, "colors").length
        + optionalRecords(args.spacing, "spacing").length
        + optionalRecords(args.typography, "typography").length;
      return planned(index, kind, `Upsert ${count} token/style definition(s)`, [], count);
    }
  }
}

export function parseBatchOperations(args: Json): Array<{ kind: string; args: Json }> {
  const values = records(args.operations, "operations");
  return values.map((item, index) => ({
    kind: commandName(item.kind, `operations[${index}].kind`),
    args: optionalRecord(item.args, `operations[${index}].args`) || {}
  }));
}

function isBatchKind(kind: string): kind is BatchKind {
  return [
    "createComponents", "createComponentSet", "createInstances", "setInstanceVariantProperties",
    "duplicateNodes", "moveNodes", "reorderNodes", "groupNodes", "ungroupNodes", "upsertDesignTokens"
  ].includes(kind);
}

function planned(index: number, kind: BatchKind, summary: string, affectedNodeIds: string[], creates: number): PlannedOperation {
  return { index, kind, summary, affectedNodeIds, creates };
}

function plannedOperation(index: number, kind: string, summary: string, affectedNodeIds: string[], creates: number): PlannedOperation {
  return { index, kind, summary, affectedNodeIds, creates };
}

async function sceneNode(id: string): Promise<SceneNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`scene node not found: ${id}`);
  return node as SceneNode;
}

async function containerNode(id: string): Promise<ContainerNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || !("children" in node) || !("insertChild" in node)) throw new Error(`node cannot contain children: ${id}`);
  return node as ContainerNode;
}

function insert(parent: ContainerNode, child: SceneNode, index?: number): void {
  if (index === undefined) parent.appendChild(child);
  else {
    if (index > parent.children.length) throw new Error(`index ${index} exceeds parent child count ${parent.children.length}`);
    parent.insertChild(index, child);
  }
}

function isDescendant(candidate: BaseNode, ancestor: BaseNode): boolean {
  let current: BaseNode | null = candidate;
  while (current) {
    if (current.id === ancestor.id) return true;
    current = current.parent;
  }
  return false;
}

function parentAbsoluteTransform(parent: ContainerNode): Transform {
  return "absoluteTransform" in parent ? parent.absoluteTransform : [[1, 0, 0], [0, 1, 0]];
}

function relativeToParent(absolute: Transform, parent: Transform): Transform {
  const determinant = parent[0][0] * parent[1][1] - parent[0][1] * parent[1][0];
  if (Math.abs(determinant) < 1e-12) throw new Error("parent transform cannot be inverted");
  const inverse: Transform = [
    [parent[1][1] / determinant, -parent[0][1] / determinant, 0],
    [-parent[1][0] / determinant, parent[0][0] / determinant, 0]
  ];
  inverse[0][2] = -(inverse[0][0] * parent[0][2] + inverse[0][1] * parent[1][2]);
  inverse[1][2] = -(inverse[1][0] * parent[0][2] + inverse[1][1] * parent[1][2]);
  return multiplyTransforms(inverse, absolute);
}

function multiplyTransforms(left: Transform, right: Transform): Transform {
  return [
    [
      left[0][0] * right[0][0] + left[0][1] * right[1][0],
      left[0][0] * right[0][1] + left[0][1] * right[1][1],
      left[0][0] * right[0][2] + left[0][1] * right[1][2] + left[0][2]
    ],
    [
      left[1][0] * right[0][0] + left[1][1] * right[1][0],
      left[1][0] * right[0][1] + left[1][1] * right[1][1],
      left[1][0] * right[0][2] + left[1][1] * right[1][2] + left[1][2]
    ]
  ];
}

function ensureModes(collection: VariableCollection, names: string[]): Array<{ name: string; modeId: string }> {
  const existing = [...collection.modes];
  if (existing.length === 1 && !names.some(name => name === existing[0].name)) {
    collection.renameMode(existing[0].modeId, names[0]);
  }
  return names.map(name => {
    const match = collection.modes.find(mode => mode.name === name);
    return { name, modeId: match?.modeId || collection.addMode(name) };
  });
}

function upsertVariable(
  variablesByName: Map<string, Variable>,
  name: string,
  collection: VariableCollection,
  type: VariableResolvedDataType
): Variable {
  const existing = variablesByName.get(name);
  if (existing && existing.resolvedType !== type) throw new Error(`variable ${name} already exists with type ${existing.resolvedType}`);
  const variable = existing || figma.variables.createVariable(name, collection, type);
  variablesByName.set(name, variable);
  return variable;
}

function setModeValues(
  variable: Variable,
  modes: Array<{ name: string; modeId: string }>,
  spec: Json,
  parse: (value: unknown) => VariableValue
): void {
  const modeValues = optionalRecord(spec.values, "values");
  const fallback = spec.value;
  for (const mode of modes) {
    const raw = modeValues?.[mode.name] ?? spec[mode.name.toLocaleLowerCase()] ?? fallback;
    if (raw === undefined) throw new Error(`${variable.name} is missing a value for mode ${mode.name}`);
    variable.setValueForMode(mode.modeId, parse(raw));
  }
}

function typographyModeValues(
  spec: Json,
  modes: Array<{ name: string }>,
  path: string
): Map<string, Record<string, string | number>> {
  const values = optionalRecord(spec.values, `${path}.values`);
  const result = new Map<string, Record<string, string | number>>();
  for (const mode of modes) {
    const raw = optionalRecord(values?.[mode.name] ?? spec[mode.name.toLocaleLowerCase()] ?? spec.value ?? spec, `${path}.${mode.name}`) || {};
    const fontSize = number(raw.fontSize, 1, 512, `${path}.${mode.name}.fontSize`);
    result.set(mode.name, {
      fontFamily: optionalString(raw.fontFamily, 128, `${path}.${mode.name}.fontFamily`) || "Inter",
      fontStyle: optionalString(raw.fontStyle, 128, `${path}.${mode.name}.fontStyle`) || "Regular",
      fontSize,
      lineHeight: optionalNumber(raw.lineHeight, 1, 1_000, `${path}.${mode.name}.lineHeight`) ?? fontSize * 1.2,
      letterSpacing: optionalNumber(raw.letterSpacing, -1_000, 1_000, `${path}.${mode.name}.letterSpacing`) ?? 0
    });
  }
  return result;
}

function validateDesignTokenArgs(args: Json): void {
  optionalString(args.collectionName, MAX_NAME, "collectionName");
  const modes = args.modes === undefined ? ["Light", "Dark"] : strings(args.modes, "modes", 8);
  if (new Set(modes).size !== modes.length) throw new Error("modes must not contain duplicates");
  const modeDescriptors = modes.map(name => ({ name }));

  optionalRecords(args.colors, "colors").forEach((spec, index) => {
    requiredString(spec.name, MAX_NAME, `colors[${index}].name`);
    validateModeValues(spec, modes, value => rgba(value, `colors[${index}]`));
  });
  optionalRecords(args.spacing, "spacing").forEach((spec, index) => {
    requiredString(spec.name, MAX_NAME, `spacing[${index}].name`);
    validateModeValues(spec, modes, value => number(value, -1_000_000, 1_000_000, `spacing[${index}]`));
  });
  optionalRecords(args.typography, "typography").forEach((spec, index) => {
    requiredString(spec.name, MAX_NAME, `typography[${index}].name`);
    typographyModeValues(spec, modeDescriptors, `typography[${index}]`);
  });
}

function validateModeValues(spec: Json, modes: string[], parse: (value: unknown) => unknown): void {
  const values = optionalRecord(spec.values, "values");
  for (const mode of modes) {
    const raw = values?.[mode] ?? spec[mode.toLocaleLowerCase()] ?? spec.value;
    if (raw === undefined) throw new Error(`token is missing a value for mode ${mode}`);
    parse(raw);
  }
}

function variantPropertiesName(value: unknown, path: string): string | undefined {
  const properties = optionalRecord(value, path);
  if (!properties) return undefined;
  const entries = Object.entries(properties);
  if (entries.length < 1 || entries.length > 20) throw new Error(`${path} must contain 1..20 properties`);
  return entries.map(([key, raw]) => {
    const name = requiredString(key, 100, `${path} key`);
    const propertyValue = requiredString(raw, 100, `${path}.${key}`);
    if (name.includes("=") || propertyValue.includes(",")) throw new Error(`${path} cannot contain '=' in names or ',' in values`);
    return `${name}=${propertyValue}`;
  }).join(", ");
}

function componentProperties(value: unknown, path: string, required = false): Record<string, string | boolean> | undefined {
  const record = optionalRecord(value, path);
  if (!record) {
    if (required) throw new Error(`${path} must be an object`);
    return undefined;
  }
  const entries = Object.entries(record);
  if (entries.length < 1 || entries.length > 50) throw new Error(`${path} must contain 1..50 properties`);
  const result: Record<string, string | boolean> = {};
  for (const [key, raw] of entries) {
    requiredString(key, 200, `${path} key`);
    if (typeof raw !== "string" && typeof raw !== "boolean") throw new Error(`${path}.${key} must be a string or boolean`);
    result[key] = raw;
  }
  return result;
}

function summarizeNode(node: SceneNode): Json {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: node.parent?.id || null,
    x: "x" in node ? node.x : undefined,
    y: "y" in node ? node.y : undefined,
    width: "width" in node ? node.width : undefined,
    height: "height" in node ? node.height : undefined
  };
}

function instanceSummary(node: InstanceNode): Json {
  return { ...summarizeNode(node), variantProperties: node.variantProperties, componentProperties: node.componentProperties };
}

function variableSummary(variable: Variable): Json {
  return {
    id: variable.id,
    name: variable.name,
    resolvedType: variable.resolvedType,
    variableCollectionId: variable.variableCollectionId,
    valuesByMode: variable.valuesByMode
  };
}

function rgba(value: unknown, path: string): RGBA {
  const record = optionalRecord(value, path);
  if (!record) throw new Error(`${path} must be an RGBA object`);
  return {
    r: number(record.r, 0, 1, `${path}.r`),
    g: number(record.g, 0, 1, `${path}.g`),
    b: number(record.b, 0, 1, `${path}.b`),
    a: optionalNumber(record.a, 0, 1, `${path}.a`) ?? 1
  };
}

function records(value: unknown, path: string, maximum = MAX_ITEMS): Json[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${path} must contain 1..${maximum} objects`);
  }
  return value.map((item, index) => {
    const record = optionalRecord(item, `${path}[${index}]`);
    if (!record) throw new Error(`${path}[${index}] must be an object`);
    return record;
  });
}

function optionalRecords(value: unknown, path: string): Json[] {
  return value === undefined ? [] : records(value, path);
}

function strings(value: unknown, path: string, maximum = MAX_ITEMS): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${path} must contain 1..${maximum} strings`);
  }
  return value.map((item, index) => requiredString(item, MAX_NAME, `${path}[${index}]`));
}

function optionalRecord(value: unknown, path: string): Json | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Json;
}

function number(value: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalNumber(value: unknown, minimum: number, maximum: number, path: string): number | undefined {
  return value === undefined || value === null ? undefined : number(value, minimum, maximum, path);
}

function optionalIndex(value: unknown, path: string): number | undefined {
  const result = optionalNumber(value, 0, 100_000, path);
  if (result !== undefined && !Number.isInteger(result)) throw new Error(`${path} must be an integer`);
  return result;
}

function requiredString(value: unknown, maximum: number, path: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${path} must contain 1..${maximum} characters`);
  }
  return value;
}

function optionalString(value: unknown, maximum: number, path: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, maximum, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function commandName(value: unknown, path: string): string {
  const result = requiredString(value, 100, path);
  if (!/^[a-z][A-Za-z0-9]*$/.test(result)) throw new Error(`${path} must be a lower-camel-case command name`);
  return result;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function exactItems<T>(ids: string[], items: Map<string, T>, label: string): T[] {
  return ids.map(id => {
    const item = items.get(id);
    if (!item) throw new Error(`${label} not found: ${id}`);
    return item;
  });
}
