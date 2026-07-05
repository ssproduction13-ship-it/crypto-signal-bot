import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";

  export async function recordTimeTrade(openedAt: string, pnlPercent: number, isWin: boolean): Promise<void> {
    try {
      const d = new Date(openedAt);
      // Use UTC methods: local timezone varies by Railway region → all historical
      // hour/dow buckets must be on a single deterministic clock (UTC).
      const hour = d.getUTCHours();
      const dow = (d.getUTCDay()+6)%7; // 0=Mon…6=Sun (UTC)
      await pool.query(
        `INSERT INTO time_analytics(hour_of_day,day_of_week,trades,wins,win_pnl,loss_pnl,total_pnl)
         VALUES($1,$2,1,$3,$4,$5,$6)
         ON CONFLICT(hour_of_day,day_of_week) DO UPDATE SET
           trades=time_analytics.trades+1,
           wins=time_analytics.wins+$3,
           win_pnl=time_analytics.win_pnl+$4,
           loss_pnl=time_analytics.loss_pnl+$5,
           total_pnl=time_analytics.total_pnl+$6`,
        [hour,dow,isWin?1:0,isWin?Math.abs(pnlPercent):0,isWin?0:Math.abs(pnlPercent),pnlPercent]
      );
    } catch(err) { logger.debug({err},"recordTimeTrade failed"); }
  }

  // Принудительная блокировка ночных часов 00:00-05:59 UTC.
  // Найдено AI Deep Analysis: PF 0.19-0.70 в этом окне, убыточная серия 03-05 июля 2026
  // спровоцировала карантин стратегий через rolling adaptation window. Держать до
  // накопления новой статистики и явного решения снять ограничение.
  const FORCED_BLOCKED_HOURS = new Set([0, 1, 2, 3, 4, 5]);

  export async function isTimeRestricted(hour: number, dow: number): Promise<{restricted:boolean;reason:string;sizeMultiplier:number}> {
    if (FORCED_BLOCKED_HOURS.has(hour)) {
      return {
        restricted: true,
        reason: `Принудительная блокировка: ${String(hour).padStart(2,"0")}:00 UTC (ночной шок 03-05.07, PF 0.19-0.70)`,
        sizeMultiplier: 0,
      };
    }
    const {rows} = await pool.query(
      "SELECT trades,wins,win_pnl,loss_pnl FROM time_analytics WHERE hour_of_day=$1 AND day_of_week=$2",
      [hour,dow]
    );
    if (!rows.length) return {restricted:false,reason:"",sizeMultiplier:1.0};
    const r=rows[0] as Record<string,unknown>;
    const trades=Number(r["trades"]);
    if (trades<5) return {restricted:false,reason:"",sizeMultiplier:1.0};
    const wins=Number(r["wins"]),winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
    const wr=wins/trades;
    const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
    const DOW=["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
    if ((wr<0.35&&pf<0.7)||(wr<0.45&&pf<0.5)) {
      return {restricted:true,reason:`Убыточное время: ${String(hour).padStart(2,"0")}:00 ${DOW[dow]??""} (WR ${(wr*100).toFixed(0)}%, PF ${pf.toFixed(2)})`,sizeMultiplier:0};
    }
    if (wr<0.50&&pf<0.75&&trades>=15) {
      return {restricted:false,reason:"",sizeMultiplier:0.5};
    }
    return {restricted:false,reason:"",sizeMultiplier:1.0};
  }

  export async function getTimeAnalytics(): Promise<string> {
    const {rows} = await pool.query(
      "SELECT hour_of_day,day_of_week,trades,wins,win_pnl,loss_pnl,total_pnl FROM time_analytics WHERE trades>=3"
    );
    if (!rows.length) return "⏰ *Аналитика по времени*\n\nНедостаточно данных (нужно ≥3 сделок в каждом слоте).";

    const byHour:Record<number,{trades:number;wins:number;pnl:number}>={};
    const byDow:Record<number,{trades:number;wins:number;pnl:number}>={};
    for (const r of rows as Record<string,unknown>[]) {
      const h=Number(r["hour_of_day"]),d=Number(r["day_of_week"]);
      const t=Number(r["trades"]),w=Number(r["wins"]),p=Number(r["total_pnl"]);
      if(!byHour[h]) byHour[h]={trades:0,wins:0,pnl:0};
      if(!byDow[d]) byDow[d]={trades:0,wins:0,pnl:0};
      byHour[h]!.trades+=t; byHour[h]!.wins+=w; byHour[h]!.pnl+=p;
      byDow[d]!.trades+=t; byDow[d]!.wins+=w; byDow[d]!.pnl+=p;
    }

    const hourArr=Object.entries(byHour).filter(([,v])=>v.trades>=3)
      .map(([h,v])=>({hour:Number(h),wr:v.wins/v.trades,pnl:v.pnl,t:v.trades}))
      .sort((a,b)=>b.wr-a.wr);
    const DOW=["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
    const dowArr=Object.entries(byDow).filter(([,v])=>v.trades>=3)
      .map(([d,v])=>({dow:Number(d),wr:v.wins/v.trades,pnl:v.pnl,t:v.trades}))
      .sort((a,b)=>b.wr-a.wr);

    const fmt=(h:number,wr:number,t:number)=>`  ${String(h).padStart(2,"0")}:00 — WR ${(wr*100).toFixed(0)}% | n=${t}`;
    return ["⏰ *Аналитика по времени*","",
      "🏆 *Лучшие часы:*",...hourArr.slice(0,3).map(x=>fmt(x.hour,x.wr,x.t)),"",
      "⚠️ *Худшие часы:*",...hourArr.slice(-3).reverse().map(x=>fmt(x.hour,x.wr,x.t)),"",
      "📅 *Лучшие дни:*",...dowArr.slice(0,3).map(x=>`  ${DOW[x.dow]??x.dow} — WR ${(x.wr*100).toFixed(0)}% | n=${x.t}`)
    ].join("\n");
  }
  