import type { FactorWeights } from "./storage.js";

export type ABShadowDirection = "LONG" | "SHORT" | "NEUTRAL";

export interface ABShadowScoreInput {
  trendScore: number;
  volumeScore: number;
  momentumScore: number;
  levelsScore: number;
  patternScore: number;
}

export interface ABShadowDecision {
  direction: ABShadowDirection;
  score: number;
}

/** Re-score the current market factors with one challenger's weights. */
export function scoreABVariant(
  factors: ABShadowScoreInput,
  weights: FactorWeights,
): ABShadowDecision {
  const trendBias =
    (factors.trendScore - 50) * weights.trend +
    (factors.momentumScore - 50) * weights.momentum +
    (factors.levelsScore - 50) * weights.levels +
    (factors.patternScore - 50) * weights.pattern +
    (factors.volumeScore - 50) * weights.volume * 0.5;

  const direction: ABShadowDirection =
    trendBias > 2 ? "LONG" : trendBias < -2 ? "SHORT" : "NEUTRAL";
  const directional = (value: number): number =>
    direction === "SHORT" ? 100 - value : value;
  const score = Math.max(0, Math.min(100, Math.round(
    directional(factors.trendScore) * weights.trend +
    factors.volumeScore * weights.volume +
    directional(factors.momentumScore) * weights.momentum +
    directional(factors.levelsScore) * weights.levels +
    directional(factors.patternScore) * weights.pattern,
  )));

  return { direction, score };
}

export function shouldOpenABShadow(
  currentDirection: "LONG" | "SHORT",
  decision: ABShadowDecision,
  minScore = 55,
): boolean {
  return decision.direction === currentDirection && decision.score >= minScore;
}
