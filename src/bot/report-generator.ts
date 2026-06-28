import { pool } from "../lib/db.js";
import { loadPaperAccount, loadWeights, type ClosedPaperTrade, type PaperPosition } from "./storage.js";
import { loadStrategyStats, type StrategyStats } from "./strategies.js";
import { loadABVariants } from "./ab-testing.js";
import { getPrice } from "./binance.js";
import { getRecentDecisionLog, getDecisionStats, type DecisionTrace } from "./decision-trace.js";
import { logger } from "../lib/logger.js";

const BOT_VERSION = "1.0.0-phase1";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WindowStats {
  label: string;
  trades: number;
  wr: number; pf: number; expectancy: number; rr: number;
  avgWin: number; avgLoss: number;
  maxLossStreak: number; maxWinStreak: number;
  grossWin: number; grossLoss: number;
}

interface StrategyDetail {
  strategy: string;
  trades: number; wins: number; losses: number;
  winRate: number; profitFactor: number; expectancy: number;
  avgWin: number; avgLoss: number;
  tp1: number; tp2: number; sl: number;
  avgDuration: number; maxDrawdown: number;
  last30: number; totalPnl: number;
  weight: number; quarantine: boolean; trustScore: number;
  disabledUntil: string | null;
}

interface CoinDetail {
  symbol: string; trades: number; wins: number;
  winRate: number; profitFactor: number; expectancy: number;
  totalPnl: number; avgDuration: number;
}

interface ReportData {
  date: string; chatId: number;
  balance: number; initialBalance: number; peakBalance: number;
  positions: PaperPosition[];
  closedTrades: ClosedPaperTrade[];
  strategyStats: StrategyStats[];
  strategyDetails: StrategyDetail[];
  coinDetails: CoinDetail[];
  weights: Record<string, number>;
  riskState: Record<string, unknown>;
  missedTrades: Array<Record<string, unknown>>;
  abVariants: Awaited<ReturnType<typeof loadABVariants>>;
  positionPrices: Record<string, number>;
  decisionLog: DecisionTrace[];
  decisionStats: Awaited<ReturnType<typeof getDecisionStats>>;
  learningReports: Array<Record<string, unknown>>;
  strategyHistory: Array<Record<string, unknown>>;
  strategyWeights: Array<Record<string, unknown>>;
}

// ── Data collection ───────────────────────────────────────────────────────────

async function collectData(chatId: number): Promise<ReportData> {
  const [account, strategyStats, weights, abVariants, decisionLog, decisionStats] = await Promise.all([
    loadPaperAccount(chatId),
    loadStrategyStats(),
    loadWeights(),
    loadABVariants(),
    getRecentDecisionLog(30),
    getDecisionStats(),
  ]);

  const [riskRes, missedRes, lrRes, shRes, swRes] = await Promise.all([
    pool.query("SELECT * FROM risk_state WHERE id=1"),
    pool.query("SELECT * FROM missed_trades ORDER BY timestamp DESC LIMIT 200"),
    pool.query("SELECT version_label,created_at,trade_count_at_report,summary FROM learning_reports ORDER BY created_at DESC LIMIT 5").catch(() => ({ rows: [] })),
    pool.query("SELECT * FROM strategy_history ORDER BY changed_at DESC LIMIT 30").catch(() => ({ rows: [] })),
    pool.query("SELECT * FROM strategy_weights").catch(() => ({ rows: [] })),
  ]);

  const positionPrices: Record<string, number> = {};
  await Promise.all(account.positions.map(async (p) => {
    try { positionPrices[p.symbol] = await getPrice(p.symbol); }
    catch { positionPrices[p.symbol] = p.entryPrice; }
  }));

  const closedTrades = account.closedTrades;
  const strategyWeights = swRes.rows as Array<Record<string, unknown>>;
  const strategyDetails = buildStrategyDetails(closedTrades, strategyStats, strategyWeights);
  const coinDetails = buildCoinDetails(closedTrades);

  return {
    date: new Date().toISOString(), chatId,
    balance: account.balance, initialBalance: account.initialBalance,
    peakBalance: account.peakBalance ?? account.balance,
    positions: account.positions, closedTrades, strategyStats,
    strategyDetails, coinDetails, weights,
    riskState: (riskRes.rows[0] ?? {}) as Record<string, unknown>,
    missedTrades: missedRes.rows as Array<Record<string, unknown>>,
    abVariants, positionPrices, decisionLog, decisionStats,
    learningReports: lrRes.rows as Array<Record<string, unknown>>,
    strategyHistory: shRes.rows as Array<Record<string, unknown>>,
    strategyWeights,
  };
}

// ── Stats calculators ─────────────────────────────────────────────────────────

function calcWindow(trades: ClosedPaperTrade[], label: string): WindowStats | null {
  if (!trades.length) return null;
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? 999 : 0;
  const aw = wins.length ? wins.reduce((a, t) => a + t.pnlPercent, 0) / wins.length : 0;
  const al = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0) / losses.length) : 0;
  const wr = wins.length / trades.length * 100;
  const exp = (wr / 100) * aw - ((100 - wr) / 100) * al;
  const rr = al > 0 ? aw / al : aw > 0 ? 999 : 0;

  // streak calculation
  let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
    else { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss); }
  }
  return { label, trades: trades.length, wr, pf, expectancy: exp, rr, avgWin: aw, avgLoss: al, maxLossStreak: maxLoss, maxWinStreak: maxWin, grossWin: gw, grossLoss: gl };
}

function buildStrategyDetails(trades: ClosedPaperTrade[], stats: StrategyStats[], weights: Array<Record<string, unknown>>): StrategyDetail[] {
  const strats = ["TREND", "BREAKOUT", "VOLUME_IMPULSE", "MEAN_REVERSION"];
  const now = Date.now();
  return strats.map(strat => {
    const st = trades.filter(t => t.strategy === strat);
    const wins = st.filter(t => t.pnl > 0);
    const losses = st.filter(t => t.pnl <= 0);
    const gw = wins.reduce((a, t) => a + t.pnl, 0);
    const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? 999 : 0;
    const aw = wins.length ? wins.reduce((a, t) => a + t.pnlPercent, 0) / wins.length : 0;
    const al = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0) / losses.length) : 0;
    const wr = st.length ? wins.length / st.length * 100 : 0;
    const exp = st.length ? (wr / 100) * aw - ((100 - wr) / 100) * al : 0;

    // duration
    const durs = st.filter(t => t.openedAt && t.closedAt)
      .map(t => (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 60000);
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;

    // max drawdown per strategy (sequential equity)
    let peak = 0, maxDd = 0, bal = 0;
    for (const t of [...st].reverse()) {
      bal += t.pnl; if (bal > peak) peak = bal;
      const dd = peak > 0 ? (peak - bal) / peak * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }

    const last30 = st.filter(t => now - new Date(t.closedAt).getTime() < 30 * 86400000).length;
    const wRow = weights.find(w => w["strategy"] === strat);
    const ss = stats.find(s => s.strategy === strat);

    return {
      strategy: strat, trades: st.length, wins: wins.length, losses: losses.length,
      winRate: wr, profitFactor: pf, expectancy: exp, avgWin: aw, avgLoss: al,
      tp1: st.filter(t => t.outcome === "TP1").length,
      tp2: st.filter(t => t.outcome === "TP2").length,
      sl: st.filter(t => t.outcome === "SL").length,
      avgDuration: avgDur, maxDrawdown: maxDd, last30,
      totalPnl: ss?.totalPnl ?? 0,
      weight: wRow ? Number(wRow["weight"]) : 1,
      quarantine: wRow ? Boolean(wRow["quarantine"]) : false,
      trustScore: wRow ? Number(wRow["trust_score"]) : 50,
      disabledUntil: wRow ? (wRow["disabled_until"] as string | null) : null,
    };
  });
}

