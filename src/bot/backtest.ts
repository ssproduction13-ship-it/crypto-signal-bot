import { getCandles } from "./binance.js";
import { calcIndicators } from "./indicators.js";
import { calcLevels } from "./levels.js";
import { detectPattern } from "./patterns.js";
import { calcScore } from "./scoring.js";
import { calcRisk } from "./risk.js";
import { loadWeights } from "./storage.js";
import type { Interval } from "./binance.js";

export interface BacktestTrade {
  entryIdx: number;
  entryPrice: number;
  direction: "LONG" | "SHORT";
  stopLoss: number;
  tp1: number;
  tp2: number;
  score: number;
  outcome: "TP1" | "TP2" | "SL" | "OPEN";
  pnlPercent: number;
  barsHeld: number;
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  totalPnlPercent: number;
  maxDrawdown: number;
  trades: BacktestTrade[];
  summary: string;
}

export async function runBacktest(
  symbol: string,
  interval: Interval = "1h",
  minScore = 70
): Promise<BacktestResult> {
  const candles = await getCandles(symbol, interval, 500);
  const weights = await loadWeights();
  const trades: BacktestTrade[] = [];

  const LOOKBACK = 100;

  for (let i = LOOKBACK; i < candles.length - 20; i++) {
    const slice = candles.slice(0, i);
    const ind = calcIndicators(slice);
    const lvl = calcLevels(slice);
    const pat = detectPattern(slice);
    const scoreResult = calcScore(ind, lvl, pat, weights, slice);

    if (scoreResult.total < minScore) continue;
    if (scoreResult.direction === "NEUTRAL") continue;

    const risk = calcRisk(slice, scoreResult.direction, 1000, 1);
    const future = candles.slice(i, i + 30);

    let outcome: "TP1" | "TP2" | "SL" | "OPEN" = "OPEN";
    let barsHeld = future.length;
    let closePrice = risk.entryPrice;

    for (let j = 0; j < future.length; j++) {
      const bar = future[j]!;

      if (scoreResult.direction === "LONG") {
        if (bar.low <= risk.stopLoss) {
          outcome = "SL";
          closePrice = risk.stopLoss;
          barsHeld = j + 1;
          break;
        }
        if (bar.high >= risk.tp2) {
          outcome = "TP2";
          closePrice = risk.tp2;
          barsHeld = j + 1;
          break;
        }
        if (bar.high >= risk.tp1) {
          outcome = "TP1";
          closePrice = risk.tp1;
          barsHeld = j + 1;
          break;
        }
      } else {
        if (bar.high >= risk.stopLoss) {
          outcome = "SL";
          closePrice = risk.stopLoss;
          barsHeld = j + 1;
          break;
        }
        if (bar.low <= risk.tp2) {
          outcome = "TP2";
          closePrice = risk.tp2;
          barsHeld = j + 1;
          break;
        }
        if (bar.low <= risk.tp1) {
          outcome = "TP1";
          closePrice = risk.tp1;
          barsHeld = j + 1;
          break;
        }
      }
    }

    if (outcome === "OPEN") continue;

    // H4: include round-trip commission (0.1% × 2 = 0.2%) so backtest PnL
    // is closer to live results. Slippage is NOT modelled here (simplified).
    const COMMISSION_RT = 0.002; // 0.1% entry + 0.1% exit
    const rawPnlPct =
      scoreResult.direction === "LONG"
        ? ((closePrice - risk.entryPrice) / risk.entryPrice) * 100
        : ((risk.entryPrice - closePrice) / risk.entryPrice) * 100;
    const pnlPercent = rawPnlPct - COMMISSION_RT * 100;

    trades.push({
      entryIdx: i,
      entryPrice: risk.entryPrice,
      direction: scoreResult.direction,
      stopLoss: risk.stopLoss,
      tp1: risk.tp1,
      tp2: risk.tp2,
      score: scoreResult.total,
      outcome,
      pnlPercent,
      barsHeld,
    });
  }

  const wins = trades.filter((t) => t.pnlPercent > 0);
  const losses = trades.filter((t) => t.pnlPercent <= 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length
    ? wins.reduce((a, t) => a + t.pnlPercent, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0) / losses.length)
    : 0;
  const totalPnlPercent = trades.reduce((a, t) => a + t.pnlPercent, 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlPercent, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPercent, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    equity += t.pnlPercent;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const summary = [
    `📊 *Бэктест ${symbol} (${interval})*`,
    ``,
    `Сигналов (мин. оценка ${minScore}): ${trades.length}`,
    `Прибыльных: ${wins.length} | Убыточных: ${losses.length}`,
    `WinRate: ${winRate.toFixed(1)}%`,
    `Средний выигрыш: +${avgWin.toFixed(2)}%`,
    `Средний проигрыш: -${avgLoss.toFixed(2)}%`,
    `Profit Factor: ${profitFactor.toFixed(2)}`,
    `Общий P&L: ${totalPnlPercent > 0 ? "+" : ""}${totalPnlPercent.toFixed(2)}%`,
    `Макс. просадка: ${maxDrawdown.toFixed(2)}%`,
    ``,
    profitFactor >= 1.5
      ? "✅ Стратегия показывает хорошие результаты на истории"
      : profitFactor >= 1
      ? "⚠️ Стратегия в плюсе, но слабо — улучши фильтры"
      : "❌ Стратегия убыточна на истории — пересмотри параметры",
    ``,
    `⚠️ _Упрощённая симуляция: комиссия 0.2% учтена, слиппедж и частичный TP1-выход — нет. Реальные результаты могут отличаться._`,
  ].join("\n");

  return {
    symbol: symbol.toUpperCase(),
    interval,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    totalPnlPercent,
    maxDrawdown,
    trades,
    summary,
  };
}
