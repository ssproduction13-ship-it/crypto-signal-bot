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

/**
 * BUG-02 fix: returns the closed candles only (drops the last, currently-open candle).
 *
 * All indicators used for signal generation MUST run on closed candles.
 * The current (last) candle is still forming — its OHLCV values change every tick,
 * causing RSI, MACD, EMA, BB, StochRSI, ADX to "flicker" until bar close.
 * This helper is the single source of truth for that slice.
 *
 * Usage: every place that builds indicator inputs from a candle array must call
 * getClosedCandles() before passing the array to calcIndicators or any indicator lib.
 */
export function getClosedCandles(candles: Candle[]): Candle[] {
  return candles.slice(0, -1);
}

export function calcIndicators(candles: Candle[]): IndicatorResult {
  if (!candles.length) {
    return {
      rsi: null, macdSignal: "neutral", macdHistogram: null,
      bbSignal: "neutral", bbPercent: null, emaCrossSignal: "neutral",
      ema20: null, ema50: null, ema200: null, stochRsi: null,
      stochSignal: "neutral", adxValue: null, trendStrength: "weak",
      volumeSignal: "below_avg", atr: null, atrPercent: null,
    };
  }

  // BUG-02 fix: drop the current open (incomplete) candle before computing any indicator.
  // Volume was already fixed at the call-site in scoring.ts / strategies.ts (using length-2),
  // but RSI, MACD, BB, EMA cross, StochRSI, ADX still used the full array including the
  // live candle, causing values to flicker mid-bar.
  // We apply the slice here — inside calcIndicators — so ALL indicators share one fix point
  // rather than scattering slices across every caller.
  const closed = candles.length > 1 ? candles.slice(0, -1) : candles;

  const closes  = closed.map((c) => c.close);
  const highs   = closed.map((c) => c.high);
  const lows    = closed.map((c) => c.low);
  const volumes = closed.map((c) => c.volume);
  // currentClose is now the last *closed* bar's close — stable, not flickering
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
      // fix: histogram > 0 without a fresh crossover is NOT a signal.
      // Always returning buy/sell here drowned out real crossovers and
      // caused MACD to signal constantly, inflating false positives.
      macdSignal = "neutral";
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

  const ema20Values  = EMA.calculate({ values: closes, period: 20 });
  const ema50Values  = EMA.calculate({ values: closes, period: 50 });
  const ema200Values = EMA.calculate({ values: closes, period: 200 });
  const ema20  = ema20Values.length  ? ema20Values[ema20Values.length - 1]!   : null;
  const ema50  = ema50Values.length  ? ema50Values[ema50Values.length - 1]!   : null;
  // L2: require at least 200 closed candles for a meaningful EMA-200.
  // With fewer bars the library still computes a value but it's unreliable —
  // silently using it would distort the trend score. Returning null makes the
  // absence explicit and scoring.ts already handles ema200 == null correctly.
  const ema200 = (closes.length >= 200 && ema200Values.length) ? ema200Values[ema200Values.length - 1]! : null;

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
  const stochRsi  = lastStoch?.k != null ? lastStoch.k : null;
  let stochSignal: "buy" | "sell" | "neutral" = "neutral";
  if (stochRsi != null) {
    if (stochRsi < 20) stochSignal = "buy";
    else if (stochRsi > 80) stochSignal = "sell";
  }

  const adxValues = ADX.calculate({ close: closes, high: highs, low: lows, period: 14 });
  const lastAdx   = adxValues.length ? adxValues[adxValues.length - 1]! : null;
  const adxValue  = lastAdx?.adx != null ? lastAdx.adx : null;
  let trendStrength: "strong" | "moderate" | "weak" = "weak";
  if (adxValue != null) {
    if (adxValue > 25) trendStrength = "strong";
    else if (adxValue > 15) trendStrength = "moderate";
  }

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr       = atrValues.length ? atrValues[atrValues.length - 1]! : null;
  const atrPercent = atr != null ? (atr / currentClose) * 100 : null;

  // BUG-02 fix: volumeSignal now compares against closed volumes (via `volumes` slice above).
  // Previously `volumes[volumes.length - 1]` pointed to the live candle, whose volume
  // starts near zero every bar → near-constant "below_avg" false signal.
  const volSlice20 = volumes.slice(-20);
  const avgVolume  = volSlice20.length > 0 ? volSlice20.reduce((a, b) => a + b, 0) / volSlice20.length : 0;
  const lastVolume = volumes[volumes.length - 1]!; // last *closed* candle volume
  // avgVolume > 0 guard prevents Infinity/NaN on zero-volume (illiquid or new-listing) candles
  const volumeSignal: "above_avg" | "below_avg" = avgVolume > 0 && lastVolume > avgVolume ? "above_avg" : "below_avg";

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
