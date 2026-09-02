import assert from "node:assert/strict";
import test from "node:test";
import {
  auditDocument,
  navigateToNodes,
  overviewDocument,
  searchAndReplaceText
} from "../src/document-operations";

type MockNode = Record<string, any>;

function installFigma(nodes: MockNode[]) {
  const page: MockNode = {
    id: "page:1",
    name: "Screens",
    type: "PAGE",
    children: nodes.filter(node => node.parent == null),
    selection: [],
    findAll: () => nodes
  };
  for (const node of nodes) if (node.parent == null) node.parent = page;

  let commits = 0;
  let focused: MockNode[] = [];
  const fonts: MockNode[] = [];
  const api: MockNode = {
    root: { name: "Example", children: [page] },
    fileKey: "file-key",
    currentPage: page,
    mixed: Symbol("mixed"),
    loadAllPagesAsync: async () => undefined,
    loadFontAsync: async (font: MockNode) => { fonts.push(font); },
    commitUndo: () => { commits += 1; },
    getNodeByIdAsync: async (id: string) => nodes.find(node => node.id === id) ?? null,
    setCurrentPageAsync: async (nextPage: MockNode) => { api.currentPage = nextPage; },
    viewport: { scrollAndZoomIntoView: (targets: MockNode[]) => { focused = targets; } }
  };
  Object.assign(globalThis, { figma: api });
  return { api, page, get commits() { return commits; }, get focused() { return focused; }, fonts };
}

function frame(overrides: MockNode = {}): MockNode {
  return {
    id: "frame:1",
    name: "Home",
    type: "FRAME",
    visible: true,
    x: 10,
    y: 20,
    width: 390,
    height: 844,
    children: [],
    ...overrides
  };
}

function textNode(overrides: MockNode = {}): MockNode {
  return {
    id: "text:1",
    name: "Title",
    type: "TEXT",
    visible: true,
    characters: "Hello hello",
    fontName: { family: "Inter", style: "Regular" },
    fills: [],
    ...overrides
  };
}

test("overviewDocument summarizes all nodes and top-level frames", async () => {
  const topFrame = frame();
  const copy = textNode({ parent: topFrame });
  const component = frame({
    id: "component:1",
    name: "Button, State=Default",
    type: "COMPONENT",
    componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Pressed"] } },
    variantProperties: { State: "Default" }
  });
  const componentSet = frame({
    id: "set:1",
    name: "Button",
    type: "COMPONENT_SET",
    componentPropertyDefinitions: { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default"] } }
  });
  const variant = frame({
    id: "variant:1",
    name: "State=Default",
    type: "COMPONENT",
    parent: componentSet,
    variantProperties: { State: "Default" }
  });
  Object.defineProperty(variant, "componentPropertyDefinitions", {
    get: () => { throw new Error("variant definitions are not readable"); }
  });
  componentSet.children = [variant];
  topFrame.children = [copy];
  installFigma([topFrame, copy, component, componentSet, variant]);

  const result = await overviewDocument({});
  assert.deepEqual(result.stats, {
    pageCount: 1,
    sceneNodeCount: 5,
    visibleNodeCount: 5,
    hiddenNodeCount: 0,
    textCharacterCount: 11,
    frameCount: 1,
    componentCount: 2,
    componentSetCount: 1,
    instanceCount: 0,
    textCount: 1
  });
  assert.equal((result.pages as MockNode[])[0].topLevelFrames[0].name, "Home");
  assert.deepEqual((result.pages as MockNode[])[0].components[0].variantProperties, { State: "Default" });
  assert.equal("componentPropertyDefinitions" in (result.pages as MockNode[])[0].components[2], false);
});

test("searchAndReplaceText dry-runs by default and mutates only when requested", async () => {
  const copy = textNode();
  const runtime = installFigma([copy]);

  const preview = await searchAndReplaceText({ query: "hello", replacement: "Hi" });
  assert.equal(preview.occurrenceCount, 2);
  assert.equal(copy.characters, "Hello hello");
  assert.equal(runtime.commits, 0);

  const applied = await searchAndReplaceText({ query: "hello", replacement: "Hi", dryRun: false });
  assert.equal(applied.changedNodeCount, 1);
  assert.equal(copy.characters, "Hi Hi");
  assert.equal(runtime.commits, 1);
  assert.deepEqual(runtime.fonts, [{ family: "Inter", style: "Regular" }]);
});

test("navigateToNodes selects and focuses exact nodes", async () => {
  const target = frame();
  const runtime = installFigma([target]);
  const result = await navigateToNodes({ nodeIds: [target.id] });
  assert.deepEqual(runtime.page.selection, [target]);
  assert.deepEqual(runtime.focused, [target]);
  assert.equal((result.page as MockNode).id, runtime.page.id);
});

test("auditDocument reports bounded hygiene signals", async () => {
  const fill = { type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 };
  const first = frame({ id: "frame:1", name: "Frame 1", fills: [fill], layoutMode: "VERTICAL", itemSpacing: 8, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 });
  const second = frame({ id: "frame:2", name: "Frame 2", fills: [fill], layoutMode: "VERTICAL", itemSpacing: 12, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16 });
  const detached = frame({ id: "instance:1", name: "Card", type: "INSTANCE", getMainComponentAsync: async () => null });
  installFigma([first, second, detached]);

  const result = await auditDocument({});
  assert.equal((result.stats as MockNode).badNameCount, 2);
  assert.equal((result.stats as MockNode).detachedInstanceCount, 1);
  assert.equal((result.stats as MockNode).duplicateSolidColorCount, 1);
  assert.equal((result.stats as MockNode).inconsistentAutoLayoutGroupCount, 1);
});
