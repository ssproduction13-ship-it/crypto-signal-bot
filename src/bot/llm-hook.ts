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
let _llmFailCount     = 0;
let _llmDisabledUntil = 0;

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

  // Auto-disable after 5 consecutive failures for 30 minutes
    if (Date.now() < _llmDisabledUntil) return null;

    try {
      const analysis = await Promise.race([
        _provider(signal, news),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("LLM timeout")), 5000)
        ),
      ]);
      _llmFailCount = 0;
      return analysis;
    } catch (err) {
      _llmFailCount++;
      if (_llmFailCount >= 5) {
        _llmDisabledUntil = Date.now() + 30 * 60 * 1000;
        _llmFailCount = 0;
        logger.warn("LLM отключён на 30 минут из-за повторных ошибок");
      } else {
        logger.debug({ err, failCount: _llmFailCount }, "LLM analysis failed");
      }
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
