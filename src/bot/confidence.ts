import { pool } from "../lib/db.js";
import type { IndicatorResult } from "./indicators.js";
import type { MarketCondition } from "./chaos-filter.js";
import type { StrategyName } from "./strategies.js";

export interface ConfidenceResult {
  score: number;
  factors: {
    recentPerformance: number;
    marketQuality: number;
    volatilityFit: number;
    strategyEffectiveness: number;
  };
  label: "high" | "medium" | "low";
}

// Calculate confidence score 0-100 based on:
// 1. Recent signals performance (last 20 trades win rate)
// 2. Market quality (non-chaotic, trending)
// 3. Volatility fit (ATR in optimal range)
// 4. Strategy effectiveness (PF of current strategy)
export async function calcConfidence(
  ind: IndicatorResult,
  market: MarketCondition,
  strategy?: StrategyName,
  signalScore?: number
): Promise<ConfidenceResult> {
  // 1. Recent performance (0-100)
  // На старте без истории — нейтральный балл 55 (чуть выше 50 чтобы не блокировать)
  let recentPerformance = 55;
  try {
    const { rows } = await pool.query(
      "SELECT pnl_percent FROM journal_entries WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 20"
    );
    if (rows.length >= 5) {
      const pnls = rows.map(r => Number((r as Record<string, unknown>)["pnl_percent"]));
      const wins = pnls.filter(p => p > 0).length;
      const winRate = wins / pnls.length;
      recentPerformance = Math.round(winRate * 100);
    }
  } catch { /* use default */ }

  // 2. Market quality (0-100)
  let marketQuality = 50;
  if (market.isChaotic) {
    marketQuality = 10;
  } else if (market.isHighVolatility && market.isSideways) {
    marketQuality = 25;
  } else if (!market.isHighVolatility && !market.isSideways && !market.isLowVolume) {
    marketQuality = 85;
  } else if (market.isSideways) {
    marketQuality = 40;
  } else if (market.isHighVolatility) {
    marketQuality = 45;
  } else {
    marketQuality = 65;
  }

  // 3. Volatility fit (0-100) — optimal ATR% is 1-3%
  let volatilityFit = 50;
  if (market.atrPercent != null) {
    const atr = market.atrPercent;
    if (atr >= 0.5 && atr <= 2)      volatilityFit = 85;
    else if (atr >= 2 && atr <= 3.5) volatilityFit = 65;
    else if (atr < 0.5)              volatilityFit = 30;
    else if (atr > 5)                volatilityFit = 15;
    else                             volatilityFit = 40;
  }

  // 4. Strategy effectiveness (0-100)
  let strategyEffectiveness = 50;
  if (strategy) {
    try {
      const { rows } = await pool.query(
        "SELECT win_pnl, loss_pnl FROM strategy_stats WHERE strategy=$1", [strategy]
      );
      if (rows.length) {
        const r = rows[0] as Record<string, unknown>;
        const winPnl = Number(r["win_pnl"]);
        const lossPnl = Number(r["loss_pnl"]);
        const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 3 : 0;
        if (pf >= 2)      strategyEffectiveness = 90;
        else if (pf >= 1.5) strategyEffectiveness = 75;
        else if (pf >= 1.2) strategyEffectiveness = 60;
        else if (pf >= 1)   strategyEffectiveness = 45;
        else                strategyEffectiveness = 20;
      }
    } catch { /* use default */ }
  }

  // Signal score bonus
  const signalBonus = signalScore ? Math.round((signalScore - 50) * 0.2) : 0;

  const total = Math.round(
    recentPerformance * 0.30 +
    marketQuality * 0.35 +
    volatilityFit * 0.20 +
    strategyEffectiveness * 0.15 +
    signalBonus
  );

  const score = Math.max(0, Math.min(100, total));
  const label: ConfidenceResult["label"] = score >= 65 ? "high" : score >= 40 ? "medium" : "low";

  return {
    score,
    factors: { recentPerformance, marketQuality, volatilityFit, strategyEffectiveness },
    label,
  };
}

export function formatConfidence(c: ConfidenceResult): string {
  const emoji = c.label === "high" ? "🟢" : c.label === "medium" ? "🟡" : "🔴";
  return `${emoji} Confidence: ${c.score}%`;
}
