import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRegimeStats } from "../regime-gate.ts";

test("interval-specific regime data can be used from five trades", () => {
  const local = evaluateRegimeStats(5, 2, 1.78, 1, 5);

  assert.ok(local);
  assert.equal(local.blocked, false);
  assert.equal(Number(local.profitFactor.toFixed(2)), 1.78);
  assert.equal(local.winRate, 0.4);
});

test("aggregate fallback still requires ten trades", () => {
  const insufficientAggregate = evaluateRegimeStats(9, 8, 8, 1, 10);
  const sufficientAggregate = evaluateRegimeStats(10, 2, 1, 2, 10);

  assert.equal(insufficientAggregate, null);
  assert.ok(sufficientAggregate);
  assert.equal(sufficientAggregate.blocked, true);
});