import {
  RSI,
  MACD,
  BollingerBands,
  EMA,
  StochasticRSI,
  ADX,
  ATR,
} from "technicalindicators";
import type { Candle } from "./binance.js";

export interface IndicatorResult {
  rsi: number | null;
  macdSignal: "buy" | "sell" | "neutral";
  macdHistogram: number | null;
  bbSignal: "buy" | "sell" | "neutral";
  bbPercent: number | null;
  emaCrossSignal: "buy" | "sell" | "neutral";
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  stochRsi: number | null;
  stochSignal: "buy" | "sell" | "neutral";
  adxValue: number | null;
  trendStrength: "strong" | "moderate" | "weak";
  volumeSignal: "above_avg" | "below_avg";
  atr: number | null;
  atrPercent: number | null;
}

export function calcIndicators(candles: Candle[]): IndicatorResult {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const currentClose = closes[closes.length - 1]!;

  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues.length ? rsiValues[rsiValues.length - 1]! : null;

  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const lastMacd = macdValues.length ? macdValues[macdValues.length - 1]! : null;
  const prevMacd = macdValues.length > 1 ? macdValues[macdValues.length - 2]! : null;

  let macdSignal: "buy" | "sell" | "neutral" = "neutral";
  let macdHistogram: number | null = null;

  if (lastMacd?.histogram != null) {
    macdHistogram = lastMacd.histogram;
    if (prevMacd?.histogram != null && prevMacd.histogram < 0 && lastMacd.histogram >= 0) {
      macdSignal = "buy";
    } else if (prevMacd?.histogram != null && prevMacd.histogram > 0 && lastMacd.histogram <= 0) {
      macdSignal = "sell";
    } else {
      macdSignal = lastMacd.histogram > 0 ? "buy" : "sell";
    }
  }

  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const lastBb = bbValues.length ? bbValues[bbValues.length - 1]! : null;
  let bbSignal: "buy" | "sell" | "neutral" = "neutral";
  let bbPercent: number | null = null;

  if (lastBb) {
    const range = lastBb.upper - lastBb.lower;
    if (range > 0) {
      bbPercent = ((currentClose - lastBb.lower) / range) * 100;
      if (bbPercent < 20) bbSignal = "buy";
      else if (bbPercent > 80) bbSignal = "sell";
    }
  }

  const ema20Values = EMA.calculate({ values: closes, period: 20 });
  const ema50Values = EMA.calculate({ values: closes, period: 50 });
  const ema200Values = EMA.calculate({ values: closes, period: 200 });
  const ema20 = ema20Values.length ? ema20Values[ema20Values.length - 1]! : null;
  const ema50 = ema50Values.length ? ema50Values[ema50Values.length - 1]! : null;
  const ema200 = ema200Values.length ? ema200Values[ema200Values.length - 1]! : null;

  let emaCrossSignal: "buy" | "sell" | "neutral" = "neutral";
  const prevEma20 = ema20Values.length > 1 ? ema20Values[ema20Values.length - 2]! : null;
  const prevEma50 = ema50Values.length > 1 ? ema50Values[ema50Values.length - 2]! : null;
  if (ema20 != null && ema50 != null && prevEma20 != null && prevEma50 != null) {
    if (prevEma20 < prevEma50 && ema20 > ema50) emaCrossSignal = "buy";
    else if (prevEma20 > prevEma50 && ema20 < ema50) emaCrossSignal = "sell";
  }

  const stochValues = StochasticRSI.calculate({
    values: closes,
    rsiPeriod: 14,
    stochasticPeriod: 14,
    kPeriod: 3,
    dPeriod: 3,
  });
  const lastStoch = stochValues.length ? stochValues[stochValues.length - 1]! : null;
  const stochRsi = lastStoch?.k != null ? lastStoch.k : null;
  let stochSignal: "buy" | "sell" | "neutral" = "neutral";
  if (stochRsi != null) {
    if (stochRsi < 20) stochSignal = "buy";
    else if (stochRsi > 80) stochSignal = "sell";
  }

  const adxValues = ADX.calculate({ close: closes, high: highs, low: lows, period: 14 });
  const lastAdx = adxValues.length ? adxValues[adxValues.length - 1]! : null;
  const adxValue = lastAdx?.adx != null ? lastAdx.adx : null;
  let trendStrength: "strong" | "moderate" | "weak" = "weak";
  if (adxValue != null) {
    if (adxValue > 25) trendStrength = "strong";
    else if (adxValue > 15) trendStrength = "moderate";
  }

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues.length ? atrValues[atrValues.length - 1]! : null;
  const atrPercent = atr != null ? (atr / currentClose) * 100 : null;

  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVolume = volumes[volumes.length - 1]!;
  const volumeSignal: "above_avg" | "below_avg" = lastVolume > avgVolume ? "above_avg" : "below_avg";

  return {
    rsi,
    macdSignal,
    macdHistogram,
    bbSignal,
    bbPercent,
    emaCrossSignal,
    ema20,
    ema50,
    ema200,
    stochRsi,
    stochSignal,
    adxValue,
    trendStrength,
    volumeSignal,
    atr,
    atrPercent,
  };
}
