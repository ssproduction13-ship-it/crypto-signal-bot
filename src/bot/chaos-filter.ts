import { ATR } from "technicalindicators";
import type { Candle } from "./binance.js";
import type { IndicatorResult } from "./indicators.js";

export interface MarketCondition {
  isChaotic: boolean;
  isHighVolatility: boolean;
  isSideways: boolean;
  isLowVolume: boolean;
  atrPercent: number | null;
  warnings: string[];
  recommendation: string;
}

export function assessMarket(
  candles: Candle[],
  ind: IndicatorResult
): MarketCondition {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues.length ? atrValues[atrValues.length - 1]! : null;
  const currentPrice = closes[closes.length - 1]!;

  const atrPercent = atr != null ? (atr / currentPrice) * 100 : null;

  // Guard: same pattern as scoring.ts C2 fix — new listings / illiquid pairs can
  // produce avgVolume=0 → Infinity volumeRatio → false isChaotic/isLowVolume result.
  const volSlice = volumes.slice(-20);
  const avgVolume = volSlice.length > 0 ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  // fix: same as scoring.ts — candles[length-1] is the current open (incomplete) candle.
  // Its volume is always low at period start, causing false isLowVolume detections.
  const lastVolume = volumes.length >= 2 ? volumes[volumes.length - 2]! : volumes[volumes.length - 1]!;
  const volumeRatio = avgVolume > 0 ? lastVolume / avgVolume : 0;

  const warnings: string[] = [];
  let isHighVolatility = false;
  let isSideways = false;
  let isLowVolume = false;

  if (atrPercent != null && atrPercent > 5) {
    isHighVolatility = true;
    warnings.push(`⚡ ATR ${atrPercent.toFixed(1)}% — экстремальная волатильность`);
  } else if (atrPercent != null && atrPercent > 4) {
    isHighVolatility = true;
    warnings.push(`⚡ ATR ${atrPercent.toFixed(1)}% — высокая волатильность`);
  }

  if (ind.adxValue != null && ind.adxValue < 10) {
    isSideways = true;
    warnings.push(`↔️ ADX ${ind.adxValue.toFixed(1)} — боковой рынок, тренда нет`);
  }

  if (volumeRatio < 0.6) {
    isLowVolume = true;
    warnings.push(`📉 Объём ${(volumeRatio * 100).toFixed(0)}% от среднего — низкое участие рынка`);
  }

  const isChaotic =
    (isHighVolatility && isSideways) ||
    (isHighVolatility && isLowVolume) ||
    (atrPercent != null && atrPercent > 6);

  let recommendation: string;
  if (isChaotic) {
    recommendation = "🚫 ТОРГОВАТЬ НЕ РЕКОМЕНДУЕТСЯ — хаотичный рынок";
  } else if (isHighVolatility) {
    recommendation = "⚠️ Высокая волатильность — уменьши размер позиции";
  } else if (isSideways) {
    recommendation = "⚠️ Боковой рынок — предпочитай контртрендовые стратегии";
  } else if (isLowVolume) {
    recommendation = "⚠️ Низкий объём — слабое подтверждение сигнала";
  } else {
    recommendation = "✅ Условия рынка нормальные";
  }

  return {
    isChaotic,
    isHighVolatility,
    isSideways,
    isLowVolume,
    atrPercent,
    warnings,
    recommendation,
  };
}
