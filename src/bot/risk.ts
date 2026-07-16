import { ATR } from "technicalindicators";
import type { Candle } from "./binance.js";

export interface RiskParams {
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  atr: number;
  atrPercent: number;
  stopDistancePct: number;
  rrRatio1: number;
  rrRatio2: number;
  positionSize: number;
  maxLossAmount: number;
  isRRViable: boolean;
}

export function calcRisk(
  candles: Candle[],
  direction: "LONG" | "SHORT",
  accountSize: number,
  riskPercent: number
): RiskParams {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues.length ? atrValues[atrValues.length - 1]! : closes[closes.length - 1]! * 0.01;

  const entryPrice = closes[closes.length - 1]!;
  const atrPercent = (atr / entryPrice) * 100;

  let stopLoss: number;
  let tp1: number;
  let tp2: number;

  if (direction === "LONG") {
    stopLoss = entryPrice - atr * 1.3;
    tp1 = entryPrice + atr * 3.0;
    tp2 = entryPrice + atr * 5.0;
  } else {
    stopLoss = entryPrice + atr * 1.3;
    tp1 = entryPrice - atr * 3.0;
    tp2 = entryPrice - atr * 5.0;
  }

  const stopDistancePct =
    (Math.abs(entryPrice - stopLoss) / entryPrice) * 100;

  const rrRatio1 =
    Math.abs(tp1 - entryPrice) / Math.abs(stopLoss - entryPrice);
  const rrRatio2 =
    Math.abs(tp2 - entryPrice) / Math.abs(stopLoss - entryPrice);

  const maxLossAmount = accountSize * (riskPercent / 100);
  // fix: position size was ignoring ~0.2% round-trip commission, causing actual risk
  // to exceed the declared riskPercent. Commission is now baked into the denominator:
  // totalLoss = size × (stopDistance + entryPrice × 0.002)
  const COMMISSION_RT = 0.002; // 0.1% entry + 0.1% exit (KuCoin standard)
  const positionSize = maxLossAmount / (Math.abs(entryPrice - stopLoss) + entryPrice * COMMISSION_RT);

  const isRRViable = rrRatio1 >= 2.0;

  return {
    entryPrice,
    stopLoss,
    tp1,
    tp2,
    atr,
    atrPercent,
    stopDistancePct,
    rrRatio1,
    rrRatio2,
    positionSize,
    maxLossAmount,
    isRRViable,
  };
}

export function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}
