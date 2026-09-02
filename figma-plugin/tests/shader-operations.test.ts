import assert from "node:assert/strict";
import test from "node:test";
import { applyShader, listShaders, parseApplyShaderOperation } from "../src/shader-operations";

test("shader parsing normalizes bounded apply options", () => {
  assert.deepEqual(parseApplyShaderOperation({
    nodeIds: ["1:2"],
    shaderId: "shader:glass",
    target: "fill",
    mode: "replace_shaders",
    properties: { Frost: 0.4 },
    opacity: 0.8
  }), {
    nodeIds: ["1:2"],
    shaderId: "shader:glass",
    target: "FILL",
    properties: { Frost: 0.4 },
    mode: "REPLACE_SHADERS",
    visible: true,
    opacity: 0.8,
    blendMode: undefined
  });
  assert.throws(() => parseApplyShaderOperation({ nodeIds: ["1:2", "1:2"], shaderId: "shader:glass" }), /duplicates/);
  assert.throws(() => parseApplyShaderOperation({ nodeIds: ["1:2"], shaderId: "shader:glass", code: "void main" }), /unsupported properties/);
});

test("lists available shaders without importing them", async () => {
  const runtime = installShaderMock();
  const result = await listShaders({ query: "glass", type: "fill" }) as Record<string, any>;
  assert.equal(result.total, 1);
  assert.equal(result.shaders[0].id, "shader:glass");
  assert.equal(runtime.imports.length, 0);
});

test("imports and applies one shader to exact nodes in one undo transaction", async () => {
  const runtime = installShaderMock();
  const result = await applyShader({
    nodeIds: ["1:2", "1:3"],
    shaderId: "shader:glass",
    properties: { Frost: 0.4, Tint: { r: 0.2, g: 0.4, b: 0.8, a: 0.7 } },
    opacity: 0.9
  }) as Record<string, any>;

  assert.deepEqual(runtime.imports, ["shader:glass"]);
  assert.deepEqual(runtime.nodes[0].fills, [
    { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
    {
      type: "SHADER",
      id: "shader:glass",
      properties: { frost: 0.4, tint: { r: 0.2, g: 0.4, b: 0.8, a: 0.7 } },
      visible: true,
      opacity: 0.9
    }
  ]);
  assert.equal(runtime.nodes[1].fills.filter((paint: any) => paint.type === "SHADER").length, 1);
  assert.equal(result.nodes.length, 2);
  assert.deepEqual(runtime.undo, { commits: 2, undos: 0 });
});

test("rejects incompatible shader targets and rolls back", async () => {
  const runtime = installShaderMock();
  await assert.rejects(() => applyShader({
    nodeIds: ["1:2"],
    shaderId: "shader:effect",
    target: "FILL"
  }), /requires target EFFECT/);
  assert.deepEqual(runtime.undo, { commits: 1, undos: 1 });
});

function installShaderMock() {
  const undo = { commits: 0, undos: 0 };
  const imports: string[] = [];
  const pluginData = new Map<string, string>();
  const nodes: any[] = [
    { id: "1:2", name: "Card", type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], strokes: [], effects: [] },
    { id: "1:3", name: "Panel", type: "FRAME", fills: [{ type: "SHADER", id: "shader:old" }], strokes: [], effects: [] }
  ];
  const shaders: any[] = [
    { id: "shader:glass", name: "Liquid Glass", type: "fill", imported: false },
    { id: "shader:effect", name: "Chromatic Edge", type: "effect", imported: true, propertyDefinitions: {} }
  ];
  const importedGlass = {
    ...shaders[0],
    imported: true,
    propertyDefinitions: {
      frost: { name: "Frost", type: "NUMBER", defaultValue: 0.2 },
      tint: { name: "Tint", type: "COLOR", defaultValue: { r: 1, g: 1, b: 1, a: 1 } }
    }
  };
  Object.defineProperty(globalThis, "figma", {
    configurable: true,
    value: {
      mixed: Symbol("mixed"),
      root: {
        getPluginData: (key: string) => pluginData.get(key) || "",
        setPluginData: (key: string, value: string) => { pluginData.set(key, value); }
      },
      listAvailableShaders: async () => shaders,
      importShaderById: async (id: string) => { imports.push(id); return importedGlass; },
      getNodeByIdAsync: async (id: string) => nodes.find(node => node.id === id) || null,
      commitUndo: () => { undo.commits += 1; },
      triggerUndo: () => { undo.undos += 1; }
    }
  });
  return { undo, imports, nodes };
}
