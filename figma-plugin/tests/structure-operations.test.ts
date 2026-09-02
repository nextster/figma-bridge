import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteDesignTokens,
  executeStructureBatch,
  inspectDesignTokens,
  parseBatchOperations,
  resolveReferences,
  upsertDesignTokens,
  type ExternalBatchHandlers
} from "../src/structure-operations";

test("design tokens create Light/Dark variables and bound paint/text styles", async () => {
  const runtime = installVariablesMock();
  const result = await upsertDesignTokens({
    collectionName: "Verification",
    modes: ["Light", "Dark"],
    colors: [{ name: "Color/Background", light: { r: 1, g: 1, b: 1 }, dark: { r: 0, g: 0, b: 0 } }],
    spacing: [{ name: "Spacing/Medium", light: 16, dark: 16 }],
    typography: [{
      name: "Type/Body",
      light: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: 24, letterSpacing: 0 },
      dark: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 16, lineHeight: 24, letterSpacing: 0 }
    }]
  }) as Record<string, any>;
  assert.deepEqual(result.collection.modes.map((mode: any) => mode.name), ["Light", "Dark"]);
  assert.equal(result.variables.length, 7);
  assert.deepEqual(result.styles.map((style: any) => style.type), ["PAINT", "TEXT"]);
  assert.equal(runtime.loadedFonts.length, 1);

  const inspected = await inspectDesignTokens({ collectionName: "Verification" }) as Record<string, any>;
  assert.equal(inspected.collections.length, 1);
  assert.equal(inspected.variables.length, 7);
  assert.equal(inspected.paintStyles.length, 1);
  assert.equal(inspected.textStyles.length, 1);

  await deleteDesignTokens({
    collectionIds: [result.collection.id],
    paintStyleIds: [result.styles[0].id],
    textStyleIds: [result.styles[1].id]
  });
  const cleaned = await inspectDesignTokens({ collectionName: "Verification" }) as Record<string, any>;
  assert.equal(cleaned.collections.length, 0);
  assert.equal(cleaned.paintStyles.length, 0);
  assert.equal(cleaned.textStyles.length, 0);
});

test("batch parser accepts bounded allowlist-style operation records", () => {
  assert.deepEqual(parseBatchOperations({
    operations: [{ kind: "applyAutoLayout", args: { nodeId: "1:2", gap: 8 } }]
  }), [{ kind: "applyAutoLayout", args: { nodeId: "1:2", gap: 8 } }]);
  assert.throws(() => parseBatchOperations({ operations: [] }), /must contain 1/);
  assert.throws(() => parseBatchOperations({ operations: [{ kind: "bad-command", args: {} }] }), /lower-camel-case/);
});

test("batch references resolve only from earlier named operation results", () => {
  const results = new Map<string, unknown>([["created", { nodes: [{ id: "4:2" }] }]]);
  assert.deepEqual(resolveReferences({ nodeId: { $ref: "created.nodes.0.id" } }, results), { nodeId: "4:2" });
  assert.throws(() => resolveReferences({ nodeId: { $ref: "missing.nodes.0.id" } }, results), /unavailable earlier step/);
  assert.throws(() => resolveReferences({ nodeId: { $ref: "created.__proto__.id" } }, results), /does not exist/);
});

test("typed script resolves a created result into a later allowlisted step", async () => {
  installUndoMock();
  const received: unknown[] = [];
  const handlers: ExternalBatchHandlers = {
    makeNode: {
      plan: async () => ({ summary: "make", creates: 1 }),
      execute: async () => ({ nodes: [{ id: "4:2" }] })
    },
    moveNode: {
      plan: async () => ({ summary: "move" }),
      execute: async args => { received.push(args); return { moved: true }; }
    }
  };
  const preview = await executeStructureBatch({
    dryRun: true,
    operations: [
      { id: "created", kind: "makeNode", args: {} },
      { id: "moved", kind: "moveNode", args: { nodeId: { $ref: "created.nodes.0.id" } } }
    ]
  }, handlers) as Record<string, any>;
  assert.equal(preview.operations[1].deferred, true);

  const result = await executeStructureBatch({
    dryRun: false,
    operations: [
      { id: "created", kind: "makeNode", args: {} },
      { id: "moved", kind: "moveNode", args: { nodeId: { $ref: "created.nodes.0.id" } } }
    ]
  }, handlers) as Record<string, any>;
  assert.deepEqual(received, [{ nodeId: "4:2" }]);
  assert.equal(result.namedResults.moved.moved, true);
});

test("batch dry-run plans without mutation or undo activity", async () => {
  const calls = installUndoMock();
  let executions = 0;
  const handlers: ExternalBatchHandlers = {
    applyAutoLayout: {
      plan: async () => ({ summary: "layout", affectedNodeIds: ["1:2"] }),
      execute: async () => { executions += 1; }
    }
  };
  const result = await executeStructureBatch({
    dryRun: true,
    operations: [{ kind: "applyAutoLayout", args: { nodeId: "1:2", gap: 8 } }]
  }, handlers) as Record<string, unknown>;
  assert.equal(result.dryRun, true);
  assert.equal(executions, 0);
  assert.deepEqual(calls, { commits: 0, undos: 0 });
});

