import assert from "node:assert/strict";
import test from "node:test";
import { calculateRealisticFill } from "../market-emulator-math.ts";

test("emulator fill has zero slippage when the first book level is enough", () => {
  const fill = calculateRealisticFill(
    [{ price: 101, baseSize: 10 }, { price: 102, baseSize: 10 }],
    2,
  );
  assert.equal(fill.fillPrice, 101);
  assert.equal(fill.slippagePct, 0);
  assert.equal(fill.filledSize, 2);
});

test("emulator fill walks the book and returns weighted average", () => {
  const fill = calculateRealisticFill(
    [{ price: 101, baseSize: 2 }, { price: 102, baseSize: 3 }],
    4,
  );
  assert.equal(fill.fillPrice, 101.5);
  assert.equal(fill.slippagePct, (0.5 / 101) * 100);
  assert.equal(fill.filledSize, 4);
});

test("emulator fill extends the last visible level for an oversized virtual order", () => {
  const fill = calculateRealisticFill(
    [{ price: 100, baseSize: 1 }, { price: 101, baseSize: 1 }],
    3,
  );
  assert.equal(fill.fillPrice, 100.66666666666667);
  assert.equal(fill.filledSize, 3);
  assert.ok(fill.slippagePct > 0);
});