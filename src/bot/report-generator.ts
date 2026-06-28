import { pool } from "../lib/db.js";
import { loadPaperAccount, loadWeights, type ClosedPaperTrade, type PaperPosition } from "./storage.js";
import { loadStrategyStats, type StrategyStats } from "./strategies.js";
import { loadABVariants } from "./ab-testing.js";
import { getPrice } from "./binance.js";
import { logger } from "../lib/logger.js";

const BOT_VERSION = "1.0.0-phase1";

// ── Data collection ──────────────────────────────────────────────────────────

interface ReportData {
  date: string;
  chatId: number;
  balance: number;
  initialBalance: number;
  peakBalance: number;
  positions: PaperPosition[];
  closedTrades: ClosedPaperTrade[];
  strategyStats: StrategyStats[];
  weights: Record<string, number>;
  riskState: Record<string, unknown>;
  missedTrades: Array<Record<string, unknown>>;
  abVariants: Awaited<ReturnType<typeof loadABVariants>>;
  positionPrices: Record<string, number>;
}

async function collectData(chatId: number): Promise<ReportData> {
  const [account, strategyStats, weights, abVariants] = await Promise.all([
    loadPaperAccount(chatId),
    loadStrategyStats(),
    loadWeights(),
    loadABVariants(),
  ]);

  const [riskRes, missedRes] = await Promise.all([
    pool.query("SELECT * FROM risk_state WHERE id=1"),
    pool.query("SELECT * FROM missed_trades ORDER BY timestamp DESC LIMIT 200"),
  ]);

  const riskState = (riskRes.rows[0] ?? {}) as Record<string, unknown>;
  const missedTrades = missedRes.rows as Array<Record<string, unknown>>;

  // Fetch current prices for open positions
  const positionPrices: Record<string, number> = {};
  await Promise.all(
    account.positions.map(async (p) => {
      try { positionPrices[p.symbol] = await getPrice(p.symbol); }
      catch { positionPrices[p.symbol] = p.entryPrice; }
    })
  );

  return {
    date: new Date().toISOString(),
    chatId,
    balance: account.balance,
    initialBalance: account.initialBalance,
    peakBalance: account.peakBalance ?? account.balance,
    positions: account.positions,
    closedTrades: account.closedTrades,
    strategyStats,
    weights,
    riskState,
    missedTrades,
    abVariants,
    positionPrices,
  };
}

// ── Stats helpers ────────────────────────────────────────────────────────────

function calcStats(trades: ClosedPaperTrade[]) {
  if (!trades.length) return null;
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin  = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf     = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const avgWin = wins.length   ? wins.reduce((a, t) => a + t.pnlPercent, 0) / wins.length : 0;
  const avgLoss= losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0) / losses.length) : 0;
  const wr     = (wins.length / trades.length) * 100;
  const expectancy = (wr / 100) * avgWin - ((100 - wr) / 100) * avgLoss;

  // Average trade duration (minutes)
  const durations = trades
    .filter(t => t.openedAt && t.closedAt)
    .map(t => (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 60000);
  const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const medianDuration = durations.length
    ? [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]!
    : 0;

  // By hour
  const byHour: Record<number, { wins: number; total: number }> = {};
  for (const t of trades) {
    const h = new Date(t.closedAt).getUTCHours();
    if (!byHour[h]) byHour[h] = { wins: 0, total: 0 };
    byHour[h]!.total++;
    if (t.pnl > 0) byHour[h]!.wins++;
  }

  return { wins, losses, grossWin, grossLoss, pf, avgWin, avgLoss, wr, expectancy, avgDuration, medianDuration, byHour };
}

function calcBySymbol(trades: ClosedPaperTrade[]) {
  const map: Record<string, { wins: number; total: number; pnl: number; grossWin: number; grossLoss: number }> = {};
  for (const t of trades) {
    if (!map[t.symbol]) map[t.symbol] = { wins: 0, total: 0, pnl: 0, grossWin: 0, grossLoss: 0 };
    map[t.symbol]!.total++;
    map[t.symbol]!.pnl += t.pnlPercent;
    if (t.pnl > 0) { map[t.symbol]!.wins++; map[t.symbol]!.grossWin += t.pnl; }
    else { map[t.symbol]!.grossLoss += Math.abs(t.pnl); }
  }
  return Object.entries(map).map(([symbol, d]) => ({
    symbol,
    trades: d.total,
    wins: d.wins,
    wr: (d.wins / d.total) * 100,
    pf: d.grossLoss > 0 ? d.grossWin / d.grossLoss : d.grossWin > 0 ? 999 : 0,
    pnl: d.pnl,
  }));
}

