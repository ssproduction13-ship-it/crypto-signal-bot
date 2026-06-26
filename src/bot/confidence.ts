import { pool } from "../lib/db.js";
  import type { IndicatorResult } from "./indicators.js";
  import type { MarketCondition } from "./chaos-filter.js";
  import type { StrategyName } from "./strategies.js";
  import type { MarketRegime } from "./learning-engine.js";
  import type { TradeFeatures } from "./similar-trades.js";

  export interface ConfidenceResult {
    score: number;
    factors: {
      recentPerformance: number;
      marketQuality: number;
      volatilityFit: number;
      strategyEffectiveness: number;
      timeFactor: number;
      instrumentFactor: number;
      regimeFactor: number;
      similarTradesFactor: number;
    };
    similarTradesBoost: number;
    label: "high" | "medium" | "low";
  }

  /**
   * Confidence Engine v3 — 8 factors:
   * 1. recentPerformance   — last 20–50 trades win rate
   * 2. marketQuality       — non-chaotic / trending
   * 3. volatilityFit       — ATR in optimal range 0.5–3%
   * 4. strategyEffectiveness — PF of chosen strategy
   * 5. timeFactor          — historical win rate at this hour/day
   * 6. instrumentFactor    — instrument priority weight
   * 7. regimeFactor        — strategy PF in current market regime
   * 8. similarTradesFactor — cosine-similarity k-NN from trade history
   */
  export async function calcConfidence(
    ind: IndicatorResult,
    market: MarketCondition,
    strategy?: StrategyName,
    signalScore?: number,
    symbol?: string,
    regime?: MarketRegime,
    tradeFeatures?: TradeFeatures
  ): Promise<ConfidenceResult> {

    // 1. Recent performance (0–100) from actual closed trades
    let recentPerformance = 55;
    try {
      const { rows } = await pool.query(
        "SELECT pnl_percent FROM paper_closed_trades ORDER BY closed_at DESC LIMIT 50"
      );
      if (rows.length >= 5) {
        const pnls = rows.map(r => Number((r as Record<string,unknown>)["pnl_percent"]));
        const wins = pnls.filter(p => p > 0).length;
        recentPerformance = Math.round((wins / pnls.length) * 100);
      }
    } catch { /* keep default */ }

    // 2. Market quality (0–100)
    let marketQuality = 50;
    if (market.isChaotic) marketQuality = 10;
    else if (market.isHighVolatility && market.isSideways) marketQuality = 25;
    else if (!market.isHighVolatility && !market.isSideways && !market.isLowVolume) marketQuality = 85;
    else if (market.isSideways) marketQuality = 40;
    else if (market.isHighVolatility) marketQuality = 45;
    else marketQuality = 65;

    // 3. Volatility fit (0–100) — optimal ATR% is 0.5–3%
    let volatilityFit = 50;
    if (market.atrPercent != null) {
      const a = market.atrPercent;
      if (a >= 0.5 && a <= 2)      volatilityFit = 85;
      else if (a >= 2 && a <= 3.5) volatilityFit = 65;
      else if (a < 0.5)            volatilityFit = 30;
      else if (a > 5)              volatilityFit = 15;
      else                         volatilityFit = 40;
    }

    // 4. Strategy effectiveness (0–100) based on PF
    let strategyEffectiveness = 50;
    if (strategy) {
      try {
        const { rows } = await pool.query(
          "SELECT win_pnl, loss_pnl FROM strategy_stats WHERE strategy=$1", [strategy]
        );
        if (rows.length) {
          const r = rows[0] as Record<string,unknown>;
          const pf = Number(r["loss_pnl"]) > 0
            ? Number(r["win_pnl"]) / Number(r["loss_pnl"])
            : Number(r["win_pnl"]) > 0 ? 3 : 0;
          strategyEffectiveness = pf >= 2 ? 90 : pf >= 1.5 ? 75 : pf >= 1.2 ? 60 : pf >= 1 ? 45 : 20;
        }
      } catch { /* keep default */ }

      // Apply strategy weight multiplier
      try {
        const { rows } = await pool.query(
          "SELECT weight, disabled FROM strategy_weights WHERE strategy=$1", [strategy]
        );
        if (rows.length) {
          const r = rows[0] as Record<string,unknown>;
          const w = Number(r["weight"]);
          const dis = Boolean(r["disabled"]);
          if (dis || w === 0) strategyEffectiveness = 0;
          else strategyEffectiveness = Math.round(strategyEffectiveness * Math.min(w * 1.2, 1.4));
        }
      } catch { /* keep default */ }
    }

    // 5. Time factor (0–100) — historical win rate at current hour/day
    let timeFactor = 60;
    try {
      const now = new Date();
      const hour = now.getHours();
      const dow = (now.getDay() + 6) % 7;
      const { rows } = await pool.query(
        "SELECT trades, wins FROM time_analytics WHERE hour_of_day=$1 AND day_of_week=$2",
        [hour, dow]
      );
      if (rows.length) {
        const r = rows[0] as Record<string,unknown>;
        const t = Number(r["trades"]), w = Number(r["wins"]);
        if (t >= 5) timeFactor = Math.round((w / t) * 100);
      }
    } catch { /* keep default */ }

    // 6. Instrument factor (0–100) from priority_weight
    let instrumentFactor = 60;
    if (symbol) {
      try {
        const { rows } = await pool.query(
          "SELECT priority_weight, trades FROM instrument_analytics WHERE symbol=$1", [symbol]
        );
        if (rows.length) {
          const r = rows[0] as Record<string,unknown>;
          const pw = Number(r["priority_weight"]);
          const t = Number(r["trades"]);
          if (t >= 5) instrumentFactor = Math.round(Math.min(pw * 60, 100));
        }
      } catch { /* keep default */ }
    }

    // 7. Regime factor (0–100) — strategy PF in current market regime
    let regimeFactor = 60;
    if (strategy && regime) {
      try {
        const { rows } = await pool.query(
          "SELECT trades, wins, win_pnl, loss_pnl FROM strategy_regime_stats WHERE strategy=$1 AND regime=$2",
          [strategy, regime]
        );
        if (rows.length) {
          const r = rows[0] as Record<string,unknown>;
          const t = Number(r["trades"]);
          if (t >= 5) {
            const w = Number(r["wins"]), wPnl = Number(r["win_pnl"]), lPnl = Number(r["loss_pnl"]);
            const pf = lPnl > 0 ? wPnl / lPnl : wPnl > 0 ? 3 : 0;
            const wr = w / t;
            regimeFactor = pf >= 1.5 && wr >= 0.5 ? 90 : pf >= 1.2 ? 70 : pf >= 1 ? 50 : pf < 0.8 ? 20 : 35;
          }
        }
      } catch { /* keep default */ }
    }

    // 8. Similar trades factor (0–100) — k-NN cosine similarity engine
    let similarTradesFactor = 50;
    let similarTradesBoost = 0;
    if (tradeFeatures) {
      try {
        const { findSimilarTrades } = await import("./similar-trades.js");
        const result = await findSimilarTrades(tradeFeatures);
        if (result) {
          // Map WR to 0-100 factor score
          similarTradesFactor = Math.round(result.winRate * 100);
          similarTradesBoost = result.confidenceBoost;
        }
      } catch { /* keep default */ }
    }

    const signalBonus = signalScore ? Math.round((signalScore - 50) * 0.15) : 0;
    // v3: reduce other weights slightly to accommodate 8th factor (sum = 1.0)
    const raw =
      recentPerformance     * 0.20 +
      marketQuality         * 0.20 +
      volatilityFit         * 0.13 +
      strategyEffectiveness * 0.15 +
      timeFactor            * 0.09 +
      instrumentFactor      * 0.07 +
      regimeFactor          * 0.07 +
      similarTradesFactor   * 0.09 +
      signalBonus +
      similarTradesBoost;

    const score = Math.max(0, Math.min(100, Math.round(raw)));
    const label: ConfidenceResult["label"] = score >= 65 ? "high" : score >= 40 ? "medium" : "low";

    return {
      score,
      factors: { recentPerformance, marketQuality, volatilityFit, strategyEffectiveness, timeFactor, instrumentFactor, regimeFactor, similarTradesFactor },
      similarTradesBoost,
      label,
    };
  }

  export function formatConfidence(c: ConfidenceResult): string {
    const emoji = c.label === "high" ? "🟢" : c.label === "medium" ? "🟡" : "🔴";
    return `${emoji} Confidence: ${c.score}%`;
  }
  