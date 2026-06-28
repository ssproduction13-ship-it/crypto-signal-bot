import { getCandles, getPrice } from "./binance.js";
import { calcIndicators } from "./indicators.js";
import { calcLevels } from "./levels.js";
import { detectPattern } from "./patterns.js";
import { calcScore, type ScoreBreakdown } from "./scoring.js";
import { calcRisk, formatPrice, type RiskParams } from "./risk.js";
import { assessMarket, type MarketCondition } from "./chaos-filter.js";
import { loadWeights, loadSettings, addJournalEntry, genId } from "./storage.js";
import { recordMissedTrade } from "./missed-trades.js";
import { analyzWithLLM, formatLLMAnalysis, isLLMAvailable, type LLMAnalysis } from "./llm-hook.js";
import { evalAllStrategies, getBestStrategy, type StrategySignal } from "./strategies.js";
import { calcConfidence, type ConfidenceResult } from "./confidence.js";
import { calcMarketRating, type MarketRating } from "./market-rating.js";
import type { Interval } from "./binance.js";
import type { SupportResistance } from "./levels.js";
import type { PatternResult } from "./patterns.js";
import { logger } from "../lib/logger.js";

export interface TradeSignal {
  symbol: string; price: number; interval: string;
  score: ScoreBreakdown; risk: RiskParams;
  market: MarketCondition; levels: SupportResistance;
  pattern: PatternResult; timestamp: Date;
  filtered: boolean; filterReason: string | null;
  llmAnalysis?: LLMAnalysis | null;
  strategies: StrategySignal[];
  bestStrategy: StrategySignal | null;
  confidence: ConfidenceResult;
  marketRating: MarketRating;
}

