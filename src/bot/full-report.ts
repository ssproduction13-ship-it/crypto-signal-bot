/**
 * full-report.ts — Telegram Full Report (кнопка «Полный отчёт»)
 * Отправляет несколько Telegram-сообщений с полным разбором работы бота.
 */
import { pool }                               from "../lib/db.js";
import { logger }                             from "../lib/logger.js";
import { calcWeightedPF }                     from "../lib/pf-utils.js";
import { loadPaperAccount }                   from "./storage.js";
import type { ClosedPaperTrade, PaperPosition } from "./storage.js";
import { calcReadinessIndex }                 from "./readiness-index.js";
import { checkLearningHealth, healthLabel }   from "./health-monitor.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function calcPF(ts: ClosedPaperTrade[]): number {
  // ts приходит отсортированным ASC (oldest first после .sort() в вызывающем коде).
  // Для time-decay веса нужен DESC (index 0 = newest) — разворачиваем.
  // Используем COALESCE(pnlEquityPct, pnlPercent) — та же единица, что в learning-engine.
  const pnls = [...ts].reverse().map(t => t.pnlEquityPct ?? t.pnlPercent ?? 0);
  return calcWeightedPF(pnls);
}
function calcWR(ts: ClosedPaperTrade[]): number {
  return ts.length ? ts.filter(t => t.pnl > 0).length / ts.length : 0;
}
function calcStreaks(ts: ClosedPaperTrade[]): { maxWin: number; maxLoss: number; cur: number; curType: "win"|"loss"|null } {
  let maxWin = 0, maxLoss = 0, cur = 0, curType: "win"|"loss"|null = null;
  for (const t of ts) {
    const type: "win"|"loss" = t.pnl > 0 ? "win" : "loss";
    cur = type === curType ? cur + 1 : 1;
    curType = type;
    if (type === "win" && cur > maxWin) maxWin = cur;
    if (type === "loss" && cur > maxLoss) maxLoss = cur;
  }
  return { maxWin, maxLoss, cur, curType };
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
    eq += p; if (eq > peak) peak = eq;
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
  if (!isFinite(mins) || mins <= 0) return "—";
  if (mins < 60)   return `${Math.round(mins)}м`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}ч`;
  return `${(mins / 1440).toFixed(1)}д`;
}
function fmtPF(pf: number): string { return pf >= 999 ? "∞" : pf.toFixed(2); }
function fmtS(n: number, d = 2):   string { return (n >= 0 ? "+" : "") + n.toFixed(d); }
function pct(n: number, d = 1):    string { return (n >= 0 ? "+" : "") + n.toFixed(d) + "%"; }

const REGIME_NAMES: Record<string, string> = {
  trend_up:   "📈 Uptrend",
  trend_down: "📉 Downtrend",
  sideways:   "↔️ Sideways",
  high_vol:   "⚡ High Vol",
  low_vol:    "😴 Low Vol",
};
const STRAT_NAMES: Record<string, string> = {
  TREND:           "Тренд",
  BREAKOUT:        "Пробой",
  VOLUME_IMPULSE:  "Объём",
  MEAN_REVERSION:  "Возврат",
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateFullReport(chatId: number): Promise<string[]> {
  const now = new Date();
  const ts  = now.toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"UTC" }) + " UTC";

  // ── Параллельная загрузка данных ─────────────────────────────────────────
  const [account, health, readiness] = await Promise.all([
    loadPaperAccount(chatId),
    checkLearningHealth(chatId).catch(() => null),
    calcReadinessIndex(chatId).catch(() => null),
  ]);

  const [regRows, timeRows, coinRows, adaptRows, quarRows,
         versionRows, histRows, firstRow, entityWeightRows] = await Promise.all([
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
    pool.query(`SELECT strategy, MAX(changed_at) last_adapt FROM strategy_history GROUP BY strategy`),
    pool.query("SELECT MIN(opened_at) first FROM paper_closed_trades WHERE chat_id=$1", [chatId]),
    pool.query(`SELECT sew.entity, sew.strategy, sew.direction,
                  sew.weight, sew.quarantine, sew.trust_score,
                  COUNT(pct.pnl)::int AS trades,
                  SUM(CASE WHEN pct.pnl > 0 THEN 1 ELSE 0 END)::int AS wins,
                  array_agg(pct.pnl ORDER BY pct.closed_at DESC)
                    FILTER (WHERE pct.pnl IS NOT NULL) AS pnl_arr
           FROM strategy_entity_weights sew
           LEFT JOIN LATERAL (
             SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl,
                    closed_at
             FROM paper_closed_trades
             WHERE strategy  = sew.strategy
               AND direction = sew.direction
               AND chat_id   = $1
               AND outcome NOT IN ('TIMEOUT_STALE')
               AND closed_at::timestamptz >= $2::timestamptz
             ORDER BY closed_at DESC LIMIT 150
           ) pct ON true
           GROUP BY sew.entity, sew.strategy, sew.direction,
                    sew.weight, sew.quarantine, sew.trust_score
           ORDER BY sew.strategy, sew.direction`, [chatId, account.resetAt || '1970-01-01']),
  ]).catch(err => { logger.warn({err}, "full-report DB query error"); throw err; });

  // ── Базовые вычисления ────────────────────────────────────────────────────
  const allTrades = account.closedTrades.slice().sort((a, b) =>
    new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()
  );
  const wins   = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const pnls   = allTrades.map(t => t.pnl);
  const pnlPcts = allTrades.map(t => t.pnlPercent);

  const last30  = allTrades.slice(-30);
  const last100 = allTrades.slice(-100);

  const pfAll  = calcPF(allTrades), pf30 = calcPF(last30), pf100 = calcPF(last100);
  const wrAll  = calcWR(allTrades), wr30 = calcWR(last30);
  const gW = wins.reduce((s, t) => s + t.pnl, 0);
  const gL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin  = wins.length   ? gW / wins.length   : 0;
  const avgLoss = losses.length ? gL / losses.length : 0;
  const avgRR   = avgLoss > 0 ? avgWin / avgLoss : 0;
  const expectPct = allTrades.length
    ? allTrades.reduce((s, t) => s + t.pnlPercent, 0) / allTrades.length
    : 0;
  const durations  = allTrades.map(t => durMin(t));
  const avgDur = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const medDur = medianVal(durations);
  const streaks  = calcStreaks(allTrades);
  const pnlTotal = account.balance - account.initialBalance;
  const retPct   = account.initialBalance > 0 ? pnlTotal / account.initialBalance * 100 : 0;

  const todayStart  = new Date(now); todayStart.setHours(0,0,0,0);
  const weekStart   = new Date(todayStart); weekStart.setDate(todayStart.getDate() - ((todayStart.getDay()+6)%7));
  const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1);
  const pnlD = allTrades.filter(t => new Date(t.closedAt) >= todayStart).reduce((a,t) => a+t.pnl, 0);
  const pnlW = allTrades.filter(t => new Date(t.closedAt) >= weekStart ).reduce((a,t) => a+t.pnl, 0);
  const pnlM = allTrades.filter(t => new Date(t.closedAt) >= monthStart).reduce((a,t) => a+t.pnl, 0);

  const equityHigh   = Math.max(account.peakBalance ?? account.balance, account.balance);
  const currentDDpct = equityHigh > 0 ? ((equityHigh - account.balance) / equityHigh) * 100 : 0;
  const maxDDpct     = maxDD(pnls);
  const firstDate    = (firstRow.rows[0] as Record<string,unknown>)?.["first"] as string|null;
  const daysSince    = firstDate ? (now.getTime() - new Date(firstDate).getTime()) / (1000*3600*24) : 0;
  const annualRet    = daysSince > 7 ? retPct * (365 / daysSince) : 0;
  const calmarR      = maxDDpct > 0 ? annualRet / maxDDpct : 0;
  const sharpe       = sharpeRatio(pnlPcts);
  const sqn          = sqnScore(pnlPcts);
  const sqnLabel     = sqn >= 5 ? "Отлично" : sqn >= 3 ? "Хорошо" : sqn >= 2 ? "Норм" : sqn >= 1 ? "Слабо" : "—";

  const overfitRisk = last30.length >= 20 && pfAll > 0 ? (pfAll - pf30) / pfAll : 0;

  // Outcome breakdown
  const outCounts: Record<string,number> = {};
  for (const t of allTrades) { const o = t.outcome ?? "UNKNOWN"; outCounts[o] = (outCounts[o] ?? 0) + 1; }
  const fmtOut = (o: string) => {
    const cnt = outCounts[o] ?? 0;
    return cnt ? `${o} ${(cnt/allTrades.length*100).toFixed(0)}%` : null;
  };

  // Coin data
  const coinData = (coinRows.rows as Record<string,unknown>[]).map(r => {
    const t=Number(r["trades"]),w=Number(r["wins"]),wp=Number(r["win_pnl"]),lp=Number(r["loss_pnl"]),tp=Number(r["total_pnl"]);
    return { sym:r["symbol"] as string, t, wr:t?w/t*100:0, pf:lp?wp/lp:wp?999:0, tp };
  });
  const coinEnough = coinData.filter(c => c.t >= 5);

  // Regime data
  const regData = (regRows.rows as Record<string,unknown>[]).map(r => {
    const t=Number(r["t"]),w=Number(r["w"]),wp=Number(r["wp"]),lp=Number(r["lp"]);
    return { regime:r["regime"] as string, t, wr:t?w/t*100:0, pf:lp?wp/lp:wp?999:0 };
  }).sort((a,b) => b.pf - a.pf);

  // Time data
  const byHour: Record<number,{t:number,w:number}> = {};
  const byDow:  Record<number,{t:number,w:number}> = {};
  const DOW = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  for (const r of timeRows.rows as Record<string,unknown>[]) {
    const h=Number(r["hour_of_day"]),d=Number(r["day_of_week"]);
    const t=Number(r["trades"]),w=Number(r["wins"]);
    if (!byHour[h]) byHour[h]={t:0,w:0}; byHour[h]!.t+=t; byHour[h]!.w+=w;
    if (!byDow[d])  byDow[d]= {t:0,w:0}; byDow[d]!.t+=t;  byDow[d]!.w+=w;
  }
  const sessStat = (hours: number[]) => {
    let t=0,w=0; for (const h of hours) { const v=byHour[h]; if(v){t+=v.t;w+=v.w;} }
    return { t, wr:t?w/t*100:0 };
  };
  const asia = sessStat([0,1,2,3,4,5,6,7]);
  const euro = sessStat([8,9,10,11,12,13,14,15]);
  const us   = sessStat([14,15,16,17,18,19,20,21,22,23]);

  // Entity weights
  const entityRows = entityWeightRows.rows as Record<string,unknown>[];
  const vRows      = versionRows.rows as Record<string,unknown>[];
  const quarStrats = (quarRows.rows as Record<string,unknown>[]).map(r => r["strategy"] as string);
  const adaptCount = Number((adaptRows.rows[0] as Record<string,unknown>)?.["cnt"] ?? 0);
  const learningProg = Math.min(100, Math.round(allTrades.length / 200 * 100));
  const learningMode = allTrades.length < 100 ? "🌱 Начальное" : allTrades.length < 200 ? "🔥 Активное" : "✅ Зрелое";

  // Total commission
  const totalComm = account.totalCommission ?? allTrades.reduce((s,t) => s+(t.commission??0), 0);

  // Health label
  const hIcon: Record<string,string> = { excellent:"🟢",good:"🟢",watch:"🟡",warning:"🟠",critical:"🔴" };
  const hText: Record<string,string> = { excellent:"Отлично",good:"Хорошо",watch:"Наблюдение",warning:"Внимание",critical:"Критично" };

  // ── Build parts ───────────────────────────────────────────────────────────
  const parts: string[] = [];

  // ─────────────────────────────────────────────────────
  //  БЛОК 1: QUICKSCAN (всё самое важное в 1 экране)
  // ─────────────────────────────────────────────────────
  const pfTrend = overfitRisk > 0.2 ? "📉" : overfitRisk < -0.15 ? "📈" : "→";
  const healthStr = health
    ? `${hIcon[health.overall]??""} ${hText[health.overall]??health.overall}`
    : "—";
  const ddIcon   = currentDDpct < 5 ? "🟢" : currentDDpct < 15 ? "🟡" : "🔴";
  const retIcon  = retPct >= 0 ? "▲" : "▼";

  parts.push(
    `📊 *AI ТРЕЙДЕР · ПОЛНЫЙ ОТЧЁТ*`,
    `🕐 ${ts}`,
    ``,
    `*━━━ ОБЗОР ━━━*`,
    `💰 *$${account.balance.toFixed(2)}* ${retIcon} ${pct(retPct)} · пик $${equityHigh.toFixed(2)}`,
    `${ddIcon} DD: *${currentDDpct.toFixed(2)}%* · макс ${maxDDpct.toFixed(2)}%`,
    ``,
    `PF: *${fmtPF(pfAll)}* ${pfTrend}  WR: *${(wrAll*100).toFixed(1)}%*  n: *${allTrades.length}*`,
    `Sharpe: *${sharpe.toFixed(2)}*  SQN: *${sqn.toFixed(2)}* (${sqnLabel})`,
    `Calmar: *${calmarR.toFixed(2)}*  RR: *${avgRR.toFixed(2)}:1*`,
    `Exp: *${fmtS(expectPct,3)}%/сделку*`,
    ``,
    `*P&L по периодам:*`,
    `├ Сегодня:  \`${fmtS(pnlD)}$\``,
    `├ Неделя:   \`${fmtS(pnlW)}$\``,
    `└ Месяц:    \`${fmtS(pnlM)}$\``,
    ``,
    `❤️ Здоровье: ${healthStr}`,
    readiness ? `🎯 Готовность: *${readiness.percent}/100* — ${readiness.label}` : ``,
    `📂 Открыто: *${account.positions.length}* · закрыто: *${allTrades.length}*`,
    ``,
  );

  // ─────────────────────────────────────────────────────
  //  БЛОК 2: СТАТИСТИКА СДЕЛОК
  // ─────────────────────────────────────────────────────
  parts.push(
    `*━━━ СТАТИСТИКА СДЕЛОК ━━━*`,
    ``,
    `Всего:  ${allTrades.length}  · wins: ${wins.length} · losses: ${losses.length}`,
    ``,
    `*Profit Factor:*`,
    `  Все: \`${fmtPF(pfAll)}\`  · 100: \`${last100.length>=10 ? fmtPF(pf100) : "—"}\`  · 30: \`${last30.length>=10 ? fmtPF(pf30) : "—"}\``,
    ``,
    `*Win Rate:*`,
    `  Все: \`${(wrAll*100).toFixed(1)}%\`  · 100: \`${last100.length>=10 ? (calcWR(last100)*100).toFixed(1)+"%" : "—"}\`  · 30: \`${last30.length>=10 ? (wr30*100).toFixed(1)+"%" : "—"}\``,
    ``,
    `Avg Win: *+$${avgWin.toFixed(2)}*  Avg Loss: *-$${avgLoss.toFixed(2)}*`,
    `Avg Dur: *${fmtDur(avgDur)}*  Med Dur: *${fmtDur(medDur)}*`,
    ``,
    `*Серии:*`,
    `  🏆 Макс побед подряд: *${streaks.maxWin}*`,
    `  💔 Макс убытков подряд: *${streaks.maxLoss}*`,
    `  Текущая: *${streaks.cur}* ${streaks.curType==="win" ? "🟢 побед" : streaks.curType==="loss" ? "🔴 убытков" : "—"}`,
    ``,
    `*Итоги закрытий:*  ` +
      (["TP2","TP1","BE","SL","TIMEOUT_STALE"].map(fmtOut).filter(Boolean).join("  · ") || "—"),
    ``,
  );

  // ─────────────────────────────────────────────────────
  //  БЛОК 3: СТРАТЕГИИ (по entity)
  // ─────────────────────────────────────────────────────
  // Хранит взвешенный PF по entity — переиспользуется в БЛОК 11 (AI анализ)
  const entityWeightedPFMap: Record<string, number> = {};

  parts.push(`*━━━ СТРАТЕГИИ ━━━*`, ``);
  if (!entityRows.length) {
    parts.push(`Нет данных`, ``);
  } else {
    for (const r of entityRows) {
      const entity   = r["entity"] as string;
      const trades   = Number(r["trades"]);
      const wins_e   = Number(r["wins"]);
      const weight   = Number(r["weight"]);
      const quar     = Boolean(r["quarantine"]);
      const trust    = Number(r["trust_score"]);
      // pnl_arr: array_agg(... ORDER BY closed_at DESC) — index 0 = newest ✓
      const pnlArr   = Array.isArray(r["pnl_arr"])
        ? (r["pnl_arr"] as unknown[]).map(Number)
        : [];

      const weightedPF = calcWeightedPF(pnlArr);
      entityWeightedPFMap[entity] = weightedPF;

      const wr_e = trades > 0 ? (wins_e / trades * 100).toFixed(0) : "—";
      const pf_e = pnlArr.length > 0 ? fmtPF(weightedPF) : "—";
      const st   = quar ? "⚠️ Кар" : weight >= 0.8 ? "✅" : weight >= 0.5 ? "📉" : "🔴";
      const wPct = (weight * 100).toFixed(0) + "%";
      const name = (STRAT_NAMES[r["strategy"] as string] ?? r["strategy"] as string)
        + " " + (r["direction"] === "LONG" ? "L" : "S");

      parts.push(
        `${st} *${entity}*  · Вес ${wPct}  Trust ${trust}/100`,
        `  WR ${wr_e}%  PF ${pf_e}  n=${trades}`,
      );
    }
    parts.push(``);
  }

  // ─────────────────────────────────────────────────────
  //  БЛОК 4: РЫНОЧНЫЕ РЕЖИМЫ
  // ─────────────────────────────────────────────────────
  parts.push(`*━━━ РЫНОЧНЫЕ РЕЖИМЫ ━━━*`, ``);
  if (!regData.length) {
    parts.push(`Нет данных (нужно ≥3 сделок в режиме)`, ``);
  } else {
    for (const r of regData) {
      const icon = r.pf >= 1.5 ? "🟢" : r.pf >= 1.0 ? "🟡" : "🔴";
      parts.push(`${icon} ${REGIME_NAMES[r.regime]??r.regime}:  PF \`${fmtPF(r.pf)}\`  WR ${r.wr.toFixed(0)}%  n=${r.t}`);
    }
    parts.push(``);
  }

  // ─────────────────────────────────────────────────────
  //  БЛОК 5: ВРЕМЕННОЙ АНАЛИЗ
  // ─────────────────────────────────────────────────────
  parts.push(`*━━━ ВРЕМЕННОЙ АНАЛИЗ ━━━*`, ``);
  if (!timeRows.rows.length) {
    parts.push(`Нет данных`, ``);
  } else {
    // Sessions
    parts.push(`*Сессии (UTC):*`);
    if (asia.t > 0) parts.push(`  Asia   00–08: WR ${asia.wr.toFixed(0)}%  n=${asia.t}`);
    if (euro.t > 0) parts.push(`  Europe 08–16: WR ${euro.wr.toFixed(0)}%  n=${euro.t}`);
    if (us.t > 0)   parts.push(`  US     14–24: WR ${us.wr.toFixed(0)}%  n=${us.t}`);
    parts.push(``);

    // Best hours
    const hourArr = Object.entries(byHour)
      .filter(([,v]) => v.t >= 3)
      .map(([h,v]) => ({ h:Number(h), wr:v.w/v.t*100, t:v.t }))
      .sort((a,b) => b.wr - a.wr);
    if (hourArr.length >= 3) {
      parts.push(`*Лучшие часы:*`);
      for (const x of hourArr.slice(0,5))
        parts.push(`  ${String(x.h).padStart(2,"0")}:00  WR ${x.wr.toFixed(0)}%  n=${x.t}`);
      parts.push(``);
    }

    // Days of week
    const dowArr = Object.entries(byDow)
      .filter(([,v]) => v.t >= 3)
      .map(([d,v]) => ({ d:Number(d), wr:v.w/v.t*100, t:v.t }))
      .sort((a,b) => b.wr - a.wr);
    if (dowArr.length >= 3) {
      parts.push(`*Дни недели:*`);
      for (const x of dowArr)
        parts.push(`  ${DOW[x.d]??x.d}  WR ${x.wr.toFixed(0)}%  n=${x.t}`);
      parts.push(``);
    }
  }

  // ─────────────────────────────────────────────────────
  //  БЛОК 6: ТОПОНЕТЫ / АУТСАЙДЕРЫ
  // ─────────────────────────────────────────────────────
  parts.push(`*━━━ МОНЕТЫ ━━━*`, ``);
  if (!coinEnough.length) {
    parts.push(`Нет монет с ≥5 сделок`, ``);
  } else {
    const sorted = [...coinEnough].sort((a,b) => b.pf - a.pf);
    parts.push(`*🏆 Топ-5 по PF:*`);
    for (const c of sorted.slice(0,5))
      parts.push(`  🟢 ${c.sym}  PF ${fmtPF(c.pf)}  WR ${c.wr.toFixed(0)}%  n=${c.t}`);
    parts.push(``);
    const worst = [...sorted].reverse().filter(c => c.pf < 1.0).slice(0,5);
    if (worst.length) {
      parts.push(`*🔴 Убыточные:*`);
      for (const c of worst)
        parts.push(`  🔴 ${c.sym}  PF ${fmtPF(c.pf)}  WR ${c.wr.toFixed(0)}%  n=${c.t}`);
    }
    parts.push(``);
  }

  // ─────────────────────────────────────────────────────
  //  БЛОК 7: ПОСЛЕДНИЕ 15 СДЕЛОК
  // ─────────────────────────────────────────────────────
  const last15 = allTrades.slice(-15).reverse();
  parts.push(`*━━━ ПОСЛЕДНИЕ ${Math.min(15,last15.length)} СДЕЛОК ━━━*`, ``);
  if (!last15.length) {
    parts.push(`Нет закрытых сделок`, ``);
  } else {
    for (const t of last15) {
      const d    = t.direction === "LONG" ? "L" : "S";
      const date = new Date(t.closedAt).toISOString().slice(5,16).replace("T"," ");
      const icon = t.pnl > 0 ? "🟢" : "🔴";
      const strat = (STRAT_NAMES[t.strategy??""] ?? t.strategy ?? "?").slice(0,5);
      parts.push(`${icon} ${date} · ${t.symbol} ${d} · ${fmtS(t.pnl)}$ · ${t.outcome??""} [${strat}]`);
    }
    parts.push(``);
  }

  // ─────────────────────────────────────────────────────
  //  БЛОК 8: ОБУЧЕНИЕ
  // ─────────────────────────────────────────────────────
  const pfImprove = vRows.length >= 2
    ? Number(vRows[0]!["profit_factor"]) - Number(vRows[1]!["profit_factor"])
    : 0;

  parts.push(
    `*━━━ ОБУЧЕНИЕ ━━━*`,
    ``,
    `Режим:          ${learningMode}`,
    `Прогресс:       ${learningProg}%  (${allTrades.length}/200 сделок)`,
    `Адаптаций:      ${adaptCount}`,
    ...(quarStrats.length ? [`В карантине:    ${quarStrats.join(", ")}`] : [`Карантин:       нет`]),
    ...(Math.abs(pfImprove) > 0.001 && vRows.length >= 2
      ? [`PF тренд:       ${pfImprove >= 0 ? "+" : ""}${pfImprove.toFixed(3)} vs ${vRows[1]!["version_label"]}`]
      : []),
    ``,
  );

  // ─────────────────────────────────────────────────────
  //  БЛОК 9: КОМИССИИ + ОТКРЫТЫЕ ПОЗИЦИИ
  // ─────────────────────────────────────────────────────
  parts.push(
    `*━━━ РАСХОДЫ ━━━*`,
    ``,
    `Комиссии итого: \`$${totalComm.toFixed(4)}\``,
    `Средняя/сделку: \`$${allTrades.length ? (totalComm/allTrades.length).toFixed(4) : "0.0000"}\``,
    ``,
  );

  parts.push(`*━━━ ОТКРЫТЫЕ ПОЗИЦИИ (${account.positions.length}) ━━━*`, ``);
  if (!account.positions.length) {
    parts.push(`Нет открытых позиций`, ``);
  } else {
    for (const p of account.positions) {
      const ageMin = (now.getTime() - new Date(p.openedAt).getTime()) / 60000;
      const isLong = p.direction === "LONG";
      const tpDist = isLong
        ? (p.tp1 - p.entryPrice) / p.entryPrice * 100
        : (p.entryPrice - p.tp1) / p.entryPrice * 100;
      const slDist = isLong
        ? (p.entryPrice - p.stopLoss) / p.entryPrice * 100
        : (p.stopLoss - p.entryPrice) / p.entryPrice * 100;
      const flags = [p.breakevenMoved ? "BE" : "", p.trailAtr ? "Trail" : ""].filter(Boolean).join("+");
      parts.push(
        `${isLong ? "⬆️" : "⬇️"} *${p.symbol}* ${p.strategy}${flags ? " ["+flags+"]" : ""}  · ${fmtDur(ageMin)}`,
        `  Вход $${p.entryPrice}  · TP1 +${tpDist.toFixed(2)}%  · SL -${slDist.toFixed(2)}%`,
      );
    }
    parts.push(``);
  }

  // ─────────────────────────────────────────────────────
  //  БЛОК 10: ЗДОРОВЬЕ + READINESS
  // ─────────────────────────────────────────────────────
  parts.push(`*━━━ ЗДОРОВЬЕ ━━━*`, ``);
  if (!health) {
    parts.push(`Нет данных`, ``);
  } else {
    parts.push(`${hIcon[health.overall]??""} *${hText[health.overall]??health.overall}*`);
    for (const ps of health.periods) {
      if (ps.trades < 5) continue;
      parts.push(`  ${ps.label}: PF ${ps.profitFactor.toFixed(2)} · WR ${(ps.winRate*100).toFixed(1)}% · DD ${ps.maxDrawdown.toFixed(1)}%`);
    }
    if (health.alerts.length) {
      parts.push(``, `Причины:`);
      for (const a of health.alerts) parts.push(`  • ${a}`);
    }
    parts.push(``);
  }

  parts.push(`*━━━ READINESS ━━━*`, ``);
  if (!readiness) {
    parts.push(`Нет данных`, ``);
  } else {
    parts.push(`*${readiness.percent}/100* — ${readiness.label}`, ``);
    for (const c of readiness.components) {
      const bar = c.score === c.maxScore ? "✅" : c.score === 0 ? "❌" : "🟡";
      parts.push(`${bar} ${c.name}: *${c.score}/${c.maxScore}* — ${c.note}`);
    }
    if (readiness.recommendations.length) {
      parts.push(``, `Улучшить:`);
      for (const r of readiness.recommendations) parts.push(`  • ${r}`);
    }
    parts.push(``);
  }

  // ─────────────────────────────────────────────────────
  //  БЛОК 11: AI АНАЛИЗ + РЕКОМЕНДАЦИИ
  // ─────────────────────────────────────────────────────

  // Per-strategy агрегация на основе взвешенных PF по entity (БЛОК 3)
  // PF стратегии = среднее взвешенных PF её LONG и SHORT entity (≥5 сделок каждый)
  const ssMap: Record<string,{strategy:string;trades:number;wins:number;pfSum:number;pfCount:number}> = {};
  for (const r of entityRows) {
    const strat  = r["strategy"] as string;
    const entity = r["entity"]   as string;
    if (!ssMap[strat]) ssMap[strat] = { strategy:strat, trades:0, wins:0, pfSum:0, pfCount:0 };
    ssMap[strat].trades += Number(r["trades"]);
    ssMap[strat].wins   += Number(r["wins"]);
    const epf = entityWeightedPFMap[entity];
    if (epf !== undefined && Number(r["trades"]) >= 5) {
      ssMap[strat].pfSum   += epf;
      ssMap[strat].pfCount += 1;
    }
  }
  const ss = Object.values(ssMap);

  const bestStrat  = ss.map(s => ({ s:s.strategy, pf:s.pfCount>0?s.pfSum/s.pfCount:0, t:s.trades }))
    .filter(x => x.t >= 10).sort((a,b) => b.pf - a.pf)[0];
  const worstStrat = ss.map(s => ({ s:s.strategy, pf:s.pfCount>0?s.pfSum/s.pfCount:0, t:s.trades }))
    .filter(x => x.t >= 10).sort((a,b) => a.pf - b.pf)[0];
  const bestRegime  = regData.filter(x => x.t >= 5)[0];
  const worstCoins  = coinEnough.filter(c => c.pf < 0.8).sort((a,b) => a.pf - b.pf).slice(0,3);

  const verdict = pfAll < 1.0
    ? "🔴 Система убыточна — PF < 1.0"
    : pfAll < 1.3
    ? "🟡 PF ниже целевого 1.30 — стабилизируй"
    : pfAll < 1.5
    ? "🟢 Система прибыльна — PF в норме"
    : "🚀 Отличный PF — выше 1.50!";

  const recs: string[] = [];
  if (pfAll < 1.0 && bestStrat)       recs.push(`Фокус на стратегию ${bestStrat.s} (PF ${fmtPF(bestStrat.pf)})`);
  if (worstStrat && worstStrat.pf < 0.8) recs.push(`Карантин ${worstStrat.s} (PF ${fmtPF(worstStrat.pf)}) — ждать 30 сделок`);
  if (currentDDpct > 15)              recs.push(`Снизить размер позиций — DD ${currentDDpct.toFixed(1)}%`);
  if (allTrades.length < 200)         recs.push(`Накопить ещё ${200-allTrades.length} сделок для надёжного обучения`);
  if (overfitRisk > 0.25)            recs.push(`Переобучение: PF(30)=${fmtPF(pf30)} < PF(all)=${fmtPF(pfAll)}`);
  if (!recs.length)                   recs.push(`Продолжать — всё стабильно`);

  parts.push(
    `*━━━ AI АНАЛИЗ ━━━*`,
    ``,
    verdict,
    ``,
    ...(bestStrat  ? [`🏆 Лучшая:    *${bestStrat.s}*  PF ${fmtPF(bestStrat.pf)}`] : []),
    ...(worstStrat && worstStrat !== bestStrat && worstStrat.pf < 1.0
      ? [`📉 Слабая:    *${worstStrat.s}*  PF ${fmtPF(worstStrat.pf)}`] : []),
    ...(bestRegime  ? [`🌍 Режим:     *${REGIME_NAMES[bestRegime.regime]??bestRegime.regime}*  PF ${fmtPF(bestRegime.pf)}`] : []),
    ...(worstCoins.length ? [`⚠️ Убыточны:  ${worstCoins.map(c=>c.sym).join(", ")}`] : []),
    overfitRisk > 0.3
      ? `🔄 Переобучение: *РИСК* — PF(30)=${fmtPF(pf30)} vs PF(all)=${fmtPF(pfAll)}`
      : overfitRisk < -0.2
      ? `📈 Тренд: последние 30 *лучше* среднего`
      : `✅ Переобучения нет`,
    ``,
    `*Рекомендации:*`,
    ...recs.slice(0,3).map((r,i) => `${i+1}. ${r}`),
    ``,
    `📋 _Конец отчёта_`,
  );

  // ── Нарезка на Telegram-чанки ≤3900 символов ────────────────────────────
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
