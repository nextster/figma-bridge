import { optionalNumber, optionalString, stringIn } from "./validation";

const MAX_RESULTS = 5_000;
const DEFAULT_RESULT_LIMIT = 200;
const DEFAULT_NODE_NAMES = /^(?:frame|group|rectangle|ellipse|line|vector|star|polygon|text|component|instance|section)(?:\s+\d+)?$/i;

type NodeSummary = {
  id: string;
  name: string;
  type: string;
  pageId: string;
  pageName: string;
};

type PageTraversal = {
  page: PageNode;
  nodes: readonly SceneNode[];
};

/** Return one bounded, whole-file structural summary. */
export async function overviewDocument(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxTopLevelFrames = integerArg(args.maxTopLevelFrames, 1, 1_000, "maxTopLevelFrames", 200);
  const maxComponents = integerArg(args.maxComponents, 1, 1_000, "maxComponents", 200);
  await figma.loadAllPagesAsync();

  const pages = traversals();
  const totals = emptyNodeCounts();
  let visibleNodes = 0;
  let hiddenNodes = 0;
  let textCharacters = 0;

  const pageSummaries = pages.map(({ page, nodes }) => {
    const counts = emptyNodeCounts();
    for (const node of nodes) {
      incrementCounts(counts, node);
      incrementCounts(totals, node);
      if (node.visible) visibleNodes += 1;
      else hiddenNodes += 1;
      if (node.type === "TEXT") textCharacters += node.characters.length;
    }

    const topLevelFrames = page.children
      .filter((node): node is FrameNode => node.type === "FRAME")
      .slice(0, maxTopLevelFrames)
      .map(node => ({
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        x: round(node.x),
        y: round(node.y),
        width: round(node.width),
        height: round(node.height),
        childCount: node.children.length
      }));
    const allComponents = nodes.filter((node): node is ComponentNode | ComponentSetNode =>
      node.type === "COMPONENT" || node.type === "COMPONENT_SET"
    );
    const components = allComponents.slice(0, maxComponents).map(node => {
      const isVariant = node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET";
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        parentId: node.parent?.id ?? null,
        ...(node.type === "COMPONENT" && node.variantProperties ? { variantProperties: node.variantProperties } : {}),
        ...(!isVariant ? { componentPropertyDefinitions: node.componentPropertyDefinitions } : {})
      };
    });

    return {
      id: page.id,
      name: page.name,
      current: page.id === figma.currentPage.id,
      directChildCount: page.children.length,
      nodeCount: nodes.length,
      counts,
      topLevelFrames,
      topLevelFramesTruncated: Math.max(0, page.children.filter(node => node.type === "FRAME").length - topLevelFrames.length),
      components,
      componentsTruncated: Math.max(0, allComponents.length - components.length)
    };
  });

  return {
    file: { name: figma.root.name, key: figma.fileKey || null },
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    stats: {
      pageCount: pages.length,
      sceneNodeCount: pages.reduce((sum, entry) => sum + entry.nodes.length, 0),
      visibleNodeCount: visibleNodes,
      hiddenNodeCount: hiddenNodes,
      textCharacterCount: textCharacters,
      ...totals
    },
    pages: pageSummaries
  };
}

/** Search every text node and optionally replace literal matches. Dry-run is the default. */
export async function searchAndReplaceText(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const query = stringIn(args.query, 1, 1_000, "query");
  const replacement = optionalString(args.replacement, 20_000, "replacement") ?? "";
  const caseSensitive = booleanArg(args.caseSensitive, "caseSensitive", false);
  const wholeWord = booleanArg(args.wholeWord, "wholeWord", false);
  const dryRun = booleanArg(args.dryRun, "dryRun", true);
  const commitUndo = booleanArg(args.commitUndo, "commitUndo", true);
  const limit = integerArg(args.limit, 1, MAX_RESULTS, "limit", DEFAULT_RESULT_LIMIT);

  await figma.loadAllPagesAsync();
  const matcher = literalMatcher(query, caseSensitive, wholeWord);
  const matches: Array<NodeSummary & { occurrences: number; before: string; after: string }> = [];
  let matchingNodeCount = 0;
  let occurrenceCount = 0;
  const changes: Array<{ node: TextNode; after: string }> = [];

  for (const { page, nodes } of traversals()) {
    for (const node of nodes) {
      if (node.type !== "TEXT") continue;
      const before = node.characters;
      const occurrences = countMatches(before, matcher);
      if (occurrences === 0) continue;
      matchingNodeCount += 1;
      occurrenceCount += occurrences;
      const after = before.replace(matcher, () => replacement);
      if (matches.length < limit) matches.push({
        ...summarizeNode(node, page),
        occurrences,
        before: boundedText(before),
        after: boundedText(after)
      });
      changes.push({ node, after });
    }
  }

  if (!dryRun && changes.length > 0) {
    if (changes.length > MAX_RESULTS) {
      throw new Error(`replacement affects more than ${MAX_RESULTS} text nodes; narrow the query before applying`);
    }
    const fonts = uniqueFonts(changes.map(change => change.node));
    await Promise.all(fonts.map(font => figma.loadFontAsync(font)));
    for (const change of changes) change.node.characters = change.after;
    if (commitUndo) figma.commitUndo();
  }

  return {
    query,
    replacement,
    caseSensitive,
    wholeWord,
    dryRun,
    matchingNodeCount,
    occurrenceCount,
    changedNodeCount: dryRun ? 0 : changes.length,
    matches,
    matchesTruncated: Math.max(0, matchingNodeCount - matches.length)
  };
}

