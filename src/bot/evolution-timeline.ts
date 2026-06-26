/**
 * Evolution Timeline — история развития системы.
 * После каждого цикла обучения сохраняет версию, дату, метрики,
 * изменения стратегий и гипотезы.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { StrategyName } from "./strategies.js";

export interface EvolutionSnapshot {
  id?: number;
  version: number;
  date: string;
  totalTrades: number;
  profitFactor: number;
  winRate: number;
  maxDrawdown: number;
  bestStrategies: StrategyName[];
  disabledStrategies: StrategyName[];
  changedParams: Record<string, { from: unknown; to: unknown }>;
  newHypotheses: string[];
  summary: string;
}

let _currentVersion = 0;

async function getNextVersion(): Promise<number> {
  const { rows } = await pool.query("SELECT COALESCE(MAX(version), 0) as v FROM evolution_timeline");
  return Number((rows[0] as Record<string, unknown>)["v"]) + 1;
}

export async function saveEvolutionSnapshot(
  snapshot: Omit<EvolutionSnapshot, "id" | "version" | "date">
): Promise<EvolutionSnapshot> {
  const version = await getNextVersion();
  const date = new Date().toISOString();
  const full: EvolutionSnapshot = { ...snapshot, version, date };

  await pool.query(
    `INSERT INTO evolution_timeline(version, date, total_trades, profit_factor, win_rate,
       max_drawdown, best_strategies, disabled_strategies, changed_params, new_hypotheses, summary)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      version, date, snapshot.totalTrades, snapshot.profitFactor, snapshot.winRate,
      snapshot.maxDrawdown,
      JSON.stringify(snapshot.bestStrategies),
      JSON.stringify(snapshot.disabledStrategies),
      JSON.stringify(snapshot.changedParams),
      JSON.stringify(snapshot.newHypotheses),
      snapshot.summary,
    ]
  ).catch(err => logger.warn({ err }, "evolution_timeline save failed"));

  logger.info({ version }, "Evolution snapshot saved");
  return full;
}

export async function getEvolutionTimeline(limit = 10): Promise<EvolutionSnapshot[]> {
  const { rows } = await pool.query(
    `SELECT * FROM evolution_timeline ORDER BY version DESC LIMIT $1`,
    [limit]
  );
  return rows.map(r => {
    const row = r as Record<string, unknown>;
    return {
      id: Number(row["id"]),
      version: Number(row["version"]),
      date: row["date"] as string,
      totalTrades: Number(row["total_trades"]),
      profitFactor: Number(row["profit_factor"]),
      winRate: Number(row["win_rate"]),
      maxDrawdown: Number(row["max_drawdown"]),
      bestStrategies: (row["best_strategies"] as StrategyName[]) ?? [],
      disabledStrategies: (row["disabled_strategies"] as StrategyName[]) ?? [],
      changedParams: (row["changed_params"] as Record<string, { from: unknown; to: unknown }>) ?? {},
      newHypotheses: (row["new_hypotheses"] as string[]) ?? [],
      summary: row["summary"] as string,
    };
  });
}

export async function autoSnapshotAfterLearning(): Promise<void> {
  try {
    const { rows: tradeRows } = await pool.query(
      `SELECT pnl_percent, strategy FROM paper_closed_trades WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT 300`
    );
    const pnls = (tradeRows as Record<string, unknown>[]).map(r => Number(r["pnl_percent"]));
    if (pnls.length < 30) return;

    const wins = pnls.filter(v => v > 0);
    const losses = pnls.filter(v => v <= 0);
    const gW = wins.reduce((s, v) => s + v, 0);
    const gL = Math.abs(losses.reduce((s, v) => s + v, 0));
    const pf = gL > 0 ? gW / gL : gW > 0 ? 99 : 0;
    const wr = wins.length / pnls.length;

    let peak = 0, eq = 0, dd = 0;
    for (const r of [...pnls].reverse()) { eq += r; if (eq > peak) peak = eq; const cur = peak > 0 ? (peak - eq) / peak * 100 : 0; if (cur > dd) dd = cur; }

    // Strategy performance
    const stratMap: Record<string, number[]> = {};
    for (const r of tradeRows as Record<string, unknown>[]) {
      const st = r["strategy"] as string;
      if (!stratMap[st]) stratMap[st] = [];
      stratMap[st]!.push(Number(r["pnl_percent"]));
    }
    const stratPFs: Array<{ name: StrategyName; pf: number }> = Object.entries(stratMap).map(([name, arr]) => {
      const gWs = arr.filter(v => v > 0).reduce((s, v) => s + v, 0);
      const gLs = Math.abs(arr.filter(v => v <= 0).reduce((s, v) => s + v, 0));
      return { name: name as StrategyName, pf: gLs > 0 ? gWs / gLs : gWs > 0 ? 99 : 0 };
    });
    stratPFs.sort((a, b) => b.pf - a.pf);
    const best = stratPFs.filter(s => s.pf >= 1.2).map(s => s.name);
    const disabled = stratPFs.filter(s => s.pf < 0.8).map(s => s.name);

    await saveEvolutionSnapshot({
      totalTrades: pnls.length,
      profitFactor: pf,
      winRate: wr,
      maxDrawdown: dd,
      bestStrategies: best,
      disabledStrategies: disabled,
      changedParams: {},
      newHypotheses: [],
      summary: `Auto-snapshot v${await getNextVersion() - 1}: PF=${pf.toFixed(2)}, WR=${(wr * 100).toFixed(1)}%, DD=${dd.toFixed(1)}%`,
    });
  } catch (err) {
    logger.warn({ err }, "autoSnapshotAfterLearning failed");
  }
}

export function formatTimeline(snapshots: EvolutionSnapshot[]): string {
  if (!snapshots.length) return "📅 *Evolution Timeline*\n\nИстория пуста — ещё нет завершённых циклов обучения.";

  let text = "📅 *Evolution Timeline*\n\n";
  for (const s of snapshots.slice(0, 5)) {
    const date = new Date(s.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });
    const pfIcon = s.profitFactor >= 1.3 ? "🟢" : s.profitFactor >= 1.0 ? "🟡" : "🔴";
    text += `*v${s.version}* — ${date}\n`;
    text += `${pfIcon} PF: ${s.profitFactor.toFixed(2)} | WR: ${(s.winRate * 100).toFixed(1)}% | DD: ${s.maxDrawdown.toFixed(1)}%\n`;
    text += `Сделок: ${s.totalTrades}`;
    if (s.bestStrategies.length) text += ` | Лучшие: ${s.bestStrategies.join(", ")}`;
    if (s.disabledStrategies.length) text += ` | Слабые: ${s.disabledStrategies.join(", ")}`;
    text += "\n";
    if (s.newHypotheses.length) text += `Гипотезы: ${s.newHypotheses.slice(0, 2).join("; ")}\n`;
    text += "\n";
  }
  return text.trim();
}
