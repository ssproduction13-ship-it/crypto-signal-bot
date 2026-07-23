/**
 * Decision Engine v1.1 — Unit Tests
 * Using Node.js built-in test runner (node:test)
 *
 * Run: node --experimental-strip-types --test src/bot/__tests__/decision-engine.test.mts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ── Pure decision logic helpers (mirrors scheduler.ts gate logic) ────────────

// ВАЖНО: это значение ДОЛЖНО совпадать с MIN_FINAL_SCORE в scheduler.ts.
// Production v3.0 uses the mature-entity threshold after bootstrap.
const MIN_FINAL_SCORE = 10;

type StrategyStatus = "active" | "quarantine" | "disabled";

interface StrategyState {
  status: StrategyStatus;
  trustScore: number;
  trades: number;
}

interface SignalInput {
  score: number;
  confidence: number;
}

interface SelectionResult {
  strategy: string;
  finalScore: number;
  trustScore: number; // from selectionResult (may differ from DB)
}

/** Mirrors scheduler.ts — no TREND fallback when selectionResult is null */
function decideOnNullSelection(selectionResult: SelectionResult | null): { open: boolean; reason: string } {
  if (!selectionResult) {
    return { open: false, reason: "NO_STRATEGY_SELECTED" };
  }
  return { open: true, reason: "OK" };
}

/** Mirrors FinalScore gate */
function finalScoreGate(finalScore: number): { pass: boolean; reason: string } {
  if (finalScore < MIN_FINAL_SCORE) {
    return { pass: false, reason: "FINAL_SCORE_TOO_LOW" };
  }
  return { pass: true, reason: "OK" };
}

/** Mirrors Quarantine gate */
function quarantineGate(
  stratStatus: StrategyState,
  signal: SignalInput,
  finalScore: number,
): { pass: boolean; reason: string } {
  if (stratStatus.status !== "quarantine") {
    return { pass: true, reason: "NOT_QUARANTINED" };
  }
  const qScore = signal.score >= 75;
  const qConf = signal.confidence >= 40;
  const qFS = finalScore >= 20;
  if (!qScore || !qConf || !qFS) {
    const why = !qScore
      ? `Score ${signal.score} < 75`
      : !qConf
      ? `Conf ${signal.confidence}% < 40%`
      : `FinalScore ${finalScore} < 20`;
    return { pass: false, reason: `QUARANTINE_RULE: ${why}` };
  }
  return { pass: true, reason: "QUARANTINE_PASS" };
}