/** Select exact nodes, switch to their page, and focus the Figma viewport. */
export async function navigateToNodes(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ids = explicitNodeIds(args.nodeIds);
  const shouldSelect = booleanArg(args.select, "select", true);
  const shouldFocus = booleanArg(args.focus, "focus", true);
  const resolved = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)));
  const nodes = resolved.map((node, index) => {
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") throw new Error(`scene node not found: ${ids[index]}`);
    return node as SceneNode;
  });
  const pages = nodes.map(containingPage);
  if (pages.some(page => page.id !== pages[0].id)) throw new Error("all navigation nodes must belong to the same page");

  await figma.setCurrentPageAsync(pages[0]);
  if (shouldSelect) figma.currentPage.selection = nodes;
  if (shouldFocus) figma.viewport.scrollAndZoomIntoView(nodes);

  return {
    page: { id: pages[0].id, name: pages[0].name },
    selected: shouldSelect,
    focused: shouldFocus,
    nodes: nodes.map(node => ({ id: node.id, name: node.name, type: node.type }))
  };
}

/** Audit common structural hygiene problems without mutating the file. */
export async function auditDocument(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const limit = integerArg(args.limit, 1, MAX_RESULTS, "limit", DEFAULT_RESULT_LIMIT);
  await figma.loadAllPagesAsync();

  const badNames: Array<NodeSummary & { reason: string }> = [];
  const instances: Array<{ node: InstanceNode; page: PageNode }> = [];
  const solidColors = new Map<string, { color: RGB; opacity: number; nodes: NodeSummary[]; nodeIds: Set<string>; totalUses: number }>();
  const layoutGroups = new Map<string, Array<NodeSummary & { signature: string; layoutMode: string }>>();
  let badNameCount = 0;

  for (const { page, nodes } of traversals()) {
    for (const node of nodes) {
      const nameIssue = nameIssueFor(node.name);
      if (nameIssue) {
        badNameCount += 1;
        if (badNames.length < limit) badNames.push({ ...summarizeNode(node, page), reason: nameIssue });
      }
      if (node.type === "INSTANCE") instances.push({ node, page });
      collectSolidColors(node, page, solidColors, limit);
      collectLayoutSignature(node, page, layoutGroups);
    }
  }

  const detachedInstances: Array<NodeSummary> = [];
  let detachedInstanceCount = 0;
  for (const { node, page } of instances) {
    let detached = false;
    try {
      detached = (await node.getMainComponentAsync()) === null;
    } catch {
      detached = true;
    }
    if (detached) {
      detachedInstanceCount += 1;
      if (detachedInstances.length < limit) detachedInstances.push(summarizeNode(node, page));
    }
  }

  const allDuplicateSolidColors = [...solidColors.entries()]
    .filter(([, entry]) => entry.nodeIds.size > 1)
    .sort((a, b) => b[1].totalUses - a[1].totalUses)
    .map(([key, entry]) => ({
      key,
      color: entry.color,
      opacity: entry.opacity,
      useCount: entry.totalUses,
      nodeCount: entry.nodeIds.size,
      nodes: entry.nodes
    }));
  const duplicateSolidColors = allDuplicateSolidColors.slice(0, limit);

  const allInconsistentAutoLayout = [...layoutGroups.entries()]
    .map(([key, entries]) => ({ key, entries, signatures: [...new Set(entries.map(entry => entry.signature))] }))
    .filter(group => group.entries.length > 1 && group.signatures.length > 1);
  const inconsistentAutoLayout = allInconsistentAutoLayout.slice(0, limit);

  return {
    stats: {
      badNameCount,
      detachedInstanceCount,
      duplicateSolidColorCount: allDuplicateSolidColors.length,
      inconsistentAutoLayoutGroupCount: allInconsistentAutoLayout.length
    },
    badNames,
    detachedInstances,
    duplicateSolidColors,
    inconsistentAutoLayout,
    notes: {
      detachedInstances: "Detected only when an INSTANCE node exists but its main component cannot be resolved.",
      duplicateSolidColors: "Exact visible SOLID paint RGBA values reused by multiple nodes; intentional reuse is not distinguished.",
      inconsistentAutoLayout: "Compared spacing signatures only among auto-layout nodes with the same normalized name and layout mode."
    }
  };
}

