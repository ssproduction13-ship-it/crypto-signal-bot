import assert from "node:assert/strict";
import test from "node:test";
import { calculateProfitProtection } from "../profit-protection.ts";

test("profit protection locks a long at +0.25R, then +1R", () => {
  const base = {direction:"LONG" as const, entryPrice:100, currentStopLoss:96, initialRiskDistance:4, stage:0};
  assert.equal(calculateProfitProtection({...base, favorableR:1.99}), null);
  assert.deepEqual(calculateProfitProtection({...base, favorableR:2}), {stage:1, stopLoss:101, lockR:0.25});
  assert.deepEqual(calculateProfitProtection({...base, favorableR:3}), {stage:2, stopLoss:104, lockR:1});
});

test("profit protection mirrors correctly for shorts and never loosens stop", () => {
  const base = {direction:"SHORT" as const, entryPrice:100, currentStopLoss:104, initialRiskDistance:4, stage:0};
  assert.deepEqual(calculateProfitProtection({...base, favorableR:2}), {stage:1, stopLoss:99, lockR:0.25});
  assert.deepEqual(calculateProfitProtection({...base, currentStopLoss:98, favorableR:2}), {stage:1, stopLoss:98, lockR:0.25});
});