function buildCoinDetails(trades: ClosedPaperTrade[]): CoinDetail[] {
  const map: Record<string, ClosedPaperTrade[]> = {};
  for (const t of trades) { if (!map[t.symbol]) map[t.symbol] = []; map[t.symbol]!.push(t); }
  return Object.entries(map).map(([symbol, st]) => {
    const wins = st.filter(t => t.pnl > 0);
    const losses = st.filter(t => t.pnl <= 0);
    const gw = wins.reduce((a, t) => a + t.pnl, 0);
    const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : gw > 0 ? 999 : 0;
    const aw = wins.length ? wins.reduce((a, t) => a + t.pnlPercent, 0) / wins.length : 0;
    const al = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0) / losses.length) : 0;
    const wr = wins.length / st.length * 100;
    const exp = (wr / 100) * aw - ((100 - wr) / 100) * al;
    const durs = st.filter(t => t.openedAt && t.closedAt)
      .map(t => (new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 60000);
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0;
    return { symbol, trades: st.length, wins: wins.length, winRate: wr, profitFactor: pf, expectancy: exp, totalPnl: st.reduce((a, t) => a + t.pnlPercent, 0), avgDuration: avgDur };
  }).sort((a, b) => b.trades - a.trades);
}

// ── Readiness (пункт 1: переработана формула) ─────────────────────────────────

function calcReadiness(d: ReportData, win: WindowStats | null) {
  const scores: Array<{ name: string; score: number; max: number; note: string }> = [];
  const total = d.closedTrades.length;
  const pf = win?.pf ?? 0;
  const wr = win?.wr ?? 0;
  const dd = d.peakBalance > 0 ? ((d.peakBalance - d.balance) / d.peakBalance) * 100 : 0;

  // Profit Factor — 30 pts (главный критерий)
  const pfScore = pf >= 1.5 ? 30 : pf >= 1.3 ? 24 : pf >= 1.1 ? 16 : pf >= 1.0 ? 10 : Math.round(pf * 8);
  scores.push({ name: "Profit Factor", score: pfScore, max: 30, note: `${pf >= 999 ? "∞" : pf.toFixed(2)} (нужно 1.3+)` });

  // WinRate — 20 pts
  const wrScore = wr >= 55 ? 20 : wr >= 50 ? 16 : wr >= 45 ? 12 : wr >= 40 ? 7 : Math.round(wr / 40 * 5);
  scores.push({ name: "WinRate", score: wrScore, max: 20, note: `${wr.toFixed(1)}% (нужно 45%+)` });

  // Просадка — 20 pts
  const ddScore = dd < 5 ? 20 : dd < 10 ? 16 : dd < 15 ? 10 : dd < 20 ? 5 : 0;
  scores.push({ name: "Просадка", score: ddScore, max: 20, note: `${dd.toFixed(2)}% (нужно <10%)` });

  // Количество дней непрерывной работы — 20 pts
  const oldest = d.closedTrades.length
    ? new Date(d.closedTrades[d.closedTrades.length - 1]!.openedAt).getTime()
    : Date.now();
  const days = (Date.now() - oldest) / 86400000;
  const dayScore = days >= 90 ? 20 : days >= 60 ? 16 : days >= 30 ? 10 : days >= 14 ? 6 : days >= 7 ? 3 : Math.round(days / 7 * 3);
  scores.push({ name: "Дней работы", score: dayScore, max: 20, note: `${days.toFixed(0)}/90 дней` });

  // Стабильность последних 30 сделок — 10 pts
  const last30w = calcWindow(d.closedTrades.slice(0, 30), "");
  const stabScore = last30w && last30w.pf >= 1.3 ? 10 : last30w && last30w.pf >= 1.0 ? 6 : last30w && last30w.pf >= 0.8 ? 3 : 0;
  scores.push({ name: "Стабильность (посл. 30)", score: stabScore, max: 10, note: `PF посл. 30: ${last30w ? (last30w.pf >= 999 ? "∞" : last30w.pf.toFixed(2)) : "—"}` });

  let totalScore = scores.reduce((a, s) => a + s.score, 0);

  // Жёсткое ограничение: PF < 1.0 → максимум 50
  if (pf < 1.0 && pf > 0) totalScore = Math.min(50, totalScore);
  // PF = 0 или нет сделок → максимум 30
  if (pf === 0 || total === 0) totalScore = Math.min(30, totalScore);

  return { scores, total: totalScore, max: 100, pfPenalty: pf < 1.0 && pf > 0 };
}

// ── Period comparison (пункт 9) ───────────────────────────────────────────────

function calcPeriodComparison(trades: ClosedPaperTrade[]) {
  const now = Date.now();
  const today    = trades.filter(t => now - new Date(t.closedAt).getTime() < 86400000);
  const yesterday= trades.filter(t => { const a = now - new Date(t.closedAt).getTime(); return a >= 86400000 && a < 172800000; });
  const last7    = trades.filter(t => now - new Date(t.closedAt).getTime() < 7 * 86400000);
  const prev7    = trades.filter(t => { const a = now - new Date(t.closedAt).getTime(); return a >= 7*86400000 && a < 14*86400000; });
  const last30t  = trades.slice(0, 30);
  const prev30t  = trades.slice(30, 60);

  return [
    { label: "Сегодня", a: calcWindow(today, "Сегодня"), b: calcWindow(yesterday, "Вчера"), bLabel: "Вчера" },
    { label: "Последние 7д", a: calcWindow(last7, "7д"), b: calcWindow(prev7, "Пред. 7д"), bLabel: "Пред. 7д" },
    { label: "Последние 30 сделок", a: calcWindow(last30t, "Посл. 30"), b: calcWindow(prev30t, "Пред. 30"), bLabel: "Пред. 30" },
  ];
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function ps(v: number) { return v >= 0 ? "+" : ""; }
function fmt(v: number, d = 2) { return isFinite(v) ? v.toFixed(d) : "0.00"; }
function fmtPrice(v: number) { return v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6); }
function fmtDur(min: number) {
  if (!isFinite(min) || min <= 0) return "—";
  if (min < 60) return `${Math.round(min)}м`;
  if (min < 1440) return `${Math.round(min / 60)}ч`;
  return `${Math.round(min / 1440)}д`;
}
function oe(o: string) { return o === "TP2" ? "🚀" : o === "TP1" ? "✅" : o === "BE" ? "🟡" : o === "SL" ? "❌" : "—"; }
function esc(s: string) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function pfClass(v: number) { return v >= 1.3 ? "pos" : v >= 1.0 ? "warn" : "neg"; }
function wrClass(v: number) { return v >= 50 ? "pos" : v >= 40 ? "warn" : "neg"; }

function arrow(a: number | undefined, b: number | undefined, higher = true): string {
  if (a === undefined || b === undefined) return "";
  const better = higher ? a > b : a < b;
  const same = Math.abs((a - b) / (b || 1)) < 0.02;
  return same ? "→" : better ? "▲" : "▼";
}

