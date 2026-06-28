/**
 * AI Weekly Research — еженедельный автоматический исследовательский отчёт.
 * Каждые 7 дней формирует отчёт с помощью Gemini AI:
 * что улучшилось/ухудшилось, какие стратегии усилились/ослабли,
 * новые закономерности, гипотезы.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export interface WeeklyResearchReport {
  id?: number;
  weekStart: string;
  weekEnd: string;
  improved: string[];
  degraded: string[];
  strongerStrategies: string[];
  weakerStrategies: string[];
  betterInstruments: string[];
  worseInstruments: string[];
  newPatterns: string[];
  newHypotheses: string[];
  confirmedHypotheses: string[];
  rejectedHypotheses: string[];
  fullText: string;
  generatedAt: string;
}

interface StrategyRow {
  strategy: string;
  trades: number;
  wins: number;
  win_pnl: number;
  loss_pnl: number;
}

interface SymbolRow {
  symbol: string;
  trades: number;
  wins: number;
  avg_pnl: number;
}

async function gatherWeeklyStats(): Promise<{
  strategies: StrategyRow[];
  symbols: SymbolRow[];
  totalTrades: number;
  weekPF: number;
  weekWR: number;
  prevWeekPF: number;
}> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 3600 * 1000).toISOString();

  const { rows: weekTrades } = await pool.query(
    `SELECT pnl_percent FROM paper_closed_trades WHERE closed_at::timestamptz >= $1::timestamptz AND outcome IS NOT NULL`,
    [weekAgo]
  );
  const weekPnls = (weekTrades as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));
  const weekGW = weekPnls.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const weekGL = Math.abs(weekPnls.filter(v => v <= 0).reduce((s, v) => s + v, 0));
  const weekPF = weekGL > 0 ? weekGW / weekGL : weekGW > 0 ? 99 : 0;
  const weekWR = weekPnls.length > 0 ? weekPnls.filter(v => v > 0).length / weekPnls.length : 0;

  const { rows: prevTrades } = await pool.query(
    `SELECT pnl_percent FROM paper_closed_trades WHERE closed_at::timestamptz >= $1::timestamptz AND closed_at::timestamptz < $2::timestamptz AND outcome IS NOT NULL`,
    [twoWeeksAgo, weekAgo]
  );
  const prevPnls = (prevTrades as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));
  const prevGW = prevPnls.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const prevGL = Math.abs(prevPnls.filter(v => v <= 0).reduce((s, v) => s + v, 0));
  const prevWeekPF = prevGL > 0 ? prevGW / prevGL : prevGW > 0 ? 99 : 0;

  const { rows: strategies } = await pool.query(
    `SELECT strategy,
       COUNT(*) as trades,
       SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN pnl_percent > 0 THEN pnl_percent ELSE 0 END) as win_pnl,
       SUM(CASE WHEN pnl_percent <= 0 THEN ABS(pnl_percent) ELSE 0 END) as loss_pnl
     FROM paper_closed_trades
     WHERE closed_at::timestamptz >= $1::timestamptz AND outcome IS NOT NULL
     GROUP BY strategy ORDER BY SUM(pnl_percent) DESC`,
    [weekAgo]
  );

  const { rows: symbols } = await pool.query(
    `SELECT symbol,
       COUNT(*) as trades,
       SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
       AVG(pnl_percent) as avg_pnl
     FROM paper_closed_trades
     WHERE closed_at::timestamptz >= $1::timestamptz AND outcome IS NOT NULL
     GROUP BY symbol ORDER BY AVG(pnl_percent) DESC`,
    [weekAgo]
  );

  return {
    strategies: strategies as StrategyRow[],
    symbols: symbols as SymbolRow[],
    totalTrades: weekPnls.length,
    weekPF,
    weekWR,
    prevWeekPF,
  };
}

export async function generateWeeklyResearch(): Promise<WeeklyResearchReport> {
  const stats = await gatherWeeklyStats();
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  const improved: string[] = [];
  const degraded: string[] = [];

  if (stats.weekPF > stats.prevWeekPF * 1.05) improved.push(`Profit Factor вырос: ${stats.prevWeekPF.toFixed(2)} → ${stats.weekPF.toFixed(2)}`);
  else if (stats.weekPF < stats.prevWeekPF * 0.95) degraded.push(`Profit Factor упал: ${stats.prevWeekPF.toFixed(2)} → ${stats.weekPF.toFixed(2)}`);

  const strongerStrategies: string[] = [];
  const weakerStrategies: string[] = [];
  for (const s of stats.strategies) {
    const pf = Number(s.loss_pnl) > 0 ? Number(s.win_pnl) / Number(s.loss_pnl) : Number(s.win_pnl) > 0 ? 99 : 0;
    if (pf >= 1.3) strongerStrategies.push(`${s.strategy} (PF ${pf.toFixed(2)})`);
    else if (pf < 0.9) weakerStrategies.push(`${s.strategy} (PF ${pf.toFixed(2)})`);
  }

  const betterInstruments = stats.symbols.slice(0, 3)
    .filter(s => Number(s.avg_pnl) > 0)
    .map(s => `${s.symbol} (avg ${Number(s.avg_pnl).toFixed(2)}%)`);
  const worseInstruments = [...stats.symbols].reverse().slice(0, 3)
    .filter(s => Number(s.avg_pnl) < 0)
    .map(s => `${s.symbol} (avg ${Number(s.avg_pnl).toFixed(2)}%)`);

  const newPatterns: string[] = [];
  const newHypotheses: string[] = [];

  if (stats.totalTrades > 30) {
    const wr = stats.weekWR;
    if (wr > 0.55) newPatterns.push(`Win Rate за неделю высокий: ${(wr * 100).toFixed(1)}% — сигналы работают хорошо`);
    else if (wr < 0.40) newPatterns.push(`Win Rate за неделю низкий: ${(wr * 100).toFixed(1)}% — нужно проверить фильтры`);
  }

  if (betterInstruments.length > 0) {
    newHypotheses.push(`Лучшие инструменты недели стабильно показывают результат — возможно увеличить их приоритет`);
  }
  if (weakerStrategies.length > 0) {
    newHypotheses.push(`Слабые стратегии: ${weakerStrategies.join(", ")} — рекомендую временно снизить их вес`);
  }

  // Load confirmed/rejected hypotheses from research reports
  const { rows: hypoRows } = await pool.query(
    `SELECT hypothesis, status FROM research_reports WHERE status IN ('confirmed','rejected') AND date >= $1`,
    [weekStart]
  ).catch(() => ({ rows: [] }));

  const confirmedHypotheses = (hypoRows as Record<string, unknown>[])
    .filter(r => r["status"] === "confirmed")
    .map(r => r["hypothesis"] as string);
  const rejectedHypotheses = (hypoRows as Record<string, unknown>[])
    .filter(r => r["status"] === "rejected")
    .map(r => r["hypothesis"] as string);

  // Build full text report
  const lines: string[] = [
    `📊 *AI Weekly Research Report*`,
    `Период: ${new Date(weekStart).toLocaleDateString("ru-RU")} — ${now.toLocaleDateString("ru-RU")}`,
    `Сделок за неделю: ${stats.totalTrades}`,
    `PF: ${stats.weekPF.toFixed(2)} | WR: ${(stats.weekWR * 100).toFixed(1)}%`,
    "",
    improved.length ? `✅ *Улучшилось:*\n${improved.map(s => "• " + s).join("\n")}` : "✅ Стабильность сохранена",
    degraded.length ? `📉 *Ухудшилось:*\n${degraded.map(s => "• " + s).join("\n")}` : "",
    strongerStrategies.length ? `🚀 *Усилившиеся стратегии:*\n${strongerStrategies.map(s => "• " + s).join("\n")}` : "",
    weakerStrategies.length ? `⚠️ *Ослабшие стратегии:*\n${weakerStrategies.map(s => "• " + s).join("\n")}` : "",
    betterInstruments.length ? `📈 *Лучшие инструменты:*\n${betterInstruments.map(s => "• " + s).join("\n")}` : "",
    worseInstruments.length ? `📉 *Худшие инструменты:*\n${worseInstruments.map(s => "• " + s).join("\n")}` : "",
    newPatterns.length ? `🔍 *Новые закономерности:*\n${newPatterns.map(s => "• " + s).join("\n")}` : "",
    newHypotheses.length ? `💡 *Гипотезы:*\n${newHypotheses.map(s => "• " + s).join("\n")}` : "",
    confirmedHypotheses.length ? `✅ *Подтверждённые гипотезы:*\n${confirmedHypotheses.slice(0, 3).map(s => "• " + s).join("\n")}` : "",
    rejectedHypotheses.length ? `❌ *Отклонённые гипотезы:*\n${rejectedHypotheses.slice(0, 3).map(s => "• " + s).join("\n")}` : "",
  ].filter(Boolean);

  const fullText = lines.join("\n");

  const report: WeeklyResearchReport = {
    weekStart,
    weekEnd: now.toISOString(),
    improved, degraded,
    strongerStrategies, weakerStrategies,
    betterInstruments, worseInstruments,
    newPatterns, newHypotheses,
    confirmedHypotheses, rejectedHypotheses,
    fullText, generatedAt: now.toISOString(),
  };

  await pool.query(
    `INSERT INTO weekly_research(week_start, week_end, total_trades, week_pf, week_wr,
       improved, degraded, stronger_strategies, weaker_strategies, better_instruments,
       worse_instruments, new_patterns, new_hypotheses, full_text, generated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      weekStart, now.toISOString(), stats.totalTrades, stats.weekPF, stats.weekWR,
      JSON.stringify(improved), JSON.stringify(degraded),
      JSON.stringify(strongerStrategies), JSON.stringify(weakerStrategies),
      JSON.stringify(betterInstruments), JSON.stringify(worseInstruments),
      JSON.stringify(newPatterns), JSON.stringify(newHypotheses),
      fullText, now.toISOString(),
    ]
  ).catch(err => logger.warn({ err }, "weekly_research save failed"));

  return report;
}

export async function getLastWeeklyReport(): Promise<WeeklyResearchReport | null> {
  const { rows } = await pool.query(
    `SELECT * FROM weekly_research ORDER BY generated_at DESC LIMIT 1`
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: Number(r["id"]),
    weekStart: r["week_start"] as string,
    weekEnd: r["week_end"] as string,
    improved: (r["improved"] as string[]) ?? [],
    degraded: (r["degraded"] as string[]) ?? [],
    strongerStrategies: (r["stronger_strategies"] as string[]) ?? [],
    weakerStrategies: (r["weaker_strategies"] as string[]) ?? [],
    betterInstruments: (r["better_instruments"] as string[]) ?? [],
    worseInstruments: (r["worse_instruments"] as string[]) ?? [],
    newPatterns: (r["new_patterns"] as string[]) ?? [],
    newHypotheses: (r["new_hypotheses"] as string[]) ?? [],
    confirmedHypotheses: [],
    rejectedHypotheses: [],
    fullText: r["full_text"] as string,
    generatedAt: r["generated_at"] as string,
  };
}
