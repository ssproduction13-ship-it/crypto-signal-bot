/**
 * Strategy Stability Index — индекс стабильности стратегии.
 * Учитывает PF, WR, просадку, волатильность результатов и стабильность последних сделок.
 * Отображает: Stable / Watch / Critical
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { StrategyName } from "./strategies.js";

export type StabilityLabel = "Stable" | "Watch" | "Critical";

export interface StrategyStabilityResult {
  strategy: StrategyName;
  stabilityScore: number;
  label: StabilityLabel;
  profitFactor: number;
  winRate: number;
  maxDrawdown: number;
  pnlVolatility: number;
  recentConsistency: number;
  trades: number;
  recentTrades: number;
  details: string[];
  computedAt: string;
}

function standardDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1));
}

function maxDD(pnls: number[]): number {
  let peak = 0, eq = 0, dd = 0;
  for (const r of pnls) {
    eq += r;
    if (eq > peak) peak = eq;
    const cur = peak > 0 ? (peak - eq) / peak * 100 : 0;
    if (cur > dd) dd = cur;
  }
  return dd;
}

// Consistency: what % of rolling 10-trade windows have PF >= 1.0
function calcConsistency(pnls: number[], windowSize = 10): number {
  if (pnls.length < windowSize) return pnls.filter(v => v > 0).length / pnls.length;
  let passCount = 0;
  const total = pnls.length - windowSize + 1;
  for (let i = 0; i <= pnls.length - windowSize; i++) {
    const slice = pnls.slice(i, i + windowSize);
    const gW = slice.filter(v => v > 0).reduce((s, v) => s + v, 0);
    const gL = Math.abs(slice.filter(v => v <= 0).reduce((s, v) => s + v, 0));
    const pf = gL > 0 ? gW / gL : gW > 0 ? 99 : 0;
    if (pf >= 1.0) passCount++;
  }
  return passCount / total;
}

export async function calcStrategyStability(strategy: StrategyName): Promise<StrategyStabilityResult> {
  const { rows } = await pool.query(
    `SELECT pnl_percent FROM paper_closed_trades
     WHERE strategy = $1 AND outcome IS NOT NULL
     ORDER BY closed_at DESC
     LIMIT 300`,
    [strategy]
  );
  const pnls = (rows as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));

  if (pnls.length < 20) {
    return {
      strategy, stabilityScore: 0, label: "Watch",
      profitFactor: 0, winRate: 0, maxDrawdown: 0, pnlVolatility: 0,
      recentConsistency: 0, trades: pnls.length, recentTrades: 0,
      details: ["Недостаточно данных (нужно 20+ сделок)"],
      computedAt: new Date().toISOString(),
    };
  }

  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v <= 0);
  const gW = wins.reduce((s, v) => s + v, 0);
  const gL = Math.abs(losses.reduce((s, v) => s + v, 0));
  const profitFactor = gL > 0 ? gW / gL : gW > 0 ? 99 : 0;
  const winRate = wins.length / pnls.length;
  const dd = maxDD([...pnls].reverse());
  const vol = standardDev(pnls);
  const consistency = calcConsistency(pnls);

  const recent30 = pnls.slice(0, 30);
  const recent30wins = recent30.filter(v => v > 0);
  const r30WR = recent30.length ? recent30wins.length / recent30.length : 0;
  const r30gW = recent30wins.reduce((s, v) => s + v, 0);
  const r30gL = Math.abs(recent30.filter(v => v <= 0).reduce((s, v) => s + v, 0));
  const r30PF = r30gL > 0 ? r30gW / r30gL : r30gW > 0 ? 99 : 0;

  // Score components (each 0–25 points = 100 total)
  let score = 0;
  const details: string[] = [];

  // 1. Profit Factor (max 30)
  if (profitFactor >= 1.5)      { score += 30; details.push(`✅ PF ${profitFactor.toFixed(2)} — отличный`); }
  else if (profitFactor >= 1.2) { score += 22; details.push(`🟡 PF ${profitFactor.toFixed(2)} — хороший`); }
  else if (profitFactor >= 1.0) { score += 12; details.push(`🟡 PF ${profitFactor.toFixed(2)} — приемлемый`); }
  else                           { score += 0;  details.push(`🔴 PF ${profitFactor.toFixed(2)} — ниже нормы`); }

  // 2. Win Rate (max 20)
  if (winRate >= 0.55)      { score += 20; details.push(`✅ WR ${(winRate * 100).toFixed(1)}% — высокий`); }
  else if (winRate >= 0.45) { score += 15; details.push(`🟡 WR ${(winRate * 100).toFixed(1)}% — нормальный`); }
  else if (winRate >= 0.35) { score += 8;  details.push(`🟡 WR ${(winRate * 100).toFixed(1)}% — низкий`); }
  else                       { score += 0;  details.push(`🔴 WR ${(winRate * 100).toFixed(1)}% — очень низкий`); }

  // 3. Max Drawdown (max 20)
  if (dd < 8)       { score += 20; details.push(`✅ Просадка ${dd.toFixed(1)}% — минимальная`); }
  else if (dd < 15) { score += 13; details.push(`🟡 Просадка ${dd.toFixed(1)}% — умеренная`); }
  else if (dd < 25) { score += 6;  details.push(`⚠️ Просадка ${dd.toFixed(1)}% — высокая`); }
  else               { score += 0;  details.push(`🔴 Просадка ${dd.toFixed(1)}% — критическая`); }

  // 4. Consistency (max 15)
  if (consistency >= 0.7)      { score += 15; details.push(`✅ Стабильность ${(consistency * 100).toFixed(0)}%`); }
  else if (consistency >= 0.5) { score += 10; details.push(`🟡 Стабильность ${(consistency * 100).toFixed(0)}%`); }
  else                          { score += 0;  details.push(`🔴 Нестабильная стратегия`); }

  // 5. Recent trend (max 15) — last 30 vs overall
  const recentBetter = r30PF >= profitFactor * 0.9;
  if (r30PF >= 1.3)        { score += 15; details.push(`✅ Последние 30 — PF ${r30PF.toFixed(2)}`); }
  else if (recentBetter)   { score += 10; details.push(`🟡 Последние 30 — PF ${r30PF.toFixed(2)}`); }
  else                      { score += 0;  details.push(`🔴 Последние 30 хуже общих (PF ${r30PF.toFixed(2)})`); }

  const label: StabilityLabel = score >= 65 ? "Stable" : score >= 40 ? "Watch" : "Critical";

  const result: StrategyStabilityResult = {
    strategy, stabilityScore: score, label,
    profitFactor, winRate, maxDrawdown: dd, pnlVolatility: vol,
    recentConsistency: consistency, trades: pnls.length, recentTrades: recent30.length,
    details, computedAt: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO strategy_stability_index(strategy, stability_score, label, profit_factor,
       win_rate, max_drawdown, pnl_volatility, consistency, trades, computed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [strategy, score, label, profitFactor, winRate, dd, vol, consistency, pnls.length, result.computedAt]
  ).catch(err => logger.warn({ err }, "strategy_stability_index save failed"));

  return result;
}

export async function getAllStrategyStabilities(): Promise<StrategyStabilityResult[]> {
  const strategies: StrategyName[] = ["TREND", "BREAKOUT", "VOLUME_IMPULSE", "MEAN_REVERSION"];
  const results = await Promise.all(strategies.map(s => calcStrategyStability(s)));
  return results.sort((a, b) => b.stabilityScore - a.stabilityScore);
}

export function formatStabilityReport(results: StrategyStabilityResult[]): string {
  let text = "🏗️ *Strategy Stability Index*\n\n";
  for (const r of results) {
    const icon = r.label === "Stable" ? "🟢" : r.label === "Watch" ? "🟡" : "🔴";
    text += `${icon} *${r.strategy}* — ${r.label} (${r.stabilityScore}/100)\n`;
    text += `PF: ${r.profitFactor.toFixed(2)} | WR: ${(r.winRate * 100).toFixed(1)}% | DD: ${r.maxDrawdown.toFixed(1)}%\n`;
    if (r.trades < 20) {
      text += `Данных: ${r.trades} сделок\n\n`;
    } else {
      text += `Сделок: ${r.trades} | Стабильность окон: ${(r.recentConsistency * 100).toFixed(0)}%\n\n`;
    }
  }
  return text.trim();
}
