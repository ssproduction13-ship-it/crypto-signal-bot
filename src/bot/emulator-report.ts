import { pool } from "../lib/db.js";
import { getPrice } from "./binance.js";

type DbRow = Record<string, unknown>;

interface EmulatorTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  pnlEquityPct: number;
  outcome: string;
  totalCommission: number;
  totalSlippageCost: number;
  fundingCost: number;
  openedAt: string;
  closedAt: string;
}

interface EmulatorPosition {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  entryPrice: number;
  size: number;
  remainingSize: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  openedAt: string;
  regime: string;
  interval: string;
  realizedPnl: number;
  totalCommission: number;
  totalSlippageCost: number;
  fundingCost: number;
}

interface PeriodStats {
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  pnl: number;
}

const BOT_VERSION = "3.0.0";

function num(row: DbRow, key: string, fallback = 0): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

function text(row: DbRow, key: string, fallback = ""): string {
  return row[key] == null ? fallback : String(row[key]);
}

function parseTrade(row: DbRow): EmulatorTrade {
  return {
    id: text(row, "id"),
    symbol: text(row, "symbol"),
    direction: text(row, "direction") as EmulatorTrade["direction"],
    strategy: text(row, "strategy", "UNKNOWN"),
    entryPrice: num(row, "entry_price"),
    exitPrice: num(row, "exit_price"),
    size: num(row, "size"),
    pnl: num(row, "pnl"),
    pnlPercent: num(row, "pnl_percent"),
    pnlEquityPct: num(row, "pnl_equity_pct"),
    outcome: text(row, "outcome", "UNKNOWN"),
    totalCommission: num(row, "total_commission"),
    totalSlippageCost: num(row, "total_slippage_cost"),
    fundingCost: num(row, "funding_cost"),
    openedAt: new Date(text(row, "opened_at")).toISOString(),
    closedAt: new Date(text(row, "closed_at")).toISOString(),
  };
}

function parsePosition(row: DbRow): EmulatorPosition {
  return {
    id: text(row, "id"),
    symbol: text(row, "symbol"),
    direction: text(row, "direction") as EmulatorPosition["direction"],
    strategy: text(row, "strategy", "UNKNOWN"),
    entryPrice: num(row, "entry_price"),
    size: num(row, "size"),
    remainingSize: num(row, "remaining_size", num(row, "size")),
    stopLoss: num(row, "stop_loss"),
    tp1: num(row, "tp1"),
    tp2: num(row, "tp2"),
    openedAt: new Date(text(row, "opened_at")).toISOString(),
    regime: text(row, "regime", "unknown"),
    interval: text(row, "interval", "1h"),
    realizedPnl: num(row, "realized_pnl"),
    totalCommission: num(row, "total_commission"),
    totalSlippageCost: num(row, "total_slippage_cost"),
    fundingCost: num(row, "funding_cost"),
  };
}

function profitFactor(trades: EmulatorTrade[]): number {
  const grossWin = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((sum, t) => sum + t.pnl, 0));
  return grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
}

function periodStats(trades: EmulatorTrade[], label: string, since?: number): PeriodStats {
  const filtered = since == null
    ? trades
    : trades.filter(t => new Date(t.closedAt).getTime() >= since);
  const wins = filtered.filter(t => t.pnl > 0).length;
  return {
    label,
    trades: filtered.length,
    wins,
    winRate: filtered.length ? wins / filtered.length * 100 : 0,
    profitFactor: profitFactor(filtered),
    pnl: filtered.reduce((sum, t) => sum + t.pnl, 0),
  };
}

function maxDrawdown(trades: EmulatorTrade[], initialBalance: number): number {
  let equity = initialBalance;
  let peak = initialBalance;
  let max = 0;
  for (const trade of [...trades].sort((a, b) => a.closedAt.localeCompare(b.closedAt))) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) max = Math.max(max, (peak - equity) / peak * 100);
  }
  return max;
}

function fmtMoney(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function fmtPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? value.toFixed(2) : value >= 1 ? value.toFixed(4) : value.toFixed(6);
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function duration(openedAt: string, closedAt: string): string {
  const minutes = (new Date(closedAt).getTime() - new Date(openedAt).getTime()) / 60000;
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)}м`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}ч`;
  return `${(minutes / 1440).toFixed(1)}д`;
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pnlClass(value: number): string {
  return value > 0 ? "positive" : value < 0 ? "negative" : "muted";
}

