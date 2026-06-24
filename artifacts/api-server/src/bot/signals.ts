import { getCandles, getPrice } from "./binance.js";
import { calcIndicators } from "./indicators.js";
import { calcLevels } from "./levels.js";
import { detectPattern } from "./patterns.js";
import { calcScore, type ScoreBreakdown } from "./scoring.js";
import { calcRisk, formatPrice, type RiskParams } from "./risk.js";
import { assessMarket, type MarketCondition } from "./chaos-filter.js";
import { loadWeights, loadSettings, addJournalEntry, genId } from "./storage.js";
import { analyzWithLLM, formatLLMAnalysis, isLLMAvailable, type LLMAnalysis } from "./llm-hook.js";
import type { Interval } from "./binance.js";
import type { SupportResistance } from "./levels.js";
import type { PatternResult } from "./patterns.js";

export interface TradeSignal {
  symbol: string;
  price: number;
  interval: string;
  score: ScoreBreakdown;
  risk: RiskParams;
  market: MarketCondition;
  levels: SupportResistance;
  pattern: PatternResult;
  timestamp: Date;
  filtered: boolean;
  filterReason: string | null;
  llmAnalysis?: LLMAnalysis | null;
}

export async function generateSignal(
  symbol: string,
  interval: Interval = "1h",
  chatId?: number
): Promise<TradeSignal> {
  const [candles, price] = await Promise.all([
    getCandles(symbol, interval, 500),
    getPrice(symbol),
  ]);

  const weights = await loadWeights();
  const settings = chatId != null ? await loadSettings(chatId) : null;
  const minScore = settings?.minScore ?? 70;
  const riskPercent = settings?.riskPercent ?? 1;
  const accountSize = settings?.accountSize ?? 1000;

  const indicators = calcIndicators(candles);
  const levels = calcLevels(candles);
  const pattern = detectPattern(candles);
  const scoreResult = calcScore(indicators, levels, pattern, weights, candles);
  const market = assessMarket(candles, indicators);
  const risk = calcRisk(candles, scoreResult.direction !== "NEUTRAL" ? scoreResult.direction : "LONG", accountSize, riskPercent);

  let filtered = false;
  let filterReason: string | null = null;

  if (settings?.noTradeMode) {
    filtered = true;
    filterReason = "🚫 Режим 'не торговать' активен (/notrade off для отключения)";
  } else if (market.isChaotic) {
    filtered = true;
    filterReason = "🚫 Хаотичный рынок — сигнал заблокирован фильтром";
  } else if (scoreResult.total < minScore) {
    filtered = true;
    filterReason = `⚠️ Оценка ${scoreResult.total}/100 ниже порога ${minScore} — сигнал слабый`;
  } else if (!risk.isRRViable) {
    filtered = true;
    filterReason = `⚠️ R/R ${risk.rrRatio1.toFixed(1)} — слишком низкое соотношение (мин. 1:1.5)`;
  } else if (scoreResult.direction === "NEUTRAL") {
    filtered = true;
    filterReason = "⚪ Нет чёткого направления — рекомендуется воздержаться";
  } else if (indicators.rsi != null && (indicators.rsi > 80 || indicators.rsi < 20)) {
    filtered = true;
    filterReason = `⚠️ RSI ${indicators.rsi.toFixed(1)} — экстремальная зона, высокий риск`;
  }

  if (!filtered && scoreResult.direction !== "NEUTRAL" && chatId != null) {
    await addJournalEntry({
      id: genId(),
      symbol: symbol.toUpperCase(),
      interval,
      direction: scoreResult.direction,
      entryPrice: risk.entryPrice,
      stopLoss: risk.stopLoss,
      tp1: risk.tp1,
      tp2: risk.tp2,
      score: scoreResult.total,
      confidence: scoreResult.total,
      timestamp: new Date().toISOString(),
      factors: scoreResult.factorScores,
    });
  }

  let llmAnalysis: LLMAnalysis | null = null;
  if (!filtered && isLLMAvailable()) {
    llmAnalysis = await analyzWithLLM({
      symbol: symbol.toUpperCase(),
      price,
      interval,
      score: scoreResult,
      risk,
      market,
      levels,
      pattern,
      timestamp: new Date(),
      filtered,
      filterReason,
    }).catch(() => null);
  }

  return {
    symbol: symbol.toUpperCase(),
    price,
    interval,
    score: scoreResult,
    risk,
    market,
    levels,
    pattern,
    timestamp: new Date(),
    filtered,
    filterReason,
    llmAnalysis,
  };
}

