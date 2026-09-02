import assert from "node:assert/strict";
import test from "node:test";
import { parseAutoLayoutOperation, parseVisualPropertiesOperation } from "../src/design-operations";

test("auto-layout parsing normalizes enums and expands padding", () => {
  assert.deepEqual(parseAutoLayoutOperation({
    nodeId: "1:2",
    direction: "vertical",
    gap: 12,
    padding: { all: 8, horizontal: 16, bottom: 20 },
    primaryAlignment: "center",
    counterSizing: "fill"
  }), {
    nodeId: "1:2",
    direction: "VERTICAL",
    gap: 12,
    padding: { top: 8, right: 16, bottom: 20, left: 16 },
    primaryAlignment: "CENTER",
    counterSizing: "FILL"
  });
});

test("auto-layout parsing rejects empty mutations and unknown fields", () => {
  assert.throws(() => parseAutoLayoutOperation({ nodeId: "1:2" }), /at least one property/);
  assert.throws(() => parseAutoLayoutOperation({ nodeId: "1:2", spacing: 8 }), /unsupported properties: spacing/);
});

test("visual parsing builds normalized solid and gradient paints", () => {
  const operation = parseVisualPropertiesOperation({
    nodeId: "1:2",
    cornerRadius: { all: 12, bottomLeft: 4 },
    fills: [{
      type: "gradient_linear",
      stops: [
        { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }
      ]
    }],
    strokes: [{ type: "solid", color: { r: 0, g: 0, b: 0 }, opacity: 0.25 }]
  });

  assert.deepEqual(operation.cornerRadius, { topLeft: 12, topRight: 12, bottomRight: 12, bottomLeft: 4 });
  assert.deepEqual(operation.fills?.[0], {
    type: "GRADIENT_LINEAR",
    gradientStops: [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }
    ],
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    opacity: 1,
    visible: true
  });
  assert.deepEqual(operation.strokes?.[0], {
    type: "SOLID",
    color: { r: 0, g: 0, b: 0 },
    opacity: 0.25,
    visible: true
  });
});

test("visual parsing validates effects and typography", () => {
  const operation = parseVisualPropertiesOperation({
    nodeId: "1:2",
    effects: [{
      type: "drop_shadow",
      color: { r: 0, g: 0, b: 0, a: 0.2 },
      offset: { x: 0, y: 4 },
      radius: 12
    }],
    typography: {
      fontFamily: "Inter",
      fontStyle: "Medium",
      fontSize: 16,
      lineHeight: { value: 150, unit: "percent" },
      letterSpacing: -0.2,
      alignHorizontal: "center"
    }
  });

  assert.deepEqual(operation.effects?.[0], {
    type: "DROP_SHADOW",
    color: { r: 0, g: 0, b: 0, a: 0.2 },
    offset: { x: 0, y: 4 },
    radius: 12,
    visible: true,
    blendMode: "NORMAL"
  });
  assert.deepEqual(operation.typography, {
    fontName: { family: "Inter", style: "Medium" },
    fontSize: 16,
    lineHeight: { value: 150, unit: "PERCENT" },
    letterSpacing: { value: -0.2, unit: "PIXELS" },
    alignHorizontal: "CENTER"
  });
});

test("visual parsing rejects malformed gradients", () => {
  assert.throws(() => parseVisualPropertiesOperation({
    nodeId: "1:2",
    fills: [{
      type: "GRADIENT_LINEAR",
      stops: [
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }
      ]
    }]
  }), /ordered by position/);
});