export async function generateSignal(
  symbol: string, interval: Interval = "1h", chatId?: number
): Promise<TradeSignal> {
  const [candles, price] = await Promise.all([
    getCandles(symbol, interval, 500),
    getPrice(symbol),
  ]);

  const weights   = await loadWeights();
  const settings  = chatId != null ? await loadSettings(chatId) : null;
  const minScore    = settings?.minScore    ?? 62;
  const riskPercent = settings?.riskPercent ?? 1;
  const accountSize = settings?.accountSize ?? 10000;

  const ind     = calcIndicators(candles);
  const levels  = calcLevels(candles);
  const pattern = detectPattern(candles);
  const score   = calcScore(ind, levels, pattern, weights, candles);
  const market  = assessMarket(candles, ind);
  const risk    = calcRisk(candles, score.direction !== "NEUTRAL" ? score.direction : "LONG", accountSize, riskPercent);

  const strategies   = evalAllStrategies(ind, levels, pattern, candles);
  const bestStrategy = getBestStrategy(strategies);
  const marketRating = calcMarketRating(ind, market, candles);
  // Detect regime for Confidence Engine v2
    const { detectMarketRegime } = await import("./learning-engine.js").catch(() => ({ detectMarketRegime: () => "sideways" as const }));
    const regime = detectMarketRegime(market, marketRating);
    const confidence   = await calcConfidence(ind, market, bestStrategy?.strategy, score.total, symbol, regime);

  let filtered = false, filterReason: string | null = null;

  if (settings?.noTradeMode) {
    filtered = true; filterReason = "🚫 Режим 'не торговать' активен";
  } else if (market.isChaotic) {
    filtered = true; filterReason = "🚫 Хаотичный рынок — сигнал заблокирован";
  } else if (score.direction === "NEUTRAL") {
    filtered = true; filterReason = "⚪ Нет чёткого направления рынка";
  } else if (!risk.isRRViable) {
    filtered = true; filterReason = `⚠️ R/R ${risk.rrRatio1.toFixed(1)} — ниже мин. 1:1.5`;
  }

  if (!filtered && score.direction !== "NEUTRAL" && chatId != null) {
    await addJournalEntry({
      id: genId(), chatId, symbol: symbol.toUpperCase(), interval,
      direction: score.direction, entryPrice: risk.entryPrice,
      stopLoss: risk.stopLoss, tp1: risk.tp1, tp2: risk.tp2,
      score: score.total, confidence: confidence.score,
      strategy: bestStrategy?.strategy ?? "TREND",
      timestamp: new Date().toISOString(), factors: score.factorScores,
    }).catch(err => logger.error({ err }, "addJournalEntry failed"));
  }

  if (filtered && score.direction !== "NEUTRAL" && score.total >= 50) {
    recordMissedTrade({
      symbol: symbol.toUpperCase(), interval, direction: score.direction,
      entryPrice: risk.entryPrice, stopLoss: risk.stopLoss, tp1: risk.tp1, tp2: risk.tp2,
      score: score.total, filterReason: filterReason ?? "unknown",
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }

  let llmAnalysis: LLMAnalysis | null = null;
  if (!filtered && isLLMAvailable()) {
    llmAnalysis = await analyzWithLLM({
      symbol: symbol.toUpperCase(), price, interval, score, risk, market, levels, pattern,
      timestamp: new Date(), filtered, filterReason,
      strategies, bestStrategy, confidence, marketRating,
    } as TradeSignal).catch(() => null);
  }

  return {
    symbol: symbol.toUpperCase(), price, interval, score, risk, market, levels, pattern,
    timestamp: new Date(), filtered, filterReason, llmAnalysis,
    strategies, bestStrategy, confidence, marketRating,
  };
}

export function formatSignal(sig: TradeSignal): string {
  const lbl: Record<string, string> = { "5m": "5 мин", "15m": "15 мин", "1h": "1 час", "4h": "4 часа", "1d": "1 день" };
  const dir = sig.score.direction;
  const dirTxt = dir === "LONG" ? "🟢 LONG" : "🔴 SHORT";

  const strategyNames: Record<string, string> = {
    TREND: "📈 Тренд", BREAKOUT: "🚀 Пробой",
    VOLUME_IMPULSE: "⚡ Объёмный импульс", MEAN_REVERSION: "↩️ Возврат к среднему",
  };

  if (sig.filtered) {
    return [
      `📊 *${sig.symbol}* | ${lbl[sig.interval] ?? sig.interval}`,
      `💰 Цена: \`${formatPrice(sig.price)}\``,
      "",
      sig.filterReason ?? "Сигнал заблокирован",
      "",
      `📈 Score: ${sig.score.total}/100 | Confidence: ${sig.confidence.score}%`,
      `${sig.marketRating.emoji} Рынок: ${sig.marketRating.label} (${sig.marketRating.index}/100)`,
      ...sig.market.warnings,
    ].join("\n");
  }

  const r  = sig.risk;
  const pm = (Math.abs(r.tp1 - r.entryPrice) / r.entryPrice * 100).toFixed(2);
  const sm = (Math.abs(r.stopLoss - r.entryPrice) / r.entryPrice * 100).toFixed(2);
  const confEmoji = sig.confidence.label === "high" ? "🟢" : sig.confidence.label === "medium" ? "🟡" : "🔴";
  const strategyLabel = sig.bestStrategy ? (strategyNames[sig.bestStrategy.strategy] ?? sig.bestStrategy.strategy) : "";

  const lines: string[] = [
    `📊 *${sig.symbol}* | ${lbl[sig.interval] ?? sig.interval}`,
    `💰 Цена: \`${formatPrice(sig.price)}\``,
    "",
    `🎯 *${dirTxt}* | ⭐ *${sig.score.total}/100* | ${confEmoji} *${sig.confidence.score}%*`,
  ];
  if (strategyLabel) lines.push(`🏷 Стратегия: ${strategyLabel}`);
  lines.push(
    "",
    `📐 Вход: \`${formatPrice(r.entryPrice)}\``,
    `  Стоп: \`${formatPrice(r.stopLoss)}\` (-${sm}%)`,
    `  TP1: \`${formatPrice(r.tp1)}\` (+${pm}%) R/R 1:${r.rrRatio1.toFixed(1)}`,
    `  TP2: \`${formatPrice(r.tp2)}\` R/R 1:${r.rrRatio2.toFixed(1)}`,
    "",
    `💼 Риск: ${r.stopDistancePct.toFixed(2)}% | Позиция: ${r.positionSize.toFixed(4)} ед.`,
    "",
    `${sig.marketRating.emoji} Рынок: ${sig.marketRating.label} (${sig.marketRating.index}/100)`,
    sig.market.recommendation,
    ...sig.market.warnings,
    ""
  );
  if (sig.pattern.name !== "NONE") lines.push(`🔷 ${sig.pattern.description}`, "");
  lines.push(
    `📋 *Причины:*`,
    ...sig.score.reasons.map(reason => `  ${reason}`),
    "",
    `🧩 Т:${sig.score.trendScore} Об:${sig.score.volumeScore} Имп:${sig.score.momentumScore} Ур:${sig.score.levelsScore} Пат:${sig.score.patternScore}`,
    "",
    `⏱ ${sig.timestamp.toUTCString()}`
  );
  if (sig.llmAnalysis) lines.push("", formatLLMAnalysis(sig.llmAnalysis));
  lines.push("", `⚠️ _Не является финансовой рекомендацией._`);

  return lines.join("\n");
}