function calcReadiness(d: ReportData, stats: ReturnType<typeof calcStats>) {
  const total = d.closedTrades.length;
  const scores: Array<{ name: string; score: number; max: number; note: string }> = [];

  // Trades count (max 20 pts, need 100+)
  const tradeScore = Math.min(20, Math.round((total / 100) * 20));
  scores.push({ name: "Кол-во сделок", score: tradeScore, max: 20, note: `${total}/100+` });

  // WR (max 20 pts, need 45%+)
  const wr = stats?.wr ?? 0;
  const wrScore = wr >= 45 ? 20 : Math.round((wr / 45) * 20);
  scores.push({ name: "WinRate", score: wrScore, max: 20, note: `${wr.toFixed(1)}% (нужно 45%+)` });

  // PF (max 20 pts, need 1.3+)
  const pf = stats?.pf ?? 0;
  const pfScore = pf >= 1.3 ? 20 : Math.round((pf / 1.3) * 20);
  scores.push({ name: "Profit Factor", score: pfScore, max: 20, note: `${pf.toFixed(2)} (нужно 1.3+)` });

  // Drawdown (max 20 pts, need < 15%)
  const dd = d.peakBalance > 0 ? ((d.peakBalance - d.balance) / d.peakBalance) * 100 : 0;
  const ddScore = dd < 15 ? 20 : Math.max(0, Math.round(20 - (dd - 15) * 2));
  scores.push({ name: "Макс. просадка", score: ddScore, max: 20, note: `${dd.toFixed(2)}% (нужно <15%)` });

  // Days running (max 20 pts, need 90 days)
  const oldest = d.closedTrades.length
    ? new Date(d.closedTrades[d.closedTrades.length - 1]!.openedAt).getTime()
    : Date.now();
  const daysSince = (Date.now() - oldest) / 86400000;
  const dayScore = Math.min(20, Math.round((daysSince / 90) * 20));
  scores.push({ name: "Дней работы", score: dayScore, max: 20, note: `${daysSince.toFixed(0)}/90 дней` });

  const total_score = scores.reduce((a, s) => a + s.score, 0);
  return { scores, total: total_score, max: 100 };
}

function calcHealth(trades: ClosedPaperTrade[]) {
  const last30  = trades.slice(0, 30);
  const last100 = trades.slice(0, 100);
  const s30  = calcStats(last30);
  const s100 = calcStats(last100);
  const sAll = calcStats(trades);

  let status = "🟢 HEALTHY";
  let reason = "Показатели в норме";
  if (s30 && s30.pf < 0.8)  { status = "🔴 CRITICAL"; reason = "PF последних 30 сделок < 0.8"; }
  else if (s30 && s30.pf < 1.0) { status = "🟡 WARNING"; reason = "PF последних 30 сделок < 1.0"; }
  else if (s30 && s30.wr < 35)  { status = "🟡 WARNING"; reason = "WR последних 30 сделок < 35%"; }

  return { status, reason, s30, s100, sAll };
}

// ── HTML builder ─────────────────────────────────────────────────────────────

function pnlColor(v: number) { return v >= 0 ? "#16a34a" : "#dc2626"; }
function pnlSign(v: number)  { return v >= 0 ? "+" : ""; }
function fmt(v: number, d = 2) { return v.toFixed(d); }
function fmtPrice(v: number) { return v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6); }
function fmtDur(min: number) {
  if (min < 60) return `${Math.round(min)}м`;
  if (min < 1440) return `${Math.round(min / 60)}ч`;
  return `${Math.round(min / 1440)}д`;
}

function outcomeEmoji(o: string) {
  if (o === "TP2") return "🚀";
  if (o === "TP1") return "✅";
  if (o === "BE")  return "🟡";
  if (o === "SL")  return "❌";
  return "—";
}