function winStat(w: WindowStats | null): string {
  if (!w || !w.trades) return '<td colspan="8" class="empty">нет сделок</td>';
  return `<td>${w.trades}</td>
    <td class="${wrClass(w.wr)}">${fmt(w.wr)}%</td>
    <td class="${pfClass(w.pf)}">${w.pf >= 999 ? "∞" : fmt(w.pf)}</td>
    <td class="${w.expectancy >= 0 ? "pos" : "neg"}">${ps(w.expectancy)}${fmt(w.expectancy)}%</td>
    <td>${fmt(w.rr)}:1</td>
    <td class="pos">+${fmt(w.avgWin)}%</td>
    <td class="neg">-${fmt(w.avgLoss)}%</td>
    <td class="warn">${w.maxLossStreak} / <span class="pos">${w.maxWinStreak}</span></td>`;
}

// ── Equity curve ──────────────────────────────────────────────────────────────

function buildEquityCurve(trades: ClosedPaperTrade[], initialBalance: number): string {
  if (trades.length < 2) return '<div class="empty">Нет данных</div>';
  const rev = [...trades].reverse();
  let bal = initialBalance, peak = initialBalance, maxDd = 0;
  const points: Array<{ x: number; bal: number }> = [{ x: 0, bal }];
  let newHighs = 0;
  for (let i = 0; i < rev.length; i++) {
    bal += rev[i]!.pnl;
    if (bal > peak) { peak = bal; newHighs++; }
    const dd = (peak - bal) / peak * 100;
    if (dd > maxDd) maxDd = dd;
    points.push({ x: i + 1, bal });
  }
  const maxB = Math.max(...points.map(p => p.bal));
  const minB = Math.min(...points.map(p => p.bal));
  const range = maxB - minB || 1;
  const W = 600, H = 100;
  const pts = points.map((p, i) => {
    const x = Math.round((i / (points.length - 1)) * W);
    const y = Math.round(H - ((p.bal - minB) / range) * H);
    return `${x},${y}`;
  }).join(" ");
  const lineColor = bal >= initialBalance ? "#22c55e" : "#ef4444";
  const initY = Math.round(H - ((initialBalance - minB) / range) * H);
  return `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">
      <span class="neutral" style="font-size:12px">📈 Новые максимумы: <strong class="pos">${newHighs}</strong></span>
      <span class="neutral" style="font-size:12px">📉 Макс. просадка: <strong class="${maxDd < 10 ? "pos" : maxDd < 15 ? "warn" : "neg"}">${maxDd.toFixed(2)}%</strong></span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100px;border-radius:6px;background:#0f172a">
      <defs><linearGradient id="ec" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0"/>
      </linearGradient></defs>
      <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="2"/>
      <line x1="0" y1="${initY}" x2="${W}" y2="${initY}" stroke="#334155" stroke-width="1" stroke-dasharray="4"/>
    </svg>`;
}

// ── Decision Log section ──────────────────────────────────────────────────────

