import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateStrategyDirectionDecision,
} from "../learning-engine.ts";
import {
  analyzeMfeTp2,
} from "../mfe-tp2-analysis.ts";
import {
  MIN_STRATEGY_REGIME_PENALTY_TRADES,
  STRATEGY_REGIME_SCORE_PENALTY,
  getStrategyRegimeScorePenalty,
} from "../strategy-regime-fit.ts";

test("aggregate strategy×direction quarantine uses the requested thresholds", () => {
  const quarantined = evaluateStrategyDirectionDecision({
    strategy: "TREND",
    direction: "LONG",
    trades: 50,
    wins: 10,
    winPnl: 10,
    lossPnl: 30,
    totalPnl: -20,
  });
  assert.equal(quarantined.profitFactor, 10 / 30);
  assert.equal(quarantined.quarantine, true);
  assert.equal(quarantined.weight, 0.25);

  const recovering = evaluateStrategyDirectionDecision({
    strategy: "TREND",
    direction: "LONG",
    trades: 50,
    wins: 30,
    winPnl: 27,
    lossPnl: 20,
    totalPnl: 7,
    currentQuarantine: true,
    currentWeight: 0.25,
  });
  assert.equal(recovering.quarantine, false);
  assert.equal(recovering.weight, 0.6);
});

test("aggregate quarantine does not trigger before 50 trades", () => {
  const result = evaluateStrategyDirectionDecision({
    strategy: "BREAKOUT",
    direction: "SHORT",
    trades: 49,
    wins: 5,
    winPnl: 1,
    lossPnl: 10,
    totalPnl: -9,
  });
  assert.equal(result.quarantine, false);
  assert.equal(result.weight, 1);
});

test("MFE/TP2 analysis reports distribution and strategy splits", () => {
  const result = analyzeMfeTp2([
    { strategy: "TREND", outcome: "TP2", mfeR: 2.4, tp2R: 2 },
    { strategy: "TREND", outcome: "TP1", mfeR: 1.2, tp2R: 2 },
    { strategy: "BREAKOUT", outcome: "SL", mfeR: 0.4, tp2R: 2 },
  ]);
  assert.equal(result.sampleSize, 3);
  assert.equal(result.tp2Reached, 1);
  assert.equal(result.byStrategy.length, 2);
  assert.equal(result.medianRatio, 0.6);
  assert.equal(result.p25Ratio, 0.4);
  assert.ok(Math.abs(result.p75Ratio - 0.9) < 1e-9);
});

test("strategy×regime penalties are explicit and scoped", () => {
  assert.equal(STRATEGY_REGIME_SCORE_PENALTY.MEAN_REVERSION.sideways, undefined);
  assert.equal(STRATEGY_REGIME_SCORE_PENALTY.MEAN_REVERSION.trend_up, 68);
  assert.equal(STRATEGY_REGIME_SCORE_PENALTY.TREND.sideways, 72);
  assert.equal(getStrategyRegimeScorePenalty("TREND", "sideways", MIN_STRATEGY_REGIME_PENALTY_TRADES - 1), null);
  assert.equal(getStrategyRegimeScorePenalty("TREND", "sideways", MIN_STRATEGY_REGIME_PENALTY_TRADES), 72);
});