/**
 * full-report.ts — Extended Full Report (16 sections per ТЗ)
 * All sections computed from existing DB tables where data is available.
 */
import { pool }                               from "../lib/db.js";
import { logger }                             from "../lib/logger.js";
import { loadPaperAccount }                   from "./storage.js";
import type { ClosedPaperTrade, PaperPosition } from "./storage.js";
import { calcReadinessIndex }                 from "./readiness-index.js";
import { checkLearningHealth, healthLabel }   from "./health-monitor.js";

type StrategyName = "TREND" | "BREAKOUT" | "VOLUME_IMPULSE" | "MEAN_REVERSION";
const STRATS: StrategyName[] = ["TREND", "BREAKOUT", "VOLUME_IMPULSE", "MEAN_REVERSION"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function calcPF(ts: ClosedPaperTrade[]): number {
  const gW = ts.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gL = Math.abs(ts.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  return gL > 0 ? gW / gL : gW > 0 ? 999 : 0;
}
function calcWR(ts: ClosedPaperTrade[]): number {
  return ts.length ? ts.filter(t => t.pnl > 0).length / ts.length : 0;
}
function calcStreaks(ts: ClosedPaperTrade[]): { maxWin: number; maxLoss: number; curType: "win"|"loss"|null; curLen: number } {
  let maxWin = 0, maxLoss = 0, cur = 0, curType: "win"|"loss"|null = null;
  for (const t of ts) {
    const type: "win"|"loss" = t.pnl > 0 ? "win" : "loss";
    cur = type === curType ? cur + 1 : 1;
    curType = type;
    if (type === "win" && cur > maxWin) maxWin = cur;
    if (type === "loss" && cur > maxLoss) maxLoss = cur;
  }
  return { maxWin, maxLoss, curType, curLen: cur };
}
function sharpeRatio(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const std  = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1));
  return std === 0 ? 0 : (mean / std) * Math.sqrt(252);
}
function sqnScore(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const std  = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1));
  return std === 0 ? 0 : (mean / std) * Math.sqrt(pnls.length);
}
function maxDD(pnls: number[]): number {
  let peak = 0, eq = 0, dd = 0;
  for (const p of pnls) {
    eq += p;
    if (eq > peak) peak = eq;
    const cur = peak > 0 ? (peak - eq) / peak * 100 : 0;
    if (cur > dd) dd = cur;
  }
  return dd;
}
function medianVal(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m]! : ((s[m - 1]! + s[m]!) / 2);
}
function durMin(t: ClosedPaperTrade): number {
  return (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 60000;
}
function fmtDur(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}
function fmtPF(pf: number): string { return pf >= 999 ? "∞" : pf.toFixed(2); }
function fmtS(n: number, d = 2): string { return (n >= 0 ? "+" : "") + n.toFixed(d); }
function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateFullReport(chatId: number): Promise<string[]> {
  const now = new Date();
  const ts  = now.toISOString().slice(0, 16).replace("T", " ");

  // ── Fetch all data in parallel ────────────────────────────────────────────
  const [account, health, readiness] = await Promise.all([
    loadPaperAccount(chatId),
    checkLearningHealth(chatId).catch(() => null),
    calcReadinessIndex(chatId).catch(() => null),
  ]);

  const [stratStatRows, stratWRows, regRows, timeRows, coinRows, adaptRows, quarRows,
         versionRows, histRows, firstRow] = await Promise.all([
    pool.query("SELECT * FROM strategy_stats"),
    pool.query("SELECT strategy,weight,disabled,quarantine,trust_score FROM strategy_weights"),
    pool.query(`SELECT regime, SUM(trades) t, SUM(wins) w, SUM(win_pnl) wp, SUM(loss_pnl) lp, SUM(total_pnl) tp
                FROM strategy_regime_stats GROUP BY regime HAVING SUM(trades)>=3`),
    pool.query("SELECT hour_of_day, day_of_week, trades, wins, win_pnl, loss_pnl, total_pnl FROM time_analytics WHERE trades>=3"),
    pool.query(`SELECT symbol, COUNT(*) trades, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) wins,
                       SUM(CASE WHEN pnl>0 THEN pnl ELSE 0 END) win_pnl,
                       SUM(CASE WHEN pnl<=0 THEN ABS(pnl) ELSE 0 END) loss_pnl, SUM(pnl) total_pnl
                FROM paper_closed_trades WHERE chat_id=$1 GROUP BY symbol`, [chatId]),
    pool.query("SELECT COUNT(*) cnt, MAX(changed_at) last FROM strategy_history"),
    pool.query("SELECT strategy FROM strategy_weights WHERE quarantine=true"),
    pool.query("SELECT version_label,profit_factor,created_at FROM strategy_versions ORDER BY created_at DESC LIMIT 2"),
    pool.query(`SELECT strategy, MAX(changed_at) last_adapt,
                       SUM(CASE WHEN changed_at > NOW()-INTERVAL '7 days' THEN new_weight-prev_weight ELSE 0 END) week_delta
                FROM strategy_history GROUP BY strategy`),
    pool.query("SELECT MIN(opened_at) first FROM paper_closed_trades WHERE chat_id=$1", [chatId]),
  ]).catch(err => { logger.warn({err}, "full-report DB query error"); throw err; });

  // ── Base calculations ─────────────────────────────────────────────────────
  const allTrades = account.closedTrades.slice().sort((a, b) =>
    new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()
  );
  const wins   = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const pnls   = allTrades.map(t => t.pnl);
  const last30  = allTrades.slice(-30);
  const last100 = allTrades.slice(-100);

  const gW = wins.reduce((s, t) => s + t.pnl, 0);
  const gL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pfAll  = calcPF(allTrades), pf30 = calcPF(last30), pf100 = calcPF(last100);
  const wrAll  = calcWR(allTrades), wr30 = calcWR(last30), wr100 = calcWR(last100);
  const avgWin  = wins.length   ? gW / wins.length   : 0;
  const avgLoss = losses.length ? gL / losses.length : 0;
  const avgRR   = avgLoss > 0 ? avgWin / avgLoss : 0;
  const expectDollar = wrAll * avgWin - (1 - wrAll) * avgLoss;
  const expectPct    = allTrades.length ? allTrades.reduce((s, t) => s + t.pnlPercent, 0) / allTrades.length : 0;
  const durations    = allTrades.map(t => durMin(t));
  const avgDur   = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const medDur   = medianVal(durations);
  const streaks  = calcStreaks(allTrades);
  const pnlTotal = account.balance - account.initialBalance;
  const retPct   = account.initialBalance > 0 ? pnlTotal / account.initialBalance * 100 : 0;

  const todayStart  = new Date(now); todayStart.setHours(0,0,0,0);
  const weekStart   = new Date(todayStart); weekStart.setDate(todayStart.getDate() - ((todayStart.getDay()+6)%7));
  const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1);
  const pnlD = allTrades.filter(t => new Date(t.closedAt) >= todayStart).reduce((a, t) => a+t.pnl, 0);
  const pnlW = allTrades.filter(t => new Date(t.closedAt) >= weekStart ).reduce((a, t) => a+t.pnl, 0);
  const pnlM = allTrades.filter(t => new Date(t.closedAt) >= monthStart).reduce((a, t) => a+t.pnl, 0);

  // ── Equity calculations ───────────────────────────────────────────────────
  const equityHigh  = Math.max(account.peakBalance ?? account.balance, account.balance);
  const currentDDpct = equityHigh > 0 ? ((equityHigh - account.balance) / equityHigh) * 100 : 0;
  const maxDDpct    = maxDD(pnls);
  const recovFactor = maxDDpct > 0 ? retPct / maxDDpct : 0;
  const firstDate   = (firstRow.rows[0] as Record<string,unknown>)?.["first"] as string|null;
  const daysSince   = firstDate ? (now.getTime() - new Date(firstDate).getTime()) / (1000*3600*24) : 0;
  const annualRet   = daysSince > 7 ? retPct * (365 / daysSince) : 0;
  const calmarR     = maxDDpct > 0 ? annualRet / maxDDpct : 0;
  const sharpe      = sharpeRatio(pnls);
  const sqn         = sqnScore(pnls);
  const sqnLabel    = sqn >= 7 ? " (Превосходно)" : sqn >= 5 ? " (Отлично)" : sqn >= 3 ? " (Хорошо)" : sqn >= 2 ? " (Выше среднего)" : sqn >= 1 ? " (Торгуемо)" : sqn > 0 ? " (Слабо)" : " (Убыточно)";

  // ── Parts builder ─────────────────────────────────────────────────────────
  const parts: string[] = [];

  // ─ HEADER ─
  parts.push(
    `📋 ПОЛНЫЙ ОТЧЁТ AI-ТРЕЙДЕРА`,
    `Дата: ${ts} UTC | Режим: Paper Trading`,
    ``,
  );

  // ─ SECTION 1: Общая статистика ─
  parts.push(
    `═══ 💰 СЧЁТ ═══`,
    `Начальный депозит: $${account.initialBalance.toFixed(2)}`,
    `Текущий баланс:    $${account.balance.toFixed(2)}`,
    `Общий P&L:         ${fmtS(retPct)}% ($${fmtS(pnlTotal)})`,
    `Equity High:       $${equityHigh.toFixed(2)}`,
    `Сегодня: ${fmtS(pnlD)}$ | Неделя: ${fmtS(pnlW)}$ | Месяц: ${fmtS(pnlM)}$`,
    ``,
    `═══ 📊 СТАТИСТИКА СДЕЛОК ═══`,
    `Всего:            ${allTrades.length}`,
    `Прибыльных:       ${wins.length} (${(wrAll*100).toFixed(1)}%)`,
    `Убыточных:        ${losses.length} (${allTrades.length ? ((losses.length/allTrades.length)*100).toFixed(1) : 0}%)`,
    ``,
    `Profit Factor:`,
    `  Все:            ${fmtPF(pfAll)}`,
    `  Посл. 100:      ${last100.length>=10 ? fmtPF(pf100) : "мало данных"}`,
    `  Посл. 30:       ${last30.length>=10 ? fmtPF(pf30) : "мало данных"}`,
    ``,
    `Win Rate:`,
    `  Все:            ${(wrAll*100).toFixed(1)}%`,
    `  Посл. 100:      ${last100.length>=10 ? (wr100*100).toFixed(1)+"%" : "мало данных"}`,
    `  Посл. 30:       ${last30.length>=10 ? (wr30*100).toFixed(1)+"%" : "мало данных"}`,
    ``,
    `Gross Profit:     +$${gW.toFixed(2)}`,
    `Gross Loss:        -$${gL.toFixed(2)}`,
    `Сред. прибыль:    +$${avgWin.toFixed(2)}`,
    `Сред. убыток:      -$${avgLoss.toFixed(2)}`,
    `Сред. RR:          ${avgRR.toFixed(2)}`,
    `Expectancy($):    ${fmtS(expectDollar)}`,
    `Expectancy(%):    ${fmtS(expectPct, 3)}%`,
    ``,
    `Сред. длительность:   ${fmtDur(avgDur)}`,
    `Медианная дл.:        ${fmtDur(medDur)}`,
    ``,
    `Макс. побед подряд:   ${streaks.maxWin}`,
    `Макс. убытков подряд: ${streaks.maxLoss}`,
    `Текущая серия:        ${streaks.curLen} ${streaks.curType==="win"?"побед":streaks.curType==="loss"?"убытков":"—"}`,
    ``,
  );

  // ─ SECTION 2: Equity ─
  parts.push(
    `═══ 📈 EQUITY ═══`,
    `Текущая просадка: ${currentDDpct.toFixed(2)}%`,
    `Макс. просадка:   ${maxDDpct.toFixed(2)}%`,
    `Recovery Factor:  ${recovFactor.toFixed(2)}`,
    `Calmar Ratio:     ${calmarR.toFixed(2)}`,
    `Sharpe Ratio:     ${sharpe.toFixed(2)}`,
    `SQN:              ${sqn.toFixed(2)}${sqnLabel}`,
    ``,
  );

  // ─ SECTION 3: Стратегии ─
  const ss  = stratStatRows.rows as Record<string,unknown>[];
  const sw  = stratWRows.rows   as Record<string,unknown>[];
  const sh  = histRows.rows     as Record<string,unknown>[];

  parts.push(`═══ 🏆 СТРАТЕГИИ ═══`);
  for (const strat of STRATS) {
    const s = ss.find(r => r["strategy"] === strat);
    const w = sw.find(r => r["strategy"] === strat);
    const h = sh.find(r => r["strategy"] === strat);
    const t_n   = s ? Number(s["trades"])   : 0;
    const w_n   = s ? Number(s["wins"])     : 0;
    const winPnl= s ? Number(s["win_pnl"])  : 0;
    const losPnl= s ? Number(s["loss_pnl"]) : 0;
    const totPnl= s ? Number(s["total_pnl"]): 0;
    const pf_s  = losPnl > 0 ? winPnl/losPnl : winPnl > 0 ? 999 : 0;
    const wr_s  = t_n > 0 ? w_n/t_n : 0;
    const avgP  = t_n > 0 ? totPnl/t_n : 0;
    const l_n   = t_n - w_n;
    const avgW  = w_n > 0 ? winPnl/w_n : 0;
    const avgL  = l_n > 0 ? losPnl/l_n : 0;
    const exp_s = wr_s * avgW - (1 - wr_s) * avgL;
    const weight = w ? Number(w["weight"]) : 1;
    const disab  = w ? Boolean(w["disabled"]) : false;
    const quar   = w ? Boolean(w["quarantine"]) : false;
    const trust  = w ? Number(w["trust_score"]) : 0;
    const statusIcon = disab ? "🚫" : quar ? "⚠️" : "✅";
    const statusStr  = disab ? "Disabled" : quar ? "Quarantine" : "Active";
    const lastAdpt   = h ? (h["last_adapt"] as string|null) : null;
    const lastAdptStr= lastAdpt ? new Date(lastAdpt).toISOString().slice(0,10) : "—";
    const wkDelta    = h ? Number(h["week_delta"]) : 0;
    const wkDeltaStr = wkDelta !== 0 ? `${wkDelta>=0?"+":""}${(wkDelta*100).toFixed(0)}%` : "0%";
    const stratTrades= allTrades.filter(t => t.strategy === strat);
    const confArr    = stratTrades.map(t => t.llmConfidence??0).filter(c => c > 0);
    const confAvg    = confArr.length ? confArr.reduce((a,b)=>a+b,0)/confArr.length : 0;
    const avgRR_s    = avgL > 0 ? avgW/avgL : 0;

    parts.push(
      `── ${strat} ──`,
      `${statusIcon} ${statusStr}  |  Trades: ${t_n}  |  Trust: ${trust}/100  |  Weight: ${(weight*100).toFixed(0)}%`,
      `WR: ${(wr_s*100).toFixed(1)}%  |  PF: ${fmtPF(pf_s)}  |  Avg RR: ${avgRR_s.toFixed(2)}`,
      `Gross+: $${winPnl.toFixed(2)}  |  Gross-: -$${losPnl.toFixed(2)}`,
      `Avg PnL: ${fmtS(avgP)}  |  Expectancy: ${fmtS(exp_s)}`,
      ...(confAvg > 0 ? [`Conf.Avg: ${confAvg.toFixed(0)}%`] : []),
      `Last adapt: ${lastAdptStr}  |  Week Δ wt: ${wkDeltaStr}`,
      ``,
    );
  }

  // ─ SECTION 4: Рынок ─
  const RLABELS: Record<string,string> = {
    trend_up:"UPTREND 📈", trend_down:"DOWNTREND 📉",
    sideways:"SIDEWAYS ↔️", high_vol:"HIGH VOL ⚡", low_vol:"LOW VOL 😴",
  };
  const regData = (regRows.rows as Record<string,unknown>[]).map(r => {
    const t=Number(r["t"]),w=Number(r["w"]),wp=Number(r["wp"]),lp=Number(r["lp"]),tp=Number(r["tp"]);
    return { regime:r["regime"] as string, t, wr:t?w/t:0, pf:lp?wp/lp:wp?999:0, avgPnl:t?tp/t:0 };
  });

  parts.push(`═══ 🌍 СТАТИСТИКА ПО РЫНКУ ═══`);
  if (!regData.length) {
    parts.push(`Данных пока нет`, ``);
  } else {
    for (const r of regData.sort((a,b)=>b.pf-a.pf)) {
      parts.push(`${RLABELS[r.regime]??r.regime}:  n=${r.t} | WR ${(r.wr*100).toFixed(0)}% | PF ${fmtPF(r.pf)} | Avg ${fmtS(r.avgPnl,3)}%`);
    }
    parts.push(``);
  }

  // ─ SECTION 5: Время ─
  const DOW = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  const byHour: Record<number,{t:number,w:number,wp:number,lp:number,tp:number}> = {};
  const byDow:  Record<number,{t:number,w:number,wp:number,lp:number,tp:number}> = {};
  for (const r of timeRows.rows as Record<string,unknown>[]) {
    const h=Number(r["hour_of_day"]),d=Number(r["day_of_week"]);
    const t=Number(r["trades"]),w=Number(r["wins"]),wp=Number(r["win_pnl"]),lp=Number(r["loss_pnl"]),tp=Number(r["total_pnl"]);
    if (!byHour[h]) byHour[h]={t:0,w:0,wp:0,lp:0,tp:0};
    if (!byDow[d])  byDow[d]= {t:0,w:0,wp:0,lp:0,tp:0};
    byHour[h]!.t+=t; byHour[h]!.w+=w; byHour[h]!.wp+=wp; byHour[h]!.lp+=lp; byHour[h]!.tp+=tp;
    byDow[d]!.t+=t;  byDow[d]!.w+=w;  byDow[d]!.wp+=wp;  byDow[d]!.lp+=lp;  byDow[d]!.tp+=tp;
  }

  const sessStat = (hours: number[]) => {
    let t=0,w=0,wp=0,lp=0,tp=0;
    for (const h of hours) { const v=byHour[h]; if(v){t+=v.t;w+=v.w;wp+=v.wp;lp+=v.lp;tp+=v.tp;} }
    return { t, wr:t?w/t:0, pf:lp?wp/lp:wp?999:0, avgPnl:t?tp/t:0 };
  };
  const asia = sessStat([0,1,2,3,4,5,6,7]);
  const euro = sessStat([8,9,10,11,12,13,14,15]);
  const us   = sessStat([14,15,16,17,18,19,20,21,22,23]);

  parts.push(`═══ ⏰ СТАТИСТИКА ПО ВРЕМЕНИ ═══`);
  if (!timeRows.rows.length) {
    parts.push(`Данных пока нет`, ``);
  } else {
    parts.push(`── Сессии (UTC) ──`);
    if (asia.t>0) parts.push(`Asia   (00-08): WR ${(asia.wr*100).toFixed(0)}% | PF ${fmtPF(asia.pf)} | n=${asia.t} | Avg ${fmtS(asia.avgPnl,3)}%`);
    if (euro.t>0) parts.push(`Europe (08-16): WR ${(euro.wr*100).toFixed(0)}% | PF ${fmtPF(euro.pf)} | n=${euro.t} | Avg ${fmtS(euro.avgPnl,3)}%`);
    if (us.t>0)   parts.push(`US     (14-24): WR ${(us.wr*100).toFixed(0)}% | PF ${fmtPF(us.pf)} | n=${us.t} | Avg ${fmtS(us.avgPnl,3)}%`);
    parts.push(``);

    const hourArr = Object.entries(byHour).filter(([,v])=>v.t>=3)
      .map(([h,v])=>({h:Number(h), wr:v.t?v.w/v.t:0, pf:v.lp?v.wp/v.lp:v.wp?999:0, t:v.t}))
      .sort((a,b)=>b.wr-a.wr);
    if (hourArr.length >= 3) {
      parts.push(`── Лучшие часы ──`);
      for (const x of hourArr.slice(0,5)) parts.push(`  ${String(x.h).padStart(2,"0")}:00  WR ${(x.wr*100).toFixed(0)}% | PF ${fmtPF(x.pf)} | n=${x.t}`);
      parts.push(`── Худшие часы ──`);
      for (const x of [...hourArr].reverse().slice(0,3)) parts.push(`  ${String(x.h).padStart(2,"0")}:00  WR ${(x.wr*100).toFixed(0)}% | PF ${fmtPF(x.pf)} | n=${x.t}`);
      parts.push(``);
    }
    const dowArr = Object.entries(byDow).filter(([,v])=>v.t>=3)
      .map(([d,v])=>({d:Number(d), wr:v.t?v.w/v.t:0, pf:v.lp?v.wp/v.lp:v.wp?999:0, t:v.t}))
      .sort((a,b)=>b.wr-a.wr);
    if (dowArr.length>=3) {
      parts.push(`── Дни недели ──`);
      for (const x of dowArr) parts.push(`  ${DOW[x.d]??x.d}  WR ${(x.wr*100).toFixed(0)}% | PF ${fmtPF(x.pf)} | n=${x.t}`);
      parts.push(``);
    }
  }

  // ─ SECTION 6: Монеты ─
  const coinData = (coinRows.rows as Record<string,unknown>[]).map(r => {
    const t=Number(r["trades"]),w=Number(r["wins"]),wp=Number(r["win_pnl"]),lp=Number(r["loss_pnl"]),tp=Number(r["total_pnl"]);
    return { sym:r["symbol"] as string, t, wr:t?w/t:0, pf:lp?wp/lp:wp?999:0, tp };
  });
  const enough   = coinData.filter(c=>c.t>=10);
  const fewCoins = coinData.filter(c=>c.t<10);

  parts.push(`═══ 🪙 СТАТИСТИКА ПО МОНЕТАМ ═══`);
  if (!enough.length) {
    parts.push(`Нет монет с ≥10 сделок.`);
  } else {
    parts.push(`── ТОП-10 лучших по PF ──`);
    for (const c of [...enough].sort((a,b)=>b.pf-a.pf).slice(0,10))
      parts.push(`  ${pad(c.sym,12)} PF ${fmtPF(c.pf)} | WR ${(c.wr*100).toFixed(0)}% | PnL ${fmtS(c.tp)} | n=${c.t}`);
    parts.push(``, `── ТОП-10 худших по PF ──`);
    for (const c of [...enough].sort((a,b)=>a.pf-b.pf).slice(0,10))
      parts.push(`  ${pad(c.sym,12)} PF ${fmtPF(c.pf)} | WR ${(c.wr*100).toFixed(0)}% | PnL ${fmtS(c.tp)} | n=${c.t}`);
  }
  if (fewCoins.length) {
    parts.push(``, `── Монеты с <10 сделок (${fewCoins.length}) ──`);
    parts.push(`  ` + fewCoins.map(c=>`${c.sym}(${c.t})`).join(", "));
  }
  parts.push(``);

  // ─ SECTION 7: Последние 20 сделок ─
  const last20 = allTrades.slice(-20).reverse();
  parts.push(`═══ 📜 ПОСЛЕДНИЕ ${Math.min(20,last20.length)} СДЕЛОК ═══`);
  if (!last20.length) {
    parts.push(`нет закрытых сделок`);
  } else {
    for (const t of last20) {
      const d    = t.direction==="LONG"?"L":"S";
      const date = new Date(t.closedAt).toISOString().slice(5,16);
      const conf = t.llmConfidence ? ` C:${t.llmConfidence}%` : "";
      parts.push(`${date} | ${t.symbol} ${d} | ${fmtS(t.pnl)}$ | ${t.strategy} | ${t.outcome??"?"} | ${fmtDur(durMin(t))}${conf}`);
    }
  }
  parts.push(``);

  // ─ SECTION 8: Причины закрытия ─
  const outCounts: Record<string,number> = {};
  for (const t of allTrades) { const o=t.outcome??"UNKNOWN"; outCounts[o]=(outCounts[o]??0)+1; }
  parts.push(`═══ 🔚 ПРИЧИНЫ ЗАКРЫТИЯ ═══`);
  for (const [out,cnt] of Object.entries(outCounts).sort((a,b)=>b[1]-a[1])) {
    const pct = allTrades.length ? (cnt/allTrades.length*100).toFixed(1) : "0";
    parts.push(`  ${pad(out,10)} ${cnt}  (${pct}%)`);
  }
  parts.push(``);

  // ─ SECTION 9: Фильтры ─
  parts.push(
    `═══ 🛡️ СТАТИСТИКА ФИЛЬТРОВ ═══`,
    `Логирование отклонений ещё не реализовано.`,
    `Данные начнут собираться в следующих версиях.`,
    ``,
  );

  // ─ SECTION 10: Обучение ─
  const adaptCount = Number((adaptRows.rows[0] as Record<string,unknown>)?.["cnt"] ?? 0);
  const lastAdaptAt = (adaptRows.rows[0] as Record<string,unknown>)?.["last"] as string|null;
  const quarStrats  = (quarRows.rows as Record<string,unknown>[]).map(r => r["strategy"] as string);
  const vRows = versionRows.rows as Record<string,unknown>[];
  const pfImprove = vRows.length>=2 ? Number(vRows[0]!["profit_factor"])-Number(vRows[1]!["profit_factor"]) : 0;
  const learningProg = Math.min(100, Math.round(allTrades.length/200*100));
  const learningMode = allTrades.length<100 ? "Начальное" : allTrades.length<200 ? "Активное" : "Зрелое";

  parts.push(
    `═══ 🧠 ОБУЧЕНИЕ ═══`,
    `Learning Mode:      ${learningMode}`,
    `Progress:           ${learningProg}% (${allTrades.length}/200 сделок)`,
    `Всего адаптаций:    ${adaptCount}`,
    `Последняя:          ${lastAdaptAt ? new Date(lastAdaptAt).toISOString().slice(0,10) : "—"}`,
    `В карантине:        ${quarStrats.length ? quarStrats.join(", ") : "нет"}`,
    ...(Math.abs(pfImprove) > 0.001 ? [`Изменение PF:       ${pfImprove>=0?"+":""}${pfImprove.toFixed(3)} (vs предыдущая версия)`] : []),
    ``,
  );

  // ─ SECTION 11: Exploration Mode ─
  const exploTrades = allTrades.filter(t => (t.llmRisk??"").toLowerCase().includes("explor"));
  parts.push(`═══ 🔬 EXPLORATION MODE ═══`);
  if (!exploTrades.length) {
    parts.push(`Статистика не собирается — начнёт с новых сделок.`);
  } else {
    parts.push(
      `Exploration сделок: ${exploTrades.length}`,
      `WR: ${(calcWR(exploTrades)*100).toFixed(1)}%  |  PF: ${fmtPF(calcPF(exploTrades))}`,
    );
  }
  parts.push(``);

  // ─ SECTION 12: Комиссии ─
  const totalComm = account.totalCommission ?? allTrades.reduce((s,t)=>s+(t.commission??0),0);
  const totalSlip  = account.totalSlippage  ?? allTrades.reduce((s,t)=>s+(t.slippage??0),0);
  const avgComm = allTrades.length ? totalComm/allTrades.length : 0;
  const avgSlip  = allTrades.length ? totalSlip/allTrades.length : 0;
  parts.push(
    `═══ 💸 КОМИССИИ ═══`,
    `Общие:              $${totalComm.toFixed(4)}`,
    `Средняя:            $${avgComm.toFixed(4)}`,
    ...(totalSlip > 0 ? [
      `Проскальзывание:    $${totalSlip.toFixed(4)}`,
      `Сред. проскальз.:   $${avgSlip.toFixed(4)}`,
    ] : [`Проскальзывание:    не отслеживается`]),
    ``,
  );

  // ─ SECTION 13: Открытые позиции (расширенные) ─
  parts.push(`═══ 📂 ОТКРЫТЫЕ ПОЗИЦИИ (${account.positions.length}) ═══`);
  if (!account.positions.length) {
    parts.push(`нет`);
  } else {
    for (const p of account.positions) {
      const ageMin = (now.getTime() - new Date(p.openedAt).getTime()) / 60000;
      const isLong = p.direction==="LONG";
      const tpDist = isLong
        ? (p.tp1-p.entryPrice)/p.entryPrice*100
        : (p.entryPrice-p.tp1)/p.entryPrice*100;
      const slDist = isLong
        ? (p.entryPrice-p.stopLoss)/p.entryPrice*100
        : (p.stopLoss-p.entryPrice)/p.entryPrice*100;
      const flags = [p.breakevenMoved?"BE":"", p.trailAtr?"Trail":""].filter(Boolean).join("+");
      parts.push(
        `${p.symbol} ${isLong?"LONG🟢":"SHORT🔴"}${flags?" ["+flags+"]":""}  |  Возраст: ${fmtDur(ageMin)}`,
        `  Вход: $${p.entryPrice}  |  TP1: +${tpDist.toFixed(2)}%  |  SL: -${slDist.toFixed(2)}%`,
        `  Стратегия: ${p.strategy}  |  ${new Date(p.openedAt).toISOString().slice(0,16)}`,
      );
    }
  }
  parts.push(``);

  // ─ SECTION 14: Health (с причинами) ─
  parts.push(`═══ ❤️ HEALTH ═══`);
  if (!health) {
    parts.push(`Нет данных`);
  } else {
    const hMap: Record<string,string> = {excellent:"Отлично",good:"Хорошо",watch:"Наблюдение",warning:"Внимание",critical:"Критично"};
    const hIcon: Record<string,string> = {excellent:"🟢",good:"🟢",watch:"🟡",warning:"🟠",critical:"🔴"};
    parts.push(`${hIcon[health.overall]??"⚪"} ${hMap[health.overall]??health.overall}`);
    for (const ps of health.periods) {
      if (ps.trades < 5) continue;
      parts.push(`${ps.label}: PF ${ps.profitFactor.toFixed(2)} | WR ${(ps.winRate*100).toFixed(1)}% | DD ${ps.maxDrawdown.toFixed(1)}% | Sharpe ${ps.sharpeRatio.toFixed(2)}`);
    }
    if (health.alerts.length) {
      parts.push(`Причины:`);
      for (const a of health.alerts) parts.push(`  ${a}`);
    } else {
      parts.push(`Показатели в норме`);
    }
  }
  parts.push(``);

  // ─ SECTION 15: Readiness (полный расчёт) ─
  parts.push(`═══ 🎯 READINESS ═══`);
  if (!readiness) {
    parts.push(`Нет данных`);
  } else {
    parts.push(`${readiness.percent}/100 — ${readiness.label}`, `Баллов: ${readiness.total}/${readiness.maxTotal}`, ``, `Компоненты:`);
    for (const c of readiness.components) {
      const sign = c.score===c.maxScore ? "+" : c.score===0 ? "-" : "~";
      parts.push(`  ${c.status} ${pad(c.name,22)} ${sign}${c.score}/${c.maxScore} — ${c.note}`);
    }
    if (readiness.recommendations.length) {
      parts.push(``, `Что улучшить:`);
      for (const r of readiness.recommendations) parts.push(`  • ${r}`);
    }
  }
  parts.push(``);

  // ─ SECTION 16: AI-Анализ ─
  const bestStrat = STRATS.map(s => {
    const st=ss.find(r=>r["strategy"]===s);
    const wp=st?Number(st["win_pnl"]):0, lp=st?Number(st["loss_pnl"]):0, t=st?Number(st["trades"]):0;
    return { s, pf:lp?wp/lp:wp?999:0, t };
  }).filter(x=>x.t>=10).sort((a,b)=>b.pf-a.pf)[0];

  const worstStrat = STRATS.map(s => {
    const st=ss.find(r=>r["strategy"]===s);
    const wp=st?Number(st["win_pnl"]):0, lp=st?Number(st["loss_pnl"]):0, t=st?Number(st["trades"]):0;
    return { s, pf:lp?wp/lp:wp?999:0, t };
  }).filter(x=>x.t>=10).sort((a,b)=>a.pf-b.pf)[0];

  const bestRegime = regData.filter(x=>x.t>=5).sort((a,b)=>b.pf-a.pf)[0];
  const worstCoins = enough.filter(c=>c.pf<0.8).sort((a,b)=>a.pf-b.pf).slice(0,3);
  const overfitRisk = last30.length>=20 && pfAll>0 ? (pfAll-pf30)/pfAll : 0;

  const mainReason = pfAll<1.0
    ? "Система убыточна. Суммарный PF < 1.0 — убытки превышают прибыль."
    : pfAll<1.3
    ? "Система работает около нуля. PF ниже целевого 1.50."
    : "Система прибыльна. PF выше 1.30.";

  const recs: string[] = [];
  if (pfAll < 1.0 && bestStrat) recs.push(`1. Максимизировать объём через ${bestStrat.s} (PF ${fmtPF(bestStrat.pf)}) — единственная прибыльная стратегия`);
  if (worstStrat && worstStrat.pf < 0.8) recs.push(`${recs.length+1}. Поставить ${worstStrat.s} в карантин (PF ${fmtPF(worstStrat.pf)}) — ждать 30 сделок для переоценки`);
  if (currentDDpct > 15) recs.push(`${recs.length+1}. Снизить размер позиций — просадка ${currentDDpct.toFixed(1)}% выше нормы`);
  if (allTrades.length < 200) recs.push(`${recs.length+1}. Накопить ${200-allTrades.length} сделок для надёжной адаптации весов`);
  if (overfitRisk > 0.25) recs.push(`${recs.length+1}. Проверить Walk-Forward — PF(30) значительно хуже среднего (возможно переобучение)`);
  if (!recs.length) recs.push("1. Продолжать в текущем режиме — показатели стабильны");

  parts.push(`═══ 🤖 AI-АНАЛИЗ ═══`);
  parts.push(mainReason, ``);
  if (bestStrat)  parts.push(`Лучшая стратегия:   ${bestStrat.s} (PF ${fmtPF(bestStrat.pf)})`);
  if (worstStrat && worstStrat !== bestStrat && worstStrat.pf < 1.0) parts.push(`Ухудшается:         ${worstStrat.s} (PF ${fmtPF(worstStrat.pf)})`);
  if (bestRegime) parts.push(`Лучший режим:       ${RLABELS[bestRegime.regime]??bestRegime.regime} (PF ${fmtPF(bestRegime.pf)})`);
  if (worstCoins.length) parts.push(`Исключить монеты:   ${worstCoins.map(c=>c.sym).join(", ")} (PF < 0.8)`);
  parts.push(
    overfitRisk > 0.3
      ? `Переобучение:       РИСК — PF(30)=${fmtPF(pf30)} хуже PF(all)=${fmtPF(pfAll)}`
      : overfitRisk < -0.2
      ? `Улучшение:          Последние 30 сделок лучше среднего`
      : `Переобучение:       Признаков нет`,
    ``,
  );
  if (vRows.length >= 2) {
    const diff = Number(vRows[0]!["profit_factor"]) - Number(vRows[1]!["profit_factor"]);
    parts.push(`Изм. с ${vRows[1]!["version_label"]}: PF ${diff>=0?"+":""}${diff.toFixed(3)}`);
    parts.push(``);
  }
  parts.push(`── Три главных рекомендации ──`);
  for (const r of recs.slice(0,3)) parts.push(r);
  parts.push(``, `📋 Конец отчёта`);

  // ── Chunk for Telegram (≤3900 chars each) ────────────────────────────────
  const chunks: string[] = [];
  let cur = "";
  for (const line of parts) {
    const next = cur ? cur + "\n" + line : line;
    if (next.length > 3800) { if (cur) chunks.push(cur); cur = line; }
    else cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
