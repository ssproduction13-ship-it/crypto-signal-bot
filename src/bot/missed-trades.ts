import { pool } from "../lib/db.js";
  import { getPrice } from "./binance.js";
  import { logger } from "../lib/logger.js";

  let idSeq = 0;
  function genId() { return `mt-${Date.now()}-${idSeq++}`; }

  export interface MissedTrade {
    id: string; symbol: string; interval: string;
    direction: "LONG"|"SHORT"; entryPrice: number;
    stopLoss: number; tp1: number; tp2: number;
    score: number; filterReason: string; timestamp: string;
    closedAt?: string; virtualOutcome?: string; virtualPnlPercent?: number;
  }

  export async function recordMissedTrade(t: Omit<MissedTrade,"id">): Promise<void> {
    await pool.query(
      `INSERT INTO missed_trades(id,symbol,interval,direction,entry_price,stop_loss,tp1,tp2,score,filter_reason,timestamp)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
      [genId(),t.symbol,t.interval,t.direction,t.entryPrice,t.stopLoss,t.tp1,t.tp2,t.score,t.filterReason,t.timestamp]
    );
  }

  export async function checkMissedTrades(): Promise<string[]> {
    const {rows} = await pool.query(
      "SELECT * FROM missed_trades WHERE closed_at IS NULL ORDER BY timestamp DESC LIMIT 30"
    );
    const msgs: string[] = [];
    for (const row of rows as Record<string,unknown>[]) {
      try {
        const sym = row["symbol"] as string;
        const price = await getPrice(sym);
        const dir = row["direction"] as "LONG"|"SHORT";
        const ep  = Number(row["entry_price"]);
        const sl  = Number(row["stop_loss"]);
        const tp1 = Number(row["tp1"]);
        const tp2 = Number(row["tp2"]);
        let outcome: string|null = null;
        let pnl = 0;
        if (dir==="LONG") {
          if (price<=sl)  { outcome="SL";  pnl=((sl-ep)/ep)*100; }
          else if (price>=tp2) { outcome="TP2"; pnl=((tp2-ep)/ep)*100; }
          else if (price>=tp1) { outcome="TP1"; pnl=((tp1-ep)/ep)*100; }
        } else {
          if (price>=sl)  { outcome="SL";  pnl=((ep-sl)/ep)*100; }
          else if (price<=tp2) { outcome="TP2"; pnl=((ep-tp2)/ep)*100; }
          else if (price<=tp1) { outcome="TP1"; pnl=((ep-tp1)/ep)*100; }
        }
        if (outcome) {
          await pool.query(
            "UPDATE missed_trades SET closed_at=$1,virtual_outcome=$2,virtual_pnl_percent=$3 WHERE id=$4",
            [new Date().toISOString(), outcome, pnl, row["id"]]
          );
          const em = pnl>0 ? "🟡" : "⚫";
          msgs.push(
            `${em} *Упущенная сделка ${sym}: ${outcome}*\n` +
            `P&L (если бы открыли): ${pnl>=0?"+":""}${pnl.toFixed(2)}%\n` +
            `Причина пропуска: ${row["filter_reason"]}`
          );
        }
      } catch(err) { logger.debug({err},"missed trade check failed"); }
    }
    return msgs;
  }

  export async function getMissedStats(): Promise<string> {
    const {rows} = await pool.query(
      "SELECT virtual_pnl_percent FROM missed_trades WHERE closed_at IS NOT NULL"
    );
    if (!rows.length) return "🔵 Упущенных сделок пока нет.";
    const pnls = rows.map(r=>Number((r as Record<string,unknown>)["virtual_pnl_percent"]));
    const wins = pnls.filter(p=>p>0);
    const wr = (wins.length/pnls.length*100).toFixed(1);
    const avg = (pnls.reduce((a,b)=>a+b,0)/pnls.length).toFixed(2);
    return `🔵 *Упущенные сделки*\n\nВсего: ${pnls.length} | WR: ${wr}%\nСред. P&L: ${Number(avg)>=0?"+":""}${avg}%\n\n_Используется для самообучения_`;
  }
  