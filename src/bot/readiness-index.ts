/**
 * Readiness Index — общий показатель готовности к реальной торговле (0–100%).
 * Учитывает: количество сделок, PF, WR, просадку, стабильность,
 * качество обучения, отсутствие деградации, Walk-Forward тесты.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export interface ReadinessComponent {
  name: string;
  score: number;
  maxScore: number;
  status: "✅" | "🟡" | "❌";
  note: string;
}

export interface ReadinessResult {
  total: number;
  maxTotal: number;
  percent: number;
  label: string;
  components: ReadinessComponent[];
  recommendations: string[];
  computedAt: string;
  /** PF, используемый при оценке Readiness (последние PF_WINDOW сделок) */
  pfValue: number;
  /** Сколько сделок вошло в расчёт PF */
  pfWindow: number;
  /** Суммарная прибыль по выигранным сделкам (в $) */
  grossProfit: number;
  /** Суммарный убыток по проигранным сделкам (в $, положительное число) */
  grossLoss: number;
}

/** Сколько последних сделок берётся для расчёта PF в Readiness */
const PF_WINDOW = 200;

export async function calcReadinessIndex(chatId?: number): Promise<ReadinessResult> {
  const components: ReadinessComponent[] = [];
  const recommendations: string[] = [];

  // 1. Trade count (max 15)
  const { rows: cntRows } = await pool.query(
    chatId != null
      ? `SELECT COUNT(*) as cnt FROM paper_closed_trades WHERE chat_id = $1 AND outcome IS NOT NULL`
      : `SELECT COUNT(*) as cnt FROM paper_closed_trades WHERE outcome IS NOT NULL`,
    chatId != null ? [chatId] : []
  );
  const totalTrades = Number((cntRows[0] as Record<string, unknown>)["cnt"]);

  let tradeScore = 0;
  let tradeNote = "";
  // FIX High: full score at 1000 trades (was 500 — too easy, not statistically sufficient)
  if (totalTrades >= 1000) { tradeScore = 15; tradeNote = `${totalTrades} сделок — отлично`; }
  else if (totalTrades >= 200) { tradeScore = 11; tradeNote = `${totalTrades} сделок — хорошо`; }
  else if (totalTrades >= 100) { tradeScore = 7; tradeNote = `${totalTrades}/100 нужно`; recommendations.push("Накопить 200+ сделок"); }
  else { tradeScore = Math.floor(totalTrades / 100 * 7); tradeNote = `${totalTrades} из нужных 100+`; recommendations.push(`Нужно ещё ${100 - totalTrades} сделок минимум`); }
  components.push({ name: "Количество сделок", score: tradeScore, maxScore: 15, status: tradeScore >= 11 ? "✅" : tradeScore >= 7 ? "🟡" : "❌", note: tradeNote });

  // 2. Profit Factor (max 20) — последние PF_WINDOW сделок
  const { rows: pfRows } = await pool.query(
    chatId != null
      ? `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl FROM paper_closed_trades WHERE chat_id = $1 AND outcome IS NOT NULL ORDER BY closed_at DESC LIMIT ${PF_WINDOW}`
      : `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl FROM paper_closed_trades WHERE outcome IS NOT NULL ORDER BY closed_at DESC LIMIT ${PF_WINDOW}`,
    chatId != null ? [chatId] : []
  );
  const pnls = (pfRows as Record<string, unknown>[]).map(r => Number(r["pnl"]));
  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v <= 0);
  const gW = wins.reduce((s, v) => s + v, 0);
  const gL = Math.abs(losses.reduce((s, v) => s + v, 0));
  const pf = gL > 0 ? gW / gL : gW > 0 ? 99 : 0;
  const wr = pnls.length > 0 ? wins.length / pnls.length : 0;

  // Прозрачная подпись: сколько сделок вошло в расчёт
  const pfWindowActual = pnls.length;
  const pfNote = `PF ${pf.toFixed(2)} [Gross+ ${gW.toFixed(2)} / Gross- ${gL.toFixed(2)}, ${pfWindowActual} сделок]`;

  let pfScore = 0;
  if (pf >= 1.5) { pfScore = 20; }
  else if (pf >= 1.3) { pfScore = 16; }
  else if (pf >= 1.1) { pfScore = 10; recommendations.push(`Profit Factor последних ${pfWindowActual} сделок: ${pf.toFixed(2)} — нужно ≥1.30`); }
  else if (pf >= 1.0) { pfScore = 5; recommendations.push(`Profit Factor последних ${pfWindowActual} сделок: ${pf.toFixed(2)} — слишком близко к 1.0`); }
  else { pfScore = 0; recommendations.push(`Profit Factor последних ${pfWindowActual} сделок: ${pf.toFixed(2)} — система убыточна на этом окне`); }
  components.push({ name: "Profit Factor", score: pfScore, maxScore: 20, status: pfScore >= 16 ? "✅" : pfScore >= 10 ? "🟡" : "❌", note: pfNote });

  // 3. Win Rate (max 10)
  let wrScore = 0;
  if (wr >= 0.52) { wrScore = 10; }
  else if (wr >= 0.45) { wrScore = 7; }
  else if (wr >= 0.38) { wrScore = 4; recommendations.push("Улучшить Win Rate до 45%+"); }
  else { wrScore = 0; recommendations.push("Win Rate ниже 38% — пересмотреть стратегии"); }
  components.push({ name: "Win Rate", score: wrScore, maxScore: 10, status: wrScore >= 7 ? "✅" : wrScore >= 4 ? "🟡" : "❌", note: `WR = ${(wr * 100).toFixed(1)}%` });

  // 4. Max Drawdown (max 15)
  let peak = 0, eq = 0, maxDd = 0;
  for (const r of [...pnls].reverse()) { eq += r; if (eq > peak) peak = eq; const dd = peak > 0 ? (peak - eq) / peak * 100 : 0; if (dd > maxDd) maxDd = dd; }
  let ddScore = 0;
  if (maxDd <= 8) { ddScore = 15; }
  else if (maxDd <= 15) { ddScore = 10; }
  else if (maxDd <= 25) { ddScore = 5; recommendations.push("Снизить максимальную просадку ниже 15%"); }
  else { ddScore = 0; recommendations.push("Критическая просадка! Пересмотреть риск-менеджмент"); }
  components.push({ name: "Макс. просадка", score: ddScore, maxScore: 15, status: ddScore >= 10 ? "✅" : ddScore >= 5 ? "🟡" : "❌", note: `DD = ${maxDd.toFixed(1)}%` });

  // 5. Walk-Forward Tests (max 15)
  const { rows: wfRows } = await pool.query(
    `SELECT DISTINCT ON (strategy) strategy, is_valid, overfit_risk FROM walk_forward_results ORDER BY strategy, computed_at DESC`
  );
  const wfTests = wfRows as Record<string, unknown>[];
  const wfPassed = wfTests.filter(r => Boolean(r["is_valid"])).length;
  const wfTotal = wfTests.length;
  let wfScore = 0;
  if (wfTotal === 0) { wfScore = 0; recommendations.push("Запустить Walk-Forward тестирование"); }
  else if (wfPassed === wfTotal) { wfScore = 15; }
  else if (wfPassed >= Math.ceil(wfTotal / 2)) { wfScore = 10; }
  else { wfScore = 5; recommendations.push("Большинство стратегий не прошли Walk-Forward"); }
  components.push({ name: "Walk-Forward тесты", score: wfScore, maxScore: 15, status: wfScore >= 10 ? "✅" : wfScore >= 5 ? "🟡" : "❌", note: `${wfPassed}/${wfTotal} прошли` });

  // 6. No Degradation (max 15) — last 30 vs 100
  const p30 = pnls.slice(0, 30);
  const p100 = pnls.slice(0, 100);
  const calcPF = (arr: number[]) => { const gWa = arr.filter(v => v > 0).reduce((s, v) => s + v, 0); const gLa = Math.abs(arr.filter(v => v <= 0).reduce((s, v) => s + v, 0)); return gLa > 0 ? gWa / gLa : gWa > 0 ? 99 : 0; };
  const pf30 = calcPF(p30);
  const pf100 = calcPF(p100);
  const degrade = p30.length >= 20 && p100.length >= 50 ? (pf100 - pf30) / pf100 : 0;
  let degScore = 0;
  if (p30.length < 20) { degScore = 7; }
  else if (degrade <= 0.1) { degScore = 15; }
  else if (degrade <= 0.2) { degScore = 10; }
  else if (degrade <= 0.35) { degScore = 5; recommendations.push("Недавние результаты хуже исторических"); }
  else { degScore = 0; recommendations.push("Обнаружена деградация системы — требует внимания"); }
  components.push({ name: "Отсутствие деградации", score: degScore, maxScore: 15, status: degScore >= 10 ? "✅" : degScore >= 5 ? "🟡" : "❌", note: degrade > 0 ? `Снижение: ${(degrade * 100).toFixed(0)}%` : "Ухудшения нет" });

  // 7. Minimum runtime (max 10) — proxy: check if first trade is old enough
  const { rows: firstRows } = await pool.query(
    `SELECT MIN(closed_at) as first FROM paper_closed_trades WHERE outcome IS NOT NULL`
  );
  const firstTradeDate = (firstRows[0] as Record<string, unknown>)["first"] as string | null;
  let runtimeScore = 0;
  let runtimeNote = "Нет данных";
  if (firstTradeDate) {
    const daysSinceFirst = (Date.now() - new Date(firstTradeDate).getTime()) / (1000 * 3600 * 24);
    if (daysSinceFirst >= 30) { runtimeScore = 10; runtimeNote = `${Math.floor(daysSinceFirst)} дней работы`; }
    else if (daysSinceFirst >= 14) { runtimeScore = 6; runtimeNote = `${Math.floor(daysSinceFirst)}/30 дней`; recommendations.push(`Нужно ещё ${30 - Math.floor(daysSinceFirst)} дней непрерывной работы`); }
    else { runtimeScore = 3; runtimeNote = `${Math.floor(daysSinceFirst)}/30 дней`; recommendations.push("Нужно минимум 30 дней непрерывной работы"); }
  } else { recommendations.push("Нет закрытых сделок"); }
  components.push({ name: "Время работы", score: runtimeScore, maxScore: 10, status: runtimeScore >= 6 ? "✅" : runtimeScore >= 3 ? "🟡" : "❌", note: runtimeNote });

  const total = components.reduce((s, c) => s + c.score, 0);
  const maxTotal = components.reduce((s, c) => s + c.maxScore, 0);
  const percent = Math.round((total / maxTotal) * 100);

  let label = "";
  if (percent >= 85) label = "🏆 Готов к реальной торговле";
  else if (percent >= 70) label = "🟢 Почти готов";
  else if (percent >= 50) label = "🟡 Требует улучшений";
  else label = "🔴 Не готов";

  const result: ReadinessResult = {
    total, maxTotal, percent, label, components, recommendations,
    computedAt: new Date().toISOString(),
    pfValue: pf,
    pfWindow: pfWindowActual,
    grossProfit: gW,
    grossLoss: gL,
  };

  await pool.query(
    `INSERT INTO readiness_index_log(percent, total_score, total_trades, pf, wr, max_drawdown, computed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [percent, total, totalTrades, pf, wr, maxDd, result.computedAt]
  ).catch(err => logger.warn({ err }, "readiness_index_log save failed"));

  return result;
}

export function formatReadinessReport(r: ReadinessResult): string {
  let text = `🎯 *Readiness Index*\n\n`;
  text += `*${r.percent}%* — ${r.label}\n`;
  text += `Баллов: ${r.total}/${r.maxTotal}\n\n`;

  const bar = "█".repeat(Math.floor(r.percent / 5)) + "░".repeat(20 - Math.floor(r.percent / 5));
  text += `\`${bar}\`\n\n`;

  // Debug: PF transparency block
  text += `📐 *Диагностика PF* (последние ${r.pfWindow} сделок, в $):\n`;
  text += `  Gross Profit: *+${r.grossProfit.toFixed(2)}*\n`;
  text += `  Gross Loss:    *-${r.grossLoss.toFixed(2)}*\n`;
  text += `  PF = *${r.pfValue.toFixed(3)}* (нужно ≥1.500)\n`;
  text += `  Сделок в расчёте: ${r.pfWindow}\n\n`;

  text += `*Компоненты:*\n`;
  for (const c of r.components) {
    text += `${c.status} ${c.name}: ${c.score}/${c.maxScore} — ${c.note}\n`;
  }

  if (r.recommendations.length) {
    text += `\n*Что улучшить:*\n`;
    for (const rec of r.recommendations.slice(0, 5)) {
      text += `• ${rec}\n`;
    }
  }

  return text.trim();
}