/** Mirrors notification trust display logic — must use DB trustScore */
function buildNotificationTrust(
  selectionResult: SelectionResult,
  stratStatus: StrategyState | undefined,
): number {
  // Decision Engine v1.1: use DB trustScore, NOT selectionResult.trustScore
  return stratStatus?.trustScore ?? selectionResult.trustScore;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Decision Engine v1.1", () => {

  describe("Test 1 — selectionResult=null → NO TRADE (NO_STRATEGY_SELECTED)", () => {
    test("returns NO TRADE when selectionResult is null", () => {
      const result = decideOnNullSelection(null);
      assert.equal(result.open, false);
      assert.equal(result.reason, "NO_STRATEGY_SELECTED");
    });

    test("proceeds when selectionResult is present", () => {
      const result = decideOnNullSelection({
        strategy: "BREAKOUT", finalScore: 25, trustScore: 50,
      });
      assert.equal(result.open, true);
    });
  });

  describe("Test 2 — FinalScore < 10 → reject (FINAL_SCORE_TOO_LOW)", () => {
    test("rejects when finalScore is 9.99", () => {
      const gate = finalScoreGate(9.99);
      assert.equal(gate.pass, false);
      assert.equal(gate.reason, "FINAL_SCORE_TOO_LOW");
    });

    test("rejects when finalScore is 0", () => {
      const gate = finalScoreGate(0);
      assert.equal(gate.pass, false);
      assert.equal(gate.reason, "FINAL_SCORE_TOO_LOW");
    });

    test(`passes when finalScore equals MIN_FINAL_SCORE (${MIN_FINAL_SCORE})`, () => {
      const gate = finalScoreGate(10);
      assert.equal(gate.pass, true);
    });

    test("passes when finalScore is above 10", () => {
      const gate = finalScoreGate(25);
      assert.equal(gate.pass, true);
    });
  });

  describe("Test 3 — Quarantine + Score 74 → reject (QUARANTINE_RULE)", () => {
    test("rejects quarantined strategy with Score=74", () => {
      const stratStatus: StrategyState = { status: "quarantine", trustScore: 60, trades: 30 };
      const signal: SignalInput = { score: 74, confidence: 45 };
      const gate = quarantineGate(stratStatus, signal, 22);
      assert.equal(gate.pass, false);
      assert.match(gate.reason, /QUARANTINE_RULE/);
      assert.match(gate.reason, /Score 74 < 75/);
    });

    test("rejects quarantined strategy with Confidence=39", () => {
      const stratStatus: StrategyState = { status: "quarantine", trustScore: 60, trades: 30 };
      const signal: SignalInput = { score: 80, confidence: 39 };
      const gate = quarantineGate(stratStatus, signal, 22);
      assert.equal(gate.pass, false);
      assert.match(gate.reason, /QUARANTINE_RULE/);
      assert.match(gate.reason, /Conf 39% < 40%/);
    });

    test("rejects quarantined strategy with FinalScore=19", () => {
      const stratStatus: StrategyState = { status: "quarantine", trustScore: 60, trades: 30 };
      const signal: SignalInput = { score: 80, confidence: 45 };
      const gate = quarantineGate(stratStatus, signal, 19);
      assert.equal(gate.pass, false);
      assert.match(gate.reason, /QUARANTINE_RULE/);
      assert.match(gate.reason, /FinalScore 19 < 20/);
    });
  });

  describe("Test 4 — Quarantine + Score≥75 + Conf≥40 + FS≥20 → allow", () => {
    test("allows quarantined strategy when all thresholds are met (Score=75, Conf=40, FS=20)", () => {
      const stratStatus: StrategyState = { status: "quarantine", trustScore: 55, trades: 30 };
      const signal: SignalInput = { score: 75, confidence: 40 };
      const gate = quarantineGate(stratStatus, signal, 20);
      assert.equal(gate.pass, true);
      assert.equal(gate.reason, "QUARANTINE_PASS");
    });

    test("allows quarantined strategy with score=90, conf=60, fs=50", () => {
      const stratStatus: StrategyState = { status: "quarantine", trustScore: 80, trades: 50 };
      const signal: SignalInput = { score: 90, confidence: 60 };
      const gate = quarantineGate(stratStatus, signal, 50);
      assert.equal(gate.pass, true);
    });
  });

  describe("Test 5 — Notification shows DB Trust (not selectionResult.trustScore)", () => {
    test("uses stratStatus.trustScore when DB value is available", () => {
      const selectionResult: SelectionResult = {
        strategy: "TREND", finalScore: 20, trustScore: 0, // selectionResult has 0 (bootstrap bug)
      };
      const stratStatus: StrategyState = { status: "active", trustScore: 65, trades: 25 };
      const trust = buildNotificationTrust(selectionResult, stratStatus);
      assert.equal(trust, 65); // must show DB value, not 0
    });

    test("falls back to selectionResult.trustScore only when stratStatus is undefined", () => {
      const selectionResult: SelectionResult = {
        strategy: "BREAKOUT", finalScore: 30, trustScore: 45,
      };
      const trust = buildNotificationTrust(selectionResult, undefined);
      assert.equal(trust, 45);
    });

    test("never displays 0 when DB has a valid trustScore", () => {
      const selectionResult: SelectionResult = {
        strategy: "VOLUME_IMPULSE", finalScore: 15, trustScore: 0,
      };
      const stratStatus: StrategyState = { status: "active", trustScore: 72, trades: 40 };
      const trust = buildNotificationTrust(selectionResult, stratStatus);
      assert.notEqual(trust, 0);
      assert.equal(trust, 72);
    });
  });

  describe("Test 6 — No TREND fallback anywhere", () => {
    test("decideOnNullSelection returns NO_STRATEGY_SELECTED, not TREND fallback", () => {
      const result = decideOnNullSelection(null);
      assert.equal(result.open, false);
      assert.notEqual(result.reason, "TREND");
      assert.equal(result.reason, "NO_STRATEGY_SELECTED");
    });

    test("buildNotificationTrust does not hardcode TREND as default strategy", () => {
      // Verify the function works with any strategy, not just TREND
      for (const strategy of ["TREND", "BREAKOUT", "VOLUME_IMPULSE", "MEAN_REVERSION"] as const) {
        const sel: SelectionResult = { strategy, finalScore: 20, trustScore: 10 };
        const status: StrategyState = { status: "active", trustScore: 50, trades: 20 };
        const trust = buildNotificationTrust(sel, status);
        assert.equal(trust, 50, `Strategy ${strategy} should use DB trustScore`);
      }
    });
  });

});
