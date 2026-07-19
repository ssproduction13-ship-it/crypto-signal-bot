import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { StrategyName } from "./strategies.js";

  export async function recordInstrumentTrade(
    symbol: string, strategy: StrategyName, pnlPercent: number, isWin: boolean
  ): Promise<void> {
    try {
      const winPnl=isWin?Math.abs(pnlPercent):0, lossPnl=isWin?0:Math.abs(pnlPercent);
      await pool.query(
        `INSERT INTO instrument_analytics(symbol,trades,wins,win_pnl,loss_pnl,total_pnl,best_strategy,updated_at)
         VALUES($1,1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(symbol) DO UPDATE SET
           trades=instrument_analytics.trades+1,
           wins=instrument_analytics.wins+$2,
           win_pnl=instrument_analytics.win_pnl+$3,
           loss_pnl=instrument_analytics.loss_pnl+$4,
           total_pnl=instrument_analytics.total_pnl+$5,
           updated_at=$7`,
        [symbol,isWin?1:0,winPnl,lossPnl,pnlPercent,strategy,new Date().toISOString()]
      );
      // Update best_strategy by Profit Factor, not just win count.
      // A strategy with 10 small wins + 2 large losses beat one with 5 wins + 0 losses
      // under the old COUNT(*) approach. PF is a more reliable quality metric.
      // HAVING COUNT(*) >= 5 avoids conclusions from 1–2 trades.
      const {rows} = await pool.query(
        `SELECT strategy,
           COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0)          AS win_pnl,
           COALESCE(ABS(SUM(pnl) FILTER (WHERE pnl < 0)), 0)      AS loss_pnl
         FROM paper_closed_trades
         WHERE symbol=$1
         GROUP BY strategy
         HAVING COUNT(*) >= 5`,
        [symbol]
      );
      if (rows.length) {
        const scored = (rows as Record<string,unknown>[]).map(r => {
          const winPnl  = Number(r["win_pnl"]);
          const lossPnl = Number(r["loss_pnl"]);
          const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
          return { strategy: r["strategy"] as string, pf };
        });
        const best = scored.reduce((a, b) => b.pf > a.pf ? b : a);
        await pool.query("UPDATE instrument_analytics SET best_strategy=$2 WHERE symbol=$1", [symbol, best.strategy]);
      }
      // Update priority: reduce if consistently losing
      await updateInstrumentPriority(symbol);
    } catch(err) { logger.debug({err},"recordInstrumentTrade failed"); }
  }

  async function updateInstrumentPriority(symbol: string): Promise<void> {
    const {rows} = await pool.query(
      "SELECT trades,wins,win_pnl,loss_pnl FROM instrument_analytics WHERE symbol=$1",[symbol]
    );
    if (!rows.length) return;
    const r=rows[0] as Record<string,unknown>;
    const trades=Number(r["trades"]);
    if (trades<10) return;
    const wins=Number(r["wins"]),winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
    const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
    const wr=wins/trades;
    let priority=1.0;
    if (pf>=1.5&&wr>=0.5) priority=1.3;
    else if (wr<0.25) priority=0.0;         // banned: WR < 25%, полный запрет новых сделок
    else if (pf<0.7&&wr<0.35) priority=0.5;
    else if (pf<0.5&&wr<0.3) priority=0.2;
    await pool.query("UPDATE instrument_analytics SET priority_weight=$2 WHERE symbol=$1",[symbol,priority]);
  }

  export async function getInstrumentPriority(symbol: string): Promise<number> {
    const {rows} = await pool.query("SELECT priority_weight FROM instrument_analytics WHERE symbol=$1",[symbol]);
    return rows.length ? Number((rows[0] as Record<string,unknown>)["priority_weight"]) : 1.0;
  }

  export async function getInstrumentAnalytics(): Promise<string> {
    const [{rows}, {rows: dirRows}] = await Promise.all([
      pool.query("SELECT * FROM instrument_analytics WHERE trades>=5 ORDER BY (CASE WHEN loss_pnl>0 THEN win_pnl/loss_pnl ELSE win_pnl+1 END) DESC"),
      pool.query(`SELECT symbol, direction, COUNT(*) AS trades,
        SUM(CASE WHEN COALESCE(pnl_equity_pct,pnl)>0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN COALESCE(pnl_equity_pct,pnl)>0 THEN COALESCE(pnl_equity_pct,pnl) ELSE 0 END) AS win_pnl,
        SUM(CASE WHEN COALESCE(pnl_equity_pct,pnl)<0 THEN ABS(COALESCE(pnl_equity_pct,pnl)) ELSE 0 END) AS loss_pnl
        FROM paper_closed_trades
        WHERE closed_at::timestamptz >= (SELECT COALESCE(reset_at,'1970-01-01'::timestamptz) FROM paper_accounts LIMIT 1)
        GROUP BY symbol, direction HAVING COUNT(*) >= 5`),
    ]);
    if (!rows.length) return "📊 *Аналитика по инструментам*\n\nНедостаточно данных (нужно ≥5 сделок на инструмент).";

    // Build per-symbol direction map
    const dirBySym:Record<string,Record<string,{trades:number;wins:number;winPnl:number;lossPnl:number}>>={}
    for (const r of dirRows as Record<string,unknown>[]) {
      const sym=r["symbol"] as string, dir=r["direction"] as string;
      if (!dirBySym[sym]) dirBySym[sym]={};
      dirBySym[sym]![dir]={trades:Number(r["trades"]),wins:Number(r["wins"]),winPnl:Number(r["win_pnl"]),lossPnl:Number(r["loss_pnl"])};
    }

    const lines:(string)[] = [];
    for (const r of (rows as Record<string,unknown>[]).slice(0,10)) {
      const sym=r["symbol"] as string;
      const trades=Number(r["trades"]),wins=Number(r["wins"]);
      const winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
      const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
      const wr=(wins/trades*100).toFixed(0);
      const best=r["best_strategy"] as string;
      const pw=Number(r["priority_weight"]);
      const icon=pw>=1.2?"🔥":pw<=0.3?"❌":pw<=0.6?"⚠️":"✅";
      lines.push(`${icon} *${sym}*: WR ${wr}% | PF ${pf===99?"∞":pf.toFixed(2)} | n=${trades} | ${best}`);
      // LONG vs SHORT breakdown
      const symDirs=dirBySym[sym]??{};
      for (const d of ["LONG","SHORT"]) {
        const sd=symDirs[d]; if(!sd) continue;
        const dwr=(sd.wins/sd.trades*100).toFixed(0);
        const dpf=sd.lossPnl>0?(sd.winPnl/sd.lossPnl).toFixed(2):sd.winPnl>0?"∞":"—";
        lines.push(`  ↳ ${d}: WR ${dwr}% | PF ${dpf} | n=${sd.trades}`);
      }
    }

    // Banned / low-priority
    const banned=(rows as Record<string,unknown>[]).filter(r=>Number(r["priority_weight"])===0);
    const worst=(rows as Record<string,unknown>[]).filter(r=>Number(r["priority_weight"])>0&&Number(r["priority_weight"])<=0.5);
    const bannedLines=banned.length ? ["","🚫 *Заблокированы (WR < 25%):*",...banned.map(r=>`  ${r["symbol"] as string} — WR ${(Number(r["wins"])/Number(r["trades"])*100).toFixed(0)}%`)] : [];
    const exclusions=worst.length ? ["","⛔ *Низкий приоритет:*",...worst.map(r=>`  ${r["symbol"] as string}`)] : [];

    return ["📊 *Аналитика по инструментам*","","🏆 *Рейтинг:*",...lines,...bannedLines,...exclusions].join("\n");
  }
  
