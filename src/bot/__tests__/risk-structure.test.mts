import { test } from "node:test";
import assert from "node:assert/strict";
import { calcRisk } from "../risk.js";
import type { Candle } from "../binance.js";
import type { SupportResistance } from "../levels.js";

function candles(): Candle[] {
  return Array.from({ length: 40 }, (_, index) => {
    const close = 100 + index * 0.05;
    return {
      openTime: index * 60_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100,
      closeTime: (index + 1) * 60_000,
    };
  });
}

function levels(
  nearestSupport: number | null,
  nearestResistance: number | null,
): SupportResistance {
  return {
    supports: nearestSupport == null ? [] : [nearestSupport],
    resistances: nearestResistance == null ? [] : [nearestResistance],
    nearestSupport,
    nearestResistance,
    distanceToSupportPct: null,
    distanceToResistancePct: null,
  };
}

test("uses a nearby structural support for a LONG stop", () => {
  const risk = calcRisk(candles(), "LONG", 10_000, 1, levels(96.8, null));
  const atrStop = risk.entryPrice - risk.atr * 2;
  assert.ok(risk.stopLoss < atrStop);
  assert.ok(risk.positionSize > 0);
});

test("ignores a structural level farther than 1.5x ATR stop distance", () => {
  const risk = calcRisk(candles(), "LONG", 10_000, 1, levels(90, null));
  const atrStop = risk.entryPrice - risk.atr * 2;
  assert.equal(risk.stopLoss, atrStop);
});

test("keeps legacy calcRisk calls working without levels", () => {
  const risk = calcRisk(candles(), "SHORT", 10_000, 1);
  assert.equal(risk.isRRViable, true);
  assert.ok(risk.positionSize > 0);
});

test("admits structure-expanded risk at reduced size when R/R is 1.2–1.5", () => {
  const risk = calcRisk(candles(), "LONG", 10_000, 1, levels(96.8, null));
  assert.ok(risk.rrRatio1 >= 1.2);
  assert.ok(risk.rrRatio1 < 1.5);
  assert.equal(risk.isRRViable, true);
  assert.equal(risk.rrSizeMultiplier, 0.75);
});

test("widens take-profit targets in a trend without changing the ATR stop", () => {
  const base = calcRisk(candles(), "LONG", 10_000, 1, undefined, "unknown");
  const trend = calcRisk(candles(), "LONG", 10_000, 1, undefined, "trend_up");
  assert.equal(trend.stopLoss, base.stopLoss);
  assert.ok(trend.tp1 > base.tp1);
  assert.ok(trend.tp2 > base.tp2);
});

test("narrows take-profit targets in sideways and low-volatility regimes", () => {
  const base = calcRisk(candles(), "LONG", 10_000, 1, undefined, "unknown");
  const sideways = calcRisk(candles(), "LONG", 10_000, 1, undefined, "sideways");
  const lowVol = calcRisk(candles(), "LONG", 10_000, 1, undefined, "low_vol");
  assert.ok(sideways.tp1 < base.tp1);
  assert.ok(lowVol.tp2 < base.tp2);
});