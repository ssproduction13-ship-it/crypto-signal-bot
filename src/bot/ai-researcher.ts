/**
 * AI Researcher — AI Learning Engine v3
 * Automatically discovers patterns, generates hypotheses in Russian,
 * converts them into shadow experiments, and tracks results.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export interface ResearchReport {
  id?: number;
  date: string;
  pattern: string;
  hypothesis: string;
  experiment: string;
  status: "generated"|"testing"|"confirmed"|"rejected";
  result?: string;
  tradeCountAt: number;
}

// ── Helper: get stats slice ───────────────────────────────────────────────────
async function queryStats(sql: string, params: unknown[] = []): Promise<Record<string,unknown>[]> {
  const { rows } = await pool.query(sql, params);
  return rows as Record<string,unknown>[];
}

// ── Core research function ─────────────────────────────────────────────────────
export async function runAIResearch(tradeCount: number): Promise<string> {
  const hypotheses: string[] = [];
  const rawPatterns: Array<{pattern:string; hypothesis:string; experiment:string}> = [];

  // 1. Best / worst hours
  try {
    const hourRows = await queryStats(
      `SELECT hour_of_day, trades, wins,
              win_pnl, loss_pnl,
              CASE WHEN trades>0 THEN wins::float/trades ELSE 0 END as wr
       FROM time_analytics WHERE trades >= 5
       ORDER BY wr DESC`
    );
    if (hourRows.length >= 4) {
      const best  = hourRows[0]!;
      const worst = hourRows[hourRows.length - 1]!;
      const bh = Number(best["hour_of_day"]), bwr = Math.round(Number(best["wr"])*100);
      const wh = Number(worst["hour_of_day"]), wwr = Math.round(Number(worst["wr"])*100);
      if (bwr - wwr >= 15) {
        rawPatterns.push({
          pattern: `Лучший час торговли: ${bh}:00 (WR ${bwr}%), худший: ${wh}:00 (WR ${wwr}%)`,
          hypothesis: `Торговля в ${bh}:00–${bh+1}:00 показывает WR на ${bwr-wwr}пп выше среднего. Рекомендую усилить фильтр по времени.`,
          experiment: `Добавить приоритет для часа ${bh} в time-analytics (TimeBoost +10%). Запустить Shadow Test на 50 сделках.`,
        });
      }
    }
  } catch { /* skip */ }

  // 2. Best/worst strategies
  try {
    const stratRows = await queryStats(
      `SELECT strategy, trades, wins, win_pnl, loss_pnl, total_pnl,
              CASE WHEN trades>0 THEN wins::float/trades ELSE 0 END as wr,
              CASE WHEN loss_pnl>0 THEN win_pnl/loss_pnl ELSE win_pnl END as pf
       FROM strategy_stats WHERE trades >= 20
       ORDER BY pf DESC`
    );
    if (stratRows.length >= 2) {
      const best  = stratRows[0]!;
      const worst = stratRows[stratRows.length - 1]!;
      const bpf = Number(best["pf"]).toFixed(2), wpf = Number(worst["pf"]).toFixed(2);
      const bs = best["strategy"] as string, ws = worst["strategy"] as string;
      if (Number(worst["pf"]) < 0.85) {
        rawPatterns.push({
          pattern: `${bs} (PF ${bpf}) значительно опережает ${ws} (PF ${wpf})`,
          hypothesis: `Стратегия ${ws} показывает PF ${wpf} < 0.85. Возможно, текущие рыночные условия ей не подходят.`,
          experiment: `Снизить вес ${ws} на 10%. Переключить ${ws} в Shadow Mode на 30 сделок. Сравнить с ${bs}.`,
        });
      }
    }
  } catch { /* skip */ }

  // 3. Best/worst market regime per strategy
  try {
    const regimeRows = await queryStats(
      `SELECT strategy, regime, trades, wins, win_pnl, loss_pnl,
              CASE WHEN trades>0 THEN wins::float/trades ELSE 0 END as wr,
              CASE WHEN loss_pnl>0 THEN win_pnl/loss_pnl ELSE COALESCE(win_pnl,0) END as pf
       FROM strategy_regime_stats WHERE trades >= 8
       ORDER BY pf DESC`
    );
    const regimeLabelRU: Record<string,string> = {
      trend_up:"восходящий тренд", trend_down:"нисходящий тренд",
      sideways:"боковик", high_vol:"высокую волатильность", low_vol:"затишье",
    };
    for (const r of regimeRows) {
      if (Number(r["pf"]) < 0.7 && Number(r["wr"]) < 0.38) {
        const strat = r["strategy"] as string;
        const regime = r["regime"] as string;
        rawPatterns.push({
          pattern: `${strat} убыточна при режиме "${regimeLabelRU[regime]??regime}" (PF ${Number(r["pf"]).toFixed(2)}, WR ${Math.round(Number(r["wr"])*100)}%)`,
          hypothesis: `${strat} показывает низкую эффективность во время ${regimeLabelRU[regime]??regime}. Рекомендую добавить режимный фильтр.`,
          experiment: `Заблокировать ${strat} при режиме "${regime}". Запустить Shadow Test для проверки гипотезы.`,
        });
        break; // one regime hypothesis at a time
      }
    }
  } catch { /* skip */ }

  // 4. Loss reasons analysis
  try {
    const lossRows = await queryStats(
      `SELECT strategy, reason, count FROM strategy_loss_reasons
       ORDER BY count DESC LIMIT 5`
    );
    if (lossRows.length) {
      const top = lossRows[0]!;
      const r = top["reason"] as string;
      const strat = top["strategy"] as string;
      const reasonLabels: Record<string,string> = {
        sideways_market:"боковой рынок",fake_breakout:"ложные пробои",
        low_volume:"низкий объём",high_volatility:"высокую волатильность",
        trend_reversal:"развороты тренда",other:"прочее",
      };
      rawPatterns.push({
        pattern: `Основная причина убытков ${strat}: ${reasonLabels[r]??r} (${top["count"]} случаев)`,
        hypothesis: `Большинство потерь ${strat} связаны с ${reasonLabels[r]??r}. Добавление дополнительного фильтра может сократить убытки.`,
        experiment: `Добавить проверку ATR/объёма перед открытием ${strat}. Shadow Test 40 сделок без этого паттерна.`,
      });
    }
  } catch { /* skip */ }

  // 5. Best instruments
  try {
    const instrRows = await queryStats(
      `SELECT symbol, trades, wins, win_pnl, loss_pnl,
              CASE WHEN trades>0 THEN wins::float/trades ELSE 0 END as wr,
              CASE WHEN loss_pnl>0 THEN win_pnl/loss_pnl ELSE COALESCE(win_pnl,0) END as pf
       FROM instrument_analytics WHERE trades >= 10
       ORDER BY pf DESC LIMIT 5`
    );
    if (instrRows.length >= 3) {
      const topSymbols = instrRows.slice(0,3).map(r => r["symbol"]).join(", ");
      const topPFs = instrRows.slice(0,3).map(r => `${r["symbol"]} PF ${Number(r["pf"]).toFixed(2)}`).join(", ");
      rawPatterns.push({
        pattern: `Лучшие инструменты: ${topPFs}`,
        hypothesis: `Концентрация на топ-3 инструментах может повысить общий PF. Рекомендую повысить их приоритет.`,
        experiment: `Повысить priority_weight для ${topSymbols} на 20%. Отслеживать влияние на итоговый PF.`,
      });
    }
  } catch { /* skip */ }

  // 6. Period comparison (last 50 vs previous 50)
  try {
    const periRows = await queryStats(
      `SELECT pnl_percent, is_win, closed_at FROM paper_closed_trades
       ORDER BY closed_at DESC LIMIT 100`
    );
    if (periRows.length >= 60) {
      const recent  = periRows.slice(0, 50);
      const prev    = periRows.slice(50, 100);
      const recentWR = recent.filter(r => r["is_win"]).length / recent.length;
      const prevWR   = prev.filter(r => r["is_win"]).length / prev.length;
      const diff = Math.round((recentWR - prevWR) * 100);
      if (Math.abs(diff) >= 10) {
        const trend = diff > 0 ? "улучшается" : "ухудшается";
        rawPatterns.push({
          pattern: `Производительность ${trend}: WR за последние 50 сделок ${Math.round(recentWR*100)}% vs предыдущие ${Math.round(prevWR*100)}%`,
          hypothesis: `Система ${trend === "улучшается" ? "адаптировалась к текущим условиям" : "теряет эффективность — возможно, изменился режим рынка"}. ${trend === "ухудшается" ? "Рекомендую внеочередной цикл адаптации." : "Зафиксировать текущую конфигурацию."}`,
          experiment: `${trend === "ухудшается" ? "Запустить цикл адаптации весов досрочно." : "Взять снапшот текущих весов как точку отсчёта."}`,
        });
      }
    }
  } catch { /* skip */ }

  // ── Save hypotheses to DB ──────────────────────────────────────────────────
  const now = new Date().toISOString();
  for (const p of rawPatterns.slice(0, 5)) {
    const text = `📌 *${p.pattern}*\n💡 ${p.hypothesis}\n🔬 ${p.experiment}`;
    hypotheses.push(text);
    await pool.query(
      `INSERT INTO ai_research_reports(date, pattern, hypothesis, experiment, status, trade_count_at)
       VALUES($1,$2,$3,$4,'generated',$5)`,
      [now, p.pattern, p.hypothesis, p.experiment, tradeCount]
    ).catch(() => {});
  }

  if (!hypotheses.length) {
    return `🔬 *AI Researcher — ${tradeCount} сделок*\n\nНедостаточно данных для формирования гипотез. Продолжаю накапливать статистику.`;
  }

  const summary = [
    `🔬 *AI Researcher — анализ ${tradeCount} сделок*`,
    `_Обнаружено закономерностей: ${rawPatterns.length}_`,
    "",
    ...hypotheses.slice(0, 3).map((h, i) => `${i+1}. ${h}`),
    "",
    `_Гипотезы сохранены для Shadow Testing_`,
  ].join("\n");

  logger.info({tradeCount, hypotheses: rawPatterns.length}, "AI Research cycle complete");
  return summary;
}

