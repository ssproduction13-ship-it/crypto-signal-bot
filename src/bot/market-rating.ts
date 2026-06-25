import type { IndicatorResult } from "./indicators.js";
import type { MarketCondition } from "./chaos-filter.js";
import type { Candle } from "./binance.js";

export interface MarketRating {
  index: number;
  state: "strong_growth" | "moderate_growth" | "sideways" | "high_volatility" | "decline";
  label: string;
  emoji: string;
  description: string;
  components: {
    trend: number;
    momentum: number;
    volume: number;
    volatility: number;
    breadth: number;
  };
}

export function calcMarketRating(
  ind: IndicatorResult,
  market: MarketCondition,
  candles: Candle[]
): MarketRating {
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1]!;

  // ── Trend component (0-100) ──
  let trend = 50;
  if (ind.ema200) {
    const pct = ((currentPrice - ind.ema200) / ind.ema200) * 100;
    if (pct > 5)        trend += 30;
    else if (pct > 2)   trend += 20;
    else if (pct > 0)   trend += 10;
    else if (pct < -5)  trend -= 30;
    else if (pct < -2)  trend -= 20;
    else                trend -= 10;
  }
  if (ind.emaCrossSignal === "buy")  trend += 15;
  if (ind.emaCrossSignal === "sell") trend -= 15;
  if (ind.trendStrength === "strong")    trend += 10;
  else if (ind.trendStrength === "weak") trend -= 10;
  trend = Math.max(0, Math.min(100, trend));

  // ── Momentum component (0-100) ──
  let momentum = 50;
  if (ind.rsi != null) {
    if (ind.rsi > 50) momentum += Math.min(30, (ind.rsi - 50) * 0.8);
    else              momentum -= Math.min(30, (50 - ind.rsi) * 0.8);
  }
  if (ind.macdSignal === "buy")  momentum += 15;
  if (ind.macdSignal === "sell") momentum -= 15;
  if (ind.stochSignal === "buy")  momentum += 8;
  if (ind.stochSignal === "sell") momentum -= 8;
  momentum = Math.max(0, Math.min(100, momentum));

  // ── Volume component (0-100) ──
  const volumes = candles.map(c => c.volume);
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1]!;
  const volRatio = lastVol / avgVol;
  let volume = 50;
  if (volRatio > 2)      volume = 90;
  else if (volRatio > 1.5) volume = 75;
  else if (volRatio > 1.2) volume = 62;
  else if (volRatio < 0.5) volume = 15;
  else if (volRatio < 0.8) volume = 35;
  volume = Math.max(0, Math.min(100, volume));

  // ── Volatility component (0-100) — higher ATR% = lower quality ──
  let volatility = 70;
  if (market.atrPercent != null) {
    const atr = market.atrPercent;
    if (atr <= 1)       volatility = 85;
    else if (atr <= 2)  volatility = 75;
    else if (atr <= 3)  volatility = 55;
    else if (atr <= 4)  volatility = 35;
    else if (atr <= 5)  volatility = 20;
    else                volatility = 5;
  }

  // ── Breadth component (0-100) — price vs recent range ──
  const recent50 = closes.slice(-50);
  const high50 = Math.max(...recent50);
  const low50 = Math.min(...recent50);
  const range50 = high50 - low50;
  let breadth = 50;
  if (range50 > 0) {
    const position = (currentPrice - low50) / range50;
    breadth = Math.round(position * 100);
  }

  // ── Composite index ──
  const index = Math.round(
    trend * 0.30 +
    momentum * 0.25 +
    volume * 0.15 +
    volatility * 0.15 +
    breadth * 0.15
  );

  // ── State classification ──
  let state: MarketRating["state"];
  let label: string;
  let emoji: string;
  let description: string;

  if (market.isChaotic || (market.isHighVolatility && !market.isSideways && trend < 40)) {
    state = "high_volatility";
    label = "Высокая волатильность";
    emoji = "⚡";
    description = "Рынок хаотичен — торговля с повышенным риском";
  } else if (trend < 35 && momentum < 40) {
    state = "decline";
    label = "Снижение";
    emoji = "📉";
    description = "Медвежий рынок — осторожно с лонгами";
  } else if (market.isSideways || (Math.abs(trend - 50) < 15 && Math.abs(momentum - 50) < 15)) {
    state = "sideways";
    label = "Боковик";
    emoji = "↔️";
    description = "Горизонтальный рынок — предпочтительны возвраты к среднему";
  } else if (index >= 70) {
    state = "strong_growth";
    label = "Сильный рост";
    emoji = "🚀";
    description = "Отличные условия — сильный бычий тренд";
  } else {
    state = "moderate_growth";
    label = "Умеренный рост";
    emoji = "📈";
    description = "Бычий рынок — условия для трендовых стратегий";
  }

  return {
    index: Math.max(0, Math.min(100, index)),
    state,
    label,
    emoji,
    description,
    components: { trend, momentum, volume, volatility, breadth },
  };
}

export function formatMarketRating(rating: MarketRating): string {
  const bar = "█".repeat(Math.round(rating.index / 10)) + "░".repeat(10 - Math.round(rating.index / 10));
  return [
    `${rating.emoji} *Рейтинг рынка: ${rating.index}/100*`,
    `[${bar}]`,
    `Состояние: ${rating.label}`,
    `${rating.description}`,
    ``,
    `Тренд: ${rating.components.trend} | Импульс: ${rating.components.momentum}`,
    `Объём: ${rating.components.volume} | Волатильность: ${rating.components.volatility}`,
  ].join("\n");
}
