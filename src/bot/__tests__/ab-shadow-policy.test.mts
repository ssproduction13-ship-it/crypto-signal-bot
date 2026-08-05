import assert from "node:assert/strict";
import test from "node:test";
import { scoreABVariant, shouldOpenABShadow } from "../ab-shadow-policy.ts";

const balanced = {
  trend: 0.30,
  volume: 0.25,
  momentum: 0.20,
  levels: 0.15,
  pattern: 0.10,
};

test("A/B shadow scoring uses challenger weights", () => {
  const factors = {
    trendScore: 90,
    volumeScore: 70,
    momentumScore: 80,
    levelsScore: 60,
    patternScore: 70,
  };
  const trendHeavy = scoreABVariant(factors, {
    ...balanced,
    trend: 0.70,
    volume: 0.10,
    momentum: 0.10,
    levels: 0.05,
    pattern: 0.05,
  });
  const volumeHeavy = scoreABVariant(factors, {
    ...balanced,
    trend: 0.10,
    volume: 0.70,
    momentum: 0.10,
    levels: 0.05,
    pattern: 0.05,
  });
  assert.equal(trendHeavy.direction, "LONG");
  assert.equal(volumeHeavy.direction, "LONG");
  assert.notEqual(trendHeavy.score, volumeHeavy.score);
});

test("A/B shadow requires matching direction and quality floor", () => {
  assert.equal(shouldOpenABShadow("LONG", { direction: "LONG", score: 55 }), true);
  assert.equal(shouldOpenABShadow("LONG", { direction: "SHORT", score: 90 }), false);
  assert.equal(shouldOpenABShadow("LONG", { direction: "LONG", score: 54 }), false);
});
