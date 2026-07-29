import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMaxDrawdown } from "../../lib/metrics.js";

test("computeMaxDrawdown — empty array returns 0", () => {
  assert.equal(computeMaxDrawdown([]), 0);
});

test("computeMaxDrawdown — all positive returns → no drawdown", () => {
  const dd = computeMaxDrawdown([2, 1, 3, 1]);
  assert.equal(dd, 0);
});

// BUG-11 regression: this series previously returned ~2323 % because the old
// formula used additive sums with a near-zero denominator.
test("computeMaxDrawdown — [+2, +1, -3, +1, -5] stays below 15 %", () => {
  const dd = computeMaxDrawdown([2, 1, -3, 1, -5]);
  assert.ok(dd < 15, `Expected dd < 15, got ${dd}`);
  assert.ok(dd > 0,  `Expected dd > 0,  got ${dd}`);
});

test("computeMaxDrawdown — result never exceeds 100 %", () => {
  // Even a catastrophic run cannot produce DD > 100 %
  const dd = computeMaxDrawdown([-50, -50, -50]);
  assert.ok(dd <= 100, `Max DD must not exceed 100 %, got ${dd}`);
});

test("computeMaxDrawdown — deep drawdown then recovery", () => {
  // +10 %: equity 110, peak 110
  // −20 %: equity 110 × 0.8 = 88
  // DD = (110 − 88) / 110 × 100 = 20 %
  const dd = computeMaxDrawdown([10, -20]);
  assert.ok(Math.abs(dd - 20) < 0.01, `Expected ~20 %, got ${dd}`);
});

test("computeMaxDrawdown — single losing trade", () => {
  const dd = computeMaxDrawdown([-5]);
  // equity = 95, peak = 100, DD = 5/100*100 = 5
  assert.ok(Math.abs(dd - 5) < 0.001, `Expected ~5 %, got ${dd}`);
});

test("computeMaxDrawdown — flat (all zeros)", () => {
  const dd = computeMaxDrawdown([0, 0, 0]);
  assert.equal(dd, 0);
});
