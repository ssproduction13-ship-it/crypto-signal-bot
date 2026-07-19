import type { IndicatorResult } from "./indicators.js";
import type { SupportResistance } from "./levels.js";
import type { PatternResult } from "./patterns.js";
import type { FactorWeights } from "./storage.js";

export interface ScoreBreakdown {
  trendScore: number;
  volumeScore: number;
  momentumScore: number;
  levelsScore: number;
  patternScore: number;
  total: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  reasons: string[];
  factorScores: Record<string, number>;
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

export function calcScore(
  ind: IndicatorResult,
  levels: SupportResistance,
  pattern: PatternResult,
  weights: FactorWeights,
  candles: { close: number; volume: number }[]
): ScoreBreakdown {
  const reasons: string[] = [];
  const factorScores: Record<string, number> = {};

  let trendRaw = 50;
  const trendReasons: string[] = [];

  if (ind.emaCrossSignal === "buy") {
    trendRaw += 20;
    trendReasons.push("EMA20 > EMA50 (бычий тренд)");
  } else if (ind.emaCrossSignal === "sell") {
    trendRaw -= 20;
    trendReasons.push("EMA20 < EMA50 (медвежий тренд)");
  }

  if (ind.ema200 != null) {
    const price = candles[candles.length - 1]!.close;
    if (price > ind.ema200) {
      trendRaw += 15;
      trendReasons.push("Цена выше EMA200 (глобальный бычий тренд)");
    } else {
      trendRaw -= 15;
      trendReasons.push("Цена ниже EMA200 (глобальный медвежий тренд)");
    }
  }

  if (ind.trendStrength === "strong") {
    trendRaw += 15;
    trendReasons.push(`ADX ${ind.adxValue?.toFixed(1)} — сильный тренд`);
  } else if (ind.trendStrength === "moderate") {
    trendRaw += 5;
    trendReasons.push(`ADX ${ind.adxValue?.toFixed(1)} — умеренный тренд`);
  } else {
    trendRaw -= 10;
    trendReasons.push(`ADX ${ind.adxValue?.toFixed(1)} — боковик`);
  }

  const trendScore = clamp(trendRaw);
  factorScores["trend"] = trendScore;
  reasons.push(...trendReasons.map((r) => `📈 ${r}`));

  let volumeRaw = 50;
  const volumes = candles.map((c) => c.volume);
  const volSlice = volumes.slice(-20);
  const avgVol = volSlice.length > 0 ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  // fix: candles[length-1] is the current *open* (incomplete) candle — its volume
  // is always low at the start of a period, causing false "below_avg" volumeSignals.
  // Use the last CLOSED candle (length-2) for an accurate volume comparison.
  const lastVol = volumes.length >= 2 ? volumes[volumes.length - 2]! : volumes[volumes.length - 1]!;

  if (avgVol <= 0) {
    // No volume data — keep neutral score, note it
    reasons.push(`📊 Объём: нет данных`);
  } else {
    const volRatio = lastVol / avgVol;
    if (volRatio > 2) {
      volumeRaw += 40;
      reasons.push(`📊 Аномальный объём: ${(volRatio * 100).toFixed(0)}% от среднего`);
    } else if (volRatio > 1.3) {
      volumeRaw += 25;
      reasons.push(`📊 Объём выше среднего: ${(volRatio * 100).toFixed(0)}%`);
    } else if (volRatio < 0.7) {
      volumeRaw -= 25;
      reasons.push(`📊 Слабый объём: ${(volRatio * 100).toFixed(0)}% от среднего`);
    } else {
      reasons.push(`📊 Объём в норме: ${(volRatio * 100).toFixed(0)}%`);
    }
  }

  const volumeScore = clamp(volumeRaw);
  factorScores["volume"] = volumeScore;

  let momentumRaw = 50;
  const momentumReasons: string[] = [];

  if (ind.rsi != null) {
    if (ind.rsi < 30) {
      momentumRaw += 30;
      momentumReasons.push(`RSI ${ind.rsi.toFixed(1)} — перепродан (зона покупки)`);
    } else if (ind.rsi < 45) {
      momentumRaw += 15;
      momentumReasons.push(`RSI ${ind.rsi.toFixed(1)} — слабый бычий`);
    } else if (ind.rsi > 70) {
      momentumRaw -= 30;
      momentumReasons.push(`RSI ${ind.rsi.toFixed(1)} — перекуплен (зона продажи)`);
    } else if (ind.rsi > 55) {
      momentumRaw -= 15;
      momentumReasons.push(`RSI ${ind.rsi.toFixed(1)} — слабый медвежий`);
    } else {
      momentumReasons.push(`RSI ${ind.rsi.toFixed(1)} — нейтральный`);
    }
  }

  if (ind.macdSignal === "buy") {
    momentumRaw += 20;
    momentumReasons.push("MACD — бычье пересечение");
  } else if (ind.macdSignal === "sell") {
    momentumRaw -= 20;
    momentumReasons.push("MACD — медвежье пересечение");
  }

  if (ind.stochSignal === "buy") {
    momentumRaw += 10;
    momentumReasons.push(`StochRSI ${ind.stochRsi?.toFixed(1)} — перепродан`);
  } else if (ind.stochSignal === "sell") {
    momentumRaw -= 10;
    momentumReasons.push(`StochRSI ${ind.stochRsi?.toFixed(1)} — перекуплен`);
  }

  const momentumScore = clamp(momentumRaw);
  factorScores["momentum"] = momentumScore;
  reasons.push(...momentumReasons.map((r) => `⚡ ${r}`));

  let levelsRaw = 50;
  const levelsReasons: string[] = [];

  if (levels.distanceToSupportPct != null) {
    if (levels.distanceToSupportPct < 1) {
      levelsRaw -= 20;
      levelsReasons.push(`Цена у поддержки — высокий риск пробоя (${levels.distanceToSupportPct.toFixed(2)}%)`);
    } else if (levels.distanceToSupportPct < 3) {
      levelsRaw += 20;
      levelsReasons.push(`Поддержка близко: ${levels.nearestSupport?.toFixed(2)} (${levels.distanceToSupportPct.toFixed(2)}%)`);
    }
  }

  if (levels.distanceToResistancePct != null) {
    if (levels.distanceToResistancePct < 1) {
      levelsRaw -= 20;
      levelsReasons.push(`Цена у сопротивления — высокий риск отката (${levels.distanceToResistancePct.toFixed(2)}%)`);
    } else if (levels.distanceToResistancePct < 3) {
      levelsRaw -= 10;
      levelsReasons.push(`Сопротивление близко: ${levels.nearestResistance?.toFixed(2)} (${levels.distanceToResistancePct.toFixed(2)}%)`);
    }
  }

  const levelsScore = clamp(levelsRaw);
  factorScores["levels"] = levelsScore;
  if (levelsReasons.length) reasons.push(...levelsReasons.map((r) => `🎯 ${r}`));

  let patternRaw = 50;
  if (pattern.name !== "NONE") {
    const boost = pattern.confidence > 75 ? 40 : 25;
    patternRaw += boost;
    reasons.push(`🔷 ${pattern.description}`);
  }
  const patternScore = clamp(patternRaw);
  factorScores["pattern"] = patternScore;

  const total = clamp(
    Math.round(
      trendScore * weights.trend +
        volumeScore * weights.volume +
        momentumScore * weights.momentum +
        levelsScore * weights.levels +
        patternScore * weights.pattern
    )
  );

  // fix: patternScore was absent from trendBias — strong reversal/breakout patterns
  // (pin bar, engulfing, double top/bottom) had zero influence on direction.
  // volumeScore added at half-weight: high-volume moves have stronger conviction.
  const trendBias =
    (trendScore    - 50) * weights.trend +
    (momentumScore - 50) * weights.momentum +
    (levelsScore   - 50) * weights.levels +
    (patternScore  - 50) * weights.pattern +
    (volumeScore   - 50) * weights.volume * 0.5;

  // Neutral zone narrowed ±5 → ±3: sideways markets cluster near 0, ±5 was blocking
  // ~50% of signals as NEUTRAL. ±3 still requires meaningful directional conviction
  // (e.g. trendScore=60 + momentumScore=55 needed) while letting marginal trends through.
  const direction: "LONG" | "SHORT" | "NEUTRAL" =
    trendBias > 3 ? "LONG" : trendBias < -3 ? "SHORT" : "NEUTRAL";

  return {
    trendScore,
    volumeScore,
    momentumScore,
    levelsScore,
    patternScore,
    total,
    direction,
    reasons,
    factorScores,
  };
}
