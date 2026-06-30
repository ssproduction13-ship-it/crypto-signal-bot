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
    else if (pf<0.7&&wr<0.35) priority=0.5;
    else if (pf<0.5&&wr<0.3) priority=0.2;
    await pool.query("UPDATE instrument_analytics SET priority_weight=$2 WHERE symbol=$1",[symbol,priority]);
  }

  export async function getInstrumentPriority(symbol: string): Promise<number> {
    const {rows} = await pool.query("SELECT priority_weight FROM instrument_analytics WHERE symbol=$1",[symbol]);
    return rows.length ? Number((rows[0] as Record<string,unknown>)["priority_weight"]) : 1.0;
  }

  export async function getInstrumentAnalytics(): Promise<string> {
    const {rows} = await pool.query(
      "SELECT * FROM instrument_analytics WHERE trades>=5 ORDER BY (CASE WHEN loss_pnl>0 THEN win_pnl/loss_pnl ELSE win_pnl+1 END) DESC"
    );
    if (!rows.length) return "📊 *Аналитика по инструментам*\n\nНедостаточно данных (нужно ≥5 сделок на инструмент).";

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
    }

    // Worst
    const worst=(rows as Record<string,unknown>[]).filter(r=>Number(r["priority_weight"])<=0.5);
    const exclusions=worst.length ? ["","⛔ *Низкий приоритет:*",...worst.map(r=>`  ${r["symbol"] as string}`)] : [];

    return ["📊 *Аналитика по инструментам*","","🏆 *Рейтинг:*",...lines,...exclusions].join("\n");
  }
  