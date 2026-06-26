import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";
  import type { StrategyName } from "./strategies.js";
  import type { MarketCondition } from "./chaos-filter.js";
  import type { MarketRating } from "./market-rating.js";

  export type MarketRegime = "trend_up"|"trend_down"|"sideways"|"high_vol"|"low_vol";

  export function detectMarketRegime(market: MarketCondition, rating: MarketRating): MarketRegime {
    if ((market.atrPercent ?? 0) > 3.5 && !market.isSideways) return "high_vol";
    if (market.isLowVolume && (market.atrPercent ?? 1) < 0.8) return "low_vol";
    if (market.isSideways) return "sideways";
    if (rating.state === "strong_growth" || rating.state === "moderate_growth") return "trend_up";
    if (rating.state === "decline") return "trend_down";
    return "sideways";
  }

  export async function recordRegimeTrade(
    strategy: StrategyName, regime: MarketRegime, pnlPercent: number, isWin: boolean
  ): Promise<void> {
    await pool.query(
      `INSERT INTO strategy_regime_stats(strategy,regime,trades,wins,win_pnl,loss_pnl,total_pnl)
       VALUES($1,$2,1,$3,$4,$5,$6)
       ON CONFLICT(strategy,regime) DO UPDATE SET
         trades=strategy_regime_stats.trades+1,
         wins=strategy_regime_stats.wins+$3,
         win_pnl=strategy_regime_stats.win_pnl+$4,
         loss_pnl=strategy_regime_stats.loss_pnl+$5,
         total_pnl=strategy_regime_stats.total_pnl+$6`,
      [strategy,regime,isWin?1:0,isWin?Math.abs(pnlPercent):0,isWin?0:Math.abs(pnlPercent),pnlPercent]
    );
  }

  export async function isStrategyBlockedInRegime(
    strategy: StrategyName, regime: MarketRegime
  ): Promise<{blocked:boolean;reason:string}> {
    const {rows} = await pool.query(
      "SELECT trades,wins,win_pnl,loss_pnl FROM strategy_regime_stats WHERE strategy=$1 AND regime=$2",
      [strategy,regime]
    );
    if (!rows.length) return {blocked:false,reason:""};
    const r = rows[0] as Record<string,unknown>;
    const trades=Number(r["trades"]),wins=Number(r["wins"]);
    const winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
    if (trades<10) return {blocked:false,reason:""};
    const pf = lossPnl>0 ? winPnl/lossPnl : winPnl>0 ? 99 : 0;
    const wr = wins/trades;
    if (pf<0.7 && wr<0.38) {
      const regimeLabel:Record<string,string>={trend_up:"восходящий тренд",trend_down:"нисходящий тренд",sideways:"боковик",high_vol:"высокая волатильность",low_vol:"затишье"};
      return {blocked:true,reason:`${strategy} убыточна в режиме "${regimeLabel[regime]??regime}" (PF ${pf.toFixed(2)}, WR ${(wr*100).toFixed(0)}%)`};
    }
    return {blocked:false,reason:""};
  }

  export async function loadStrategyWeights(): Promise<Record<StrategyName,number>> {
    const {rows} = await pool.query("SELECT strategy,weight,disabled,disabled_until FROM strategy_weights");
    const weights:Record<string,number>={TREND:1,BREAKOUT:1,VOLUME_IMPULSE:1,MEAN_REVERSION:1};
    const now = new Date().toISOString();
    for (const r of rows as Record<string,unknown>[]) {
      const strat=r["strategy"] as string;
      let w=Number(r["weight"]);
      const disabled=Boolean(r["disabled"]);
      const until=r["disabled_until"] as string|null;
      if (disabled && until && until>now) { w=0; }
      else if (disabled && (!until||until<=now)) {
        await pool.query("UPDATE strategy_weights SET disabled=false,disabled_until=NULL WHERE strategy=$1",[strat]);
      }
      weights[strat]=w;
    }
    return weights as Record<StrategyName,number>;
  }

  export async function runAdaptationCycle(chatIds:Set<number>): Promise<string> {
    const {rows:statRows} = await pool.query("SELECT strategy,trades,wins,win_pnl,loss_pnl,total_pnl FROM strategy_stats");
    const {rows:wRows} = await pool.query("SELECT strategy,weight,cycles_below_threshold FROM strategy_weights");
    const curW:Record<string,{weight:number;cycles:number}>={};
    for (const r of wRows as Record<string,unknown>[])
      curW[r["strategy"] as string]={weight:Number(r["weight"]),cycles:Number(r["cycles_below_threshold"])};

    const MAX_CHANGE=0.05, MIN_W=0.3, MAX_W=1.5;
    const changes:string[]=[];

    for (const r of statRows as Record<string,unknown>[]) {
      const strat=r["strategy"] as string;
      const trades=Number(r["trades"]);
      if (trades<20) continue;
      const wins=Number(r["wins"]);
      const winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
      const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
      const wr=wins/trades;
      const cur=curW[strat]??{weight:1,cycles:0};
      let newW=cur.weight, newC=cur.cycles, disabled=false, until:string|null=null;

      if (pf>=1.5&&wr>=0.5) {
        newW=Math.min(MAX_W,cur.weight+MAX_CHANGE); newC=0;
        if (newW>cur.weight+0.001) changes.push(`📈 ${strat}: вес +5% (PF ${pf.toFixed(2)})`);
      } else if (pf<0.8||wr<0.35) {
        newW=Math.max(MIN_W,cur.weight-MAX_CHANGE); newC=cur.cycles+1;
        if (cur.weight-newW>0.001) changes.push(`📉 ${strat}: вес -5% (PF ${pf.toFixed(2)})`);
        if (newC>=3) {
          disabled=true; newC=0;
          until=new Date(Date.now()+24*3600000).toISOString();
          changes.push(`🚫 ${strat}: отключена на 24ч (3 цикла ниже порога)`);
        }
      } else {
        newW=cur.weight>1?Math.max(1,cur.weight-0.01):Math.min(1,cur.weight+0.01);
        newC=Math.max(0,cur.cycles-1);
      }
      await pool.query(
        "UPDATE strategy_weights SET weight=$2,disabled=$3,disabled_until=$4,cycles_below_threshold=$5,updated_at=$6 WHERE strategy=$1",
        [strat,newW,disabled,until,newC,new Date().toISOString()]
      );
    }
    return changes.length>0 ? changes.join("\n") : "Изменений нет — все стратегии в норме";
  }

  export async function getClosedTradeCount(): Promise<number> {
    const {rows} = await pool.query("SELECT COUNT(*) as cnt FROM paper_closed_trades");
    return Number((rows[0] as Record<string,unknown>)["cnt"]);
  }

  async function getVersionCounter(): Promise<string> {
    const {rows} = await pool.query("SELECT COUNT(*) as cnt FROM strategy_versions");
    const n=Number((rows[0] as Record<string,unknown>)["cnt"])+1;
    return `v1.${n}`;
  }

  export async function snapshotStrategyVersion(changes:string): Promise<void> {
    const {rows:wRows} = await pool.query("SELECT * FROM factor_weights WHERE id=1");
    const weights=wRows.length ? wRows[0] as Record<string,unknown> : {};
    const {rows:statsRows} = await pool.query(
      "SELECT pnl_percent FROM paper_closed_trades WHERE pnl_percent IS NOT NULL ORDER BY closed_at DESC LIMIT 100"
    );
    const pnls=statsRows.map(r=>Number((r as Record<string,unknown>)["pnl_percent"]));
    const wins=pnls.filter(p=>p>0);
    const losses=pnls.filter(p=>p<=0);
    const wr=pnls.length?wins.length/pnls.length*100:0;
    const winPnl=wins.reduce((a,b)=>a+b,0);
    const lossPnl=Math.abs(losses.reduce((a,b)=>a+b,0));
    const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
    const mean=pnls.length?pnls.reduce((a,b)=>a+b,0)/pnls.length:0;
    const std=pnls.length>1?Math.sqrt(pnls.reduce((a,b)=>a+(b-mean)**2,0)/(pnls.length-1)):0;
    const sharpe=std>0?mean/std:0;
    let eq=100; const curve=[100];
    for (const p of [...pnls].reverse()) { eq*=(1+p/100); curve.push(eq); }
    let peak=curve[0]??100, dd=0;
    for (const v of curve) { if(v>peak)peak=v; dd=Math.max(dd,peak>0?(peak-v)/peak*100:0); }
    const rf=dd>0?((eq-100)/dd):0;
    const label=await getVersionCounter();

    await pool.query("UPDATE strategy_versions SET is_best=false WHERE is_best=true");
    await pool.query(
      `INSERT INTO strategy_versions(created_at,weights,win_rate,profit_factor,trade_count,is_best,version_label,total_return,max_drawdown,sharpe_ratio,recovery_factor,notes)
       VALUES($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11)`,
      [new Date().toISOString(),JSON.stringify(weights),wr,pf,pnls.length,label,eq-100,dd,sharpe,rf,changes]
    );
    // Keep only last 10 versions
    const {rows:all} = await pool.query("SELECT id FROM strategy_versions ORDER BY created_at DESC OFFSET 10");
    for (const r of all as Record<string,unknown>[])
      await pool.query("DELETE FROM strategy_versions WHERE id=$1",[r["id"]]);
    logger.info({label,pf,wr,sharpe},"Strategy version snapshot saved");
  }

  export async function checkAndRollback(): Promise<string|null> {
    const {rows} = await pool.query(
      "SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 2"
    );
    if (rows.length<2) return null;
    const cur=rows[0] as Record<string,unknown>;
    const prev=rows[1] as Record<string,unknown>;
    const curPF=Number(cur["profit_factor"]);
    const prevPF=Number(prev["profit_factor"]);
    if (prevPF>0.5 && curPF<prevPF*0.8) {
      const bestWeights=(prev["weights"] as Record<string,unknown>);
      await pool.query(
        "UPDATE factor_weights SET trend=$1,volume=$2,momentum=$3,levels=$4,pattern=$5 WHERE id=1",
        [bestWeights["trend"],bestWeights["volume"],bestWeights["momentum"],bestWeights["levels"],bestWeights["pattern"]]
      );
      logger.warn({curPF,prevPF},"Strategy rolled back to previous version");
      return `🔄 *Откат стратегии*
Текущий PF ${curPF.toFixed(2)} хуже предыдущего ${prevPF.toFixed(2)} на >20%.
Восстановлена версия ${cur["version_label"]??prev["version_label"]}.`;
    }
    return null;
  }

  export async function generateLearningReport(): Promise<string> {
    const tradeCount=await getClosedTradeCount();
    const {rows:statRows} = await pool.query("SELECT * FROM strategy_stats");
    const {rows:wRows} = await pool.query("SELECT strategy,weight,disabled FROM strategy_weights");
    const {rows:vRows} = await pool.query("SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 2");

    const stratLines:string[]=[];
    for (const r of statRows as Record<string,unknown>[]) {
      const strat=r["strategy"] as string;
      const trades=Number(r["trades"]);
      if (trades<5) continue;
      const wins=Number(r["wins"]);
      const winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
      const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
      const wr=(wins/trades*100).toFixed(1);
      const wRow=wRows.find(w=>(w as Record<string,unknown>)["strategy"]===strat) as Record<string,unknown>|undefined;
      const weight=wRow?Number(wRow["weight"]):1;
      const dis=wRow?Boolean(wRow["disabled"]):false;
      const icon=dis?"🚫":weight>=1.3?"🔥":weight<=0.5?"⚠️":"✅";
      stratLines.push(`${icon} ${strat}: WR ${wr}% | PF ${pf===99?"∞":pf.toFixed(2)} | Вес ${(weight*100).toFixed(0)}%`);
    }

    let vLine="";
    if (vRows.length>=2) {
      const c=vRows[0] as Record<string,unknown>, p=vRows[1] as Record<string,unknown>;
      const diff=Number(c["profit_factor"])-Number(p["profit_factor"]);
      vLine=`\n📊 ${p["version_label"]}→${c["version_label"]}: PF ${Number(p["profit_factor"]).toFixed(2)}→${Number(c["profit_factor"]).toFixed(2)} (${diff>=0?"+":""}${diff.toFixed(2)})`;
    }

    const reportLabel=`v${Math.floor(tradeCount/100)}.${tradeCount%100<50?0:5}`;
    const summary=[`🧠 *AI Learning Report — ${reportLabel}*`,`📊 Сделок: ${tradeCount}`,"",`📐 *Стратегии:*`,...stratLines,vLine].filter(Boolean).join("\n");

    await pool.query(
      "INSERT INTO learning_reports(version_label,created_at,trade_count_at_report,summary,report_json) VALUES($1,$2,$3,$4,$5)",
      [reportLabel,new Date().toISOString(),tradeCount,summary,JSON.stringify({strategies:stratLines,tradeCount})]
    );
    return summary;
  }

  export async function getLearningHistory(): Promise<string> {
    const {rows:vRows} = await pool.query("SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 10");
    const {rows:rRows} = await pool.query("SELECT version_label,created_at,summary FROM learning_reports ORDER BY created_at DESC LIMIT 3");
    const {rows:regRows} = await pool.query("SELECT strategy,regime,trades,wins,win_pnl,loss_pnl FROM strategy_regime_stats");

    if (!vRows.length) return "📚 *История обучения*\n\nДанных пока нет — нужно минимум 20 сделок для первого снапшота.";

    const vLines=vRows.map(r=>{
      const row=r as Record<string,unknown>;
      const label=(row["version_label"] as string)??"—";
      const pf=Number(row["profit_factor"]);
      const wr=Number(row["win_rate"]);
      const n=Number(row["trade_count"]);
      const best=Boolean(row["is_best"]);
      const date=(row["created_at"] as string).slice(0,10);
      const dd=Number(row["max_drawdown"]);
      return `${best?"⭐":"  "} ${label} [${date}] PF ${pf.toFixed(2)} | WR ${wr.toFixed(1)}% | n=${n} | DD ${dd.toFixed(1)}%`;
    });

    const regByStrat:Record<string,string[]>={};
    const REGIME_LABEL:Record<string,string>={trend_up:"📈↑",trend_down:"📉↓",sideways:"↔️",high_vol:"⚡",low_vol:"😴"};
    for (const r of regRows as Record<string,unknown>[]) {
      const strat=r["strategy"] as string;
      const trades=Number(r["trades"]);
      if (trades<5) continue;
      const wins=Number(r["wins"]),winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
      const pf=lossPnl>0?winPnl/lossPnl:99;
      const wr=(wins/trades*100).toFixed(0);
      const regime=r["regime"] as string;
      if(!regByStrat[strat]) regByStrat[strat]=[];
      regByStrat[strat]!.push(`  ${REGIME_LABEL[regime]??regime}: PF ${pf===99?"∞":pf.toFixed(2)} WR${wr}% n=${trades}`);
    }
    const regLines:string[]=[];
    for (const [s,lines] of Object.entries(regByStrat)) { regLines.push(`*${s}:*`,...lines); }

    const lastReports=rRows.length ? ["","📋 *Последние отчёты:*",...rRows.map(r=>(r as Record<string,unknown>)["version_label"] as string)] : [];

    return ["📚 *История обучения AI*","","🔖 *Версии стратегии:*",...vLines,
      ...(regLines.length?["","🌍 *По режиму рынка:*",...regLines]:[]),
      ...lastReports].join("\n");
  }
  