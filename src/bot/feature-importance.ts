/**
 * Feature Importance Engine — AI Learning Engine v3
 * Determines which indicators actually improve trade outcomes.
 * After every 100 trades: calculates factor lift, updates factor_weights (±5% per cycle).
 */
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export interface FactorImportance {
  factor: string;
  label: string;
  importanceScore: number; // -100 … +100
  winRateLift: number;     // percentage points difference high vs low quartile
  pfLift: number;          // PF diff high vs low
  trades: number;
}

// ── Compute importance for one binary/numeric feature ────────────────────────
// Splits trades into "above median" and "below median" by feature value,
// compares WR and PF between the two groups.
function liftFromGroups(
  high: Array<{pnl: number; isWin: boolean}>,
  low:  Array<{pnl: number; isWin: boolean}>
): {wrLift: number; pfLift: number} {
  function stats(g: typeof high) {
    if (!g.length) return {wr:0, pf:0};
    const wins = g.filter(t => t.isWin);
    const wPnl = wins.reduce((a, t) => a + t.pnl, 0);
    const lPnl = Math.abs(g.filter(t => !t.isWin).reduce((a, t) => a + t.pnl, 0));
    return {wr: wins.length / g.length, pf: lPnl > 0 ? wPnl / lPnl : wPnl > 0 ? 3 : 0};
  }
  const h = stats(high), l = stats(low);
  return {wrLift: (h.wr - l.wr) * 100, pfLift: h.pf - l.pf};
}

export async function calcFeatureImportance(): Promise<FactorImportance[]> {
  // Load all closed trades with features
  const { rows } = await pool.query(
    `SELECT features, pnl_percent, is_win
     FROM trade_features
     WHERE pnl_percent IS NOT NULL
     ORDER BY saved_at DESC
     LIMIT 500`
  );

  if (rows.length < 30) return [];

  type Row = {pnl: number; isWin: boolean; feat: Record<string, unknown>};
  const trades: Row[] = [];
  for (const r of rows as Record<string,unknown>[]) {
    try {
      const feat = typeof r["features"] === "string"
        ? JSON.parse(r["features"] as string)
        : r["features"] as Record<string,unknown>;
      trades.push({pnl: Number(r["pnl_percent"]), isWin: Boolean(r["is_win"]), feat});
    } catch { /* skip */ }
  }
  if (trades.length < 30) return [];

  // Factor definitions: name, label, extractor
  const factors: Array<{name:string; label:string; get:(f:Record<string,unknown>)=>number|null}> = [
    {name:"ema200", label:"EMA200",
     get: f => typeof f["ema200rel"]==="number" ? (f["ema200rel"] as number) - 1 : null},
    {name:"volume", label:"Volume",
     get: f => typeof f["volumeAbove"]==="number" ? f["volumeAbove"] as number : null},
    {name:"adx",    label:"ADX",
     get: f => typeof f["adxValue"]==="number" ? f["adxValue"] as number : null},
    {name:"atr",    label:"ATR%",
     get: f => typeof f["atrPercent"]==="number" ? f["atrPercent"] as number : null},
    {name:"rsi",    label:"RSI",
     get: f => typeof f["rsi"]==="number" ? f["rsi"] as number : null},
    {name:"macd",   label:"MACD",
     get: f => typeof f["macdHistogram"]==="number" ? f["macdHistogram"] as number : null},
    {name:"bb",     label:"Bollinger%",
     get: f => typeof f["bbPercent"]==="number" ? f["bbPercent"] as number : null},
    {name:"score",  label:"Signal Score",
     get: f => typeof f["score"]==="number" ? f["score"] as number : null},
    {name:"confidence", label:"Confidence",
     get: f => typeof f["confidence"]==="number" ? f["confidence"] as number : null},
    {name:"time",   label:"Час торговли",
     get: f => typeof f["hour"]==="number" ? f["hour"] as number : null},
    {name:"regime", label:"Режим рынка (волат.)",
     get: f => typeof f["isHighVol"]==="number" ? f["isHighVol"] as number : null},
    {name:"sideways", label:"Боковой рынок",
     get: f => typeof f["isSideways"]==="number" ? 1 - (f["isSideways"] as number) : null},
  ];

  const results: FactorImportance[] = [];

  for (const factor of factors) {
    // Get values for all trades
    const withVals = trades
      .map(t => ({...t, val: factor.get(t.feat)}))
      .filter(t => t.val !== null) as Array<Row & {val: number}>;

    if (withVals.length < 20) continue;

    // Split by median
    const vals = withVals.map(t => t.val).sort((a,b) => a-b);
    const median = vals[Math.floor(vals.length / 2)]!;

    const high = withVals.filter(t => t.val >= median);
    const low  = withVals.filter(t => t.val < median);

    if (high.length < 5 || low.length < 5) continue;

    const {wrLift, pfLift} = liftFromGroups(
      high.map(t => ({pnl: t.pnl, isWin: t.isWin})),
      low.map(t => ({pnl: t.pnl, isWin: t.isWin}))
    );

    // Importance score: weighted combination of WR lift + PF lift, clamped -100..100
    const importanceScore = Math.max(-100, Math.min(100,
      Math.round(wrLift * 1.5 + pfLift * 20)
    ));

    results.push({
      factor: factor.name,
      label: factor.label,
      importanceScore,
      winRateLift: Math.round(wrLift * 10) / 10,
      pfLift: Math.round(pfLift * 100) / 100,
      trades: withVals.length,
    });
  }

  // Sort by absolute importance
  results.sort((a,b) => Math.abs(b.importanceScore) - Math.abs(a.importanceScore));

  // Persist to DB
  for (const r of results) {
    await pool.query(
      `INSERT INTO feature_importance(factor, label, importance_score, wr_lift, pf_lift, trades, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(factor) DO UPDATE SET
         importance_score=$3, wr_lift=$4, pf_lift=$5, trades=$6, updated_at=$7`,
      [r.factor, r.label, r.importanceScore, r.winRateLift, r.pfLift, r.trades, new Date().toISOString()]
    ).catch(() => {});
  }

  logger.info({factors: results.length}, "Feature importance calculated");
  return results;
}