// ── Research history ────────────────────────────────────────────────────────
export async function getResearchHistory(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT date, pattern, hypothesis, experiment, status, result, trade_count_at
     FROM ai_research_reports
     ORDER BY date DESC LIMIT 10`
  );
  if (!rows.length)
    return "🔬 *История AI-исследований*\n\nПока нет данных — нужно минимум 100 сделок для первого анализа.";

  const statusIcon: Record<string,string> = {
    generated:"🔍", testing:"🧪", confirmed:"✅", rejected:"❌",
  };
  const lines = ["🔬 *История AI-исследований*", ""];
  for (const r of rows as Record<string,unknown>[]) {
    const date = (r["date"] as string).slice(0,10);
    const status = r["status"] as string;
    const icon = statusIcon[status] ?? "🔍";
    lines.push(`${icon} [${date}] n=${r["trade_count_at"]}`);
    lines.push(`  _${r["pattern"]}_`);
    if (r["result"]) lines.push(`  → ${r["result"]}`);
  }
  return lines.join("\n");
}

// ── Update research result ────────────────────────────────────────────────────
export async function updateResearchResult(
  id: number, status: "testing"|"confirmed"|"rejected", result: string
): Promise<void> {
  await pool.query(
    "UPDATE ai_research_reports SET status=$2, result=$3 WHERE id=$1",
    [id, status, result]
  );
}