function outcomeIcon(outcome: string): string {
  if (outcome === "TP2") return "🚀";
  if (outcome === "TP1") return "✅";
  if (outcome === "SL") return "❌";
  if (outcome === "BE") return "🟡";
  return "—";
}

function buildHtml(args: {
  generatedAt: string;
  balance: number;
  initialBalance: number;
  peakBalance: number;
  trades: EmulatorTrade[];
  positions: Array<EmulatorPosition & { currentPrice: number; unrealizedPnl: number }>;
}): string {
  const { generatedAt, balance, initialBalance, peakBalance, trades, positions } = args;
  const now = Date.now();
  const all = periodStats(trades, "Все сделки");
  const today = periodStats(trades, "Сегодня", new Date(new Date().setHours(0, 0, 0, 0)).getTime());
  const week = periodStats(trades, "7 дней", now - 7 * 86400000);
  const month = periodStats(trades, "30 дней", now - 30 * 86400000);
  const closedPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const equity = balance + unrealizedPnl;
  const returnPct = initialBalance > 0 ? (balance - initialBalance) / initialBalance * 100 : 0;
  const equityReturnPct = initialBalance > 0 ? (equity - initialBalance) / initialBalance * 100 : 0;
  const currentDd = peakBalance > 0 ? (peakBalance - balance) / peakBalance * 100 : 0;
  const historicalDd = maxDrawdown(trades, initialBalance);
  const totalCommission = trades.reduce((sum, t) => sum + t.totalCommission, 0)
    + positions.reduce((sum, p) => sum + p.totalCommission, 0);
  const totalSlippage = trades.reduce((sum, t) => sum + t.totalSlippageCost, 0)
    + positions.reduce((sum, p) => sum + p.totalSlippageCost, 0);
  const totalFunding = trades.reduce((sum, t) => sum + t.fundingCost, 0)
    + positions.reduce((sum, p) => sum + p.fundingCost, 0);

  const strategies = new Map<string, EmulatorTrade[]>();
  const symbols = new Map<string, EmulatorTrade[]>();
  for (const trade of trades) {
    if (!strategies.has(trade.strategy)) strategies.set(trade.strategy, []);
    if (!symbols.has(trade.symbol)) symbols.set(trade.symbol, []);
    strategies.get(trade.strategy)!.push(trade);
    symbols.get(trade.symbol)!.push(trade);
  }
  const strategyRows = [...strategies.entries()].sort((a, b) => b[1].length - a[1].length);
  const symbolRows = [...symbols.entries()].sort((a, b) => b[1].length - a[1].length);

  const statCard = (label: string, value: string, note = "", cls = "") =>
    `<div class="card"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
  const periodRow = (s: PeriodStats) => `
    <tr><td>${esc(s.label)}</td><td>${s.trades}</td><td>${s.wins}/${Math.max(0, s.trades - s.wins)}</td>
    <td>${s.winRate.toFixed(1)}%</td><td class="${pnlClass(s.profitFactor - 1)}">${s.profitFactor >= 999 ? "∞" : s.profitFactor.toFixed(2)}</td>
    <td class="${pnlClass(s.pnl)}">${esc(fmtMoney(s.pnl))}</td></tr>`;

  const positionRows = positions.length
    ? positions.map(p => `
      <tr>
        <td><b>${p.direction === "LONG" ? "⬆️" : "⬇️"} ${esc(p.symbol)}</b><br><span class="muted">${esc(p.strategy)} · ${esc(p.interval)}</span></td>
        <td>${fmtPrice(p.entryPrice)}<br><span class="muted">текущая ${fmtPrice(p.currentPrice)}</span></td>
        <td>${fmtPrice(p.stopLoss)}<br>${fmtPrice(p.tp1)} / ${fmtPrice(p.tp2)}</td>
        <td class="${pnlClass(p.unrealizedPnl)}">${esc(fmtMoney(p.unrealizedPnl))}</td>
        <td>${fmtDate(p.openedAt)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="empty">Нет открытых emulator-позиций</td></tr>`;

  const strategyTable = strategyRows.length
    ? strategyRows.map(([name, group]) => {
      const s = periodStats(group, name);
      return `<tr><td><b>${esc(name)}</b></td><td>${s.trades}</td><td>${s.winRate.toFixed(1)}%</td><td>${s.profitFactor >= 999 ? "∞" : s.profitFactor.toFixed(2)}</td><td class="${pnlClass(s.pnl)}">${esc(fmtMoney(s.pnl))}</td></tr>`;
    }).join("")
    : `<tr><td colspan="5" class="empty">Пока нет закрытых сделок</td></tr>`;

  const symbolTable = symbolRows.length
    ? symbolRows.map(([name, group]) => {
      const s = periodStats(group, name);
      return `<tr><td><b>${esc(name)}</b></td><td>${s.trades}</td><td>${s.winRate.toFixed(1)}%</td><td>${s.profitFactor >= 999 ? "∞" : s.profitFactor.toFixed(2)}</td><td class="${pnlClass(s.pnl)}">${esc(fmtMoney(s.pnl))}</td></tr>`;
    }).join("")
    : `<tr><td colspan="5" class="empty">Пока нет закрытых сделок</td></tr>`;

  const tradeRows = trades.slice(0, 50).length
    ? trades.slice(0, 50).map(t => `
      <tr>
        <td>${fmtDate(t.closedAt)}</td><td><b>${esc(t.symbol)}</b><br><span class="muted">${t.direction} · ${esc(t.strategy)}</span></td>
        <td>${outcomeIcon(t.outcome)} ${esc(t.outcome)}</td><td>${fmtPrice(t.entryPrice)} → ${fmtPrice(t.exitPrice)}</td>
        <td class="${pnlClass(t.pnl)}">${esc(fmtMoney(t.pnl))}<br><span class="muted">${esc(fmtPct(t.pnlPercent))}</span></td>
        <td>${duration(t.openedAt, t.closedAt)}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty">Закрытых emulator-сделок пока нет</td></tr>`;

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Emulator Trading Report</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f1f5f9;color:#172033;font-family:Inter,Arial,sans-serif;line-height:1.45}
.page{max-width:1180px;margin:0 auto;padding:28px}.hero{background:linear-gradient(135deg,#0f172a,#1d4ed8);color:#fff;border-radius:20px;padding:28px 32px;margin-bottom:18px}
h1{margin:0 0 7px;font-size:28px}.subtitle{color:#bfdbfe;font-size:13px}.badge{display:inline-block;margin-top:14px;padding:5px 10px;border:1px solid #60a5fa;border-radius:999px;color:#dbeafe;font-size:12px}
h2{margin:30px 0 12px;font-size:19px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;min-height:92px;box-shadow:0 2px 7px #0f172a0a}.label{font-size:12px;color:#64748b}.value{font-size:22px;font-weight:750;margin-top:6px}.note,.muted{font-size:12px;color:#64748b}.positive{color:#15803d}.negative{color:#dc2626}.warn{color:#b45309}
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#64748b;font-weight:600;background:#f8fafc}th,td{padding:10px 9px;border-bottom:1px solid #e2e8f0;vertical-align:top}tr:last-child td{border-bottom:0}.empty{text-align:center;color:#64748b;padding:24px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.foot{color:#64748b;text-align:center;font-size:12px;padding:22px 0}.source{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px;color:#1e40af;font-size:12px}
@media(max-width:800px){.page{padding:14px}.grid{grid-template-columns:repeat(2,1fr)}.two{grid-template-columns:1fr}h1{font-size:23px}.panel{padding:10px}th,td{padding:8px 6px}}
</style></head><body><main class="page">
<section class="hero"><h1>🤖 Emulator Trading Report</h1><div class="subtitle">Отдельный отчёт виртуального фьючерсного эмулятора · ${esc(new Date(generatedAt).toLocaleString("ru-RU"))}</div><span class="badge">Данные только emulator_* · Paper не включён</span></section>
<div class="grid">
${statCard("Баланс", `$${balance.toFixed(2)}`, `начальный $${initialBalance.toFixed(2)}`)}
${statCard("Equity", `$${equity.toFixed(2)}`, `нереализованный ${fmtMoney(unrealizedPnl)}`, pnlClass(unrealizedPnl))}
${statCard("P&L", `${fmtMoney(closedPnl)}`, `закрытые сделки · ${fmtPct(returnPct)}`, pnlClass(closedPnl))}
${statCard("Открытые позиции", String(positions.length), positions.length ? "есть нереализованный результат" : "нет открытых позиций")}
${statCard("Все сделки", String(all.trades), `WR ${all.winRate.toFixed(1)}% · PF ${all.profitFactor >= 999 ? "∞" : all.profitFactor.toFixed(2)}`)}
${statCard("Просадка", `${currentDd.toFixed(2)}%`, `исторический максимум ${historicalDd.toFixed(2)}%`, currentDd > 10 ? "negative" : "")}
${statCard("Peak balance", `$${peakBalance.toFixed(2)}`, `equity return ${fmtPct(equityReturnPct)}`)}
${statCard("Издержки", `-$${(totalCommission + totalSlippage + totalFunding).toFixed(2)}`, `fee $${totalCommission.toFixed(2)} · slip $${totalSlippage.toFixed(2)}`)}
</div>
<h2>Периоды</h2><section class="panel"><table><thead><tr><th>Период</th><th>Сделки</th><th>W/L</th><th>WR</th><th>PF</th><th>P&L</th></tr></thead><tbody>${[today, week, month, all].map(periodRow).join("")}</tbody></table></section>
<h2>Открытые позиции</h2><section class="panel"><table><thead><tr><th>Позиция</th><th>Вход / цена</th><th>SL / TP1 / TP2</th><th>Unrealized P&L</th><th>Открыта</th></tr></thead><tbody>${positionRows}</tbody></table></section>
<section class="two"><div><h2>По стратегиям</h2><section class="panel"><table><thead><tr><th>Стратегия</th><th>Сделки</th><th>WR</th><th>PF</th><th>P&L</th></tr></thead><tbody>${strategyTable}</tbody></table></section></div>
<div><h2>По инструментам</h2><section class="panel"><table><thead><tr><th>Инструмент</th><th>Сделки</th><th>WR</th><th>PF</th><th>P&L</th></tr></thead><tbody>${symbolTable}</tbody></table></section></div></section>
<h2>Последние закрытые сделки</h2><section class="panel"><table><thead><tr><th>Закрыта</th><th>Инструмент</th><th>Результат</th><th>Цена</th><th>P&L</th><th>Длительность</th></tr></thead><tbody>${tradeRows}</tbody></table></section>
<h2>Состав издержек</h2><section class="panel"><div class="grid">
${statCard("Комиссии", `-$${totalCommission.toFixed(2)}`, "entry + exit")}
${statCard("Slippage", `-$${totalSlippage.toFixed(2)}`, "вход + выход")}
${statCard("Funding", `-$${totalFunding.toFixed(2)}`, "начислено эмулятором")}
${statCard("После издержек", fmtMoney(closedPnl), "P&L в emulator_closed_trades", pnlClass(closedPnl))}
</div></section>
<div class="source" style="margin-top:20px">Этот файл намеренно не использует paper_accounts, paper_positions, paper_closed_trades, instrument_analytics или paper-отчёт. Emulator считается отдельным виртуальным счётом.</div>
<div class="foot">Сгенерировано автоматически · ${esc(new Date(generatedAt).toUTCString())} · AI Paper Trader v${BOT_VERSION}</div>
</main></body></html>`;
}

export interface EmulatorReportResult {
  html: Buffer;
  filename: string;
  summary: string;
}

export async function generateEmulatorReport(): Promise<EmulatorReportResult> {
  const accountResult = await pool.query(
    "SELECT balance, initial_balance, peak_balance FROM emulator_account WHERE id=1",
  );
  const positionResult = await pool.query(
    "SELECT * FROM emulator_positions ORDER BY opened_at ASC",
  );
  const tradeResult = await pool.query(
    "SELECT * FROM emulator_closed_trades ORDER BY closed_at DESC",
  );

  const account = accountResult.rows[0] as DbRow | undefined;
  const balance = num(account ?? {}, "balance", 10_000);
  const initialBalance = num(account ?? {}, "initial_balance", 10_000);
  const peakBalance = num(account ?? {}, "peak_balance", balance);
  const trades = (tradeResult.rows as DbRow[]).map(parseTrade);
  const rawPositions = (positionResult.rows as DbRow[]).map(parsePosition);
  const positions: Array<EmulatorPosition & { currentPrice: number; unrealizedPnl: number }> = [];

  for (const position of rawPositions) {
    let currentPrice = position.entryPrice;
    try {
      currentPrice = await getPrice(position.symbol);
    } catch {
      // A report must still be available if a market price is temporarily unavailable.
    }
    const directionSign = position.direction === "LONG" ? 1 : -1;
    const unrealizedPnl = directionSign * (currentPrice - position.entryPrice) * position.remainingSize;
    positions.push({ ...position, currentPrice, unrealizedPnl });
  }

  const generatedAt = new Date().toISOString();
  const html = buildHtml({ generatedAt, balance, initialBalance, peakBalance, trades, positions });
  const all = periodStats(trades, "all");
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    html: Buffer.from(html, "utf8"),
    filename: `emulator_report_${generatedAt.slice(0, 10)}.html`,
    summary: `Emulator: ${all.trades} сделок, P&L ${fmtMoney(pnl)}, открытых позиций ${positions.length}`,
  };
}