import { pool } from "../lib/db.js";
  import { getPrice } from "./binance.js";
  import { genId } from "./storage.js";
  import { logger } from "../lib/logger.js";
  import type { StrategyName } from "./strategies.js";
  import type { FactorWeights } from "./storage.js";

  export interface ShadowPosition {
    id: string; symbol: string; direction: "LONG"|"SHORT";
    entryPrice: number; size: number; stopLoss: number;
    tp1: number; tp2: number; strategy: StrategyName;
    challengerWeights: FactorWeights; marketRegime: string; openedAt: string;
  }

  export async function openShadowPosition(
    symbol: string, direction: "LONG"|"SHORT",
    entryPrice: number, stopLoss: number, tp1: number, tp2: number,
    strategy: StrategyName, challengerWeights: FactorWeights, marketRegime: string,
    isDirectionShadow: boolean = false
  ): Promise<void> {
    const stopDist = Math.abs(entryPrice - stopLoss);
    if (stopDist <= 0) return;
    const size = 100 / stopDist;
    await pool.query(
      `INSERT INTO shadow_positions(id,symbol,direction,entry_price,size,stop_loss,tp1,tp2,strategy,challenger_weights,market_regime,opened_at,is_direction_shadow)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [genId(),symbol,direction,entryPrice,size,stopLoss,tp1,tp2,strategy,JSON.stringify(challengerWeights),marketRegime,new Date().toISOString(),isDirectionShadow]
    );
  }

  export async function checkShadowPositions(): Promise<void> {
    const {rows} = await pool.query("SELECT * FROM shadow_positions");
    if (!rows.length) return;
    // FIX: fetch all prices in parallel — sequential await getPrice() per position
    // caused rate-limit delays proportional to shadow position count.
    const positions = rows as Record<string,unknown>[];
    const uniqueSymbols = [...new Set(positions.map(r => r["symbol"] as string))];
    const priceMap = new Map<string, number>();
    await Promise.allSettled(
      uniqueSymbols.map(sym =>
        getPrice(sym).then(p => priceMap.set(sym, p)).catch(err => logger.debug({ err, sym }, "shadow price fetch failed"))
      )
    );
    for (const r of positions) {
      try {
        const pos = r as Record<string,unknown>;
        const price = priceMap.get(pos["symbol"] as string);
        if (price == null) continue; // price fetch failed for this symbol — skip
        const dir = pos["direction"] as "LONG"|"SHORT";
        const entry = Number(pos["entry_price"]);
        const sl = Number(pos["stop_loss"]);
        const tp1 = Number(pos["tp1"]);
        const tp2 = Number(pos["tp2"]);
        const size = Number(pos["size"]);
        let closeReason: string|null = null, closePrice = price;
        if (dir === "LONG") {
          if (price<=sl) { closeReason="SL"; closePrice=sl; }
          else if (price>=tp2) { closeReason="TP2"; closePrice=tp2; }
          else if (price>=tp1) { closeReason="TP1"; closePrice=tp1; }
        } else {
          if (price>=sl) { closeReason="SL"; closePrice=sl; }
          else if (price<=tp2) { closeReason="TP2"; closePrice=tp2; }
          else if (price<=tp1) { closeReason="TP1"; closePrice=tp1; }
        }
        if (closeReason) {
          const pnl = dir==="LONG" ? (closePrice-entry)*size : (entry-closePrice)*size;
          const pnlPct = dir==="LONG" ? ((closePrice-entry)/entry)*100 : ((entry-closePrice)/entry)*100;
          // pnl_equity_pct: portfolio-impact % using reference equity 10000.
          // Shadow positions risk $100/trade (size=100/stopDist), so referenceEquity=10000
          // gives consistent scale with paper_closed_trades (1% risk per trade baseline).
          const SHADOW_REF_EQUITY = 10000;
          const pnlEquityPct = (pnl / SHADOW_REF_EQUITY) * 100;
          await pool.query(
            `INSERT INTO shadow_closed_trades(id,symbol,direction,entry_price,close_price,pnl_percent,pnl_equity_pct,outcome,strategy,opened_at,closed_at,is_win,is_direction_shadow)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [genId(),pos["symbol"],dir,entry,closePrice,pnlPct,pnlEquityPct,closeReason,pos["strategy"],pos["opened_at"],new Date().toISOString(),pnl>0,Boolean(pos["is_direction_shadow"])]
          );
          await pool.query("DELETE FROM shadow_positions WHERE id=$1",[pos["id"]]);
        }
      } catch(err) { logger.debug({err},"shadow position check failed"); }
    }
  }

  export interface ShadowStats {
    trades: number; wins: number; winRate: number; profitFactor: number; totalPnl: number;
  }

  export async function getShadowStats(): Promise<ShadowStats> {
    // COALESCE: use pnl_equity_pct (portfolio-impact %) when available,
    // fall back to pnl_percent for legacy rows recorded before the column was added.
    // Mixing scales caused anomalous shadow PF (e.g. TREND SHORT showed 4.56).
    const {rows} = await pool.query(
      "SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl, is_win FROM shadow_closed_trades"
    );
    if (!rows.length) return {trades:0,wins:0,winRate:0,profitFactor:0,totalPnl:0};
    const trades=rows.length;
    const wins=(rows as Record<string,unknown>[]).filter(r=>Boolean(r["is_win"])).length;
    const winPnl=(rows as Record<string,unknown>[]).filter(r=>Boolean(r["is_win"])).reduce((a,r)=>a+Number(r["pnl"]),0);
    const lossPnl=Math.abs((rows as Record<string,unknown>[]).filter(r=>!Boolean(r["is_win"])).reduce((a,r)=>a+Number(r["pnl"]),0));
    return {trades,wins,winRate:wins/trades,profitFactor:lossPnl>0?winPnl/lossPnl:winPnl>0?99:0,totalPnl:winPnl-lossPnl};
  }

  // ── Entity Shadow Quarantine ─────────────────────────────────────────────
  // Когда entity в карантине, сигналы которые были бы отклонены — открываются
  // как shadow-позиции с тегом entity. Learning-engine проверяет эту статистику
  // и при хорошем PF/WR выводит entity из карантина без ожидания реальных сделок.

  export async function openEntityShadowPosition(
    entity: string,
    symbol: string, direction: "LONG"|"SHORT",
    entryPrice: number, stopLoss: number, tp1: number, tp2: number,
    strategy: StrategyName, challengerWeights: FactorWeights, marketRegime: string,
  ): Promise<void> {
    const stopDist = Math.abs(entryPrice - stopLoss);
    if (stopDist <= 0) return;
    const size = 100 / stopDist;
    await pool.query(
      `INSERT INTO shadow_positions(id,symbol,direction,entry_price,size,stop_loss,tp1,tp2,strategy,challenger_weights,market_regime,opened_at,is_direction_shadow,entity)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
      [genId(),symbol,direction,entryPrice,size,stopLoss,tp1,tp2,strategy,
       JSON.stringify(challengerWeights),marketRegime,new Date().toISOString(),false,entity]
    );
  }

  export interface EntityShadowStats {
    trades: number; wins: number; winRate: number; pf: number; totalPnl: number;
  }

  export async function getEntityShadowStats(entity: string): Promise<EntityShadowStats> {
    const {rows} = await pool.query(
      `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl, is_win
       FROM shadow_closed_trades WHERE entity=$1 ORDER BY closed_at DESC LIMIT 60`,
      [entity]
    );
    if (!rows.length) return {trades:0,wins:0,winRate:0,pf:0,totalPnl:0};
    const r = rows as Record<string,unknown>[];
    const trades = r.length;
    const wins = r.filter(x=>Boolean(x["is_win"])).length;
    const winPnl = r.filter(x=>Boolean(x["is_win"])).reduce((a,x)=>a+Number(x["pnl"]),0);
    const lossPnl = Math.abs(r.filter(x=>!Boolean(x["is_win"])).reduce((a,x)=>a+Number(x["pnl"]),0));
    return {
      trades, wins, winRate: wins/trades,
      pf: lossPnl > 0 ? winPnl/lossPnl : winPnl > 0 ? 99 : 0,
      totalPnl: winPnl - lossPnl,
    };
  }

  export async function compareShadowVsLive(livePF: number, liveWR: number): Promise<string|null> {
    const s = await getShadowStats();
    if (s.trades < 20) return null;
    if (s.profitFactor > livePF*1.1 && s.winRate > liveWR*1.05) {
      return `🧪 *Shadow Testing*: новая версия превосходит текущую\nPF ${s.profitFactor.toFixed(2)} vs ${livePF.toFixed(2)} | WR ${(s.winRate*100).toFixed(1)}% vs ${(liveWR*100).toFixed(1)}%\n✅ Готова к внедрению`;
    }
    return null;
  }
  