// ── Auto-adjust factor weights ±5% per cycle based on importance ─────────────
export async function applyFeatureWeightAdjustments(importances: FactorImportance[]): Promise<string[]> {
  if (!importances.length) return [];

  // Map importance factor names to factor_weights column names
  const factorMap: Record<string, "trend"|"volume"|"momentum"|"levels"|"pattern"> = {
    ema200: "trend",
    adx: "trend",
    volume: "volume",
    macd: "momentum",
    rsi: "momentum",
    bb: "momentum",
    score: "pattern",
    regime: "pattern",
    sideways: "pattern",
  };

  const { rows } = await pool.query("SELECT * FROM factor_weights WHERE id=1");
  if (!rows.length) return [];

  const w = rows[0] as Record<string, number>;
  const changes: Record<string, number> = {};

  for (const imp of importances) {
    const col = factorMap[imp.factor];
    if (!col) continue;
    // Calculate delta: importance of ±100 → ±0.05 weight change
    const delta = (imp.importanceScore / 100) * 0.05;
    changes[col] = (changes[col] ?? 0) + delta;
  }

  const msgs: string[] = [];
  const COLS = ["trend", "volume", "momentum", "levels", "pattern"] as const;
  const newW: Record<string, number> = {};

  for (const col of COLS) {
    const delta = Math.max(-0.05, Math.min(0.05, changes[col] ?? 0));
    const prev = Number(w[col] ?? 0.2);
    const next = Math.max(0.05, Math.min(0.50, prev + delta));
    newW[col] = next;
    if (Math.abs(next - prev) > 0.001) {
      msgs.push(`  ${col}: ${(prev*100).toFixed(0)}%→${(next*100).toFixed(0)}%`);
    }
  }

  // Normalize so all weights sum to 1.0
  const total = COLS.reduce((a, c) => a + newW[c]!, 0);
  for (const col of COLS) newW[col]! /= total;

  await pool.query(
    "UPDATE factor_weights SET trend=$1,volume=$2,momentum=$3,levels=$4,pattern=$5 WHERE id=1",
    [newW["trend"], newW["volume"], newW["momentum"], newW["levels"], newW["pattern"]]
  ).catch(() => {});

  return msgs;
}

// ── Load stored importances ───────────────────────────────────────────────────
export async function loadFeatureImportance(): Promise<FactorImportance[]> {
  const { rows } = await pool.query(
    "SELECT factor,label,importance_score,wr_lift,pf_lift,trades FROM feature_importance ORDER BY ABS(importance_score) DESC"
  );
  return (rows as Record<string,unknown>[]).map(r => ({
    factor: r["factor"] as string,
    label: r["label"] as string,
    importanceScore: Number(r["importance_score"]),
    winRateLift: Number(r["wr_lift"]),
    pfLift: Number(r["pf_lift"]),
    trades: Number(r["trades"]),
  }));
}

// ── Format for Telegram ───────────────────────────────────────────────────────
export function formatFeatureImportance(importances: FactorImportance[]): string {
  if (!importances.length)
    return "📊 *Влияние факторов*\n\nНедостаточно данных — нужно минимум 30 сделок.";

  const lines = [`📊 *Влияние факторов на прибыльность*`, ""];
  for (const r of importances.slice(0, 10)) {
    const sign = r.importanceScore >= 0 ? "+" : "";
    const bar = r.importanceScore >= 0
      ? "█".repeat(Math.min(8, Math.round(r.importanceScore / 14)))
      : "░".repeat(Math.min(8, Math.round(Math.abs(r.importanceScore) / 14)));
    const icon = r.importanceScore >= 15 ? "🔥" : r.importanceScore <= -15 ? "❌" : r.importanceScore >= 5 ? "✅" : "➡️";
    lines.push(`${icon} *${r.label}* ${bar} ${sign}${r.importanceScore}%`);
    lines.push(`  WR: ${r.winRateLift >= 0 ? "+" : ""}${r.winRateLift}пп | PF: ${r.pfLift >= 0 ? "+" : ""}${r.pfLift} | n=${r.trades}`);
  }
  // Weight-change status is appended by the caller after applyFeatureWeightAdjustments()
  return lines.join("\n");
}
