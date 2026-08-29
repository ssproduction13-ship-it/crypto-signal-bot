import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_STRATEGY_REGIME_LIMITS,
  getDefaultStrategyRegimeLimits,
} from "../regime-limits.ts";

test("strategy/regime defaults preserve the former thresholds", () => {
  const sideways = getDefaultStrategyRegimeLimits("TREND", "sideways");
  const lowVol = getDefaultStrategyRegimeLimits("TREND", "low_vol");

  assert.deepEqual(sideways, DEFAULT_STRATEGY_REGIME_LIMITS);
  assert.deepEqual(lowVol, DEFAULT_STRATEGY_REGIME_LIMITS);
  assert.equal(sideways.enabled, true);
  assert.equal(sideways.minIntervalTrades, 5);
  assert.equal(sideways.minAggregateTrades, 10);
  assert.equal(sideways.minProfitFactor, 0.70);
  assert.equal(sideways.minWinRate, 0.38);
});