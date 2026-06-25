import { loadClosedTrades, loadWeights } from "./storage.js";
    import { getMissedStats } from "./missed-trades.js";
    import type { ClosedPaperTrade } from "./storage.js";

    function sharpe(returns: number[]) {
      if (returns.length<2) return 0;
      const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
      const std  = Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/(returns.length-1));
      return std===0 ? 0 : mean/std;
    }

    function maxDD(curve: number[]) {
      let peak=curve[0]??0, dd=0;
      for (const v of curve) { if(v>peak)peak=v; dd=Math.max(dd,peak>0?(peak-v)/peak*100:0); }
      return dd;
    }

    export async function buildSelfAnalysis(chatId?: number): Promise<string> {
      const closed = await loadClosedTrades(chatId);

      if (closed.length < 10)
        return `📊 *Самоанализ*\n\nЗакрытых сделок: ${closed.length} (нужно минимум 10).\n` +
               `Жди сигналов — бот учится на каждой сделке.`;

      const recent = closed.slice(0, 100);
      const wins   = recent.filter(e=>e.pnlPercent>0);
      const losses = recent.filter(e=>e.pnlPercent<=0);
      const wr     = (wins.length/recent.length*100);
      const avgW   = wins.length  ? wins.reduce((a,e)=>a+e.pnlPercent,0)/wins.length   : 0;
      const avgL   = losses.length? Math.abs(losses.reduce((a,e)=>a+e.pnlPercent,0)/losses.length): 0;
      const gW     = wins.reduce((a,e)=>a+e.pnlPercent,0);
      const gL     = Math.abs(losses.reduce((a,e)=>a+e.pnlPercent,0));
      const pf     = gL>0 ? gW/gL : gW>0 ? 999 : 0;
      // DB returns trades newest-first (ORDER BY closed_at DESC).
      // Time-series calcs (drawdown, Sharpe) need chronological order.
      const chronological = [...recent].reverse();
      const ret    = chronological.map(e=>e.pnlPercent);
      const sp     = sharpe(ret);

      let eq=1000; const curve=[1000];
      for (const r of ret) { eq*=(1+r/100); curve.push(eq); }
      const dd = maxDD(curve);
      const totalRet = ((curve[curve.length-1]!-1000)/1000*100);

      const bySym: Record<string,{w:number;t:number;pnl:number}> = {};
      for (const e of recent) {
        if(!bySym[e.symbol]) bySym[e.symbol]={w:0,t:0,pnl:0};
        bySym[e.symbol]!.t++; bySym[e.symbol]!.pnl+=e.pnlPercent;
        if(e.pnlPercent>0) bySym[e.symbol]!.w++;
      }
      const sorted = Object.entries(bySym).sort(([,a],[,b])=>b.pnl/b.t-a.pnl/a.t);
      const top3 = sorted.slice(0,3).map(([s,d])=>`  ${s}: WR ${(d.w/d.t*100).toFixed(0)}% | avg ${(d.pnl/d.t).toFixed(2)}%`);
      const bot3 = sorted.slice(-3).reverse().map(([s,d])=>`  ${s}: WR ${(d.w/d.t*100).toFixed(0)}% | avg ${(d.pnl/d.t).toFixed(2)}%`);

      const byStr: Record<string,{w:number;t:number;pnl:number}> = {};
      for (const e of recent) {
        const s = e.strategy ?? "TREND";
        if(!byStr[s]) byStr[s]={w:0,t:0,pnl:0};
        byStr[s]!.t++; byStr[s]!.pnl+=e.pnlPercent;
        if(e.pnlPercent>0) byStr[s]!.w++;
      }
      const stratLines = Object.entries(byStr)
        .sort(([,a],[,b])=>b.pnl/b.t-a.pnl/a.t)
        .map(([s,d])=>`  ${s}: ${d.t} сд. | WR ${(d.w/d.t*100).toFixed(0)}% | avg ${(d.pnl/d.t).toFixed(2)}%`);

      const weights = await loadWeights();
      const recs: string[] = [];
      if (wr<45)         recs.push("• Повысь мин. оценку: /settings minScore 75");
      if (pf<1.2)        recs.push("• Плохой PF — улучши R/R управление стопом");
      if (dd>15)         recs.push("• Большая просадка — снизь риск: /settings risk 0.5");
      if (sp<0.5)        recs.push("• Низкий Шарп — много убыточных серий подряд");
      if (wr>55&&pf>1.5) recs.push("• Отличные результаты! Можно повысить риск: /settings risk 1.5");

      const criteria = [
        {ok:closed.length>=1000, label:`Сделок: ${closed.length}/1000`},
        {ok:pf>=1.5,             label:`PF: ${pf===999?"∞":pf.toFixed(2)} (≥1.5)`},
        {ok:wr>=50,              label:`WR: ${wr.toFixed(1)}% (≥50%)`},
        {ok:dd<10,               label:`Просадка: ${dd.toFixed(1)}% (<10%)`},
      ];

      const missedStats = await getMissedStats();

      return [
        `📊 *Самоанализ (последние ${recent.length} из ${closed.length} сделок)*`, "",
        `WR: *${wr.toFixed(1)}%* | PF: *${pf===999?"∞":pf.toFixed(2)}*`,
        `Win avg: +${avgW.toFixed(2)}% | Loss avg: -${avgL.toFixed(2)}%`,
        `Шарп: ${sp.toFixed(2)} | Просадка: ${dd.toFixed(1)}%`,
        `Доходность: ${totalRet>=0?"+":""}${totalRet.toFixed(2)}%`, "",
        `🏆 *Лучшие пары:*`, ...top3, "",
        `⚠️ *Слабые пары:*`,  ...bot3, "",
        `📐 *По стратегиям:*`, ...stratLines, "",
        `🧠 Веса: тренд ${(weights.trend*100).toFixed(0)}% | объём ${(weights.volume*100).toFixed(0)}% | импульс ${(weights.momentum*100).toFixed(0)}%`, "",
        ...(recs.length ? [`💡 *Рекомендации:*`, ...recs, ""] : []),
        `🎯 *Критерии реальной торговли (${criteria.filter(c=>c.ok).length}/4):*`,
        ...criteria.map(c=>`  ${c.ok?"✅":"❌"} ${c.label}`), "",
        missedStats,
      ].join("\n");
    }
  