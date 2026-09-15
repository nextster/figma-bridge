#!/usr/bin/env node
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { requestControl } from "../plugins/figma-bridge/mcp/control.mjs";

const clientId = valueAfter("--client");
if (!clientId || !process.argv.includes("--mutate-temporary")) {
  throw new Error("usage: node scripts/live-verify.mjs --client <id> --mutate-temporary");
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const originalText = `Figma Bridge verification ${suffix}`;
const replacementText = `Verified by Figma Bridge ${suffix}`;
let rootId;

try {
  const createdRoot = await call("nodes.create", {
    nodes: [{ type: "FRAME", name: `__Figma Bridge Verification ${suffix}`, x: 6000, y: 0, width: 520, height: 640 }]
  });
  rootId = createdRoot[0].id;

  const children = await call("nodes.create", {
    parentId: rootId,
    nodes: [
      { type: "RECTANGLE", name: "Visual target", width: 180, height: 96 },
      { type: "TEXT", name: "Text target", characters: originalText, fontSize: 16 },
      { type: "FRAME", name: "Move target", width: 220, height: 120 }
    ]
  });
  const [rectangle, text, moveTarget] = children;

  const operations = [
    {
      kind: "applyAutoLayout",
      args: {
        nodeId: rootId,
        direction: "VERTICAL",
        gap: 16,
        padding: { top: 24, right: 24, bottom: 24, left: 24 },
        primaryAlignment: "MIN",
        counterAlignment: "CENTER",
        primarySizing: "FIXED",
        counterSizing: "FIXED"
      }
    },
    {
      kind: "applyVisualProperties",
      args: {
        nodeId: rectangle.id,
        cornerRadius: { all: 18, bottomLeft: 6 },
        fills: [{
          type: "GRADIENT_LINEAR",
          stops: [
            { position: 0, color: { r: 0.15, g: 0.45, b: 1, a: 1 } },
            { position: 1, color: { r: 0.65, g: 0.2, b: 0.95, a: 1 } }
          ]
        }],
        strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 0.8 }],
        strokeWeight: 2,
        strokeAlign: "INSIDE",
        effects: [{
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 8 },
          radius: 16,
          spread: 0
        }]
      }
    },
    {
      kind: "applyVisualProperties",
      args: {
        nodeId: text.id,
        typography: {
          fontFamily: "Inter",
          fontStyle: "Medium",
          fontSize: 18,
          lineHeight: { value: 24, unit: "PIXELS" },
          letterSpacing: { value: 0.2, unit: "PIXELS" },
          alignHorizontal: "CENTER"
        }
      }
    }
  ];

  const preview = await call("batch.execute", { dryRun: true, operations });
  assert(preview.dryRun === true && preview.operationCount === operations.length, "batch preview mismatch");
  const applied = await call("batch.execute", { dryRun: false, operations });
  assert(applied.dryRun === false && applied.results.length === operations.length, "batch execution mismatch");
  const visualExport = await call("nodes.exportPng", { nodeId: rootId, scale: 1 });

  const duplicate = await call("nodes.duplicate", {
    items: [{ nodeId: rectangle.id, parentId: rootId, name: "Visual target copy", offsetX: 20, offsetY: 20 }]
  });
  const cloneId = duplicate.nodes[0].id;
  const grouped = await call("nodes.group", { nodeIds: [rectangle.id, cloneId], parentId: rootId, name: "Verification group" });
  await call("nodes.ungroup", { nodeIds: [grouped.group.id] });

  const components = await call("components.create", {
    components: [
      { parentId: rootId, width: 120, height: 44, variantProperties: { State: "Default" } },
      { parentId: rootId, width: 120, height: 44, variantProperties: { State: "Pressed" } }
    ]
  });
  const componentIds = components.components.map(component => component.id);
  const componentSet = await call("components.createSet", { componentIds, parentId: rootId, name: "Verification Button" });
  const instanceResult = await call("instances.create", {
    instances: [{ componentId: componentIds[0], parentId: rootId, properties: { State: "Pressed" } }]
  });
  const instanceId = instanceResult.instances[0].id;
  await call("instances.setProperties", { updates: [{ instanceId, properties: { State: "Default" } }] });

  await call("nodes.move", { moves: [{ nodeId: text.id, parentId: moveTarget.id, preserveAbsolutePosition: true }] });
  await call("nodes.move", { moves: [{ nodeId: text.id, parentId: rootId, preserveAbsolutePosition: true }] });
  await call("nodes.reorder", { parentId: rootId, nodeIds: [text.id, rectangle.id] });

  const searchPreview = await call("document.searchReplaceText", { query: originalText, replacement: replacementText, dryRun: true, limit: 10 });
  assert(searchPreview.matchingNodeCount === 1 && searchPreview.changedNodeCount === 0, "text preview mismatch");
  const searchApplied = await call("document.searchReplaceText", { query: originalText, replacement: replacementText, dryRun: false, limit: 10 });
  assert(searchApplied.changedNodeCount === 1, "text replacement mismatch");

  await call("document.navigate", { nodeIds: [rootId], select: true, focus: true });
  const exported = await call("nodes.exportPng", { nodeId: rootId, scale: 1 });
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "figma-bridge-live-"));
  const visualPngPath = path.join(outputDirectory, "visual-verification.png");
  const finalPngPath = path.join(outputDirectory, "structural-verification.png");
  await writeFile(visualPngPath, Buffer.from(visualExport.data, "base64"));
  await writeFile(finalPngPath, Buffer.from(exported.data, "base64"));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    clientId,
    rootId,
    visualPngPath,
    finalPngPath,
    componentSetId: componentSet.componentSet.id,
    instanceId,
    checks: {
      batchPreview: true,
      batchExecution: true,
      autoLayout: true,
      visualProperties: true,
      typography: true,
      duplicateGroupUngroup: true,
      componentsVariantsInstances: true,
      moveReparentReorder: true,
      wholeFileTextReplace: true,
      navigation: true,
      pngExport: true
    }
  }, null, 2)}\n`);
} finally {
  if (rootId) {
    try {
      await call("nodes.delete", { nodeIds: [rootId] });
      process.stderr.write(`cleaned temporary Figma root ${rootId}\n`);
    } catch (error) {
      process.stderr.write(`FAILED TO CLEAN temporary Figma root ${rootId}: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

function call(command, arguments_) {
  return requestControl("figma.call", { clientId, command, arguments: arguments_ });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
