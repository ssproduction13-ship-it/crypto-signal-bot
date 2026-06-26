/**
 * Market Drift Detector — обнаруживает изменение характера рынка.
 * Сравнивает последние 300 сделок с предыдущими.
 * При дрейфе уменьшает Confidence и снижает активность.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export type DriftSeverity = "none" | "mild" | "moderate" | "severe";

export interface DriftMetrics {
  period: string;
  trades: number;
  winRate: number;
  profitFactor: number;
  avgPnl: number;
  maxDrawdown: number;
}

export interface DriftDetectionResult {
  hasDrift: boolean;
  severity: DriftSeverity;
  recentMetrics: DriftMetrics;
  historicalMetrics: DriftMetrics;
  confidenceReduction: number;
  activityReduction: number;
  message: string;
  detectedAt: string;
}

function calcMetrics(trades: number[], label: string): DriftMetrics {
  if (!trades.length) return { period: label, trades: 0, winRate: 0, profitFactor: 0, avgPnl: 0, maxDrawdown: 0 };
  const wins = trades.filter(v => v > 0);
  const losses = trades.filter(v => v <= 0);
  const winPnl = wins.reduce((s, v) => s + v, 0);
  const lossPnl = Math.abs(losses.reduce((s, v) => s + v, 0));
  const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 99 : 0;
  const wr = wins.length / trades.length;
  const avgPnl = trades.reduce((s, v) => s + v, 0) / trades.length;

  let peak = 0, equity = 0, maxDD = 0;
  for (const r of trades) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return { period: label, trades: trades.length, winRate: wr, profitFactor: pf, avgPnl, maxDrawdown: maxDD };
}

export async function detectMarketDrift(): Promise<DriftDetectionResult> {
  const RECENT_WINDOW = 300;
  const HISTORY_WINDOW = 700;

  const { rows } = await pool.query(
    `SELECT pnl_percent FROM paper_closed_trades
     WHERE outcome IS NOT NULL
     ORDER BY closed_at DESC
     LIMIT $1`,
    [RECENT_WINDOW + HISTORY_WINDOW]
  );

  const all = (rows as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));
  const recentArr = all.slice(0, Math.min(RECENT_WINDOW, all.length));
  const histArr = all.slice(recentArr.length, all.length);

  const recent = calcMetrics(recentArr, `Последние ${recentArr.length} сделок`);
  const historical = calcMetrics(histArr, `Предыдущие ${histArr.length} сделок`);

  let severity: DriftSeverity = "none";
  let hasDrift = false;
  const messages: string[] = [];

  if (historical.trades < 50) {
    return {
      hasDrift: false, severity: "none",
      recentMetrics: recent, historicalMetrics: historical,
      confidenceReduction: 0, activityReduction: 0,
      message: "Недостаточно исторических данных для анализа дрейфа",
      detectedAt: new Date().toISOString(),
    };
  }

  const pfDrop = historical.profitFactor > 0
    ? (historical.profitFactor - recent.profitFactor) / historical.profitFactor
    : 0;
  const wrDrop = historical.winRate - recent.winRate;
  const ddIncrease = recent.maxDrawdown - historical.maxDrawdown;

  if (pfDrop > 0.4 || wrDrop > 0.15 || ddIncrease > 15) {
    severity = "severe"; hasDrift = true;
    messages.push("🚨 Тяжёлый дрейф рынка");
  } else if (pfDrop > 0.25 || wrDrop > 0.10 || ddIncrease > 10) {
    severity = "moderate"; hasDrift = true;
    messages.push("⚠️ Умеренный дрейф рынка");
  } else if (pfDrop > 0.15 || wrDrop > 0.05 || ddIncrease > 5) {
    severity = "mild"; hasDrift = true;
    messages.push("📉 Лёгкий дрейф рынка");
  }

  if (pfDrop > 0.05) messages.push(`PF: ${historical.profitFactor.toFixed(2)} → ${recent.profitFactor.toFixed(2)} (−${(pfDrop * 100).toFixed(0)}%)`);
  if (wrDrop > 0.02) messages.push(`WR: ${(historical.winRate * 100).toFixed(1)}% → ${(recent.winRate * 100).toFixed(1)}%`);
  if (ddIncrease > 2) messages.push(`Просадка: ${historical.maxDrawdown.toFixed(1)}% → ${recent.maxDrawdown.toFixed(1)}%`);

  const confidenceReduction = severity === "severe" ? 15 : severity === "moderate" ? 10 : severity === "mild" ? 5 : 0;
  const activityReduction = severity === "severe" ? 0.5 : severity === "moderate" ? 0.3 : severity === "mild" ? 0.15 : 0;

  const result: DriftDetectionResult = {
    hasDrift,
    severity,
    recentMetrics: recent,
    historicalMetrics: historical,
    confidenceReduction,
    activityReduction,
    message: messages.join("\n") || "Дрейф не обнаружен — рынок стабилен",
    detectedAt: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO market_drift_log(has_drift, severity, recent_pf, historical_pf,
       recent_wr, historical_wr, confidence_reduction, activity_reduction, message, detected_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [hasDrift, severity, recent.profitFactor, historical.profitFactor,
      recent.winRate, historical.winRate, confidenceReduction, activityReduction,
      result.message, result.detectedAt]
  ).catch(err => logger.warn({ err }, "market_drift_log save failed"));

  return result;
}

export async function getLatestDrift(): Promise<DriftDetectionResult | null> {
  const { rows } = await pool.query(
    `SELECT * FROM market_drift_log ORDER BY detected_at DESC LIMIT 1`
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    hasDrift: Boolean(r["has_drift"]),
    severity: r["severity"] as DriftSeverity,
    recentMetrics: { period: "Последние", trades: 0, winRate: Number(r["recent_wr"]), profitFactor: Number(r["recent_pf"]), avgPnl: 0, maxDrawdown: 0 },
    historicalMetrics: { period: "Исторические", trades: 0, winRate: Number(r["historical_wr"]), profitFactor: Number(r["historical_pf"]), avgPnl: 0, maxDrawdown: 0 },
    confidenceReduction: Number(r["confidence_reduction"]),
    activityReduction: Number(r["activity_reduction"]),
    message: r["message"] as string,
    detectedAt: r["detected_at"] as string,
  };
}

export function formatDriftReport(d: DriftDetectionResult): string {
  const icon = d.severity === "severe" ? "🚨" : d.severity === "moderate" ? "⚠️" : d.severity === "mild" ? "📉" : "✅";
  let text = `${icon} *Market Drift Detector*\n\n`;
  text += `Статус: ${d.hasDrift ? `Дрейф обнаружен (${d.severity.toUpperCase()})` : "Рынок стабилен"}\n\n`;
  text += `*Последние сделки (${d.recentMetrics.trades})*\n`;
  text += `PF: ${d.recentMetrics.profitFactor.toFixed(2)} | WR: ${(d.recentMetrics.winRate * 100).toFixed(1)}%\n`;
  text += `Просадка: ${d.recentMetrics.maxDrawdown.toFixed(1)}%\n\n`;
  text += `*История (${d.historicalMetrics.trades})*\n`;
  text += `PF: ${d.historicalMetrics.profitFactor.toFixed(2)} | WR: ${(d.historicalMetrics.winRate * 100).toFixed(1)}%\n`;
  text += `Просадка: ${d.historicalMetrics.maxDrawdown.toFixed(1)}%\n\n`;
  if (d.hasDrift) {
    text += `*Меры:*\n`;
    text += `Снижение Confidence: −${d.confidenceReduction}%\n`;
    text += `Снижение активности: −${(d.activityReduction * 100).toFixed(0)}%\n\n`;
  }
  text += d.message;
  return text;
}
