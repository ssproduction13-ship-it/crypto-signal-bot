/**
 * Similar Trades Engine — AI Learning Engine v3
 * Finds historically similar trades and uses their outcomes to adjust confidence.
 * Uses cosine similarity on normalized indicator vectors.
 * Target: <100ms, graceful fallback if unavailable.
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { StrategyName } from "./strategies.js";

export interface TradeFeatures {
  symbol: string;
  strategy: StrategyName;
  direction: "LONG"|"SHORT";
  interval: string;
  score: number;
  confidence: number;
  rsi: number;
  macdHistogram: number;
  adxValue: number;
  atrPercent: number;
  bbPercent: number;
  ema20rel: number;   // ema20 / price
  ema50rel: number;   // ema50 / price
  ema200rel: number;  // ema200 / price
  volumeAbove: number; // 1 = above_avg, 0 = below
  isSideways: number;
  isHighVol: number;
  hour: number;
  dayOfWeek: number;
}

export interface SimilarTradesResult {
  count: number;
  winRate: number;
  profitFactor: number;
  avgProfit: number;
  avgLoss: number;
  confidenceBoost: number; // -20 … +20
}

// ── Feature vector normalization ──────────────────────────────────────────────
function toVector(f: TradeFeatures): number[] {
  return [
    (f.rsi ?? 50) / 100,
    Math.tanh((f.macdHistogram ?? 0) / 0.5),        // [-1..1]
    Math.tanh((f.adxValue ?? 25) / 50),
    Math.min((f.atrPercent ?? 1) / 5, 1),
    ((f.bbPercent ?? 50) - 50) / 50,                // [-1..1]
    (f.ema20rel ?? 1) - 1,                           // deviation from price
    (f.ema50rel ?? 1) - 1,
    (f.ema200rel ?? 1) - 1,
    f.volumeAbove ?? 0,
    f.isSideways ?? 0,
    f.isHighVol ?? 0,
    (f.score ?? 50) / 100,
    (f.confidence ?? 50) / 100,
    (f.hour ?? 12) / 24,
    (f.dayOfWeek ?? 0) / 7,
  ];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i]!) * (b[i]!);
    normA += (a[i]!) ** 2;
    normB += (b[i]!) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Save features at trade open ───────────────────────────────────────────────
export async function saveTradeFeatures(positionId: string, features: TradeFeatures): Promise<void> {
  await pool.query(
    `INSERT INTO trade_features(position_id, symbol, strategy, direction, interval, features, saved_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(position_id) DO NOTHING`,
    [positionId, features.symbol, features.strategy, features.direction, features.interval,
     JSON.stringify(features), new Date().toISOString()]
  ).catch(err => logger.error({ err, positionId, symbol: features.symbol }, "saveTradeFeatures INSERT failed — trade_features row NOT written"));
}

// ── Update features with trade result at close ────────────────────────────────
export async function updateTradeResult(
  positionId: string, pnlPercent: number, isWin: boolean, outcome: string
): Promise<void> {
  await pool.query(
    `UPDATE trade_features SET pnl_percent=$2, is_win=$3, outcome=$4 WHERE position_id=$1`,
    [positionId, pnlPercent, isWin, outcome]
  ).catch(err => logger.error({ err, positionId }, "updateTradeResult UPDATE failed — trade_features row NOT updated"));
}

// ── Find similar trades ────────────────────────────────────────────────────────
export async function findSimilarTrades(
  features: TradeFeatures,
  minSimilarity = 0.82,
  minCount = 20,
  maxSearchPool = 500
): Promise<SimilarTradesResult | null> {
  const t0 = Date.now();
  try {
    // Load recent closed trades with features (same strategy + direction for efficiency)
    const { rows } = await pool.query(
      `SELECT features, pnl_percent, is_win
       FROM trade_features
       WHERE pnl_percent IS NOT NULL
         AND strategy = $1
         AND direction = $2
       ORDER BY saved_at DESC
       LIMIT $3`,
      [features.strategy, features.direction, maxSearchPool]
    );

    if (!rows.length) return null;

    const queryVec = toVector(features);
    const similar: Array<{pnl: number; isWin: boolean}> = [];

    for (const r of rows as Record<string,unknown>[]) {
      let feat: TradeFeatures;
      try {
        feat = typeof r["features"] === "string"
          ? JSON.parse(r["features"] as string)
          : r["features"] as TradeFeatures;
      } catch { continue; }

      const sim = cosineSimilarity(queryVec, toVector(feat));
      if (sim >= minSimilarity) {
        similar.push({pnl: Number(r["pnl_percent"]), isWin: Boolean(r["is_win"])});
      }
      if (similar.length >= 200) break; // cap at 200 for performance
    }

    const elapsed = Date.now() - t0;
    logger.debug({count: similar.length, elapsed, strategy: features.strategy}, "Similar trades found");

    if (similar.length < minCount) return null;

    const wins = similar.filter(t => t.isWin);
    const losses = similar.filter(t => !t.isWin);
    const winPnl = wins.reduce((a, t) => a + t.pnl, 0);
    const lossPnl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 5 : 0;
    const wr = wins.length / similar.length;
    const avgProfit = wins.length > 0 ? winPnl / wins.length : 0;
    const avgLoss   = losses.length > 0 ? lossPnl / losses.length : 0;

    // Confidence boost: +20 if PF>1.5 & WR>0.6, -20 if PF<0.7 & WR<0.35
    let boost = 0;
    if (pf >= 1.5 && wr >= 0.6) boost = 20;
    else if (pf >= 1.2 && wr >= 0.5) boost = 12;
    else if (pf >= 1.0 && wr >= 0.45) boost = 5;
    else if (pf < 0.7 && wr < 0.35) boost = -20;
    else if (pf < 0.85 && wr < 0.42) boost = -10;
    else if (pf < 0.95) boost = -4;

    return {
      count: similar.length,
      winRate: wr,
      profitFactor: pf,
      avgProfit,
      avgLoss,
      confidenceBoost: boost,
    };
  } catch (err) {
    logger.debug({err}, "findSimilarTrades error — fallback to main logic");
    return null;
  }
}

// ── Stats for display ──────────────────────────────────────────────────────────
export async function getSimilarTradesStats(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT strategy, direction, COUNT(*) as cnt
     FROM trade_features WHERE pnl_percent IS NOT NULL
     GROUP BY strategy, direction ORDER BY strategy, direction`
  );
  if (!rows.length) return "📊 *Похожие сделки*\n\nДанных пока нет — накапливается история.";

  const total = (rows as Record<string,unknown>[]).reduce((a, r) => a + Number(r["cnt"]), 0);
  const lines = (rows as Record<string,unknown>[]).map(r =>
    `  ${r["strategy"]} ${r["direction"]}: ${r["cnt"]} сд.`
  );
  return [`📊 *Similar Trades Engine*`, `Всего в базе: ${total} сделок с признаками`, "", ...lines].join("\n");
}
