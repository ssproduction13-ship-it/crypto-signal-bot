import { pool } from "../lib/db.js";
  import { loadWeights, saveWeights, loadJournal, type FactorWeights } from "./storage.js";
  import { logger } from "../lib/logger.js";

  async function currentMetrics(): Promise<{wr:number;pf:number;n:number}> {
    const all = await loadJournal();
    const entries = all.filter(e=>e.closedAt).slice(-50);
    if (entries.length<5) return {wr:0,pf:0,n:entries.length};
    const wins   = entries.filter(e=>(e.pnlPercent??0)>0);
    const losses = entries.filter(e=>(e.pnlPercent??0)<=0);
    const gW = wins.reduce((a,e)=>a+(e.pnlPercent??0),0);
    const gL = Math.abs(losses.reduce((a,e)=>a+(e.pnlPercent??0),0));
    return {wr:(wins.length/entries.length*100),pf:gL>0?gW/gL:0,n:entries.length};
  }

  export async function snapshotStrategy(): Promise<void> {
    const w = await loadWeights();
    const {wr,pf,n} = await currentMetrics();
    if (n<20) return;
    const {rows:best} = await pool.query("SELECT * FROM strategy_versions WHERE is_best=true LIMIT 1");
    const bestPf = best.length ? Number((best[0] as Record<string,unknown>)["profit_factor"]) : 0;
    const isBetter = pf>bestPf || !best.length;
    if (isBetter) await pool.query("UPDATE strategy_versions SET is_best=false");
    await pool.query(
      "INSERT INTO strategy_versions(created_at,weights,win_rate,profit_factor,trade_count,is_best) VALUES($1,$2,$3,$4,$5,$6)",
      [new Date().toISOString(),JSON.stringify(w),wr,pf,n,isBetter]
    );
    if (isBetter) logger.info({pf,wr},"New best strategy snapshot saved");
  }

  export async function checkAndProtect(): Promise<string|null> {
    const {pf,n} = await currentMetrics();
    if (n<20) return null;
    const {rows:best} = await pool.query("SELECT * FROM strategy_versions WHERE is_best=true ORDER BY created_at DESC LIMIT 1");
    if (!best.length) { await snapshotStrategy(); return null; }
    const bestPf = Number((best[0] as Record<string,unknown>)["profit_factor"]);
    if (bestPf>0.5 && pf<bestPf*0.8) {
      const bestW = (best[0] as Record<string,unknown>)["weights"] as FactorWeights;
      await saveWeights(bestW);
      logger.warn({currentPf:pf,bestPf},"Strategy degraded — rolled back");
      return `🔄 *Защита стратегии*\nPF упал до ${pf.toFixed(2)} vs лучшего ${bestPf.toFixed(2)}.\nВеса откачены к лучшей версии.`;
    }
    if (pf>bestPf) await snapshotStrategy();
    return null;
  }

  export async function getStrategyStatus(): Promise<string> {
    const {wr,pf,n} = await currentMetrics();
    const {rows} = await pool.query("SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 5");
    const history = rows.map(r=>{
      const row=r as Record<string,unknown>;
      return `  ${(row["created_at"] as string).slice(0,10)}: PF ${Number(row["profit_factor"]).toFixed(2)} | WR ${Number(row["win_rate"]).toFixed(1)}% ${row["is_best"]?"⭐":""}`;
    });
    return [`🛡 *Защита стратегии*`,"",`Текущие метрики (послед. 50): PF ${pf.toFixed(2)} | WR ${wr.toFixed(1)}% | n=${n}`,"",
      `📜 *История:*`,...(history.length?history:["  нет снапшотов"])].join("\n");
  }
  