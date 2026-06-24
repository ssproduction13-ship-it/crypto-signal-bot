import type { Candle } from "./binance.js";

export type PatternName =
  | "BREAKOUT"
  | "FALSE_BREAKOUT"
  | "CONSOLIDATION"
  | "FLAG"
  | "DOUBLE_TOP"
  | "DOUBLE_BOTTOM"
  | "TRIANGLE"
  | "NONE";

export interface PatternResult {
  name: PatternName;
  confidence: number;
  description: string;
}

function stdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function detectPattern(candles: Candle[]): PatternResult {
  const recent = candles.slice(-30);
  const closes = recent.map((c) => c.close);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);

  const currClose = closes[closes.length - 1]!;
  const prevClose = closes[closes.length - 2]!;
  const recentHigh = Math.max(...highs.slice(-10));
  const recentLow = Math.min(...lows.slice(-10));
  const priorHigh = Math.max(...highs.slice(-20, -10));
  const priorLow = Math.min(...lows.slice(-20, -10));

  const consolidationStd = stdDev(closes.slice(-10));
  const consolidationRange = (recentHigh - recentLow) / currClose;

  if (consolidationRange < 0.02) {
    return {
      name: "CONSOLIDATION",
      confidence: 75,
      description: "Консолидация — цена в узком диапазоне, ожидается пробой",
    };
  }

  const upperTouches = highs.slice(-20).filter(
    (h) => Math.abs(h - priorHigh) / priorHigh < 0.005
  ).length;
  const lowerTouches = lows.slice(-20).filter(
    (l) => Math.abs(l - priorLow) / priorLow < 0.005
  ).length;

  if (upperTouches >= 2 && lowerTouches >= 2) {
    const higherHighs = highs.slice(-10).some((h) => h > priorHigh);
    const lowerLows = lows.slice(-10).some((l) => l < priorLow);
    if (!higherHighs && !lowerLows) {
      return {
        name: "TRIANGLE",
        confidence: 70,
        description: "Треугольник — сжатие диапазона, скоро пробой",
      };
    }
  }

  if (Math.abs(recentHigh - priorHigh) / priorHigh < 0.01 && recentHigh > priorHigh * 0.99) {
    return {
      name: "DOUBLE_TOP",
      confidence: 72,
      description: "Двойная вершина — медвежий разворотный паттерн",
    };
  }

  if (Math.abs(recentLow - priorLow) / priorLow < 0.01 && recentLow < priorLow * 1.01) {
    return {
      name: "DOUBLE_BOTTOM",
      confidence: 72,
      description: "Двойное дно — бычий разворотный паттерн",
    };
  }

  const prevHighs = highs.slice(-20, -5);
  const maxPrevHigh = Math.max(...prevHighs);
  if (currClose > maxPrevHigh * 1.005) {
    const prevBarClose = closes[closes.length - 2]!;
    const prevBarHigh = highs[highs.length - 2]!;
    if (prevBarClose < maxPrevHigh && currClose > maxPrevHigh) {
      return {
        name: "BREAKOUT",
        confidence: 80,
        description: `Пробой уровня сопротивления ${maxPrevHigh.toFixed(2)} — сильный бычий сигнал`,
      };
    }
  }

  const prevLows = lows.slice(-20, -5);
  const minPrevLow = Math.min(...prevLows);
  if (currClose < minPrevLow * 0.995) {
    return {
      name: "BREAKOUT",
      confidence: 78,
      description: `Пробой уровня поддержки ${minPrevLow.toFixed(2)} — медвежий сигнал`,
    };
  }

  const flag5 = closes.slice(-5);
  const trend20 = closes.slice(-25, -5);
  const trendDir = trend20[trend20.length - 1]! > trend20[0]! ? 1 : -1;
  const flagStd = stdDev(flag5);
  const flagMean = flag5.reduce((a, b) => a + b, 0) / flag5.length;

  if (flagStd / flagMean < 0.01) {
    return {
      name: "FLAG",
      confidence: 68,
      description: `Флаг — коррекция против тренда, возможное продолжение ${trendDir > 0 ? "роста" : "падения"}`,
    };
  }

  return {
    name: "NONE",
    confidence: 0,
    description: "Чёткий паттерн не определён",
  };
}
