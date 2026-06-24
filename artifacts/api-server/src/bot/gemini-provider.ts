import { GoogleGenAI } from "@google/genai";
import { registerLLMProvider, type LLMAnalysis, type NewsItem } from "./llm-hook.js";
import type { TradeSignal } from "./signals.js";
import { logger } from "../lib/logger.js";

function buildPrompt(signal: TradeSignal, news: NewsItem[]): string {
  const dir = signal.score.direction;
  const newsBlock = news.length
    ? news.map((n) => `- [${n.sentiment}] ${n.title} (${n.source})`).join("\n")
    : "Новостей нет.";

  return `Ты — опытный криптовалютный аналитик. Проанализируй торговый сигнал и дай краткое заключение на русском языке.

СИГНАЛ:
Пара: ${signal.symbol}
Таймфрейм: ${signal.interval}
Направление: ${dir}
Цена: ${signal.price}
Рейтинг сигнала: ${signal.score.total}/100
Тренд: ${signal.score.trendScore}/100
Объём: ${signal.score.volumeScore}/100
Импульс: ${signal.score.momentumScore}/100
Уровни: ${signal.score.levelsScore}/100
Паттерн: ${signal.score.patternScore}/100
ATR%: ${signal.risk.atrPercent?.toFixed(2) ?? "н/д"}
R/R: 1:${signal.risk.rrRatio1.toFixed(1)}
Паттерн: ${signal.pattern.name} — ${signal.pattern.description}
Рынок: ${signal.market.recommendation}

НОВОСТНОЙ ФОН:
${newsBlock}

Ответь строго в формате JSON (без markdown, без \`\`\`):
{
  "summary": "2-3 предложения: почему этот сигнал интересен или опасен",
  "newsSentiment": "bullish" | "bearish" | "neutral",
  "riskLevel": "low" | "medium" | "high",
  "additionalFactors": ["фактор 1", "фактор 2"],
  "confidence": число от 0 до 100
}`;
}

export async function setupGeminiProvider(): Promise<boolean> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    logger.warn("GEMINI_API_KEY not set — LLM analysis disabled");
    return false;
  }

  const ai = new GoogleGenAI({ apiKey });

  registerLLMProvider(async (signal: TradeSignal, news: NewsItem[]): Promise<LLMAnalysis> => {
    const prompt = buildPrompt(signal, news);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 8192 },
    });

    const text = response.text ?? "";

    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned) as {
        summary?: string;
        newsSentiment?: string;
        riskLevel?: string;
        additionalFactors?: string[];
        confidence?: number;
      };

      return {
        summary: parsed.summary ?? "Анализ недоступен",
        newsSentiment: (parsed.newsSentiment as LLMAnalysis["newsSentiment"]) ?? "neutral",
        riskLevel: (parsed.riskLevel as LLMAnalysis["riskLevel"]) ?? "medium",
        additionalFactors: parsed.additionalFactors ?? [],
        confidence: parsed.confidence ?? 50,
      };
    } catch {
      return {
        summary: text.slice(0, 300),
        newsSentiment: "neutral",
        riskLevel: "medium",
        additionalFactors: [],
        confidence: 50,
      };
    }
  });

  logger.info("Gemini AI provider registered for signal analysis");
  return true;
}
