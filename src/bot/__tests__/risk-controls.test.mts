import assert from "node:assert/strict";
import test from "node:test";
import {
  capPositionSizeByNotional,
  capRiskPercentByNotional,
} from "../position-sizing.ts";
import { getLossLimitStopReason } from "../risk-limits.ts";

test("daily loss series activates the kill switch threshold", () => {
  const losses = [-2.1, -1.4, -1.6];
  const dailyLoss = losses.reduce((sum, value) => sum + value, 0);

  assert.equal(
    getLossLimitStopReason(dailyLoss, dailyLoss, 5, 12),
    "Дневной лимит убытка достигнут: -5.1% (лимит 5%)",
  );
});

test("weekly loss threshold is checked after the daily threshold", () => {
  assert.equal(
    getLossLimitStopReason(-3, -12, 5, 12),
    "Недельный лимит убытка достигнут: -12.0% (лимит 12%)",
  );
});

test("absolute position cap reduces risk before opening", () => {
  const capped = capRiskPercentByNotional({
    balance: 100_000,
    entryPrice: 100,
    stopLoss: 95,
    riskPercent: 2,
    maxNotional: 500,
  });

  assert.equal(capped.capped, true);
  assert.equal(capped.calculatedNotional, 40_000);
  assert.equal(capped.riskPercent, 0.025);
  assert.equal(capPositionSizeByNotional(100, 10, 500).size, 5);
});