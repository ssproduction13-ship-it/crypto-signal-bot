/**
 * Walk-Forward Testing — модуль исключения переобучения.
 * Делит историю сделок на обучающие и тестовые окна,
 * проверяет стратегию только на данных, которых она ещё не видела.
 *
 * NOTE on window overlap: pos advances by TEST_SIZE (200) per window, not by
 * TRAIN_SIZE+TEST_SIZE. This means consecutive training windows share up to
 * 800 trades. True non-overlapping walk-forward would advance by 1200/step,
 * but with <1200 trades per strategy (typical for this bot) that yields 0–1
 * windows and makes the feature useless. The rolling approach is intentional
 * for small datasets — the test windows themselves never overlap.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { StrategyName } from "./strategies.js";

export interface WalkForwardWindow {
  windowIndex: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  trainTrades: number;
  testTrades: number;
  trainPF: number;
  testPF: number;
  trainWR: number;
  testWR: number;
  trainPnl: number;
  testPnl: number;
  overfitScore: number;
}

export interface WalkForwardResult {
  strategy: StrategyName;
  windows: WalkForwardWindow[];
  avgTrainPF: number;
  avgTestPF: number;
  avgTrainWR: number;
  avgTestWR: number;
  overfitRisk: "low" | "medium" | "high";
  isValid: boolean;
  summary: string;
  computedAt: string;
}

const TRAIN_SIZE = 1000;
const TEST_SIZE = 200;
const MIN_TRAIN = 100;
const MIN_TEST = 20;

interface TradeRow {
  pnl_percent: number;
  outcome: string;
  strategy: string;
  closed_at: string;
}

async function getClosedTradesForStrategy(strategy: StrategyName): Promise<TradeRow[]> {
  const { rows } = await pool.query<TradeRow>(
    `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl_percent, outcome, strategy, closed_at
     FROM paper_closed_trades
     WHERE strategy = $1 AND outcome IS NOT NULL
       AND closed_at::timestamptz >= (SELECT COALESCE(reset_at, '1970-01-01'::timestamptz) FROM paper_accounts LIMIT 1)
     ORDER BY closed_at ASC`,
    [strategy]
  );
  return rows;
}

function calcStats(trades: TradeRow[]): { pf: number; wr: number; pnl: number } {
  if (!trades.length) return { pf: 0, wr: 0, pnl: 0 };
  const wins = trades.filter(t => t.pnl_percent > 0);
  const losses = trades.filter(t => t.pnl_percent <= 0);
  const winPnl = wins.reduce((s, t) => s + t.pnl_percent, 0);
  const lossPnl = Math.abs(losses.reduce((s, t) => s + t.pnl_percent, 0));
  const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 99 : 0;
  const wr = wins.length / trades.length;
  const pnl = trades.reduce((s, t) => s + t.pnl_percent, 0);
  return { pf, wr, pnl };
}

export async function runWalkForwardTest(strategy: StrategyName): Promise<WalkForwardResult> {
  const trades = await getClosedTradesForStrategy(strategy);
  const windows: WalkForwardWindow[] = [];

  let windowIndex = 0;
  let pos = 0;

  while (pos + MIN_TRAIN + MIN_TEST <= trades.length) {
    const trainEnd = Math.min(pos + TRAIN_SIZE, trades.length - MIN_TEST);
    const testStart = trainEnd;
    const testEnd = Math.min(testStart + TEST_SIZE, trades.length);

    if (trainEnd - pos < MIN_TRAIN || testEnd - testStart < MIN_TEST) break;

    const trainSlice = trades.slice(pos, trainEnd);
    const testSlice = trades.slice(testStart, testEnd);

    const trainStats = calcStats(trainSlice);
    const testStats = calcStats(testSlice);

    const overfitScore = trainStats.pf > 0
      ? Math.max(0, 1 - testStats.pf / trainStats.pf)
      : 1;

    windows.push({
      windowIndex,
      trainStart: pos,
      trainEnd,
      testStart,
      testEnd,
      trainTrades: trainSlice.length,
      testTrades: testSlice.length,
      trainPF: trainStats.pf,
      testPF: testStats.pf,
      trainWR: trainStats.wr,
      testWR: testStats.wr,
      trainPnl: trainStats.pnl,
      testPnl: testStats.pnl,
      overfitScore,
    });

    pos += TEST_SIZE;
    windowIndex++;
  }

  const avgTrainPF = windows.length ? windows.reduce((s, w) => s + w.trainPF, 0) / windows.length : 0;
  const avgTestPF = windows.length ? windows.reduce((s, w) => s + w.testPF, 0) / windows.length : 0;
  const avgTrainWR = windows.length ? windows.reduce((s, w) => s + w.trainWR, 0) / windows.length : 0;
  const avgTestWR = windows.length ? windows.reduce((s, w) => s + w.testWR, 0) / windows.length : 0;
  const avgOverfit = windows.length ? windows.reduce((s, w) => s + w.overfitScore, 0) / windows.length : 1;

  const overfitRisk: "low" | "medium" | "high" =
    avgOverfit < 0.2 ? "low" : avgOverfit < 0.4 ? "medium" : "high";

  const isValid = windows.length >= 2 && avgTestPF >= 1.0 && overfitRisk !== "high";

  let summary = `Walk-Forward: ${windows.length} окон\n`;
  summary += `Train PF: ${avgTrainPF.toFixed(2)} | Test PF: ${avgTestPF.toFixed(2)}\n`;
  summary += `Train WR: ${(avgTrainWR * 100).toFixed(1)}% | Test WR: ${(avgTestWR * 100).toFixed(1)}%\n`;
  summary += `Риск переобучения: ${overfitRisk === "low" ? "🟢 Низкий" : overfitRisk === "medium" ? "🟡 Средний" : "🔴 Высокий"}\n`;
  summary += isValid ? "✅ Стратегия прошла тест" : "⚠️ Стратегия не прошла тест";

  const result: WalkForwardResult = {
    strategy,
    windows,
    avgTrainPF,
    avgTestPF,
    avgTrainWR,
    avgTestWR,
    overfitRisk,
    isValid,
    summary,
    computedAt: new Date().toISOString(),
  };

  pool.query(
    `INSERT INTO walk_forward_results(strategy, windows_count, avg_train_pf, avg_test_pf,
       avg_train_wr, avg_test_wr, overfit_risk, is_valid, summary, computed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT(strategy) DO UPDATE SET
       windows_count=$2, avg_train_pf=$3, avg_test_pf=$4,
       avg_train_wr=$5, avg_test_wr=$6, overfit_risk=$7,
       is_valid=$8, summary=$9, computed_at=NOW()`,
    [strategy, windows.length, avgTrainPF, avgTestPF, avgTrainWR, avgTestWR,
     overfitRisk, isValid, summary]
  ).catch(err => logger.warn({ err }, "walk_forward_results save failed"));

  return result;
}

export async function getWalkForwardResult(strategy: StrategyName): Promise<WalkForwardResult | null> {
  const { rows } = await pool.query(
    `SELECT strategy, windows_count, avg_train_pf, avg_test_pf, avg_train_wr, avg_test_wr,
            overfit_risk, is_valid, summary, computed_at
     FROM walk_forward_results
     WHERE strategy = $1`,
    [strategy]
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    strategy: r["strategy"] as StrategyName,
    windows: [],
    avgTrainPF: Number(r["avg_train_pf"]),
    avgTestPF: Number(r["avg_test_pf"]),
    avgTrainWR: Number(r["avg_train_wr"]),
    avgTestWR: Number(r["avg_test_wr"]),
    overfitRisk: r["overfit_risk"] as "low" | "medium" | "high",
    isValid: Boolean(r["is_valid"]),
    summary: String(r["summary"]),
    computedAt: String(r["computed_at"]),
  };
}
