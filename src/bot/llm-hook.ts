import type { TradeSignal } from "./signals.js";
import { logger } from "../lib/logger.js";

export interface NewsItem {
  title: string;
  sentiment: "positive" | "negative" | "neutral";
  source: string;
  publishedAt: string;
}

export interface LLMAnalysis {
  summary: string;
  newsSentiment: "bullish" | "bearish" | "neutral";
  riskLevel: "low" | "medium" | "high";
  additionalFactors: string[];
  confidence: number;
}

export type LLMProvider = (
  signal: TradeSignal,
  news: NewsItem[]
) => Promise<LLMAnalysis>;

let _provider: LLMProvider | null = null;

export function registerLLMProvider(provider: LLMProvider): void {
  _provider = provider;
  logger.info("LLM provider registered for signal analysis");
}

export async function analyzWithLLM(
  signal: TradeSignal,
  news: NewsItem[] = []
): Promise<LLMAnalysis | null> {
  if (!_provider) {
    return null;
  }

  try {
    const analysis = await _provider(signal, news);
    return analysis;
  } catch (err) {
    logger.error({ err }, "LLM analysis failed");
    return null;
  }
}

export function formatLLMAnalysis(analysis: LLMAnalysis): string {
  const sentimentEmoji = {
    bullish: "🟢",
    bearish: "🔴",
    neutral: "⚪",
  }[analysis.newsSentiment];

  const riskEmoji = {
    low: "🟢",
    medium: "🟡",
    high: "🔴",
  }[analysis.riskLevel];

  return [
    `🤖 *ИИ-анализ:*`,
    ``,
    analysis.summary,
    ``,
    `Новостной фон: ${sentimentEmoji} ${analysis.newsSentiment}`,
    `Риск: ${riskEmoji} ${analysis.riskLevel}`,
    `Уверенность ИИ: ${analysis.confidence}%`,
    ...(analysis.additionalFactors.length
      ? [``, `Дополнительные факторы:`, ...analysis.additionalFactors.map((f) => `  • ${f}`)]
      : []),
  ].join("\n");
}

export function isLLMAvailable(): boolean {
  return _provider !== null;
}