function buildHtml(d: ReportData): string {
  const dateStr  = new Date(d.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
  const timeStr  = new Date(d.date).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const stats    = calcStats(d.closedTrades);
  const bySymbol = calcBySymbol(d.closedTrades);
  const readiness= calcReadiness(d, stats);
  const health   = calcHealth(d.closedTrades);
  const totalRet = ((d.balance - d.initialBalance) / d.initialBalance) * 100;
  const dd       = d.peakBalance > 0 ? ((d.peakBalance - d.balance) / d.peakBalance) * 100 : 0;

  const now = Date.now();
  const pnlDay  = d.closedTrades.filter(t => now - new Date(t.closedAt).getTime() < 86_400_000).reduce((a, t) => a + t.pnl, 0);
  const pnlWeek = d.closedTrades.filter(t => now - new Date(t.closedAt).getTime() < 604_800_000).reduce((a, t) => a + t.pnl, 0);
  const pnlMonth= d.closedTrades.filter(t => now - new Date(t.closedAt).getTime() < 2_592_000_000).reduce((a, t) => a + t.pnl, 0);

  const champion = d.abVariants.find(v => v.isChampion);
  const active   = d.abVariants.find(v => v.isActive);

  // Strategy rankings
  const stratsSorted = [...d.strategyStats].sort((a, b) => b.profitFactor - a.profitFactor);
  const bestStrats   = stratsSorted.slice(0, 2);
  const worstStrats  = [...stratsSorted].reverse().slice(0, 2);

  // Coin rankings
  const coinsSorted = bySymbol.sort((a, b) => b.pnl - a.pnl);
  const bestCoins   = coinsSorted.slice(0, 5);
  const worstCoins  = [...coinsSorted].reverse().slice(0, 5);

  // Recent trades
  const recentTrades = d.closedTrades.slice(0, 20);

  // Filter stats
  const totalMissed = d.missedTrades.length;
  const filterReasons: Record<string, number> = {};
  for (const mt of d.missedTrades) {
    const r = (mt["filter_reason"] as string) ?? "unknown";
    filterReasons[r] = (filterReasons[r] ?? 0) + 1;
  }

  // AI Summary
  const leadStrat = stratsSorted[0];
  const degradStrat = stratsSorted[stratsSorted.length - 1];
  const aiSummary = buildAISummary(d, stats, health, readiness, leadStrat, degradStrat, dd);

  // Readiness bar color
  const readColor = readiness.total >= 70 ? "#16a34a" : readiness.total >= 40 ? "#d97706" : "#dc2626";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Trading Report — ${dateStr}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;font-size:14px;line-height:1.6}
a{color:#60a5fa}
.wrap{max-width:960px;margin:0 auto;padding:16px}
.header{background:linear-gradient(135deg,#1e3a5f,#0f2027);border-radius:12px;padding:24px;margin-bottom:20px;border:1px solid #1e40af}
.header h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:4px}
.header .sub{color:#94a3b8;font-size:13px}
.header .badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.badge{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;background:#1e40af;color:#bfdbfe}
.badge.paper{background:#065f46;color:#6ee7b7}
.badge.v{background:#312e81;color:#a5b4fc}

.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.kpi{background:#1e293b;border-radius:10px;padding:14px;border:1px solid #334155}
.kpi .label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.kpi .value{font-size:22px;font-weight:700;color:#f1f5f9}
.kpi .value.pos{color:#22c55e}
.kpi .value.neg{color:#ef4444}
.kpi .value.warn{color:#f59e0b}
.kpi .sub{font-size:11px;color:#475569;margin-top:2px}

details{background:#1e293b;border:1px solid #334155;border-radius:10px;margin-bottom:12px;overflow:hidden}
details[open]{border-color:#3b82f6}
summary{padding:14px 16px;cursor:pointer;font-weight:600;font-size:14px;color:#f1f5f9;list-style:none;display:flex;align-items:center;justify-content:space-between;user-select:none}
summary::-webkit-details-marker{display:none}
summary::after{content:"▶";font-size:11px;color:#64748b;transition:transform .2s}
details[open] summary::after{transform:rotate(90deg)}
summary:hover{background:#263348}
.section-body{padding:16px;border-top:1px solid #334155}

table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 10px;background:#0f172a;color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
td{padding:8px 10px;border-bottom:1px solid #1e293b;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#263348}
.pos{color:#22c55e;font-weight:600}
.neg{color:#ef4444;font-weight:600}
.warn{color:#f59e0b;font-weight:600}
.neutral{color:#94a3b8}

.bar-wrap{background:#0f172a;border-radius:4px;height:8px;overflow:hidden;margin-top:4px}
.bar{height:100%;border-radius:4px;transition:width .3s}
.progress-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.progress-label{width:160px;font-size:12px;color:#94a3b8;flex-shrink:0}
.progress-note{font-size:11px;color:#475569;width:120px;text-align:right}
.progress-bar-wrap{flex:1;background:#0f172a;border-radius:4px;height:10px;overflow:hidden}
.progress-bar{height:100%;border-radius:4px}

.tag{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.tag-long{background:#064e3b;color:#6ee7b7}
.tag-short{background:#450a0a;color:#fca5a5}
.tag-tp2{background:#1e3a5f;color:#93c5fd}
.tag-tp1{background:#064e3b;color:#6ee7b7}
.tag-sl{background:#450a0a;color:#fca5a5}
.tag-be{background:#713f12;color:#fde68a}

.health-box{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;font-weight:600;font-size:15px}
.health-green{background:#064e3b;color:#6ee7b7}
.health-yellow{background:#713f12;color:#fde68a}
.health-red{background:#450a0a;color:#fca5a5}

.ai-summary{background:linear-gradient(135deg,#1e3a5f22,#0f202722);border:1px solid #1e40af;border-radius:10px;padding:20px}
.ai-summary h3{color:#60a5fa;margin-bottom:12px;font-size:16px}
.ai-summary ul{padding-left:20px}
.ai-summary li{margin-bottom:6px;color:#cbd5e1}
.ai-summary .highlight{color:#34d399;font-weight:600}
.ai-summary .warn-text{color:#fbbf24;font-weight:600}
.ai-summary .danger{color:#f87171;font-weight:600}

.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.grid2{grid-template-columns:1fr}.kpi-grid{grid-template-columns:repeat(2,1fr)}}

.readiness-score{font-size:48px;font-weight:800;text-align:center;padding:16px}
.divider{border:none;border-top:1px solid #334155;margin:12px 0}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;margin-bottom:8px}
.empty{text-align:center;color:#475569;padding:24px;font-style:italic}
</style>
</head>
<body>
<div class="wrap">

<!-- HEADER -->
<div class="header">
  <h1>📊 AI Trading Report</h1>
  <div class="sub">${dateStr} · ${timeStr} UTC · v${BOT_VERSION}</div>
  <div class="badges">
    <span class="badge paper">Paper Trading</span>
    <span class="badge v">v${BOT_VERSION}</span>
    <span class="badge">21 монета</span>
    <span class="badge">4 стратегии</span>
  </div>
</div>

<!-- KPI ROW -->
<div class="kpi-grid">
  <div class="kpi">
    <div class="label">Баланс</div>
    <div class="value ${totalRet >= 0 ? "pos" : "neg"}">$${fmt(d.balance)}</div>
    <div class="sub">Старт $${fmt(d.initialBalance)}</div>
  </div>
  <div class="kpi">
    <div class="label">Общий P&L</div>
    <div class="value ${totalRet >= 0 ? "pos" : "neg"}">${pnlSign(totalRet)}${fmt(totalRet)}%</div>
    <div class="sub">${pnlSign(d.balance - d.initialBalance)}$${fmt(Math.abs(d.balance - d.initialBalance))}</div>
  </div>
  <div class="kpi">
    <div class="label">WinRate</div>
    <div class="value ${(stats?.wr ?? 0) >= 50 ? "pos" : (stats?.wr ?? 0) >= 40 ? "warn" : "neg"}">${fmt(stats?.wr ?? 0)}%</div>
    <div class="sub">${stats?.wins.length ?? 0}W / ${stats?.losses.length ?? 0}L</div>
  </div>
  <div class="kpi">
    <div class="label">Profit Factor</div>
    <div class="value ${(stats?.pf ?? 0) >= 1.3 ? "pos" : (stats?.pf ?? 0) >= 1 ? "warn" : "neg"}">${stats ? (stats.pf >= 999 ? "∞" : fmt(stats.pf)) : "—"}</div>
    <div class="sub">Целевой: 1.3+</div>
  </div>
  <div class="kpi">
    <div class="label">Просадка</div>
    <div class="value ${dd < 10 ? "pos" : dd < 15 ? "warn" : "neg"}">${fmt(dd)}%</div>
    <div class="sub">Пик $${fmt(d.peakBalance)}</div>
  </div>
  <div class="kpi">
    <div class="label">Открытых</div>
    <div class="value">${d.positions.length}/5</div>
    <div class="sub">Макс. 5 позиций</div>
  </div>
  <div class="kpi">
    <div class="label">Сделок всего</div>
    <div class="value">${d.closedTrades.length}</div>
    <div class="sub">Нужно 100+ для real</div>
  </div>
  <div class="kpi">
    <div class="label">Готовность</div>
    <div class="value" style="color:${readColor}">${readiness.total}/100</div>
    <div class="sub">для реальной торговли</div>
  </div>
</div>

<!-- SECTION 2: Account State -->
<details open>
  <summary>💰 Состояние счёта</summary>
  <div class="section-body">
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Сегодня P&L</div>
        <div class="value ${pnlDay >= 0 ? "pos" : "neg"}">${pnlSign(pnlDay)}$${fmt(Math.abs(pnlDay))}</div></div>
      <div class="kpi"><div class="label">Неделя P&L</div>
        <div class="value ${pnlWeek >= 0 ? "pos" : "neg"}">${pnlSign(pnlWeek)}$${fmt(Math.abs(pnlWeek))}</div></div>
      <div class="kpi"><div class="label">Месяц P&L</div>
        <div class="value ${pnlMonth >= 0 ? "pos" : "neg"}">${pnlSign(pnlMonth)}$${fmt(Math.abs(pnlMonth))}</div></div>
      <div class="kpi"><div class="label">Текущая просадка</div>
        <div class="value ${dd < 10 ? "pos" : "neg"}">${fmt(dd)}%</div></div>
    </div>
    <hr class="divider">
    <div class="section-title">Equity Curve (приблизительно)</div>
    ${buildEquityCurve(d.closedTrades, d.initialBalance)}
  </div>
</details>

<!-- SECTION 3: Trading Stats -->
<details open>
  <summary>📊 Статистика торговли</summary>
  <div class="section-body">
    ${stats ? `
    <table>
      <tr><th>Параметр</th><th>Значение</th><th>Оценка</th></tr>
      <tr><td>Всего сделок</td><td>${d.closedTrades.length}</td><td class="${d.closedTrades.length >= 100 ? "pos" : "warn"}">${d.closedTrades.length >= 100 ? "✅" : "⚠️ нужно 100+"}</td></tr>
      <tr><td>WinRate</td><td><span class="${stats.wr >= 50 ? "pos" : stats.wr >= 40 ? "warn" : "neg"}">${fmt(stats.wr)}%</span></td><td class="${stats.wr >= 50 ? "pos" : "warn"}">${stats.wr >= 45 ? "✅" : "⚠️ нужно 45%+"}</td></tr>
      <tr><td>Profit Factor</td><td><span class="${stats.pf >= 1.3 ? "pos" : stats.pf >= 1 ? "warn" : "neg"}">${stats.pf >= 999 ? "∞" : fmt(stats.pf)}</span></td><td class="${stats.pf >= 1.3 ? "pos" : "warn"}">${stats.pf >= 1.3 ? "✅" : "⚠️ нужно 1.3+"}</td></tr>
      <tr><td>Gross Profit</td><td class="pos">+$${fmt(stats.grossWin)}</td><td></td></tr>
      <tr><td>Gross Loss</td><td class="neg">-$${fmt(stats.grossLoss)}</td><td></td></tr>
      <tr><td>Average Win</td><td class="pos">+${fmt(stats.avgWin)}%</td><td></td></tr>
      <tr><td>Average Loss</td><td class="neg">-${fmt(stats.avgLoss)}%</td><td></td></tr>
      <tr><td>Risk/Reward</td><td>${stats.avgLoss > 0 ? fmt(stats.avgWin / stats.avgLoss) : "∞"}:1</td><td></td></tr>
      <tr><td>Expectancy</td><td class="${stats.expectancy >= 0 ? "pos" : "neg"}">${pnlSign(stats.expectancy)}${fmt(stats.expectancy)}%</td><td class="${stats.expectancy >= 0 ? "pos" : "neg"}">${stats.expectancy >= 0 ? "✅" : "❌"}</td></tr>
      <tr><td>Среднее время сделки</td><td>${fmtDur(stats.avgDuration)}</td><td></td></tr>
      <tr><td>Медиана времени</td><td>${fmtDur(stats.medianDuration)}</td><td></td></tr>
    </table>` : '<div class="empty">Нет закрытых сделок</div>'}
  </div>
</details>

<!-- SECTION 4: Open Positions -->
<details ${d.positions.length > 0 ? "open" : ""}>
  <summary>📂 Открытые позиции (${d.positions.length}/5)</summary>
  <div class="section-body">
    ${d.positions.length === 0
      ? '<div class="empty">Нет открытых позиций</div>'
      : `<table>
      <tr><th>Монета</th><th>Направление</th><th>Стратегия</th><th>Вход</th><th>Текущая</th><th>PnL%</th><th>SL</th><th>TP1</th><th>Статус</th></tr>
      ${d.positions.map(p => {
        const cur = d.positionPrices[p.symbol] ?? p.entryPrice;
        const pnlPct = p.direction === "LONG"
          ? ((cur - p.entryPrice) / p.entryPrice) * 100
          : ((p.entryPrice - cur) / p.entryPrice) * 100;
        const status = p.breakevenMoved ? "🟡 BE" : p.trailAtr ? "↔ Trail" : "🔵 Обычная";
        return `<tr>
          <td><strong>${p.symbol}</strong></td>
          <td><span class="tag ${p.direction === "LONG" ? "tag-long" : "tag-short"}">${p.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT"}</span></td>
          <td>${p.strategy}</td>
          <td>${fmtPrice(p.entryPrice)}</td>
          <td>${fmtPrice(cur)}</td>
          <td class="${pnlPct >= 0 ? "pos" : "neg"}">${pnlSign(pnlPct)}${fmt(pnlPct)}%</td>
          <td class="neg">${fmtPrice(p.stopLoss)}</td>
          <td class="pos">${fmtPrice(p.tp1)}</td>
          <td>${status}</td>
        </tr>`;
      }).join("")}
    </table>`}
  </div>
</details>

<!-- SECTION 5: Strategies -->
<details open>
  <summary>🏆 Стратегии</summary>
  <div class="section-body">
    <table>
      <tr><th>Стратегия</th><th>Сделок</th><th>WR</th><th>PF</th><th>Avg Win</th><th>Avg Loss</th><th>Total P&L</th><th>Вес</th></tr>
      ${d.strategyStats.map(s => {
        const stratWeightKey: Record<string, string> = { TREND: "trend", BREAKOUT: "pattern", VOLUME_IMPULSE: "volume", MEAN_REVERSION: "momentum" };
        const wKey = stratWeightKey[s.strategy] ?? "";
        const w = d.weights[wKey] ?? 0;
        const pfStr = s.profitFactor >= 999 ? "∞" : fmt(s.profitFactor);
        return `<tr>
          <td><strong>${s.strategy}</strong></td>
          <td>${s.trades}</td>
          <td class="${s.winRate >= 50 ? "pos" : s.winRate >= 40 ? "warn" : "neg"}">${fmt(s.winRate)}%</td>
          <td class="${s.profitFactor >= 1.3 ? "pos" : s.profitFactor >= 1 ? "warn" : "neg"}">${pfStr}</td>
          <td class="pos">+${fmt(s.avgWin)}%</td>
          <td class="neg">-${fmt(s.avgLoss)}%</td>
          <td class="${s.totalPnl >= 0 ? "pos" : "neg"}">${pnlSign(s.totalPnl)}${fmt(s.totalPnl)}%</td>
          <td>${(w * 100).toFixed(0)}%</td>
        </tr>`;
      }).join("")}
    </table>
    <hr class="divider">
    <div class="section-title">A/B Тест — Активный вариант</div>
    ${active ? `<p>👑 Чемпион: <strong>${champion?.name ?? "—"}</strong> | Активный: <strong>${active.name}</strong></p>` : "<p class='neutral'>A/B данные накапливаются...</p>"}
  </div>
</details>

<!-- SECTION 6: AI Learning -->
<details>
  <summary>🧠 AI Learning</summary>
  <div class="section-body">
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Обучающих сделок</div>
        <div class="value">${d.closedTrades.length}</div>
        <div class="sub">Из 100 для полного цикла</div>
      </div>
      <div class="kpi"><div class="label">Чемпион A/B</div>
        <div class="value" style="font-size:16px">${champion?.name ?? "Определяется"}</div>
        <div class="sub">${champion ? `Сделок: ${champion.trades}` : "Нужно 20+ сделок"}</div>
      </div>
    </div>
    <hr class="divider">
    <div class="section-title">Текущие веса факторов</div>
    ${Object.entries(d.weights).map(([k, v]) => `
      <div class="progress-row">
        <div class="progress-label">${k}</div>
        <div class="progress-bar-wrap"><div class="progress-bar" style="width:${(v*100).toFixed(0)}%;background:#3b82f6"></div></div>
        <div class="progress-note">${(v * 100).toFixed(1)}%</div>
      </div>`).join("")}
    <hr class="divider">
    <div class="section-title">A/B Варианты</div>
    <table>
      <tr><th>Вариант</th><th>Сделок</th><th>WR</th><th>PF</th><th>Статус</th></tr>
      ${d.abVariants.map(v => {
        const wr = v.trades > 0 ? (v.wins / v.trades * 100).toFixed(1) : "—";
        const pfl = Number(v.lossPnl) > 0 ? (Number(v.winPnl) / Number(v.lossPnl)).toFixed(2) : "∞";
        return `<tr>
          <td>${v.name}</td>
          <td>${v.trades}</td>
          <td>${wr}%</td>
          <td>${pfl}</td>
          <td>${v.isChampion ? "👑 Чемпион" : v.isActive ? "🎯 Активный" : "⏳ Тест"}</td>
        </tr>`;
      }).join("")}
    </table>
  </div>
</details>

<!-- SECTION 7: Readiness -->
<details>
  <summary>🎯 Readiness для реальной торговли</summary>
  <div class="section-body">
    <div style="text-align:center;margin-bottom:16px">
      <div class="readiness-score" style="color:${readColor}">${readiness.total}/100</div>
      <div style="color:#64748b;font-size:13px">${readiness.total >= 70 ? "✅ Близко к готовности" : readiness.total >= 40 ? "⚠️ Нужно больше данных" : "❌ Ещё не готов — продолжай бумажную торговлю"}</div>
    </div>
    ${readiness.scores.map(s => `
      <div class="progress-row">
        <div class="progress-label">${s.name}</div>
        <div class="progress-bar-wrap">
          <div class="progress-bar" style="width:${(s.score/s.max*100).toFixed(0)}%;background:${s.score === s.max ? "#16a34a" : s.score > s.max/2 ? "#d97706" : "#dc2626"}"></div>
        </div>
        <div class="progress-note">${s.score}/${s.max} · ${s.note}</div>
      </div>`).join("")}
  </div>
</details>

<!-- SECTION 8: Health -->
<details>
  <summary>❤️ Health Status</summary>
  <div class="section-body">
    <div style="margin-bottom:16px">
      <div class="health-box ${health.status.includes("HEALTHY") ? "health-green" : health.status.includes("WARNING") ? "health-yellow" : "health-red"}">${health.status}</div>
      <p style="margin-top:8px;color:#94a3b8">${health.reason}</p>
    </div>
    <table>
      <tr><th>Метрика</th><th>Последние 30</th><th>Последние 100</th><th>Все сделки</th></tr>
      <tr><td>WinRate</td>
        <td class="${(health.s30?.wr ?? 0) >= 45 ? "pos" : "warn"}">${health.s30 ? fmt(health.s30.wr) + "%" : "—"}</td>
        <td class="${(health.s100?.wr ?? 0) >= 45 ? "pos" : "warn"}">${health.s100 ? fmt(health.s100.wr) + "%" : "—"}</td>
        <td class="${(health.sAll?.wr ?? 0) >= 45 ? "pos" : "warn"}">${health.sAll ? fmt(health.sAll.wr) + "%" : "—"}</td>
      </tr>
      <tr><td>Profit Factor</td>
        <td class="${(health.s30?.pf ?? 0) >= 1.3 ? "pos" : (health.s30?.pf ?? 0) >= 1 ? "warn" : "neg"}">${health.s30 ? (health.s30.pf >= 999 ? "∞" : fmt(health.s30.pf)) : "—"}</td>
        <td class="${(health.s100?.pf ?? 0) >= 1.3 ? "pos" : (health.s100?.pf ?? 0) >= 1 ? "warn" : "neg"}">${health.s100 ? (health.s100.pf >= 999 ? "∞" : fmt(health.s100.pf)) : "—"}</td>
        <td class="${(health.sAll?.pf ?? 0) >= 1.3 ? "pos" : (health.sAll?.pf ?? 0) >= 1 ? "warn" : "neg"}">${health.sAll ? (health.sAll.pf >= 999 ? "∞" : fmt(health.sAll.pf)) : "—"}</td>
      </tr>
      <tr><td>Expectancy</td>
        <td class="${(health.s30?.expectancy ?? 0) >= 0 ? "pos" : "neg"}">${health.s30 ? pnlSign(health.s30.expectancy) + fmt(health.s30.expectancy) + "%" : "—"}</td>
        <td class="${(health.s100?.expectancy ?? 0) >= 0 ? "pos" : "neg"}">${health.s100 ? pnlSign(health.s100.expectancy) + fmt(health.s100.expectancy) + "%" : "—"}</td>
        <td class="${(health.sAll?.expectancy ?? 0) >= 0 ? "pos" : "neg"}">${health.sAll ? pnlSign(health.sAll.expectancy) + fmt(health.sAll.expectancy) + "%" : "—"}</td>
      </tr>
    </table>
  </div>
</details>

<!-- SECTIONS 9+10: Best/Worst Strategies -->
<details>
  <summary>📈 Лучшие и худшие стратегии</summary>
  <div class="section-body">
    <div class="grid2">
      <div>
        <div class="section-title">🏆 Лучшие</div>
        <table>
          <tr><th>Стратегия</th><th>WR</th><th>PF</th><th>P&L</th></tr>
          ${bestStrats.map(s => `<tr>
            <td>${s.strategy}</td>
            <td class="pos">${fmt(s.winRate)}%</td>
            <td class="pos">${s.profitFactor >= 999 ? "∞" : fmt(s.profitFactor)}</td>
            <td class="${s.totalPnl >= 0 ? "pos" : "neg"}">${pnlSign(s.totalPnl)}${fmt(s.totalPnl)}%</td>
          </tr>`).join("")}
        </table>
      </div>
      <div>
        <div class="section-title">📉 Худшие</div>
        <table>
          <tr><th>Стратегия</th><th>WR</th><th>PF</th><th>P&L</th></tr>
          ${worstStrats.map(s => `<tr>
            <td>${s.strategy}</td>
            <td class="${s.winRate >= 40 ? "warn" : "neg"}">${fmt(s.winRate)}%</td>
            <td class="${s.profitFactor >= 1 ? "warn" : "neg"}">${s.profitFactor >= 999 ? "∞" : fmt(s.profitFactor)}</td>
            <td class="${s.totalPnl >= 0 ? "pos" : "neg"}">${pnlSign(s.totalPnl)}${fmt(s.totalPnl)}%</td>
          </tr>`).join("")}
        </table>
      </div>
    </div>
  </div>
</details>

<!-- SECTIONS 11+12: Best/Worst Coins -->
<details>
  <summary>🪙 Лучшие и худшие монеты</summary>
  <div class="section-body">
    <div class="grid2">
      <div>
        <div class="section-title">🏆 Лучшие</div>
        ${bestCoins.length ? `<table>
          <tr><th>Символ</th><th>Сделок</th><th>WR</th><th>PF</th><th>P&L</th></tr>
          ${bestCoins.map(c => `<tr>
            <td>${c.symbol}</td><td>${c.trades}</td>
            <td class="pos">${fmt(c.wr)}%</td>
            <td class="${c.pf >= 1.3 ? "pos" : "warn"}">${c.pf >= 999 ? "∞" : fmt(c.pf)}</td>
            <td class="pos">${pnlSign(c.pnl)}${fmt(c.pnl)}%</td>
          </tr>`).join("")}
        </table>` : '<div class="empty">Нет данных</div>'}
      </div>
      <div>
        <div class="section-title">📉 Худшие</div>
        ${worstCoins.length ? `<table>
          <tr><th>Символ</th><th>Сделок</th><th>WR</th><th>PF</th><th>P&L</th></tr>
          ${worstCoins.map(c => `<tr>
            <td>${c.symbol}</td><td>${c.trades}</td>
            <td class="${c.wr >= 40 ? "warn" : "neg"}">${fmt(c.wr)}%</td>
            <td class="${c.pf >= 1 ? "warn" : "neg"}">${c.pf >= 999 ? "∞" : fmt(c.pf)}</td>
            <td class="${c.pnl >= 0 ? "pos" : "neg"}">${pnlSign(c.pnl)}${fmt(c.pnl)}%</td>
          </tr>`).join("")}
        </table>` : '<div class="empty">Нет данных</div>'}
      </div>
    </div>
  </div>
</details>

<!-- SECTION 13: Recent Trades -->
<details>
  <summary>🕐 Последние сделки (${recentTrades.length})</summary>
  <div class="section-body">
    ${recentTrades.length === 0 ? '<div class="empty">Нет закрытых сделок</div>' : `
    <table>
      <tr><th>Время</th><th>Монета</th><th>Dir</th><th>Стратегия</th><th>Исход</th><th>P&L</th></tr>
      ${recentTrades.map(t => `<tr>
        <td class="neutral" style="font-size:12px">${new Date(t.closedAt).toLocaleString("ru-RU", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
        <td><strong>${t.symbol}</strong></td>
        <td><span class="tag ${t.direction === "LONG" ? "tag-long" : "tag-short"}">${t.direction}</span></td>
        <td style="font-size:12px">${t.strategy}</td>
        <td><span class="tag tag-${t.outcome.toLowerCase()}">${outcomeEmoji(t.outcome)} ${t.outcome}</span></td>
        <td class="${t.pnl >= 0 ? "pos" : "neg"}">${pnlSign(t.pnlPercent)}${fmt(t.pnlPercent)}%</td>
      </tr>`).join("")}
    </table>`}
  </div>
</details>

<!-- SECTION 15: Time Stats -->
<details>
  <summary>⏰ Статистика по времени</summary>
  <div class="section-body">
    ${stats && Object.keys(stats.byHour).length > 0 ? `
    <div class="section-title">WR по часам (UTC)</div>
    <table>
      <tr><th>Час</th><th>Сделок</th><th>WR</th><th>Оценка</th></tr>
      ${Object.entries(stats.byHour)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([h, v]) => {
          const wr = (v.wins / v.total * 100);
          return `<tr>
            <td>${String(h).padStart(2, "0")}:00–${String((Number(h) + 1) % 24).padStart(2, "0")}:00</td>
            <td>${v.total}</td>
            <td class="${wr >= 55 ? "pos" : wr >= 40 ? "warn" : "neg"}">${wr.toFixed(0)}%</td>
            <td>${wr >= 60 ? "🔥 Лучший" : wr >= 50 ? "✅ Хороший" : wr >= 40 ? "⚠️ Слабый" : "❌ Плохой"}</td>
          </tr>`;
        }).join("")}
    </table>` : '<div class="empty">Недостаточно данных</div>'}
  </div>
</details>

<!-- SECTION 16: Filters -->
<details>
  <summary>🔍 Статистика фильтров</summary>
  <div class="section-body">
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="kpi"><div class="label">Пропущено сигналов</div><div class="value warn">${totalMissed}</div></div>
      <div class="kpi"><div class="label">Открыто сделок</div><div class="value pos">${d.closedTrades.length + d.positions.length}</div></div>
      <div class="kpi"><div class="label">% принято</div>
        <div class="value">${totalMissed + d.closedTrades.length > 0 ? ((d.closedTrades.length / (totalMissed + d.closedTrades.length)) * 100).toFixed(1) : 0}%</div>
      </div>
    </div>
    ${Object.keys(filterReasons).length > 0 ? `
    <hr class="divider">
    <div class="section-title">Причины отклонения</div>
    <table>
      <tr><th>Причина</th><th>Кол-во</th><th>Доля</th></tr>
      ${Object.entries(filterReasons)
        .sort(([, a], [, b]) => b - a)
        .map(([r, n]) => `<tr>
          <td>${r}</td>
          <td>${n}</td>
          <td class="neutral">${totalMissed > 0 ? ((n / totalMissed) * 100).toFixed(1) : 0}%</td>
        </tr>`).join("")}
    </table>` : ""}
  </div>
</details>

<!-- SECTION 17: AI Summary -->
<div class="ai-summary" style="margin-bottom:20px">
  <h3>🤖 AI Summary</h3>
  ${aiSummary}
</div>

<div style="text-align:center;color:#334155;font-size:12px;padding:16px">
  Сгенерировано автоматически · ${new Date(d.date).toUTCString()} · AI Paper Trader v${BOT_VERSION}
</div>

</div>
</body>
</html>`;
}

function buildEquityCurve(trades: ClosedPaperTrade[], initialBalance: number): string {
  if (trades.length < 2) return '<div class="empty">Нет данных</div>';
  const reversed = [...trades].reverse();
  let bal = initialBalance;
  const points = [{ x: 0, bal }];
  for (let i = 0; i < reversed.length; i++) {
    bal += reversed[i]!.pnl;
    points.push({ x: i + 1, bal });
  }
  const maxB = Math.max(...points.map(p => p.bal));
  const minB = Math.min(...points.map(p => p.bal));
  const range = maxB - minB || 1;
  const W = 600, H = 80;
  const pts = points.map((p, i) => {
    const x = Math.round((i / (points.length - 1)) * W);
    const y = Math.round(H - ((p.bal - minB) / range) * H);
    return `${x},${y}`;
  }).join(" ");
  const finalColor = bal >= initialBalance ? "#22c55e" : "#ef4444";
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:80px;border-radius:6px;background:#0f172a">
    <polyline points="${pts}" fill="none" stroke="${finalColor}" stroke-width="2"/>
    <line x1="0" y1="${Math.round(H - ((initialBalance - minB) / range) * H)}" x2="${W}" y2="${Math.round(H - ((initialBalance - minB) / range) * H)}" stroke="#334155" stroke-width="1" stroke-dasharray="4"/>
  </svg>`;
}

function buildAISummary(
  d: ReportData,
  stats: ReturnType<typeof calcStats>,
  health: ReturnType<typeof calcHealth>,
  readiness: ReturnType<typeof calcReadiness>,
  leadStrat: StrategyStats | undefined,
  degradStrat: StrategyStats | undefined,
  dd: number
): string {
  const items: string[] = [];

  // What improved
  if (stats && stats.wr >= 50)
    items.push(`<li>✅ <span class="highlight">WR ${stats.wr.toFixed(1)}%</span> — выше 50%, это хороший результат</li>`);
  if (stats && stats.pf >= 1.3)
    items.push(`<li>✅ <span class="highlight">PF ${stats.pf.toFixed(2)}</span> — превышает целевой 1.3</li>`);
  if (dd < 5)
    items.push(`<li>✅ Просадка ${dd.toFixed(2)}% — отлично, риск под контролем</li>`);

  // What's bad
  if (stats && stats.wr < 40)
    items.push(`<li>⚠️ <span class="warn-text">WR ${stats.wr.toFixed(1)}%</span> — ниже нормы, фильтры слишком мягкие или рынок сложный</li>`);
  if (stats && stats.pf < 1.0 && stats.pf > 0)
    items.push(`<li>⚠️ <span class="warn-text">PF ${stats.pf.toFixed(2)}</span> — убыточный, нужно поднять порог score</li>`);
  if (dd > 10)
    items.push(`<li>⚠️ <span class="danger">Просадка ${dd.toFixed(2)}%</span> — высокая, рассмотри снижение risk%</li>`);

  // Leader / degrading
  if (leadStrat && leadStrat.trades > 0)
    items.push(`<li>🏆 Лидирует стратегия <span class="highlight">${leadStrat.strategy}</span> — PF ${leadStrat.profitFactor >= 999 ? "∞" : leadStrat.profitFactor.toFixed(2)}, WR ${leadStrat.winRate.toFixed(1)}%</li>`);
  if (degradStrat && degradStrat.trades > 0 && degradStrat.strategy !== leadStrat?.strategy)
    items.push(`<li>📉 Слабейшая стратегия: <span class="warn-text">${degradStrat.strategy}</span> — PF ${degradStrat.profitFactor >= 999 ? "∞" : degradStrat.profitFactor.toFixed(2)}</li>`);

  // Recommendations
  items.push(`<li>💡 Рекомендация: ${
    d.closedTrades.length < 20
      ? "Накопи 20+ сделок прежде чем делать выводы"
      : stats && stats.pf < 1.0
      ? "Повысь AUTO_MIN_SCORE до 55+ чтобы улучшить качество сигналов"
      : dd > 15
      ? "Снизь riskPercent с 1% до 0.5% для уменьшения просадки"
      : "Продолжай бумажную торговлю, накапливай статистику"
  }</li>`);

  // Readiness
  items.push(`<li>🎯 Готовность к реальной торговле: <span class="${readiness.total >= 70 ? "highlight" : "warn-text"}">${readiness.total}/100</span>${readiness.total < 70 ? " — нужно больше данных" : " — почти готов!"}</li>`);

  return `<ul>${items.join("")}</ul>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ReportResult {
  html: Buffer;
  filename: string;
  summary: string;
}

export async function generateDailyReport(chatId: number): Promise<ReportResult> {
  const data = await collectData(chatId);
  const html = buildHtml(data);
  const stats = calcStats(data.closedTrades);
  const dd = data.peakBalance > 0 ? ((data.peakBalance - data.balance) / data.peakBalance) * 100 : 0;
  const totalRet = ((data.balance - data.initialBalance) / data.initialBalance) * 100;

  const dateTag = new Date().toISOString().slice(0, 10);
  const filename = `report_${dateTag}.html`;

  const summary =
    `📊 *Daily Report — ${dateTag}*\n\n` +
    `💰 Баланс: *$${data.balance.toFixed(2)}* (${totalRet >= 0 ? "+" : ""}${totalRet.toFixed(2)}%)\n` +
    `📈 PF: *${stats ? (stats.pf >= 999 ? "∞" : stats.pf.toFixed(2)) : "—"}*\n` +
    `🎯 WR: *${stats ? stats.wr.toFixed(1) + "%" : "—"}*\n` +
    `📉 Просадка: *${dd.toFixed(2)}%*\n` +
    `📂 Сделок: *${data.closedTrades.length}*\n\n` +
    `📄 Полный отчёт — файл ниже`;

  return { html: Buffer.from(html, "utf8"), filename, summary };
}