// ── AI Watchlist (shadow-карантин на уровне инструмента) ─────────────────────

export type InstrumentStatus = "normal" | "watchlist" | "deep_watchlist" | "banned";

function classifyInstrument(stats: { trades: number; pf: number; wr: number }): InstrumentStatus {
  // Fast-ban: 0% WR at 5+ trades — statistically undeniable, no need to wait for 10.
  if (stats.wr === 0 && stats.trades >= 5) return "banned";
  if (stats.trades < 10) return "normal";
  // Полный бан: WR < 25% OR PF < 0.5 при 10+ сделках — статистически устойчивый аутсайдер.
  // Разблокируется автоматически при WR ≥ 25% И PF ≥ 0.5 в последних 20 сделках.
  if (stats.wr < 0.25 && stats.trades >= 10) return "banned";
  if (stats.pf < 0.5 && stats.trades >= 10) return "banned";  // Coin shadow trading: strict PF block
  if (stats.pf < 0.7 && stats.trades >= 10) return "deep_watchlist";
  if (stats.pf < 0.7) return "watchlist";
  return "normal";
}

/** Возвращает true если инструмент полностью заблокирован для новых позиций. */
export async function isInstrumentBanned(symbol: string): Promise<boolean> {
  return (await getInstrumentStatus(symbol)) === "banned";
}