export function formatSignal(sig: TradeSignal): string {
  const intervalLabel: Record<string, string> = {
    "5m": "5 минут", "15m": "15 минут", "1h": "1 час", "4h": "4 часа", "1d": "1 день",
  };

  const dir = sig.score.direction;
  const dirEmoji = dir === "LONG" ? "🟢 LONG (Покупка)" : dir === "SHORT" ? "🔴 SHORT (Продажа)" : "⚪ Нейтрально";

  if (sig.filtered) {
    const lines = [
      `📊 *${sig.symbol}* | ${intervalLabel[sig.interval] ?? sig.interval}`,
      `💰 Цена: \`${formatPrice(sig.price)}\``,
      ``,
      sig.filterReason ?? "Сигнал заблокирован",
      ``,
      `📈 Оценка: ${sig.score.total}/100`,
      ...(sig.market.warnings.length ? [``, `⚠️ *Рынок:*`, ...sig.market.warnings] : []),
    ];
    return lines.join("\n");
  }

  const r = sig.risk;
  const priceMove = (Math.abs(r.tp1 - r.entryPrice) / r.entryPrice * 100).toFixed(2);
  const slMove = (Math.abs(r.stopLoss - r.entryPrice) / r.entryPrice * 100).toFixed(2);

  const lines = [
    `📊 *${sig.symbol}* | ${intervalLabel[sig.interval] ?? sig.interval}`,
    `💰 Цена: \`${formatPrice(sig.price)}\``,
    ``,
    `🎯 *Направление: ${dirEmoji}*`,
    `⭐ Рейтинг сигнала: *${sig.score.total}/100*`,
    ``,
    `📐 *Параметры сделки:*`,
    `  Вход: \`${formatPrice(r.entryPrice)}\``,
    `  Стоп-лосс: \`${formatPrice(r.stopLoss)}\` (-${slMove}%)`,
    `  TP1: \`${formatPrice(r.tp1)}\` (+${priceMove}%) | R/R 1:${r.rrRatio1.toFixed(1)}`,
    `  TP2: \`${formatPrice(r.tp2)}\` | R/R 1:${r.rrRatio2.toFixed(1)}`,
    ``,
    `💼 *Риск-менеджмент:*`,
    `  Риск на сделку: ${r.stopDistancePct.toFixed(2)}%`,
    `  Размер позиции: ${r.positionSize.toFixed(4)} ед.`,
    `  Макс. убыток: $${r.maxLossAmount.toFixed(2)}`,
    ``,
    `${sig.market.recommendation}`,
    ...(sig.market.warnings.length ? sig.market.warnings : []),
    ``,
    ...(sig.pattern.name !== "NONE" ? [`🔷 ${sig.pattern.description}`, ``] : []),
    `📋 *Причины сигнала:*`,
    ...sig.score.reasons.map((r) => `  ${r}`),
    ``,
    `🧩 *Оценка по факторам:*`,
    `  Тренд: ${sig.score.trendScore}/100`,
    `  Объём: ${sig.score.volumeScore}/100`,
    `  Импульс: ${sig.score.momentumScore}/100`,
    `  Уровни: ${sig.score.levelsScore}/100`,
    `  Паттерн: ${sig.score.patternScore}/100`,
    ``,
    `⏱ ${sig.timestamp.toUTCString()}`,
    ...(sig.llmAnalysis ? [``, formatLLMAnalysis(sig.llmAnalysis)] : []),
    ``,
    `⚠️ _Не является финансовой рекомендацией. Используйте stop-loss._`,
  ];

  return lines.join("\n");
}