function buildDecisionLogSection(log: DecisionTrace[], stats: Awaited<ReturnType<typeof getDecisionStats>>): string {
  const statsHtml = `
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
      <div class="kpi"><div class="label">Сигналов (7 дней)</div><div class="value">${stats.total}</div></div>
      <div class="kpi"><div class="label">Открыто</div><div class="value pos">${stats.opened}</div></div>
      <div class="kpi"><div class="label">Отклонено</div><div class="value warn">${stats.rejected}</div></div>
    </div>
    ${stats.topRejectReasons.length ? `
    <div class="section-title">Топ причины отклонения (7 дней)</div>
    <table style="margin-bottom:16px">
      <tr><th>Причина</th><th>Кол-во</th></tr>
      ${stats.topRejectReasons.map(r => `<tr><td>${esc(r.reason)}</td><td class="warn">${r.count}</td></tr>`).join("")}
    </table>` : ""}`;

  if (!log.length) return statsHtml + '<div class="empty">Нет записей в Decision Log</div>';

  const rows = log.slice(0, 10).map(d => {
    const icon = d.verdict === "OPEN" ? "✅" : "❌";
    const time = new Date(d.timestamp).toLocaleString("ru-RU", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const rankStep = d.steps.find(s => s.check === "Выбор стратегии");
    const rankNote = rankStep?.note ?? "";
    const winnerVal = rankStep?.value ? String(rankStep.value) : "";
    const otherStrats = rankNote ? rankNote.split(" | ").map(part => {
      const m = part.match(/(\w+): score=([\d.]+) trust=([\d.]+) w=([\d.]+)%/);
      return m ? { strategy: m[1]!, score: m[2]!, trust: m[3]!, weight: m[4]! } : null;
    }).filter(Boolean) : [];
    const passCount = d.steps.filter(s => s.result === "PASS").length;
    const failCount = d.steps.filter(s => s.result === "FAIL").length;
    const stepsHtml = d.steps.length ? `
      <details style="margin-top:8px">
        <summary style="font-size:12px;color:#64748b;cursor:pointer">${passCount} ✅ / ${failCount} ❌ шагов — детали</summary>
        <table style="margin-top:6px;font-size:12px">
          <tr><th>Проверка</th><th>Рез.</th><th>Значение</th></tr>
          ${d.steps.map(s => `<tr>
            <td>${esc(s.check)}</td>
            <td>${s.result === "PASS" ? "✅" : s.result === "FAIL" ? "❌" : "⏭"}</td>
            <td style="font-size:11px;color:#94a3b8">${esc(String(s.value ?? ""))}${s.threshold !== undefined ? ` / мин ${s.threshold}` : ""}${s.note && s.result !== "PASS" ? ` — ${esc(s.note)}` : ""}</td>
          </tr>`).join("")}
        </table>
      </details>` : "";
    return `
      <div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid ${d.verdict === "OPEN" ? "#16a34a" : "#dc2626"}">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <div>${icon} <strong>${esc(d.symbol)}</strong>
            <span class="tag ${d.direction === "LONG" ? "tag-long" : "tag-short"}" style="margin-left:6px">${d.direction}</span>
            <span style="color:#64748b;font-size:12px;margin-left:8px">${esc(d.strategy)}</span>
          </div>
          <div style="color:#475569;font-size:12px">${time} · ${esc(d.regime)}</div>
        </div>
        ${d.verdict === "OPEN"
          ? `<div style="margin-top:4px;font-size:12px;color:#94a3b8">Score: ${d.score ?? "—"} · Conf: ${d.confidence ?? "—"}%</div>`
          : `<div style="margin-top:4px;font-size:12px;color:#ef4444">🚫 ${esc(d.rejectReason ?? "")}</div>`}
        ${rankStep ? `<div style="margin-top:6px;font-size:12px"><span style="color:#64748b">🏆 </span><strong style="color:#34d399">${esc(winnerVal)}</strong>
          ${otherStrats.length ? `<div style="color:#64748b;margin-top:2px">Прочие: ${otherStrats.map(s => `${s!.strategy}(${s!.score}/${s!.trust}/${s!.weight}%)`).join(" · ")}</div>` : ""}
        </div>` : ""}
        ${stepsHtml}
      </div>`;
  }).join("");

  return statsHtml + rows;
}

// ── Learning journal (пункт 7) ────────────────────────────────────────────────

function buildLearningJournal(learningReports: Array<Record<string, unknown>>, stratHistory: Array<Record<string, unknown>>, stratWeights: Array<Record<string, unknown>>): string {
  const quarantined = stratWeights.filter(w => w["quarantine"]);
  const disabled    = stratWeights.filter(w => w["disabled"] && !w["quarantine"]);

  const statusHtml = `
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
      ${stratWeights.map(w => `
        <div class="kpi">
          <div class="label">${esc(String(w["strategy"] ?? ""))}</div>
          <div class="value" style="font-size:16px">${(Number(w["weight"]) * 100).toFixed(0)}%</div>
          <div class="sub">Trust: ${Number(w["trust_score"]).toFixed(0)} ${w["quarantine"] ? "🔴 Карантин" : w["disabled"] ? "⛔ Отключена" : "✅ Активна"}</div>
        </div>`).join("")}
    </div>`;

  const historyHtml = stratHistory.length ? `
    <div class="section-title" style="margin-top:12px">История изменений весов</div>
    <table>
      <tr><th>Время</th><th>Стратегия</th><th>Вес</th><th>PF</th><th>Trust</th><th>Причина</th></tr>
      ${stratHistory.slice(0, 15).map(h => {
        const pw = Number(h["prev_weight"]), nw = Number(h["new_weight"]);
        const pp = Number(h["prev_pf"]), np = Number(h["new_pf"]);
        const delta = nw - pw;
        const t = new Date(String(h["changed_at"])).toLocaleString("ru-RU", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        return `<tr>
          <td style="font-size:12px;color:#64748b">${t}</td>
          <td><strong>${esc(String(h["strategy"] ?? ""))}</strong></td>
          <td>${(pw * 100).toFixed(0)}% → <span class="${delta >= 0 ? "pos" : "neg"}">${(nw * 100).toFixed(0)}%</span>
              <span style="font-size:11px">(${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%)</span></td>
          <td>${pp.toFixed(2)} → ${np.toFixed(2)}</td>
          <td>${Number(h["trust_score"]).toFixed(0)}</td>
          <td style="font-size:12px;color:#94a3b8">${esc(String(h["reason"] ?? ""))}</td>
        </tr>`;
      }).join("")}
    </table>` : '<div class="empty">История изменений пуста</div>';

  const reportsHtml = learningReports.length ? `
    <div class="section-title" style="margin-top:16px">Циклы адаптации (последние ${learningReports.length})</div>
    ${learningReports.map(r => {
      const t = new Date(String(r["created_at"])).toLocaleString("ru-RU", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `<div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid #3b82f6">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px">
          <strong style="color:#60a5fa">${esc(String(r["version_label"] ?? ""))}</strong>
          <span style="color:#475569;font-size:12px">${t} · ${r["trade_count_at_report"]} сделок</span>
        </div>
        <div style="margin-top:8px;font-size:13px;color:#94a3b8;white-space:pre-wrap">${esc(String(r["summary"] ?? "").slice(0, 500))}</div>
      </div>`;
    }).join("")}` : "";

  return statusHtml + historyHtml + reportsHtml;
}

// ── AI Summary (пункт 8) ──────────────────────────────────────────────────────

function buildAISummary(d: ReportData, allStats: WindowStats | null, last30w: WindowStats | null, prev30w: WindowStats | null, readiness: ReturnType<typeof calcReadiness>): string {
  const items: string[] = [];
  const dd = d.peakBalance > 0 ? ((d.peakBalance - d.balance) / d.peakBalance) * 100 : 0;

  // PF trend
  if (allStats && last30w) {
    if (last30w.pf > (allStats.pf + 0.1)) items.push(`<li>📈 PF <span class="highlight">растёт</span>: посл. 30 = ${fmt(last30w.pf)} vs общий ${fmt(allStats.pf)}</li>`);
    else if (last30w.pf < (allStats.pf - 0.1)) items.push(`<li>📉 PF <span class="warn-text">падает</span>: посл. 30 = ${fmt(last30w.pf)} vs общий ${fmt(allStats.pf)}</li>`);
    else items.push(`<li>→ PF стабилен: посл. 30 = ${fmt(last30w.pf)} ≈ общий ${fmt(allStats.pf)}</li>`);
  }

  // WR trend
  if (allStats && last30w) {
    if (last30w.wr > allStats.wr + 3) items.push(`<li>📈 WR <span class="highlight">улучшается</span>: ${fmt(last30w.wr)}% vs ${fmt(allStats.wr)}%</li>`);
    else if (last30w.wr < allStats.wr - 3) items.push(`<li>📉 WR <span class="warn-text">снижается</span>: ${fmt(last30w.wr)}% vs ${fmt(allStats.wr)}%</li>`);
  }

  // Period comparison
  if (last30w && prev30w && last30w.trades > 0 && prev30w.trades > 0) {
    const pfDelta = last30w.pf - prev30w.pf;
    items.push(`<li>${pfDelta >= 0 ? "✅" : "⚠️"} Посл. 30 vs Пред. 30: PF ${fmt(prev30w.pf)} → <strong>${fmt(last30w.pf)}</strong> (${ps(pfDelta)}${fmt(pfDelta)})</li>`);
  }

  // Leader strategy
  const byPF = [...d.strategyDetails].filter(s => s.trades >= 5).sort((a, b) => b.profitFactor - a.profitFactor);
  if (byPF.length > 0) {
    const lead = byPF[0]!;
    items.push(`<li>🏆 Лидер стратегия: <span class="highlight">${lead.strategy}</span> — PF ${lead.profitFactor >= 999 ? "∞" : fmt(lead.profitFactor)}, WR ${fmt(lead.winRate)}%, ${lead.trades} сделок</li>`);
  }
  if (byPF.length > 1) {
    const worst = byPF[byPF.length - 1]!;
    if (worst.profitFactor < 1.0) items.push(`<li>📉 Деградирует: <span class="warn-text">${worst.strategy}</span> — PF ${fmt(worst.profitFactor)}, убыточна</li>`);
  }

  // Worst coin
  const worstCoin = [...d.coinDetails].filter(c => c.trades >= 3).sort((a, b) => a.profitFactor - b.profitFactor)[0];
  if (worstCoin && worstCoin.profitFactor < 0.8) items.push(`<li>🪙 Убыточная монета: <span class="warn-text">${worstCoin.symbol}</span> — PF ${fmt(worstCoin.profitFactor)}, WR ${fmt(worstCoin.winRate)}%</li>`);

  // Drawdown
  if (dd < 5) items.push(`<li>✅ Просадка ${fmt(dd)}% — в норме</li>`);
  else if (dd > 15) items.push(`<li>⚠️ <span class="danger">Просадка ${fmt(dd)}%</span> — высокая, рассмотри снижение risk%</li>`);

  // Loss reasons from last 30
  const last30 = d.closedTrades.slice(0, 30).filter(t => t.outcome === "SL");
  if (last30.length > 5) items.push(`<li>🔴 ${last30.length} из 30 посл. сделок закрылись по SL — фильтры работают слабо</li>`);

  // Decision log quality
  if (d.decisionStats.total > 0) {
    const rate = (d.decisionStats.opened / d.decisionStats.total * 100).toFixed(1);
    items.push(`<li>🔬 Trade Quality Gate: принято <span class="highlight">${rate}%</span> из ${d.decisionStats.total} сигналов за 7 дней</li>`);
    if (d.decisionStats.topRejectReasons[0]) items.push(`<li>🚫 Главный фильтр: <span class="warn-text">${esc(d.decisionStats.topRejectReasons[0].reason)}</span></li>`);
  }

  // Readiness
  const rc = readiness.total >= 70 ? "highlight" : readiness.total >= 50 ? "warn-text" : "danger";
  items.push(`<li>🎯 Готовность к реальной торговле: <span class="${rc}">${readiness.total}/100</span>${readiness.pfPenalty ? " (ограничено: PF < 1.0)" : readiness.total < 70 ? " — нужно больше данных" : " — близко к готовности!"}</li>`);

  // Recommendation
  items.push(`<li>💡 Рекомендация: ${
    d.closedTrades.length < 20 ? "Накопи 20+ сделок прежде чем делать выводы" :
    allStats && allStats.pf < 0.9 ? "PF критически низкий — проверь качество сигналов" :
    allStats && allStats.pf < 1.0 ? "PF < 1.0 — система убыточна, не переходи на реальные деньги" :
    dd > 20 ? "Просадка > 20% — снизи risk% до 0.5% немедленно" :
    "Продолжай накапливать статистику, система работает нормально"
  }</li>`);

  return `<ul>${items.join("")}</ul>`;
}

// ── Main HTML builder ─────────────────────────────────────────────────────────

function buildHtml(d: ReportData): string {
  const dateStr = new Date(d.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
  const timeStr = new Date(d.date).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const allStats = calcWindow(d.closedTrades, "Все сделки");
  const last20   = calcWindow(d.closedTrades.slice(0, 20), "Последние 20");
  const last50   = calcWindow(d.closedTrades.slice(0, 50), "Последние 50");
  const last100  = calcWindow(d.closedTrades.slice(0, 100), "Последние 100");
  const last30w  = calcWindow(d.closedTrades.slice(0, 30), "Последние 30");
  const prev30w  = calcWindow(d.closedTrades.slice(30, 60), "Предыдущие 30");
  const readiness= calcReadiness(d, allStats);
  const periods  = calcPeriodComparison(d.closedTrades);
  const readColor= readiness.total >= 70 ? "#16a34a" : readiness.total >= 50 ? "#d97706" : "#dc2626";
  const totalRet = ((d.balance - d.initialBalance) / d.initialBalance) * 100;
  const dd       = d.peakBalance > 0 ? ((d.peakBalance - d.balance) / d.peakBalance) * 100 : 0;
  const now = Date.now();
  const pnlDay  = d.closedTrades.filter(t => now - new Date(t.closedAt).getTime() < 86400000).reduce((a, t) => a + t.pnl, 0);
  const pnlWeek = d.closedTrades.filter(t => now - new Date(t.closedAt).getTime() < 604800000).reduce((a, t) => a + t.pnl, 0);
  const pnlMonth= d.closedTrades.filter(t => now - new Date(t.closedAt).getTime() < 2592000000).reduce((a, t) => a + t.pnl, 0);
  const champion = d.abVariants.find(v => v.isChampion);
  const recentTrades = d.closedTrades.slice(0, 20);
  const totalMissed = d.missedTrades.length;
  const filterReasons: Record<string, number> = {};
  for (const mt of d.missedTrades) { const r = String(mt["filter_reason"] ?? "unknown"); filterReasons[r] = (filterReasons[r] ?? 0) + 1; }

  const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;font-size:14px;line-height:1.6}
.wrap{max-width:980px;margin:0 auto;padding:16px}
.header{background:linear-gradient(135deg,#1e3a5f,#0f2027);border-radius:12px;padding:24px;margin-bottom:20px;border:1px solid #1e40af}
.header h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:4px}
.header .sub{color:#94a3b8;font-size:13px}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.badge{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;background:#1e40af;color:#bfdbfe}
.badge.paper{background:#065f46;color:#6ee7b7}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.kpi{background:#1e293b;border-radius:10px;padding:14px;border:1px solid #334155}
.kpi .label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.kpi .value{font-size:22px;font-weight:700;color:#f1f5f9}
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
th{text-align:left;padding:7px 9px;background:#0f172a;color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
td{padding:7px 9px;border-bottom:1px solid #1e293b;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#263348}
.pos{color:#22c55e;font-weight:600}
.neg{color:#ef4444;font-weight:600}
.warn{color:#f59e0b;font-weight:600}
.neutral{color:#94a3b8}
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
.ai-summary{background:linear-gradient(135deg,#1e3a5f22,#0f202722);border:1px solid #1e40af;border-radius:10px;padding:20px;margin-bottom:20px}
.ai-summary h3{color:#60a5fa;margin-bottom:12px;font-size:16px}
.ai-summary ul{padding-left:20px}
.ai-summary li{margin-bottom:6px;color:#cbd5e1}
.ai-summary .highlight{color:#34d399;font-weight:600}
.ai-summary .warn-text{color:#fbbf24;font-weight:600}
.ai-summary .danger{color:#f87171;font-weight:600}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.progress-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.progress-label{width:170px;font-size:12px;color:#94a3b8;flex-shrink:0}
.progress-note{font-size:11px;color:#475569;width:150px;text-align:right;flex-shrink:0}
.progress-bar-wrap{flex:1;background:#0f172a;border-radius:4px;height:10px;overflow:hidden}
.progress-bar{height:100%;border-radius:4px}
.readiness-score{font-size:48px;font-weight:800;text-align:center;padding:16px}
.divider{border:none;border-top:1px solid #334155;margin:12px 0}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;margin-bottom:8px}
.empty{text-align:center;color:#475569;padding:16px;font-style:italic}
.cmp-better{color:#22c55e}
.cmp-worse{color:#ef4444}
@media(max-width:600px){.grid2{grid-template-columns:1fr}.kpi-grid{grid-template-columns:repeat(2,1fr)}}`;

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Trading Report — ${dateStr}</title>
<style>${css}</style></head>
<body><div class="wrap">

<div class="header">
  <h1>📊 AI Trading Report</h1>
  <div class="sub">${dateStr} · ${timeStr} UTC · v${BOT_VERSION}</div>
  <div class="badges">
    <span class="badge paper">Paper Trading</span>
    <span class="badge">21 монета · 4 стратегии</span>
    <span class="badge">${d.closedTrades.length} сделок</span>
  </div>
</div>

<div class="kpi-grid">
  <div class="kpi"><div class="label">Баланс</div>
    <div class="value ${totalRet >= 0 ? "pos" : "neg"}">$${fmt(d.balance)}</div>
    <div class="sub">Старт $${fmt(d.initialBalance)}</div></div>
  <div class="kpi"><div class="label">Общий P&L</div>
    <div class="value ${totalRet >= 0 ? "pos" : "neg"}">${ps(totalRet)}${fmt(totalRet)}%</div>
    <div class="sub">${ps(d.balance - d.initialBalance)}$${fmt(Math.abs(d.balance - d.initialBalance))}</div></div>
  <div class="kpi"><div class="label">WinRate</div>
    <div class="value ${wrClass(allStats?.wr ?? 0)}">${fmt(allStats?.wr ?? 0)}%</div>
    <div class="sub">${allStats?.wins.length ?? 0}W / ${allStats?.losses.length ?? 0}L</div></div>
  <div class="kpi"><div class="label">Profit Factor</div>
    <div class="value ${pfClass(allStats?.pf ?? 0)}">${allStats ? (allStats.pf >= 999 ? "∞" : fmt(allStats.pf)) : "—"}</div>
    <div class="sub">Целевой: 1.3+</div></div>
  <div class="kpi"><div class="label">Просадка</div>
    <div class="value ${dd < 10 ? "pos" : dd < 15 ? "warn" : "neg"}">${fmt(dd)}%</div>
    <div class="sub">Пик $${fmt(d.peakBalance)}</div></div>
  <div class="kpi"><div class="label">Открытых</div>
    <div class="value">${d.positions.length}</div>
    <div class="sub">позиций</div></div>
  <div class="kpi"><div class="label">Сделок всего</div>
    <div class="value">${d.closedTrades.length}</div>
    <div class="sub">Нужно 100+ для real</div></div>
  <div class="kpi"><div class="label">Готовность</div>
    <div class="value" style="color:${readColor}">${readiness.total}/100</div>
    <div class="sub">${readiness.pfPenalty ? "⚠️ ограничено PF" : "к реальной торговле"}</div></div>
</div>

<!-- 2. Account state -->
<details open>
  <summary>💰 Состояние счёта</summary>
  <div class="section-body">
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Сегодня P&L</div>
        <div class="value ${pnlDay >= 0 ? "pos" : "neg"}">${ps(pnlDay)}$${fmt(Math.abs(pnlDay))}</div></div>
      <div class="kpi"><div class="label">Неделя P&L</div>
        <div class="value ${pnlWeek >= 0 ? "pos" : "neg"}">${ps(pnlWeek)}$${fmt(Math.abs(pnlWeek))}</div></div>
      <div class="kpi"><div class="label">Месяц P&L</div>
        <div class="value ${pnlMonth >= 0 ? "pos" : "neg"}">${ps(pnlMonth)}$${fmt(Math.abs(pnlMonth))}</div></div>
      <div class="kpi"><div class="label">Просадка сейчас</div>
        <div class="value ${dd < 10 ? "pos" : "neg"}">${fmt(dd)}%</div></div>
    </div>
    <hr class="divider">
    <div class="section-title">Equity Curve</div>
    ${buildEquityCurve(d.closedTrades, d.initialBalance)}
  </div>
</details>

<!-- TRADING STATS -->
<details open>
  <summary>📊 Статистика торговли (все сделки)</summary>
  <div class="section-body">
    ${allStats ? `<table>
      <tr><th>Параметр</th><th>Значение</th><th>Оценка</th></tr>
      <tr><td>Всего сделок</td><td>${d.closedTrades.length}</td><td class="${d.closedTrades.length >= 100 ? "pos" : "warn"}">${d.closedTrades.length >= 100 ? "✅" : "⚠️ нужно 100+"}</td></tr>
      <tr><td>WinRate</td><td class="${wrClass(allStats.wr)}">${fmt(allStats.wr)}%</td><td class="${allStats.wr >= 45 ? "pos" : "warn"}">${allStats.wr >= 45 ? "✅" : "⚠️ нужно 45%+"}</td></tr>
      <tr><td>Profit Factor</td><td class="${pfClass(allStats.pf)}">${allStats.pf >= 999 ? "∞" : fmt(allStats.pf)}</td><td class="${allStats.pf >= 1.3 ? "pos" : "warn"}">${allStats.pf >= 1.3 ? "✅" : "⚠️ нужно 1.3+"}</td></tr>
      <tr><td>Gross Profit / Loss</td><td><span class="pos">+$${fmt(allStats.grossWin)}</span> / <span class="neg">-$${fmt(allStats.grossLoss)}</span></td><td></td></tr>
      <tr><td>Average Win / Loss</td><td><span class="pos">+${fmt(allStats.avgWin)}%</span> / <span class="neg">-${fmt(allStats.avgLoss)}%</span></td><td></td></tr>
      <tr><td>Risk/Reward</td><td>${allStats.avgLoss > 0 ? fmt(allStats.avgWin / allStats.avgLoss) : "∞"}:1</td><td></td></tr>
      <tr><td>Expectancy</td><td class="${allStats.expectancy >= 0 ? "pos" : "neg"}">${ps(allStats.expectancy)}${fmt(allStats.expectancy)}%</td><td class="${allStats.expectancy >= 0 ? "pos" : "neg"}">${allStats.expectancy >= 0 ? "✅" : "❌"}</td></tr>
      <tr><td>Макс. серия убытков</td><td class="neg">${allStats.maxLossStreak}</td><td></td></tr>
      <tr><td>Макс. серия побед</td><td class="pos">${allStats.maxWinStreak}</td><td></td></tr>
    </table>` : '<div class="empty">Нет закрытых сделок</div>'}
  </div>
</details>

<!-- WINDOWS (пункт 2) -->
<details open>
  <summary>📉 Анализ последних окон</summary>
  <div class="section-body">
    <table>
      <tr><th>Период</th><th>Сделок</th><th>WR</th><th>PF</th><th>Expectancy</th><th>RR</th><th>Avg Win</th><th>Avg Loss</th><th>Max L / W серия</th></tr>
      ${[last20, last50, last100, allStats].map(w => w ? `<tr>
        <td><strong>${w.label}</strong></td>${winStat(w)}</tr>` : "").join("")}
    </table>
  </div>
</details>

<!-- OPEN POSITIONS (пункт 6) -->
<details ${d.positions.length > 0 ? "open" : ""}>
  <summary>📂 Открытые позиции (${d.positions.length})</summary>
  <div class="section-body">
    ${d.positions.length === 0 ? '<div class="empty">Нет открытых позиций</div>' : `
    <table>
      <tr><th>Монета</th><th>Dir</th><th>Стратегия</th><th>Вход</th><th>Текущая</th><th>PnL%</th><th>R-множитель</th><th>До SL</th><th>До TP</th><th>Время</th><th>Статус</th></tr>
      ${d.positions.map(p => {
        const cur = d.positionPrices[p.symbol] ?? p.entryPrice;
        const slDist = Math.abs(p.entryPrice - p.stopLoss) / p.entryPrice * 100;
        const pnlPct = p.direction === "LONG"
          ? (cur - p.entryPrice) / p.entryPrice * 100
          : (p.entryPrice - cur) / p.entryPrice * 100;
        const rMult = slDist > 0 ? pnlPct / slDist : 0;
        const distSL = p.direction === "LONG"
          ? (cur - p.stopLoss) / cur * 100
          : (p.stopLoss - cur) / cur * 100;
        const distTP = p.direction === "LONG"
          ? (p.tp1 - cur) / cur * 100
          : (cur - p.tp1) / cur * 100;
        const hrs = (now - new Date(p.openedAt).getTime()) / 3600000;
        const timeStr2 = hrs < 24 ? `${Math.round(hrs)}ч` : `${Math.round(hrs/24)}д`;
        const status = p.breakevenMoved ? "🟡 BE" : p.trailAtr ? "↔ Trail" : "🔵";
        return `<tr>
          <td><strong>${p.symbol}</strong></td>
          <td><span class="tag ${p.direction === "LONG" ? "tag-long" : "tag-short"}">${p.direction}</span></td>
          <td style="font-size:12px">${p.strategy}</td>
          <td style="font-size:12px">${fmtPrice(p.entryPrice)}</td>
          <td style="font-size:12px">${fmtPrice(cur)}</td>
          <td class="${pnlPct >= 0 ? "pos" : "neg"}">${ps(pnlPct)}${fmt(pnlPct)}%</td>
          <td class="${rMult >= 1 ? "pos" : rMult >= 0 ? "warn" : "neg"}">${ps(rMult)}${fmt(rMult)}R</td>
          <td class="${distSL > 1.5 ? "pos" : "warn"}">${fmt(distSL)}%</td>
          <td class="${distTP > 0 ? "neutral" : "neg"}">${fmt(Math.max(0, distTP))}%</td>
          <td class="neutral">${timeStr2}</td>
          <td>${status}</td>
        </tr>`;
      }).join("")}
    </table>`}
  </div>
</details>

<!-- STRATEGIES (пункт 3) -->
<details open>
  <summary>🏆 Стратегии — расширенная статистика</summary>
  <div class="section-body">
    <div style="overflow-x:auto">
    <table>
      <tr><th>Стратегия</th><th>Всего</th><th>Посл.30</th><th>WR</th><th>PF</th><th>Exp.</th><th>Avg W/L</th><th>TP1</th><th>TP2</th><th>SL</th><th>Avg Dur</th><th>Max DD</th><th>Вес</th><th>Trust</th><th>Статус</th></tr>
      ${d.strategyDetails.map(s => `<tr>
        <td><strong>${s.strategy}</strong></td>
        <td>${s.trades}</td>
        <td class="neutral">${s.last30}</td>
        <td class="${wrClass(s.winRate)}">${fmt(s.winRate)}%</td>
        <td class="${pfClass(s.profitFactor)}">${s.profitFactor >= 999 ? "∞" : fmt(s.profitFactor)}</td>
        <td class="${s.expectancy >= 0 ? "pos" : "neg"}">${ps(s.expectancy)}${fmt(s.expectancy)}%</td>
        <td><span class="pos">+${fmt(s.avgWin)}%</span>/<span class="neg">-${fmt(s.avgLoss)}%</span></td>
        <td class="pos">${s.tp1}</td>
        <td class="pos">${s.tp2}</td>
        <td class="neg">${s.sl}</td>
        <td class="neutral">${fmtDur(s.avgDuration)}</td>
        <td class="${s.maxDrawdown < 10 ? "pos" : s.maxDrawdown < 20 ? "warn" : "neg"}">${fmt(s.maxDrawdown)}%</td>
        <td>${(s.weight * 100).toFixed(0)}%</td>
        <td>${s.trustScore.toFixed(0)}</td>
        <td>${s.quarantine ? "🔴 Карантин" : s.disabledUntil ? "⛔ Откл." : "✅"}</td>
      </tr>`).join("")}
    </table>
    </div>
  </div>
</details>

<!-- COINS (пункт 4) -->
<details>
  <summary>🪙 Монеты — расширенная статистика</summary>
  <div class="section-body">
    ${d.coinDetails.length === 0 ? '<div class="empty">Нет данных</div>' : `
    <div style="overflow-x:auto"><table>
      <tr><th>Символ</th><th>Сделок</th><th>WR</th><th>PF</th><th>Expectancy</th><th>Total PnL%</th><th>Avg Dur</th></tr>
      ${d.coinDetails.map(c => `<tr>
        <td><strong>${c.symbol}</strong></td>
        <td>${c.trades}</td>
        <td class="${wrClass(c.winRate)}">${fmt(c.winRate)}%</td>
        <td class="${pfClass(c.profitFactor)}">${c.profitFactor >= 999 ? "∞" : fmt(c.profitFactor)}</td>
        <td class="${c.expectancy >= 0 ? "pos" : "neg"}">${ps(c.expectancy)}${fmt(c.expectancy)}%</td>
        <td class="${c.totalPnl >= 0 ? "pos" : "neg"}">${ps(c.totalPnl)}${fmt(c.totalPnl)}%</td>
        <td class="neutral">${fmtDur(c.avgDuration)}</td>
      </tr>`).join("")}
    </table></div>`}
  </div>
</details>

<!-- READINESS (пункт 1 - переработан) -->
<details>
  <summary>🎯 Readiness для реальной торговли</summary>
  <div class="section-body">
    <div style="text-align:center;margin-bottom:16px">
      <div class="readiness-score" style="color:${readColor}">${readiness.total}/100</div>
      <div style="color:#64748b;font-size:13px">
        ${readiness.pfPenalty ? "⚠️ Ограничено: PF < 1.0 → максимум 50" :
          readiness.total >= 70 ? "✅ Близко к готовности" :
          readiness.total >= 50 ? "⚠️ Нужно больше данных" : "❌ Продолжай бумажную торговлю"}
      </div>
    </div>
    ${readiness.scores.map(s => `
      <div class="progress-row">
        <div class="progress-label">${s.name}</div>
        <div class="progress-bar-wrap">
          <div class="progress-bar" style="width:${(s.score/s.max*100).toFixed(0)}%;background:${s.score === s.max ? "#16a34a" : s.score > s.max/2 ? "#d97706" : "#dc2626"}"></div>
        </div>
        <div class="progress-note">${s.score}/${s.max} · ${s.note}</div>
      </div>`).join("")}
    ${readiness.pfPenalty ? `<div style="margin-top:12px;padding:10px;background:#450a0a;border-radius:8px;color:#fca5a5;font-size:13px">🚫 <strong>Жёсткое ограничение:</strong> При PF &lt; 1.0 итоговый счёт не может превышать 50. Сначала добейся прибыльности.</div>` : ""}
  </div>
</details>

<!-- HEALTH -->
<details>
  <summary>❤️ Health Status</summary>
  <div class="section-body">
    ${(() => {
      const s30 = calcWindow(d.closedTrades.slice(0, 30), "");
      const s100 = calcWindow(d.closedTrades.slice(0, 100), "");
      let status = "🟢 HEALTHY", reason = "Показатели в норме";
      if (s30 && s30.pf < 0.8) { status = "🔴 CRITICAL"; reason = "PF последних 30 сделок < 0.8"; }
      else if (s30 && s30.pf < 1.0) { status = "🟡 WARNING"; reason = "PF последних 30 сделок < 1.0"; }
      const cls = status.includes("HEALTHY") ? "health-green" : status.includes("WARNING") ? "health-yellow" : "health-red";
      return `<div style="margin-bottom:16px"><div class="health-box ${cls}">${status}</div>
        <p style="margin-top:8px;color:#94a3b8">${reason}</p></div>
        <table>
          <tr><th>Метрика</th><th>Последние 30</th><th>Последние 100</th><th>Все сделки</th></tr>
          <tr><td>WinRate</td>
            <td class="${wrClass(s30?.wr ?? 0)}">${s30 ? fmt(s30.wr) + "%" : "—"}</td>
            <td class="${wrClass(s100?.wr ?? 0)}">${s100 ? fmt(s100.wr) + "%" : "—"}</td>
            <td class="${wrClass(allStats?.wr ?? 0)}">${allStats ? fmt(allStats.wr) + "%" : "—"}</td></tr>
          <tr><td>Profit Factor</td>
            <td class="${pfClass(s30?.pf ?? 0)}">${s30 ? (s30.pf >= 999 ? "∞" : fmt(s30.pf)) : "—"}</td>
            <td class="${pfClass(s100?.pf ?? 0)}">${s100 ? (s100.pf >= 999 ? "∞" : fmt(s100.pf)) : "—"}</td>
            <td class="${pfClass(allStats?.pf ?? 0)}">${allStats ? (allStats.pf >= 999 ? "∞" : fmt(allStats.pf)) : "—"}</td></tr>
          <tr><td>Expectancy</td>
            <td class="${(s30?.expectancy ?? 0) >= 0 ? "pos" : "neg"}">${s30 ? ps(s30.expectancy) + fmt(s30.expectancy) + "%" : "—"}</td>
            <td class="${(s100?.expectancy ?? 0) >= 0 ? "pos" : "neg"}">${s100 ? ps(s100.expectancy) + fmt(s100.expectancy) + "%" : "—"}</td>
            <td class="${(allStats?.expectancy ?? 0) >= 0 ? "pos" : "neg"}">${allStats ? ps(allStats.expectancy) + fmt(allStats.expectancy) + "%" : "—"}</td></tr>
        </table>`;
    })()}
  </div>
</details>

<!-- DECISION LOG -->
<details open>
  <summary>🔬 Decision Log</summary>
  <div class="section-body">
    ${buildDecisionLogSection(d.decisionLog, d.decisionStats)}
  </div>
</details>

<!-- LEARNING JOURNAL (пункт 7) -->
<details>
  <summary>🧠 Журнал обучения AI</summary>
  <div class="section-body">
    ${buildLearningJournal(d.learningReports, d.strategyHistory, d.strategyWeights)}
  </div>
</details>

<!-- RECENT TRADES -->
<details>
  <summary>🕐 Последние сделки (${recentTrades.length})</summary>
  <div class="section-body">
    ${recentTrades.length === 0 ? '<div class="empty">Нет сделок</div>' : `
    <table>
      <tr><th>Время</th><th>Монета</th><th>Dir</th><th>Стратегия</th><th>Исход</th><th>P&L%</th></tr>
      ${recentTrades.map(t => `<tr>
        <td class="neutral" style="font-size:12px">${new Date(t.closedAt).toLocaleString("ru-RU",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
        <td><strong>${t.symbol}</strong></td>
        <td><span class="tag ${t.direction === "LONG" ? "tag-long" : "tag-short"}">${t.direction}</span></td>
        <td style="font-size:12px">${t.strategy}</td>
        <td><span class="tag tag-${t.outcome.toLowerCase()}">${oe(t.outcome)} ${t.outcome}</span></td>
        <td class="${t.pnl >= 0 ? "pos" : "neg"}">${ps(t.pnlPercent)}${fmt(t.pnlPercent)}%</td>
      </tr>`).join("")}
    </table>`}
  </div>
</details>

<!-- TIME STATS -->
<details>
  <summary>⏰ Статистика по времени</summary>
  <div class="section-body">
    ${allStats && Object.keys(allStats.byHour).length > 0 ? `
    <table>
      <tr><th>Час UTC</th><th>Сделок</th><th>WR</th><th>Оценка</th></tr>
      ${Object.entries(allStats.byHour).sort(([a],[b]) => Number(a)-Number(b)).map(([h,v]) => {
        const wr2 = v.wins/v.total*100;
        return `<tr><td>${String(h).padStart(2,"0")}:00</td><td>${v.total}</td>
          <td class="${wrClass(wr2)}">${wr2.toFixed(0)}%</td>
          <td>${wr2>=60?"🔥 Лучший":wr2>=50?"✅ Хороший":wr2>=40?"⚠️ Слабый":"❌ Плохой"}</td></tr>`;
      }).join("")}
    </table>` : '<div class="empty">Недостаточно данных</div>'}
  </div>
</details>

<!-- FILTERS -->
<details>
  <summary>🔍 Статистика фильтров</summary>
  <div class="section-body">
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="kpi"><div class="label">Пропущено</div><div class="value warn">${totalMissed}</div></div>
      <div class="kpi"><div class="label">Открыто</div><div class="value pos">${d.closedTrades.length + d.positions.length}</div></div>
      <div class="kpi"><div class="label">% принято</div>
        <div class="value">${totalMissed + d.closedTrades.length > 0 ? (d.closedTrades.length/(totalMissed+d.closedTrades.length)*100).toFixed(1) : 0}%</div></div>
    </div>
    ${Object.keys(filterReasons).length ? `
    <hr class="divider">
    <table>
      <tr><th>Причина</th><th>Кол-во</th><th>Доля</th></tr>
      ${Object.entries(filterReasons).sort(([,a],[,b])=>b-a).map(([r,n])=>`<tr>
        <td>${esc(r)}</td><td>${n}</td>
        <td class="neutral">${totalMissed>0?((n/totalMissed)*100).toFixed(1):0}%</td>
      </tr>`).join("")}
    </table>` : ""}
  </div>
</details>

<!-- PERIOD COMPARISON (пункт 9) -->
<details open>
  <summary>📅 Сравнение периодов</summary>
  <div class="section-body">
    <table>
      <tr><th>Период</th><th>PF</th><th></th><th>WR</th><th></th><th>Expectancy</th><th></th><th>Сделок</th></tr>
      ${periods.map(p => {
        if (!p.a && !p.b) return `<tr><td colspan="8"><strong>${p.label}</strong> — нет данных</td></tr>`;
        const pfA = p.a?.pf ?? 0, pfB = p.b?.pf ?? 0;
        const wrA = p.a?.wr ?? 0, wrB = p.b?.wr ?? 0;
        const eA  = p.a?.expectancy ?? 0, eB = p.b?.expectancy ?? 0;
        return `<tr>
          <td><strong>${p.label}</strong><br><span style="font-size:11px;color:#475569">vs ${p.bLabel}</span></td>
          <td class="${pfClass(pfA)}">${pfA >= 999 ? "∞" : fmt(pfA)}</td>
          <td class="${pfA > pfB ? "cmp-better" : pfA < pfB ? "cmp-worse" : "neutral"}">${arrow(pfA, pfB)}</td>
          <td class="${wrClass(wrA)}">${fmt(wrA)}%</td>
          <td class="${wrA > wrB ? "cmp-better" : wrA < wrB ? "cmp-worse" : "neutral"}">${arrow(wrA, wrB)}</td>
          <td class="${eA >= 0 ? "pos" : "neg"}">${ps(eA)}${fmt(eA)}%</td>
          <td class="${eA > eB ? "cmp-better" : eA < eB ? "cmp-worse" : "neutral"}">${arrow(eA, eB)}</td>
          <td>${p.a?.trades ?? 0} <span style="color:#475569;font-size:12px">/ ${p.b?.trades ?? 0} ${p.bLabel}</span></td>
        </tr>`;
      }).join("")}
    </table>
  </div>
</details>

<!-- AI SUMMARY (пункт 8) -->
<div class="ai-summary">
  <h3>🤖 AI Summary</h3>
  ${buildAISummary(d, allStats, last30w, prev30w, readiness)}
</div>

<div style="text-align:center;color:#334155;font-size:12px;padding:16px">
  Сгенерировано автоматически · ${new Date(d.date).toUTCString()} · AI Paper Trader v${BOT_VERSION}
</div>
</div></body></html>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ReportResult {
  html: Buffer;
  filename: string;
  summary: string;
}

export async function generateDailyReport(chatId: number): Promise<ReportResult> {
  const data  = await collectData(chatId);
  const html  = buildHtml(data);
  const stats = calcWindow(data.closedTrades, "");
  const dd    = data.peakBalance > 0 ? ((data.peakBalance - data.balance) / data.peakBalance) * 100 : 0;
  const ret   = ((data.balance - data.initialBalance) / data.initialBalance) * 100;
  const date  = new Date().toISOString().slice(0, 10);

  const summary =
    `📊 *Daily Report — ${date}*\n\n` +
    `💰 Баланс: *$${data.balance.toFixed(2)}* (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%)\n` +
    `📈 PF: *${stats ? (stats.pf >= 999 ? "∞" : stats.pf.toFixed(2)) : "—"}*\n` +
    `🎯 WR: *${stats ? stats.wr.toFixed(1) + "%" : "—"}*\n` +
    `📉 Просадка: *${dd.toFixed(2)}%*\n` +
    `📂 Сделок: *${data.closedTrades.length}*\n` +
    `🔬 Решений AI (7д): *${data.decisionStats.total}* (принято ${data.decisionStats.opened})\n\n` +
    `📄 Полный HTML-отчёт — файл ниже`;

  return { html: Buffer.from(html, "utf8"), filename: `report_${date}.html`, summary };
}