export async function getInstrumentStatus(symbol: string): Promise<InstrumentStatus> {
  try {
    const { rows } = await pool.query(
      "SELECT status FROM instrument_analytics WHERE symbol=$1", [symbol]
    );
    if (!rows.length) return "normal";
    return ((rows[0] as Record<string, unknown>)["status"] as InstrumentStatus) ?? "normal";
  } catch (err) {
    logger.debug({ err }, "getInstrumentStatus failed");
    return "normal";
  }
}

/**
 * Пересчитывает classifyInstrument для всех монет на основе последних 20 сделок.
 * Вызывается раз в сутки — позволяет монете выйти из watchlist если она исправилась.
 * Возвращает список изменений для отправки Telegram-уведомлений.
 */
export async function updateAllInstrumentStatuses(): Promise<
  { symbol: string; oldStatus: InstrumentStatus; newStatus: InstrumentStatus; pf: number; wr: number; trades: number }[]
> {
  const changes: { symbol: string; oldStatus: InstrumentStatus; newStatus: InstrumentStatus; pf: number; wr: number; trades: number }[] = [];
  try {
    const { rows } = await pool.query(
      "SELECT symbol, trades, wins, win_pnl, loss_pnl, status FROM instrument_analytics WHERE trades >= 10"
    );
    for (const row of rows as Record<string, unknown>[]) {
      const symbol = row["symbol"] as string;
      const oldStatus = ((row["status"] as InstrumentStatus) ?? "normal");
      const trades    = Number(row["trades"]);
      const wins      = Number(row["wins"]);
      const winPnl    = Number(row["win_pnl"]);
      const lossPnl   = Number(row["loss_pnl"]);

      // Последние 20 сделок — чтобы монета могла выйти из watchlist после улучшения
      // fix: use pnl_percent (per-trade quality) not pnl_equity_pct (per-equity impact).
      // pnl_equity_pct is skewed by position-sizing multipliers (cooldown/MTF/corr-guard),
      // so a trade entered at 30% size has 70% less equity impact even if the trade quality
      // is identical. This distorts PF downward for instruments that happen to be traded
      // at reduced size, causing false bans. pnl_percent measures raw trade quality only.
      const { rows: recentRows } = await pool.query(
        `SELECT pnl_percent AS pnl FROM paper_closed_trades
          WHERE symbol=$1
            AND closed_at::timestamptz >= (SELECT COALESCE(reset_at,'1970-01-01'::timestamptz) FROM paper_accounts LIMIT 1)
          ORDER BY closed_at DESC LIMIT 20`,
        [symbol]
      );
      const recentN = recentRows.length;
      let rWinPnl = 0, rLossPnl = 0, rWins = 0;
      for (const r of recentRows as Record<string, unknown>[]) {
        const pnl = Number(r["pnl"]);
        if (pnl > 0) { rWinPnl += pnl; rWins++; } else { rLossPnl += Math.abs(pnl); }
      }

      const pf = recentN >= 10
        ? (rLossPnl > 0 ? rWinPnl / rLossPnl : rWinPnl > 0 ? 99 : 0)
        : (lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 99 : 0);
      const wr = recentN >= 10
        ? (recentN > 0 ? rWins / recentN : 0)
        : (trades > 0 ? wins / trades : 0);
      const effectiveTrades = recentN >= 10 ? recentN : trades;

      const newStatus = classifyInstrument({ trades: effectiveTrades, pf, wr });
      if (newStatus !== oldStatus) {
        await pool.query("UPDATE instrument_analytics SET status=$2 WHERE symbol=$1", [symbol, newStatus]).catch(() => {});
        changes.push({ symbol, oldStatus, newStatus, pf, wr: wr * 100, trades: effectiveTrades });
      }
    }
  } catch (err) {
    logger.error({ err }, "updateAllInstrumentStatuses failed");
  }
  return changes;
}
