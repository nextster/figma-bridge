import assert from "node:assert/strict";
import test from "node:test";
import { exportHandoffAsset, prepareSwiftUIHandoff } from "../src/handoff-operations";

test("SwiftUI handoff collects layout, text, assets, symbols, and shader guidance", async () => {
  const text = {
    id: "1:2", name: "Title", type: "TEXT", visible: true, x: 16, y: 20, width: 100, height: 24, opacity: 1,
    characters: "Hello", fontName: { family: "SF Pro", style: "Regular" }, fontSize: 17,
    lineHeight: { unit: "PIXELS", value: 22 }, letterSpacing: { unit: "PERCENT", value: 0 },
    textAlignHorizontal: "LEFT", textAlignVertical: "TOP", textAutoResize: "WIDTH_AND_HEIGHT",
    textCase: "ORIGINAL", textDecoration: "NONE", textStyleId: "",
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }], strokes: [], effects: [],
    constraints: { horizontal: "MIN", vertical: "MIN" }
  };
  const symbol = vector("1:3", "Icon / Search");
  const customVector = vector("1:4", "Brand mark");
  const screen = {
    id: "1:1", name: "Home", type: "FRAME", visible: true, x: 0, y: 0, width: 390, height: 844, opacity: 1,
    layoutMode: "VERTICAL", itemSpacing: 12, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED",
    layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutGrow: 0, layoutAlign: "INHERIT", layoutPositioning: "AUTO",
    constraints: { horizontal: "MIN", vertical: "MIN" }, cornerRadius: 24,
    fills: [
      { type: "IMAGE", imageHash: "abc", scaleMode: "FILL", opacity: 1, visible: true },
      { type: "SHADER", id: "shader:1", properties: { speed: 2 }, opacity: 1, visible: true }
    ], strokes: [], effects: [], children: [text, symbol, customVector],
    exportAsync: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  };
  installFigma(screen);

  const result = await prepareSwiftUIHandoff({ screenIds: ["1:1"] }) as Record<string, any>;
  assert.equal(result.format, "figma-swiftui-handoff@1");
  assert.equal(result.screens[0].layout.mode, "VERTICAL");
  assert.equal(result.texts[0].value, "Hello");
  assert.equal(result.sfSymbols[0].symbol, "magnifyingglass");
  assert.equal(result.sfSymbols[0].exportSkipped, true);
  assert(result.assets.some((asset: any) => asset.kind === "image-fill"));
  assert(result.assets.some((asset: any) => asset.kind === "vector-svg" && asset.nodeId === "1:4"));
  assert(!result.assets.some((asset: any) => asset.nodeId === "1:3"));
  assert.equal(result.shaders[0].sourceCodeRequiresManualViewCode, true);
  assert.match(result.shaderSourceAccess.deeplink, /node-id=1-1/);
});

test("handoff asset export returns bounded original image bytes", async () => {
  installFigma({ id: "1:1", type: "FRAME" }, new Uint8Array([0xff, 0xd8, 0xff]));
  const result = await exportHandoffAsset({ kind: "image-fill", imageHash: "abc" }) as Record<string, any>;
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.extension, "jpg");
  assert.equal(result.data, "/9j/");
});

function vector(id: string, name: string) {
  return {
    id, name, type: "VECTOR", visible: true, x: 0, y: 0, width: 24, height: 24, opacity: 1,
    fills: [], strokes: [], effects: [], constraints: { horizontal: "MIN", vertical: "MIN" },
    exportAsync: async () => new TextEncoder().encode("<svg/>")
  };
}

function installFigma(screen: any, imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])) {
  Object.defineProperty(globalThis, "figma", {
    configurable: true,
    value: {
      fileKey: "file-key",
      mixed: Symbol("mixed"),
      root: { name: "Test file" },
      currentPage: { id: "0:1", name: "Page" },
      variables: {
        getLocalVariableCollectionsAsync: async () => [],
        getLocalVariablesAsync: async () => []
      },
      getLocalPaintStylesAsync: async () => [],
      getLocalTextStylesAsync: async () => [],
      getNodeByIdAsync: async (id: string) => id === screen.id ? screen : null,
      getImageByHash: (hash: string) => hash === "abc" ? { getBytesAsync: async () => imageBytes } : null,
      base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
    }
  });
}
