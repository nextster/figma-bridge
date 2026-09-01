import assert from "node:assert/strict";
import test from "node:test";
import { color, nodeIds, numberIn, optionalString } from "../src/validation";

test("numberIn rejects non-finite and out-of-range values", () => {
  assert.equal(numberIn(4, 0, 10, "value"), 4);
  assert.throws(() => numberIn(Number.NaN, 0, 10, "value"), /between 0 and 10/);
  assert.throws(() => numberIn(11, 0, 10, "value"), /between 0 and 10/);
});

test("nodeIds enforces bounded explicit identifiers", () => {
  assert.deepEqual(nodeIds(["1:2", "3:4"]), ["1:2", "3:4"]);
  assert.throws(() => nodeIds([]), /1..100/);
  assert.throws(() => nodeIds(new Array(101).fill("1:2")), /1..100/);
});

test("color validates normalized RGB values", () => {
  assert.deepEqual(color({ r: 1, g: 0.5, b: 0 }), { r: 1, g: 0.5, b: 0 });
  assert.throws(() => color({ r: 2, g: 0.5, b: 0 }), /fill.r/);
});

test("optionalString preserves omission", () => {
  assert.equal(optionalString(undefined, 10, "name"), undefined);
  assert.equal(optionalString("hello", 10, "name"), "hello");
});
