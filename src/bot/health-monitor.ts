/**
 * Learning Health Monitor — контроль качества обучения.
 * Отображает статистику за последние 30/100/300 сделок.
 * Предупреждает при ухудшении показателей.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export interface PeriodStats {
  label: string;
  trades: number;
  winRate: number;
  profitFactor: number;
  totalReturn: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  sharpeRatio: number;
}

export type HealthLevel = "excellent" | "good" | "watch" | "warning" | "critical";

export interface HealthStatus {
  overall: HealthLevel;
  periods: PeriodStats[];
  trend: "improving" | "stable" | "degrading";
  alerts: string[];
  lastChecked: string;
}

const PERIODS = [
  { label: "Последние 30", size: 30 },
  { label: "Последние 100", size: 100 },
  { label: "Последние 300", size: 300 },
];

function sharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1));
  return std === 0 ? 0 : mean / std * Math.sqrt(252);
}

function maxDD(pnls: number[]): number {
  let peak = 0, equity = 0, dd = 0;
  for (const r of pnls) {
    equity += r;
    if (equity > peak) peak = equity;
    const cur = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (cur > dd) dd = cur;
  }
  return dd;
}

function calcPeriodStats(pnls: number[], label: string): PeriodStats {
  if (!pnls.length) return { label, trades: 0, winRate: 0, profitFactor: 0, totalReturn: 0, maxDrawdown: 0, avgWin: 0, avgLoss: 0, sharpeRatio: 0 };
  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v <= 0);
  const gW = wins.reduce((s, v) => s + v, 0);
  const gL = Math.abs(losses.reduce((s, v) => s + v, 0));
  return {
    label,
    trades: pnls.length,
    winRate: wins.length / pnls.length,
    profitFactor: gL > 0 ? gW / gL : gW > 0 ? 99 : 0,
    totalReturn: pnls.reduce((s, v) => s + v, 0),
    maxDrawdown: maxDD(pnls),
    avgWin: wins.length ? gW / wins.length : 0,
    avgLoss: losses.length ? gL / losses.length : 0,
    sharpeRatio: sharpe(pnls),
  };
}

export async function checkLearningHealth(chatId?: number): Promise<HealthStatus> {
  const query = chatId != null
    ? `SELECT pnl_percent FROM paper_closed_trades WHERE chat_id = $1 AND outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 300`
    : `SELECT pnl_percent FROM paper_closed_trades WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 300`;
  const params = chatId != null ? [chatId] : [];

  const { rows } = await pool.query(query, params);
  const all = (rows as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));

  const periods: PeriodStats[] = PERIODS.map(p => calcPeriodStats(all.slice(0, p.size), p.label));

  const alerts: string[] = [];

  const p30  = periods[0]!;
  const p100 = periods[1]!;
  const p300 = periods[2]!;

  // ── 5-level health assessment ─────────────────────────────────────────────
  // Scores: each metric contributes points (100 = perfect)
  let score = 100;

  if (p30.trades >= 10) {
    // PF component (−40 max penalty)
    if      (p30.profitFactor < 0.7)  { score -= 40; alerts.push("🔴 PF(30) критически низкий: " + p30.profitFactor.toFixed(2)); }
    else if (p30.profitFactor < 0.9)  { score -= 30; alerts.push("🟠 PF(30) ниже 0.9: " + p30.profitFactor.toFixed(2)); }
    else if (p30.profitFactor < 1.1)  { score -= 18; alerts.push("🟡 PF(30) ниже 1.1: " + p30.profitFactor.toFixed(2)); }
    else if (p30.profitFactor < 1.3)  { score -=  6; }
    // WR component (−25 max penalty)
    if      (p30.winRate < 0.30) { score -= 25; alerts.push("🔴 WR(30) < 30%"); }
    else if (p30.winRate < 0.38) { score -= 15; alerts.push("🟠 WR(30) < 38%"); }
    else if (p30.winRate < 0.45) { score -=  5; alerts.push("🟡 WR(30) < 45%"); }
    // DD component (−25 max penalty)
    if      (p30.maxDrawdown > 25) { score -= 25; alerts.push("🔴 Просадка(30) > 25%"); }
    else if (p30.maxDrawdown > 18) { score -= 15; alerts.push("🟠 Просадка(30) > 18%"); }
    else if (p30.maxDrawdown > 12) { score -=  6; alerts.push("🟡 Просадка(30) > 12%"); }
  }

  if (p100.trades >= 30) {
    // Stability vs p30 (−10 max penalty for degradation)
    if (p30.profitFactor < p100.profitFactor - 0.2) { score -= 10; alerts.push("📉 Деградация: PF(30) значительно хуже PF(100)"); }
    else if (p30.profitFactor > p100.profitFactor + 0.15) { score += 5; } // bonus for improvement
  }

  score = Math.max(0, Math.min(100, score));

  // Map score to 5-level status
  let overall: HealthLevel;
  if      (score >= 85) overall = "excellent";
  else if (score >= 68) overall = "good";
  else if (score >= 50) overall = "watch";
  else if (score >= 32) overall = "warning";
  else                  overall = "critical";

  // Trend: comparing 30 vs 100 vs 300
  let trend: "improving" | "stable" | "degrading" = "stable";
  if (p30.trades >= 15 && p100.trades >= 40) {
    const pfDelta = p30.profitFactor - p100.profitFactor;
    if      (pfDelta < -0.15) trend = "degrading";
    else if (pfDelta >  0.10) trend = "improving";
  }

  if (trend === "degrading" && overall === "good")  overall = "watch";
  if (trend === "degrading" && overall === "watch")  overall = "warning";

  const status: HealthStatus = {
    overall, periods, trend, alerts, lastChecked: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO health_monitor_log(overall_status, trend, alerts_count, p30_pf, p100_pf, p300_pf, checked_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [overall, trend, alerts.length, p30.profitFactor, p100.profitFactor, p300.profitFactor, status.lastChecked]
  ).catch(err => logger.warn({ err }, "health_monitor_log save failed"));

  return status;
}

export function healthIcon(level: HealthLevel): string {
  return { excellent: "🟢", good: "🟢", watch: "🟡", warning: "🟠", critical: "🔴" }[level] ?? "⚪";
}
export function healthLabel(level: HealthLevel): string {
  return { excellent: "Отлично", good: "Хорошо", watch: "Наблюдение", warning: "Внимание", critical: "Критично" }[level] ?? level;
}

export function formatHealthReport(h: HealthStatus): string {
  const icon = healthIcon(h.overall);
  const trendIcon = h.trend === "improving" ? "📈" : h.trend === "degrading" ? "📉" : "➡️";

  let text = `${icon} *Learning Health Monitor*\n`;
  text += `Тренд: ${trendIcon} ${h.trend === "improving" ? "Улучшается" : h.trend === "degrading" ? "Ухудшается" : "Стабильно"}\n\n`;

  for (const p of h.periods) {
    if (p.trades < 5) continue;
    const pfIcon = p.profitFactor >= 1.3 ? "🟢" : p.profitFactor >= 1.0 ? "🟡" : "🔴";
    text += `*${p.label} (${p.trades} сделок)*\n`;
    text += `${pfIcon} PF: ${p.profitFactor.toFixed(2)} | WR: ${(p.winRate * 100).toFixed(1)}%\n`;
    text += `Доходность: ${p.totalReturn >= 0 ? "+" : ""}${p.totalReturn.toFixed(2)}% | Просадка: ${p.maxDrawdown.toFixed(1)}%\n`;
    text += `Avg Win: +${p.avgWin.toFixed(2)}% | Avg Loss: −${p.avgLoss.toFixed(2)}%\n\n`;
  }

  if (h.alerts.length) {
    text += `*Предупреждения:*\n${h.alerts.join("\n")}\n`;
  } else {
    text += "✅ Показатели в норме\n";
  }

  return text.trim();
}