function traversals(): PageTraversal[] {
  return figma.root.children.map(page => ({ page, nodes: page.findAll() }));
}

function emptyNodeCounts(): Record<string, number> {
  return { frameCount: 0, componentCount: 0, componentSetCount: 0, instanceCount: 0, textCount: 0 };
}

function incrementCounts(counts: Record<string, number>, node: SceneNode): void {
  if (node.type === "FRAME") counts.frameCount += 1;
  if (node.type === "COMPONENT") counts.componentCount += 1;
  if (node.type === "COMPONENT_SET") counts.componentSetCount += 1;
  if (node.type === "INSTANCE") counts.instanceCount += 1;
  if (node.type === "TEXT") counts.textCount += 1;
}

function summarizeNode(node: SceneNode, page: PageNode): NodeSummary {
  return { id: node.id, name: node.name, type: node.type, pageId: page.id, pageName: page.name };
}

function literalMatcher(query: string, caseSensitive: boolean, wholeWord: boolean): RegExp {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = wholeWord ? `\\b${escaped}\\b` : escaped;
  return new RegExp(body, caseSensitive ? "g" : "gi");
}

function countMatches(value: string, matcher: RegExp): number {
  matcher.lastIndex = 0;
  let count = 0;
  while (matcher.exec(value)) {
    count += 1;
    if (matcher.lastIndex === 0) break;
  }
  matcher.lastIndex = 0;
  return count;
}

function uniqueFonts(nodes: readonly TextNode[]): FontName[] {
  const fonts = new Map<string, FontName>();
  for (const node of nodes) {
    const nodeFonts = node.fontName === figma.mixed
      ? node.getRangeAllFontNames(0, node.characters.length)
      : [node.fontName];
    for (const font of nodeFonts) fonts.set(`${font.family}\u0000${font.style}`, font);
  }
  return [...fonts.values()];
}

function containingPage(node: SceneNode): PageNode {
  let cursor: BaseNode | null = node;
  while (cursor && cursor.type !== "PAGE") cursor = cursor.parent;
  if (!cursor || cursor.type !== "PAGE") throw new Error(`node is not attached to a page: ${node.id}`);
  return cursor;
}

function explicitNodeIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error("nodeIds must contain 1..100 node IDs");
  return value.map((id, index) => stringIn(id, 1, 128, `nodeIds[${index}]`));
}

function nameIssueFor(name: string): string | null {
  if (name.trim().length === 0) return "empty";
  if (/\p{C}/u.test(name)) return "control-character";
  if (/^\d+$/.test(name.trim())) return "numeric-only";
  if (DEFAULT_NODE_NAMES.test(name.trim())) return "default-name";
  return null;
}

function collectSolidColors(
  node: SceneNode,
  page: PageNode,
  colors: Map<string, { color: RGB; opacity: number; nodes: NodeSummary[]; nodeIds: Set<string>; totalUses: number }>,
  limit: number
): void {
  if (!("fills" in node) || node.fills === figma.mixed) return;
  for (const paint of node.fills) {
    if (paint.type !== "SOLID" || paint.visible === false) continue;
    const opacity = paint.opacity ?? 1;
    const key = [paint.color.r, paint.color.g, paint.color.b, opacity].map(value => round(value)).join(":");
    const entry = colors.get(key) ?? { color: paint.color, opacity, nodes: [], nodeIds: new Set<string>(), totalUses: 0 };
    entry.totalUses += 1;
    if (!entry.nodeIds.has(node.id) && entry.nodes.length < limit) entry.nodes.push(summarizeNode(node, page));
    entry.nodeIds.add(node.id);
    colors.set(key, entry);
  }
}

function collectLayoutSignature(
  node: SceneNode,
  page: PageNode,
  groups: Map<string, Array<NodeSummary & { signature: string; layoutMode: string }>>
): void {
  if (!("layoutMode" in node) || (node.layoutMode !== "HORIZONTAL" && node.layoutMode !== "VERTICAL")) return;
  const normalizedName = node.name.trim().toLocaleLowerCase().replace(/\s+\d+$/, "");
  if (!normalizedName) return;
  const signature = [node.itemSpacing, node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
    .map(value => round(value))
    .join(":");
  const key = `${normalizedName}|${node.layoutMode}`;
  const entries = groups.get(key) ?? [];
  entries.push({ ...summarizeNode(node, page), signature, layoutMode: node.layoutMode });
  groups.set(key, entries);
}

function integerArg(value: unknown, minimum: number, maximum: number, name: string, fallback: number): number {
  return Math.round(optionalNumber(value, minimum, maximum, name) ?? fallback);
}

function booleanArg(value: unknown, name: string, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function boundedText(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
}
