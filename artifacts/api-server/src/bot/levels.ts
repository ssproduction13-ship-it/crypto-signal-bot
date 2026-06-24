import type { Candle } from "./binance.js";

export interface SupportResistance {
  supports: number[];
  resistances: number[];
  nearestSupport: number | null;
  nearestResistance: number | null;
  distanceToSupportPct: number | null;
  distanceToResistancePct: number | null;
}

export interface FibLevels {
  fib236: number;
  fib382: number;
  fib500: number;
  fib618: number;
  fib786: number;
}

function findPivots(
  candles: Candle[],
  lookback = 5
): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const curr = candles[i]!;

    const isHigh = slice.every((c) => c.high <= curr.high);
    const isLow = slice.every((c) => c.low >= curr.low);

    if (isHigh) highs.push(curr.high);
    if (isLow) lows.push(curr.low);
  }

  return { highs, lows };
}

function clusterLevels(levels: number[], tolerance = 0.005): number[] {
  if (levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters: number[] = [];

  let group: number[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = group[group.length - 1]!;
    if (Math.abs(sorted[i]! - prev) / prev < tolerance) {
      group.push(sorted[i]!);
    } else {
      clusters.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [sorted[i]!];
    }
  }
  clusters.push(group.reduce((a, b) => a + b, 0) / group.length);
  return clusters;
}

export function calcLevels(candles: Candle[]): SupportResistance {
  const currentPrice = candles[candles.length - 1]!.close;
  const { highs, lows } = findPivots(candles, 5);

  const supports = clusterLevels(
    lows.filter((l) => l < currentPrice)
  ).slice(-5);
  const resistances = clusterLevels(
    highs.filter((h) => h > currentPrice)
  ).slice(0, 5);

  const nearestSupport = supports.length
    ? supports[supports.length - 1]!
    : null;
  const nearestResistance = resistances.length ? resistances[0]! : null;

  const distanceToSupportPct =
    nearestSupport != null
      ? ((currentPrice - nearestSupport) / currentPrice) * 100
      : null;

  const distanceToResistancePct =
    nearestResistance != null
      ? ((nearestResistance - currentPrice) / currentPrice) * 100
      : null;

  return {
    supports,
    resistances,
    nearestSupport,
    nearestResistance,
    distanceToSupportPct,
    distanceToResistancePct,
  };
}

export function calcFibonacci(candles: Candle[], lookback = 50): FibLevels {
  const slice = candles.slice(-lookback);
  const high = Math.max(...slice.map((c) => c.high));
  const low = Math.min(...slice.map((c) => c.low));
  const range = high - low;

  return {
    fib236: high - range * 0.236,
    fib382: high - range * 0.382,
    fib500: high - range * 0.5,
    fib618: high - range * 0.618,
    fib786: high - range * 0.786,
  };
}

export function nearFibLevel(
  price: number,
  fib: FibLevels,
  tolerance = 0.005
): string | null {
  const levels: [string, number][] = [
    ["0.236", fib.fib236],
    ["0.382", fib.fib382],
    ["0.500", fib.fib500],
    ["0.618", fib.fib618],
    ["0.786", fib.fib786],
  ];

  for (const [name, level] of levels) {
    if (Math.abs(price - level) / price < tolerance) {
      return name;
    }
  }
  return null;
}
