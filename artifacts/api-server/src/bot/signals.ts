import { getCandles, getPrice } from "./binance.js";
import { calcIndicators, type IndicatorResult } from "./indicators.js";
import type { Interval } from "./binance.js";

export type SignalType = "ПОКУПАТЬ 🟢" | "ПРОДАВАТЬ 🔴" | "ДЕРЖАТЬ ⚪";

export interface TradeSignal {
  symbol: string;
  price: number;
  signal: SignalType;
  confidence: number;
  interval: string;
  indicators: IndicatorResult;
  reasons: string[];
  timestamp: Date;
}

function score(ind: IndicatorResult): { score: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];

  if (ind.rsi != null) {
    if (ind.rsi < 30) {
      s += 2;
      reasons.push(`RSI ${ind.rsi.toFixed(1)} — перепродан (сигнал покупки)`);
    } else if (ind.rsi < 45) {
      s += 1;
      reasons.push(`RSI ${ind.rsi.toFixed(1)} — слабый бычий momentum`);
    } else if (ind.rsi > 70) {
      s -= 2;
      reasons.push(`RSI ${ind.rsi.toFixed(1)} — перекуплен (сигнал продажи)`);
    } else if (ind.rsi > 55) {
      s -= 1;
      reasons.push(`RSI ${ind.rsi.toFixed(1)} — слабый медвежий momentum`);
    } else {
      reasons.push(`RSI ${ind.rsi.toFixed(1)} — нейтральная зона`);
    }
  }

  if (ind.macdSignal === "buy") {
    s += 2;
    reasons.push(`MACD гистограмма растёт — бычий сигнал`);
  } else if (ind.macdSignal === "sell") {
    s -= 2;
    reasons.push(`MACD гистограмма падает — медвежий сигнал`);
  }

  if (ind.bbSignal === "buy") {
    s += 1;
    reasons.push(
      `Цена у нижней полосы Боллинджера (${ind.bbPercent?.toFixed(0)}%) — возможный отскок`
    );
  } else if (ind.bbSignal === "sell") {
    s -= 1;
    reasons.push(
      `Цена у верхней полосы Боллинджера (${ind.bbPercent?.toFixed(0)}%) — возможный разворот`
    );
  }

  if (ind.emaCrossSignal === "buy") {
    s += 1;
    reasons.push(
      `EMA20 (${ind.ema20?.toFixed(2)}) выше EMA50 (${ind.ema50?.toFixed(2)}) — восходящий тренд`
    );
  } else if (ind.emaCrossSignal === "sell") {
    s -= 1;
    reasons.push(
      `EMA20 (${ind.ema20?.toFixed(2)}) ниже EMA50 (${ind.ema50?.toFixed(2)}) — нисходящий тренд`
    );
  }

  if (ind.stochSignal === "buy") {
    s += 1;
    reasons.push(
      `StochRSI ${ind.stochRsi?.toFixed(1)} — зона перепроданности`
    );
  } else if (ind.stochSignal === "sell") {
    s -= 1;
    reasons.push(
      `StochRSI ${ind.stochRsi?.toFixed(1)} — зона перекупленности`
    );
  }

  if (ind.trendStrength === "strong") {
    reasons.push(
      `ADX ${ind.adxValue?.toFixed(1)} — сильный тренд, торгуйте по тренду`
    );
  } else if (ind.trendStrength === "moderate") {
    reasons.push(`ADX ${ind.adxValue?.toFixed(1)} — умеренный тренд`);
  } else {
    reasons.push(`ADX ${ind.adxValue?.toFixed(1)} — флэт/боковик, будьте осторожны`);
    s = Math.round(s * 0.7);
  }

  if (ind.volumeSignal === "above_avg") {
    reasons.push(`Объём выше среднего — подтверждение движения`);
    if (s > 0) s += 1;
    else if (s < 0) s -= 1;
  } else {
    reasons.push(`Объём ниже среднего — слабое подтверждение`);
  }

  return { score: s, reasons };
}

export async function generateSignal(
  symbol: string,
  interval: Interval = "1h"
): Promise<TradeSignal> {
  const [candles, price] = await Promise.all([
    getCandles(symbol, interval, 200),
    getPrice(symbol),
  ]);

  const indicators = calcIndicators(candles);
  const { score: s, reasons } = score(indicators);

  const maxScore = 10;
  const confidence = Math.min(100, Math.round((Math.abs(s) / maxScore) * 100));

  let signal: SignalType;
  if (s >= 3) signal = "ПОКУПАТЬ 🟢";
  else if (s <= -3) signal = "ПРОДАВАТЬ 🔴";
  else signal = "ДЕРЖАТЬ ⚪";

  return {
    symbol: symbol.toUpperCase(),
    price,
    signal,
    confidence,
    interval,
    indicators,
    reasons,
    timestamp: new Date(),
  };
}

export function formatSignal(sig: TradeSignal): string {
  const intervalLabel: Record<string, string> = {
    "15m": "15 минут",
    "1h": "1 час",
    "4h": "4 часа",
    "1d": "1 день",
  };

  const lines = [
    `📊 *${sig.symbol}* | ${intervalLabel[sig.interval] ?? sig.interval}`,
    `💰 Цена: \`${sig.price.toFixed(sig.price < 1 ? 6 : 2)}\``,
    ``,
    `🎯 *Сигнал: ${sig.signal}*`,
    `📈 Уверенность: ${sig.confidence}%`,
    ``,
    `📋 *Анализ:*`,
    ...sig.reasons.map((r) => `  • ${r}`),
    ``,
    `⏱ ${sig.timestamp.toUTCString()}`,
    ``,
    `⚠️ _Не является финансовой рекомендацией. Используйте stop-loss._`,
  ];

  return lines.join("\n");
}