test("successful batch is bounded by one user-visible Undo step", async () => {
  const calls = installUndoMock();
  const handlers: ExternalBatchHandlers = {
    applyAutoLayout: {
      plan: async () => ({ summary: "layout", affectedNodeIds: ["1:2"] }),
      execute: async () => ({ id: "1:2" })
    }
  };
  const result = await executeStructureBatch({
    dryRun: false,
    operations: [{ kind: "applyAutoLayout", args: { nodeId: "1:2", gap: 8 } }]
  }, handlers) as Record<string, unknown>;
  assert.equal(result.dryRun, false);
  assert.deepEqual(calls, { commits: 2, undos: 0 });
});

test("failed batch rolls back mutations to its opening boundary", async () => {
  const calls = installUndoMock();
  const handlers: ExternalBatchHandlers = {
    applyAutoLayout: {
      plan: async () => ({ summary: "layout", affectedNodeIds: ["1:2"] }),
      execute: async () => { throw new Error("boom"); }
    }
  };
  await assert.rejects(() => executeStructureBatch({
    dryRun: false,
    operations: [{ kind: "applyAutoLayout", args: { nodeId: "1:2", gap: 8 } }]
  }, handlers), /boom/);
  assert.deepEqual(calls, { commits: 1, undos: 1 });
});

function installUndoMock(): { commits: number; undos: number } {
  const calls = { commits: 0, undos: 0 };
  const pluginData = new Map<string, string>();
  Object.defineProperty(globalThis, "figma", {
    configurable: true,
    value: {
      root: {
        getPluginData: (key: string) => pluginData.get(key) || "",
        setPluginData: (key: string, value: string) => { pluginData.set(key, value); }
      },
      commitUndo: () => { calls.commits += 1; },
      triggerUndo: () => { calls.undos += 1; }
    }
  });
  return calls;
}

function installVariablesMock() {
  const collections: any[] = [];
  const variables: any[] = [];
  const paintStyles: any[] = [];
  const textStyles: any[] = [];
  const loadedFonts: any[] = [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}:${++sequence}`;
  const api = {
    root: {
      pluginData: new Map<string, string>(),
      getPluginData(key: string) { return this.pluginData.get(key) || ""; },
      setPluginData(key: string, value: string) { this.pluginData.set(key, value); }
    },
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      createVariableCollection: (name: string) => {
        const collection: any = {
          id: nextId("collection"),
          name,
          modes: [{ modeId: nextId("mode"), name: "Mode 1" }],
          renameMode(modeId: string, modeName: string) {
            this.modes.find((mode: any) => mode.modeId === modeId).name = modeName;
          },
          addMode(modeName: string) {
            const modeId = nextId("mode");
            this.modes.push({ modeId, name: modeName });
            return modeId;
          },
          remove() { collections.splice(collections.indexOf(this), 1); }
        };
        collections.push(collection);
        return collection;
      },
      getLocalVariablesAsync: async () => variables,
      createVariable: (name: string, collection: any, resolvedType: string) => {
        const variable: any = {
          id: nextId("variable"),
          name,
          resolvedType,
          variableCollectionId: collection.id,
          valuesByMode: {},
          scopes: [],
          setValueForMode(modeId: string, value: unknown) { this.valuesByMode[modeId] = value; },
          remove() { variables.splice(variables.indexOf(this), 1); }
        };
        variables.push(variable);
        return variable;
      },
      setBoundVariableForPaint: (paint: any, field: string, variable: any) => ({
        ...paint,
        boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } }
      })
    },
    getLocalPaintStylesAsync: async () => paintStyles,
    getLocalTextStylesAsync: async () => textStyles,
    createPaintStyle: () => {
      const style: any = {
        id: nextId("paint"), name: "", type: "PAINT", paints: [] as any[],
        remove() { paintStyles.splice(paintStyles.indexOf(this), 1); }
      };
      paintStyles.push(style);
      return style;
    },
    createTextStyle: () => {
      const style: any = {
        id: nextId("text"), name: "", type: "TEXT", boundVariables: {},
        setBoundVariable(field: string, variable: any) { this.boundVariables[field] = variable.id; },
        remove() { textStyles.splice(textStyles.indexOf(this), 1); }
      };
      textStyles.push(style);
      return style;
    },
    loadFontAsync: async (font: any) => { loadedFonts.push(font); },
    commitUndo: () => undefined,
    triggerUndo: () => undefined
  };
  Object.defineProperty(globalThis, "figma", { configurable: true, value: api });
  return { collections, variables, paintStyles, textStyles, loadedFonts };
}
