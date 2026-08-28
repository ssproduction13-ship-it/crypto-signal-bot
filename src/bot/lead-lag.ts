import { getCandles, type Interval } from "./binance.js";

export interface BtcMomentum {
  direction: "up" | "down" | "flat";
  strengthPct: number;
}

/**
 * Uses only closed BTC candles so an unfinished candle cannot leak future
 * information into the shadow experiment.
 */
export async function getBtcMomentum(interval: Interval): Promise<BtcMomentum> {
  const candles = await getCandles("BTCUSDT", interval, 3);
  const closed = candles.slice(0, -1);
  if (closed.length < 2) return { direction: "flat", strengthPct: 0 };

  const last = closed[closed.length - 1]!;
  const previous = closed[closed.length - 2]!;
  const strengthPct = ((last.close - previous.close) / previous.close) * 100;
  return {
    direction: strengthPct > 0.3 ? "up" : strengthPct < -0.3 ? "down" : "flat",
    strengthPct,
  };
}