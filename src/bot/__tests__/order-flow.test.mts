import assert from "node:assert/strict";
import test from "node:test";
import { calculateOrderBookImbalance } from "../order-flow-math.ts";

test("order-book imbalance is positive when bid depth dominates", () => {
  const result = calculateOrderBookImbalance(
    [[100, 8], [99, 2]],
    [[101, 2]],
  );
  assert.equal(result.direction, "bid");
  assert.equal(result.imbalance, 0.6666666666666666);
});

test("order-book imbalance is negative when ask depth dominates", () => {
  const result = calculateOrderBookImbalance(
    [[100, 1]],
    [[101, 5], [102, 5]],
  );
  assert.equal(result.direction, "ask");
  assert.equal(result.imbalance, -0.8181818181818182);
});

test("empty order books produce a neutral zero imbalance", () => {
  assert.deepEqual(calculateOrderBookImbalance([], []), {
    imbalance: 0,
    direction: "neutral",
  });
});