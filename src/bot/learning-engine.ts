import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { StrategyName } from "./strategies.js";
import type { MarketCondition } from "./chaos-filter.js";
import type { MarketRating } from "./market-rating.js";

export type MarketRegime = "trend_up"|"trend_down"|"sideways"|"high_vol"|"low_vol";
export type StrategyStatus = "active"|"quarantine"|"disabled";

export interface StrategyTrustResult {
  strategy: StrategyName;
  trustScore: number;
  status: StrategyStatus;
  weight: number;
  trades: number;
  winRate: number;
  profitFactor: number;
}

export function detectMarketRegime(market: MarketCondition, rating: MarketRating): MarketRegime {
  if ((market.atrPercent ?? 0) > 3.5 && !market.isSideways) return "high_vol";
  if (market.isLowVolume && (market.atrPercent ?? 1) < 0.8) return "low_vol";
  if (market.isSideways) return "sideways";
  if (rating.state === "strong_growth" || rating.state === "moderate_growth") return "trend_up";
  if (rating.state === "decline") return "trend_down";
  return "sideways";
}

export async function recordRegimeTrade(
  strategy: StrategyName, regime: MarketRegime, pnlPercent: number, isWin: boolean,
  interval = "ALL" // M1 fix: store per-interval stats to stop 15m/1h data mixing
): Promise<void> {
  const vals = [strategy,regime,isWin?1:0,isWin?Math.abs(pnlPercent):0,isWin?0:Math.abs(pnlPercent),pnlPercent];
  const upsertSql = (iv: string) =>
    pool.query(
      `INSERT INTO strategy_regime_stats(strategy,regime,interval,trades,wins,win_pnl,loss_pnl,total_pnl)
       VALUES($1,$2,$7,1,$3,$4,$5,$6)
       ON CONFLICT(strategy,regime,interval) DO UPDATE SET
         trades=strategy_regime_stats.trades+1,
         wins=strategy_regime_stats.wins+$3,
         win_pnl=strategy_regime_stats.win_pnl+$4,
         loss_pnl=strategy_regime_stats.loss_pnl+$5,
         total_pnl=strategy_regime_stats.total_pnl+$6`,
      [...vals, iv]
    );
  // Write per-interval row AND cross-interval 'ALL' aggregate in parallel
  await Promise.all([upsertSql(interval), ...(interval !== "ALL" ? [upsertSql("ALL")] : [])]);
}

export async function recordDirectionTrade(
  strategy: StrategyName, direction: string, pnlPercent: number, isWin: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO strategy_direction_stats(strategy,direction,trades,wins,win_pnl,loss_pnl,total_pnl)
     VALUES($1,$2,1,$3,$4,$5,$6)
     ON CONFLICT(strategy,direction) DO UPDATE SET
       trades=strategy_direction_stats.trades+1,
       wins=strategy_direction_stats.wins+$3,
       win_pnl=strategy_direction_stats.win_pnl+$4,
       loss_pnl=strategy_direction_stats.loss_pnl+$5,
       total_pnl=strategy_direction_stats.total_pnl+$6`,
    [strategy, direction, isWin?1:0, isWin?Math.abs(pnlPercent):0, isWin?0:Math.abs(pnlPercent), pnlPercent]
  ).catch(()=>{});
}

export async function isStrategyBlockedInRegime(
  strategy: StrategyName, regime: MarketRegime,
  interval = "ALL" // M1 fix: query per-interval stats first, fall back to 'ALL' aggregate
): Promise<{blocked:boolean;reason:string}> {
  // Try interval-specific stats first (>=10 trades); fall back to cross-interval 'ALL'
  const candidates = interval !== "ALL" ? [interval, "ALL"] : ["ALL"];
  for (const iv of candidates) {
    const {rows} = await pool.query(
      "SELECT trades,wins,win_pnl,loss_pnl FROM strategy_regime_stats WHERE strategy=$1 AND regime=$2 AND interval=$3",
      [strategy, regime, iv]
    );
    if (!rows.length) continue;
    const r = rows[0] as Record<string,unknown>;
    const trades=Number(r["trades"]),wins=Number(r["wins"]);
    const winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
    if (trades<10) continue; // not enough data in this bucket — try next
    const pf = lossPnl>0 ? winPnl/lossPnl : winPnl>0 ? 2.0 : 0;
    const wr = wins/trades;
    if (pf<0.7 && wr<0.38) {
      const regimeLabel:Record<string,string>={trend_up:"восходящий тренд",trend_down:"нисходящий тренд",sideways:"боковик",high_vol:"высокая волатильность",low_vol:"затишье"};
      const ivNote = iv !== "ALL" ? ` [${iv}]` : "";
      return {blocked:true,reason:`${strategy} убыточна в режиме "${regimeLabel[regime]??regime}"${ivNote} (PF ${pf.toFixed(2)}, WR ${(wr*100).toFixed(0)}%)`};
    }
    return {blocked:false,reason:""};
  }
  return {blocked:false,reason:""};
}

// ── Trust Score (0–100) ───────────────────────────────────────────────────────
// Weights: PF 35%, WR 25%, DD 15%, stability 10%, sample size 10%, regime fit 5%
export async function calcTrustScore(
  strategy: StrategyName,
  trades: number,
  wins: number,
  winPnl: number,
  lossPnl: number,
  _totalPnl: number,
  regime: MarketRegime
): Promise<number> {
  if (trades === 0) return 0;

  // PF fallback capped at 2.0 (was 5): a strategy with 0 losses gets PF=2.0 max,
  // preventing over-inflation of pfScore during bootstrap (H3 fix)
  const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
  const wr = wins / trades;

  // PF score (0–35)
  let pfScore = 0;
  if (pf >= 2.0) pfScore = 35;
  else if (pf >= 1.5) pfScore = 28;
  else if (pf >= 1.2) pfScore = 22;
  else if (pf >= 1.0) pfScore = 16;
  else if (pf >= 0.8) pfScore = 8;
  else pfScore = 0;

  // WR score (0–25)
  let wrScore = 0;
  if (wr >= 0.65) wrScore = 25;
  else if (wr >= 0.55) wrScore = 20;
  else if (wr >= 0.45) wrScore = 14;
  else if (wr >= 0.38) wrScore = 8;
  else wrScore = 0;

  // Drawdown score (0–15) — estimated from avg loss magnitude.
  // M3 fix: blend raw ddScore toward a neutral value (7) when <5 losses exist,
  // preventing a single outlier loss from tanking the score to 0 instantly.
  const lossCount = trades - wins;
  const avgLoss = lossCount > 0 ? lossPnl / lossCount : 0;
  const rawDdScore = avgLoss > 5 ? 0 : avgLoss > 3 ? 5 : avgLoss > 2 ? 10 : 15;
  const ddSampleConf = Math.min(1.0, lossCount / 5); // ramps from 0→1 over first 5 losses
  const ddScore = Math.round(ddSampleConf * rawDdScore + (1 - ddSampleConf) * 7);

  // Stability of recent trades (0–10)
  // Uses pnl_equity_pct (portfolio impact %) — same scale as strategy_stats accumulator.
  // pnl_percent is raw price % and uses a different scale, mixing them broke PF vs stability comparison.
  let stabilityScore = 0;
  try {
    const {rows} = await pool.query(
      `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl FROM paper_closed_trades WHERE strategy=$1 ORDER BY closed_at DESC LIMIT 20`,
      [strategy]
    );
    if (rows.length >= 10) {
      const pnls = (rows as Record<string,unknown>[]).map(r => Number(r["pnl"]));
      const recentWins = pnls.filter(p => p > 0).length;
      const recentWR = recentWins / pnls.length;
      if (recentWR >= 0.55) stabilityScore = 10;
      else if (recentWR >= 0.45) stabilityScore = 7;
      else if (recentWR >= 0.35) stabilityScore = 4;
      else stabilityScore = 0;
    } else { stabilityScore = 5; }
  } catch { stabilityScore = 5; }

  // Sample size score (0–10)
  let sampleScore = 0;
  if (trades >= 100) sampleScore = 10;
  else if (trades >= 50) sampleScore = 7;
  else if (trades >= 30) sampleScore = 4;
  else sampleScore = 1;

  // Regime fit score (0–5)
  let regimeFit = 3;
  try {
    const {rows} = await pool.query(
      "SELECT trades,wins,win_pnl,loss_pnl FROM strategy_regime_stats WHERE strategy=$1 AND regime=$2",
      [strategy, regime]
    );
    if (rows.length) {
      const r = rows[0] as Record<string,unknown>;
      const rt=Number(r["trades"]),rw=Number(r["wins"]),rwp=Number(r["win_pnl"]),rlp=Number(r["loss_pnl"]);
      if (rt >= 5) {
        const rpf = rlp > 0 ? rwp / rlp : rwp > 0 ? 2.0 : 0; // cap at 2.0 — consistent with H3
        regimeFit = rpf >= 1.3 ? 5 : rpf >= 1.0 ? 3 : rpf >= 0.8 ? 1 : 0;
      }
    }
  } catch { regimeFit = 3; }

  const raw = pfScore + wrScore + ddScore + stabilityScore + sampleScore + regimeFit;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

// ── Loss Reason Recording ──────────────────────────────────────────────────────
export type LossReason =
  | "sideways_market" | "fake_breakout" | "low_volume"
  | "high_volatility" | "trend_reversal" | "other";

export function classifyLossReason(
  strategy: StrategyName,
  regime: MarketRegime,
  _outcome: string
): LossReason {
  if (regime === "sideways") return "sideways_market";
  if (regime === "low_vol") return "low_volume";
  if (regime === "high_vol") return "high_volatility";
  if (strategy === "BREAKOUT" && (regime === "sideways" || regime === "low_vol")) return "fake_breakout";
  if (regime === "trend_down" && strategy === "TREND") return "trend_reversal";
  if (regime === "trend_up" && strategy === "MEAN_REVERSION") return "trend_reversal";
  return "other";
}

export async function recordLossReason(
  strategy: StrategyName,
  reason: LossReason
): Promise<void> {
  await pool.query(
    `INSERT INTO strategy_loss_reasons(strategy, reason, count)
     VALUES($1,$2,1)
     ON CONFLICT(strategy,reason) DO UPDATE SET count=strategy_loss_reasons.count+1`,
    [strategy, reason]
  ).catch(err => logger.debug({err}, "recordLossReason failed"));
}

export async function getLossReasonStats(strategy: StrategyName): Promise<string> {
  const {rows} = await pool.query(
    "SELECT reason,count FROM strategy_loss_reasons WHERE strategy=$1 ORDER BY count DESC",
    [strategy]
  );
  if (!rows.length) return "нет данных по убыткам";
  const total = (rows as Record<string,unknown>[]).reduce((a,r) => a+Number(r["count"]), 0);
  const reasonLabels: Record<string,string> = {
    sideways_market:"Боковой рынок",fake_breakout:"Ложный пробой",
    low_volume:"Низкий объём",high_volatility:"Высокая волатильность",
    trend_reversal:"Разворот тренда",other:"Прочее",
  };
  return (rows as Record<string,unknown>[]).map(r => {
    const pct = total > 0 ? (Number(r["count"])/total*100).toFixed(0) : "0";
    return `  ${pct}% — ${reasonLabels[r["reason"] as string] ?? r["reason"]}`;
  }).join("\n");
}

// ── Strategy Selection by Trust Score ─────────────────────────────────────────
export interface StrategySignalInput {
  strategy: StrategyName;
  score: number;
  confidence: number;
  direction: "LONG"|"SHORT";
}

export interface StrategyRankEntry {
  strategy: StrategyName;
  finalScore: number;
  trustScore: number;
  weight: number;
  regimePF: number;
  rawScore: number;
}

export interface StrategySelectionResult {
  selected: StrategySignalInput;
  isExploration: boolean;
  finalScore: number;
  trustScore: number;
  weight: number;
  ranking: StrategyRankEntry[];
}

/** 10% of trades go to non-best strategies for exploration (TZ §2) */
const EXPLORATION_RATE = 0.10;

export async function selectBestStrategy(
  signals: StrategySignalInput[],
  regime: MarketRegime
): Promise<StrategySelectionResult | null> {
  if (!signals.length) return null;

  const {rows:wRows} = await pool.query(
    "SELECT strategy,weight,disabled,disabled_until,quarantine,trust_score FROM strategy_weights"
  );

  const scored: Array<{sig:StrategySignalInput;trustScore:number;regimePF:number;weight:number;finalScore:number}> = [];

  for (const sig of signals) {
    const wRow = (wRows as Record<string,unknown>[]).find(r => r["strategy"] === sig.strategy);
    // Learning mode: never fully exclude a strategy — min weight 0.10 (TZ §2 exploration floor)
    const weight = Math.max(0.10, wRow ? Number(wRow["weight"]) : 1);
    const isQuarantine = wRow ? Boolean(wRow["quarantine"]) : false;

    // Quarantine: only allow moderate-confidence signals (≥35%)
    if (isQuarantine && sig.confidence < 35) continue;

    const recent = await getRecentStrategyStats(sig.strategy);
    const trustScore = await calcTrustScore(sig.strategy, recent.trades, recent.wins, recent.winPnl, recent.lossPnl, recent.totalPnl, regime);

    // Regime-specific PF
    let regimePF = 1;
    try {
      const {rows:regRows} = await pool.query(
        "SELECT win_pnl,loss_pnl FROM strategy_regime_stats WHERE strategy=$1 AND regime=$2",
        [sig.strategy, regime]
      );
      if (regRows.length) {
        const rr = regRows[0] as Record<string,unknown>;
        const rwp=Number(rr["win_pnl"]),rlp=Number(rr["loss_pnl"]);
        // Cap at 2.0: unbounded regimePF (e.g. 5 when lossPnl=0) inflated finalScore up to 750
        regimePF = Math.min(2.0, rlp > 0 ? rwp/rlp : rwp > 0 ? 2.0 : 0);
      }
    } catch { regimePF = 1; }

    // Final Score = Signal Score × Trust × Strategy Weight × Regime Score (TZ §1)
    // Math.min(100): weight≤1.5, regimePF≤2.0, trust≤1.0 → theoretical max=100*1.5*2.0=300 before cap
    const trustFloor = recent.trades < 30 ? 0.25 : 0.15;
    const finalScore = Math.min(100, sig.score
      * Math.max(trustFloor, trustScore / 100)  // bootstrap floor 25% if trades<30, else 15%
      * Math.max(0.10, weight)
      * Math.max(0.10, regimePF));

    scored.push({sig, trustScore, regimePF, weight, finalScore});
  }

  if (!scored.length) return null;

  // Sort by composite finalScore descending
  scored.sort((a, b) => b.finalScore - a.finalScore);

  const ranking: StrategyRankEntry[] = scored.map(s => ({
    strategy: s.sig.strategy,
    finalScore: s.finalScore,
    trustScore: s.trustScore,
    weight: s.weight,
    regimePF: s.regimePF,
    rawScore: s.sig.score,
  }));

  logger.debug({
    candidates: ranking.map(r => ({
      strategy: r.strategy, finalScore: r.finalScore.toFixed(1),
      trustScore: r.trustScore, weight: r.weight.toFixed(2),
    }))
  }, "Strategy selection ranking (composite finalScore)");

  // Exploration Mode (TZ §2): 10% of trades go to non-best strategies
  let pickedIdx = 0;
  let isExploration = false;
  if (scored.length > 1 && Math.random() < EXPLORATION_RATE) {
    pickedIdx = Math.floor(Math.random() * (scored.length - 1)) + 1;
    isExploration = true;
    logger.debug({ explorationPick: scored[pickedIdx]!.sig.strategy }, "Exploration mode: non-best strategy selected");
  }

  const best = scored[pickedIdx]!;
  return {
    selected: best.sig,
    isExploration,
    finalScore: best.finalScore,
    trustScore: best.trustScore,
    weight: best.weight,
    ranking,
  };
}

// ── Get all strategy statuses ──────────────────────────────────────────────────
export async function getAllStrategyStatuses(
  regime: MarketRegime = "sideways"
): Promise<StrategyTrustResult[]> {
  const {rows:wRows}    = await pool.query("SELECT * FROM strategy_weights");
  const now = new Date().toISOString();
  const results: StrategyTrustResult[] = [];

  for (const stratName of ["TREND","BREAKOUT","VOLUME_IMPULSE","MEAN_REVERSION"] as StrategyName[]) {
    const wRow    = (wRows    as Record<string,unknown>[]).find(r => r["strategy"] === stratName);

    const recent = await getRecentStrategyStats(stratName);
    const weight   = wRow ? Number(wRow["weight"]) : 1;
    const isDisabled  = wRow ? Boolean(wRow["disabled"])   : false;
    const disabledUntil = wRow ? wRow["disabled_until"] as string|null : null;
    const isQuarantine  = wRow ? Boolean(wRow["quarantine"]) : false;
    const isActuallyDisabled = isDisabled && (!disabledUntil || disabledUntil > now);
    const trustScore = await calcTrustScore(stratName, recent.trades, recent.wins, recent.winPnl, recent.lossPnl, recent.totalPnl, regime);
    const pf = recent.pf;
    const wr = recent.trades > 0 ? recent.wins / recent.trades : 0;
    const status: StrategyStatus = isActuallyDisabled ? "disabled" : isQuarantine ? "quarantine" : "active";
    results.push({strategy:stratName, trustScore, status, weight, trades:recent.trades, winRate:wr, profitFactor:pf});
  }
  return results;
}

// ── Quarantine check ──────────────────────────────────────────────────────────
export async function isStrategyInQuarantine(strategy: StrategyName): Promise<boolean> {
  const {rows} = await pool.query(
    "SELECT quarantine FROM strategy_weights WHERE strategy=$1", [strategy]
  );
  if (!rows.length) return false;
  return Boolean((rows[0] as Record<string,unknown>)["quarantine"]);
}

// ── Strategy history recording ─────────────────────────────────────────────────
async function recordStrategyHistory(
  strategy: StrategyName, prevWeight: number, newWeight: number,
  prevPF: number, newPF: number, trustScore: number, reason: string
): Promise<void> {
  await pool.query(
    `INSERT INTO strategy_history(strategy,changed_at,prev_weight,new_weight,prev_pf,new_pf,trust_score,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [strategy, new Date().toISOString(), prevWeight, newWeight, prevPF, newPF, trustScore, reason]
  ).catch(err => logger.debug({err}, "recordStrategyHistory failed"));
}

// ── Main adaptation cycle ──────────────────────────────────────────────────────
export async function loadStrategyWeights(): Promise<Record<StrategyName,number>> {
  const {rows} = await pool.query(
    "SELECT strategy,weight,disabled,disabled_until,quarantine FROM strategy_weights"
  );
  const weights:Record<string,number>={TREND:1,BREAKOUT:1,VOLUME_IMPULSE:1,MEAN_REVERSION:1};
  const now = new Date().toISOString();
  for (const r of rows as Record<string,unknown>[]) {
    const strat=r["strategy"] as string;
    let w=Number(r["weight"]);
    const disabled=Boolean(r["disabled"]);
    const quarantine=Boolean(r["quarantine"]);
    const until=r["disabled_until"] as string|null;
    if (disabled && until && until>now) { w=0; }
    else if (disabled && (!until||until<=now)) {
      await pool.query("UPDATE strategy_weights SET disabled=false,disabled_until=NULL WHERE strategy=$1",[strat]);
    }
    // Quarantine: cap effective weight at 0.5 for callers
    if (quarantine && w > 0) w = Math.min(w, 0.5);
    weights[strat]=w;
  }
  return weights as Record<StrategyName,number>;
}

/** PF → target weight mapping from TZ §1 */
function pfToTargetWeight(pf: number): number {
  if (pf >= 1.70) return 1.50;
  if (pf >= 1.40) return 1.20;
  if (pf >= 1.20) return 0.90;
  if (pf >= 1.00) return 0.60;
  if (pf >= 0.80) return 0.30;
  return 0.10; // exploration floor — never zero in learning mode
}

// ── Sliding window PF for Adaptation Engine ────────────────────────────────
  // Replaces lifetime cumulative strategy_stats to avoid pollution from legacy
  // fallback "TREND" trades recorded before the C1 fix.
  // Reverted 75 → 150 (07.07.2026): window of 75 was too narrow — shock period
  // dominated it and re-quarantined TREND/VOLUME_IMPULSE on every /adapt cycle.
  // 150 trades dilutes the shock sufficiently to give a fair PF read.
  const ADAPTATION_WINDOW = 150;

  async function getRecentStrategyStats(strategy: StrategyName): Promise<{
    trades: number; wins: number; winPnl: number; lossPnl: number; totalPnl: number; pf: number;
  }> {
    const { rows } = await pool.query(
      `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl
       FROM paper_closed_trades
       WHERE strategy=$1
       ORDER BY closed_at DESC
       LIMIT $2`,
      [strategy, ADAPTATION_WINDOW]
    );
    const pnls = (rows as Record<string, unknown>[]).map(r => Number(r["pnl"]) || 0);
    const trades   = pnls.length;
    const wins     = pnls.filter(p => p > 0).length;
    const winPnl   = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const lossPnl  = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
    return { trades, wins, winPnl, lossPnl, totalPnl, pf };
  }

  async function getRecentDirectionStats(
    strategy: string,
    direction: string
  ): Promise<{ trades: number; wins: number; winPnl: number; lossPnl: number; pf: number }> {
    const { rows } = await pool.query(
      `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl
       FROM paper_closed_trades
       WHERE strategy = $1
         AND direction = $2
         AND outcome NOT IN ('TIMEOUT_STALE')
       ORDER BY closed_at DESC
       LIMIT $3`,
      [strategy, direction, ADAPTATION_WINDOW]
    );
    const pnls = (rows as Record<string, unknown>[]).map(r => Number(r["pnl"]) || 0);
    const trades  = pnls.length;
    const wins    = pnls.filter(p => p > 0).length;
    const winPnl  = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const lossPnl = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
    return { trades, wins, winPnl, lossPnl, pf };
  }

  export async function runAdaptationCycle(_chatIds:Set<number>): Promise<string> {
  const {rows:wRows} = await pool.query(
    "SELECT strategy,weight,disabled,quarantine,cycles_below_threshold FROM strategy_weights"
  );
  const curW:Record<string,{weight:number;cycles:number;disabled:boolean;quarantine:boolean}>={};
  for (const r of wRows as Record<string,unknown>[])
    curW[r["strategy"] as string]={
      weight:Number(r["weight"]),
      cycles:Number(r["cycles_below_threshold"]),
      disabled:Boolean(r["disabled"]),
      quarantine:Boolean(r["quarantine"]),
    };

  const changes:string[]=[];
  const STRATS = ["TREND","BREAKOUT","VOLUME_IMPULSE","MEAN_REVERSION"] as StrategyName[];

  for (const strat of STRATS) {
    // ── Sliding window PF: last ADAPTATION_WINDOW trades instead of lifetime cumulative ──
      // Prevents pollution from legacy fallback-TREND records written before fix C1.
      const recent = await getRecentStrategyStats(strat);
      const trades   = recent.trades;
      const wins     = recent.wins;
      const winPnl   = recent.winPnl;
      const lossPnl  = recent.lossPnl;
      const totalPnl = recent.totalPnl;
      const pf       = recent.pf;
      const isNegativeReturn = totalPnl < 0;

      // ── 1. Gradual learning: start adapting at 20 trades (TZ §3) ───────────
      // Confidence scale: 20-49 trades=30%, 50-99=70%, 100+=100%
      // trades = min(real count, ADAPTATION_WINDOW) — threshold behaviour unchanged
      const confidenceScale = trades >= 100 ? 1.0 : trades >= 50 ? 0.7 : trades >= 20 ? 0.3 : 0;
      if (confidenceScale === 0) {
        logger.debug({strat,trades},"Adaptation skipped: insufficient sample (<20)");
        continue;
      }

    const cur = curW[strat] ?? {weight:1,cycles:0,disabled:false,quarantine:false};
    const trustScore = await calcTrustScore(strat, trades, wins, winPnl, lossPnl, totalPnl, "sideways");

    let newW = cur.weight;
    let newCycles = cur.cycles;
    let newDisabled = cur.disabled;
    let newQuarantine = cur.quarantine;
    let disabledUntil: string|null = null;
    let changeReason = "";

    // ── 4. Learning mode: never fully disable — use exploration floor 0.10 (TZ §5) ──
    // Strategies with 100+ trades and PF<0.7 get pinned to 0.10 weight (not disabled)
    if (trades >= 100 && pf < 0.7 && isNegativeReturn && !cur.disabled) {
      newQuarantine = true;
      newW = 0.10; // exploration floor — always gets 10% of slots
      changeReason = `Слабая стратегия (${trades} сд, PF ${pf.toFixed(2)}) → вес минимум 10% (режим обучения)`;
      changes.push(`⚠️ ${strat}: вес → 10% (PF ${pf.toFixed(2)}, режим обучения — не отключаем)`);
      await recordStrategyHistory(strat, cur.weight, newW, pf, pf, trustScore, changeReason);
      await pool.query(
        `UPDATE strategy_weights SET weight=$2,disabled=false,disabled_until=NULL,quarantine=true,
         cycles_below_threshold=$3,trust_score=$4,updated_at=$5 WHERE strategy=$1`,
        [strat, newW, cur.cycles + 1, trustScore, new Date().toISOString()]
      );
      continue;
    }

    // Re-enable: check shadow performance if disabled
    if (cur.disabled) {
      const {rows:shadowRows} = await pool.query(
        `SELECT COUNT(*) as cnt,
                SUM(CASE WHEN is_win THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN is_win THEN pnl_percent ELSE 0 END) as win_pnl,
                SUM(CASE WHEN NOT is_win THEN ABS(pnl_percent) ELSE 0 END) as loss_pnl
         FROM shadow_closed_trades WHERE strategy=$1 ORDER BY closed_at DESC LIMIT 30`,
        [strat]
      );
      if (shadowRows.length) {
        const sr = shadowRows[0] as Record<string,unknown>;
        const sCnt = Number(sr["cnt"]);
        const sWinPnl = Number(sr["win_pnl"]);
        const sLossPnl = Number(sr["loss_pnl"]);
        const sPF = sCnt >= 10 && sLossPnl > 0 ? sWinPnl/sLossPnl : 0;
        if (sPF >= 1.0 && sCnt >= 10) {
          newDisabled = false;
          newQuarantine = true; // Return via quarantine first
          newW = Math.max(0.3, cur.weight * 0.5);
          changeReason = `Восстановлена из Shadow (PF ${sPF.toFixed(2)}) → Карантин`;
          changes.push(`🔄 ${strat}: возвращена из Shadow → *Карантин* (PF тени: ${sPF.toFixed(2)})`);
          await recordStrategyHistory(strat, 0, newW, pf, sPF, trustScore, changeReason);
        } else {
          await pool.query(
            "UPDATE strategy_weights SET trust_score=$2,updated_at=$3 WHERE strategy=$1",
            [strat, trustScore, new Date().toISOString()]
          );
          continue;
        }
      } else {
        continue;
      }
    }

    // ── 3. Quarantine mode: PF<0.8 and negative return ──────────────────
    if (!newDisabled) {
      if (trades >= 30 && pf < 0.5 && isNegativeReturn && !cur.quarantine) {
        newQuarantine = true;
        newW = Math.max(0.3, cur.weight - 0.10);
        newCycles = cur.cycles + 1;
        changeReason = `Карантин: PF ${pf.toFixed(2)}, убыточна`;
        changes.push(`⚠️ ${strat}: → *Карантин* (PF ${pf.toFixed(2)}, только Confidence ≥60%)`);
        await recordStrategyHistory(strat, cur.weight, newW, pf, pf, trustScore, changeReason);
      } else if (cur.quarantine && pf >= 1.0 && !isNegativeReturn) {
        newQuarantine = false;
        newW = Math.min(1.0, cur.weight + 0.05);
        changeReason = `Выход из карантина: PF ${pf.toFixed(2)} → норма`;
        changes.push(`✅ ${strat}: выходит из карантина (PF ${pf.toFixed(2)})`);
        await recordStrategyHistory(strat, cur.weight, newW, pf, pf, trustScore, changeReason);
      } else {
        // ── 2. PF-table direct mapping with confidence scaling (TZ §1, §3) ──
        // Target weight from PF table; blend toward it scaled by sample confidence
        const targetW = pfToTargetWeight(pf);
        const blendSpeed = 0.15; // max 15% of gap per cycle
        const blendedW = cur.weight + (targetW - cur.weight) * confidenceScale * blendSpeed;
        // H3 warm-up cap: limit weight growth to 0.80 until 30 trades are collected.
        // Prevents a lucky bootstrap streak (PF=2.0 with 5 wins, 0 losses) from
        // immediately reaching max weight (1.50) before the strategy is proven.
        const warmupCap = trades < 30 ? 0.80 : 1.50;
        newW = Math.max(0.10, Math.min(warmupCap, blendedW));
        newCycles = pf < 0.5 ? cur.cycles + 1 : Math.max(0, cur.cycles - 1);
        if (Math.abs(newW - cur.weight) > 0.005) {
          const dir = newW > cur.weight ? "📈" : "📉";
          const arrow = newW > cur.weight ? "+" : "";
          changeReason = `PF ${pf.toFixed(2)} → цель ${(targetW*100).toFixed(0)}%, шаг ${arrow}${((newW-cur.weight)*100).toFixed(1)}% (conf ${(confidenceScale*100).toFixed(0)}%)`;
          changes.push(`${dir} ${strat}: вес ${(cur.weight*100).toFixed(0)}%→${(newW*100).toFixed(0)}% (PF ${pf.toFixed(2)}, n=${trades})`);
          await recordStrategyHistory(strat, cur.weight, newW, pf, pf, trustScore, changeReason);
        }
      }
    }

    // ── Минимальный вес — стратегия не может быть фактически отключена
    // даже в период деградации, чтобы не терять данные для обучения
    const MIN_STRATEGY_WEIGHT = 0.35;
    const MAX_STRATEGY_WEIGHT = 1.50;
    newW = Math.max(MIN_STRATEGY_WEIGHT, Math.min(MAX_STRATEGY_WEIGHT, newW));

    await pool.query(
      `UPDATE strategy_weights SET weight=$2,disabled=$3,disabled_until=$4,quarantine=$5,
       cycles_below_threshold=$6,trust_score=$7,updated_at=$8 WHERE strategy=$1`,
      [strat, newW, newDisabled, disabledUntil, newQuarantine, newCycles, trustScore, new Date().toISOString()]
    );
  }

  // ── ТЗ: адаптация весов/карантина по направлению (LONG/SHORT) ──────────
  // Работает поверх strategy-level весов как дополнительный слой (не замена).
  // Получить список уникальных strategy+direction из таблицы весов
  const {rows:dirWeightRows} = await pool.query(
    "SELECT strategy, direction, weight, quarantine, quarantine_since FROM strategy_direction_stats"
  );

  for (const row of dirWeightRows as Record<string,unknown>[]) {
    const strat     = row["strategy"] as string;
    const direction = row["direction"] as string;
    const wasInQuarantine = Boolean(row["quarantine"]);

    // Использовать ту же метрику и то же окно что и основной адаптер
    const recent = await getRecentDirectionStats(strat, direction);
    const dTrades = recent.trades;
    const pf      = recent.pf;
    const wr      = dTrades > 0 ? recent.wins / dTrades : 0;

    // Порог для карантина и адаптации — такой же как в основном адаптере
    if (dTrades < 10) continue; // мало данных — не трогать

    let newWeight = Number(row["weight"]);
    let quarantine = false;

    if (pf < 0.5 && dTrades >= 10) {
      quarantine = true;
      newWeight = Math.max(0.1, newWeight * 0.7);
    } else if (pf < 0.8 && dTrades >= 5) {
      newWeight = Math.max(0.2, newWeight * 0.9);
    } else if (pf > 1.5) {
      newWeight = Math.min(1.5, newWeight * 1.1);
    }

    let quarantineSinceUpdate: string | null | undefined; // undefined = don't touch column

    // ── ТЗ: выход из direction карантина — Механизм 1: принудительный пересмотр раз в 7 дней ──
    if (quarantine && !wasInQuarantine) {
      // Только что вошли в карантин — зафиксировать момент входа
      quarantineSinceUpdate = new Date().toISOString();
    } else if (quarantine && wasInQuarantine) {
      const quarantineSince = row["quarantine_since"] ? new Date(row["quarantine_since"] as string) : null;
      const daysSinceQuarantine = quarantineSince
        ? (Date.now() - quarantineSince.getTime()) / (1000 * 60 * 60 * 24)
        : 0;

      if (daysSinceQuarantine >= 7) {
        const freshRecent = await getRecentDirectionStats(strat, direction);
        if (freshRecent.pf >= 0.6 && freshRecent.trades >= 5) {
          quarantine = false;
          newWeight = 0.3; // Начать с минимального веса, не с нуля
          quarantineSinceUpdate = null;
          changes.push(`🔄 ${strat} ${direction}: карантин снят (7 дней, PF ${freshRecent.pf.toFixed(2)}) → вес 30%`);
        } else {
          quarantineSinceUpdate = new Date().toISOString();
          changes.push(`🔒 ${strat} ${direction}: карантин продлён (PF ${freshRecent.pf.toFixed(2)} < 0.6)`);
        }
      }
    } else if (!quarantine && wasInQuarantine) {
      // Естественный выход (свежие сделки подняли PF выше 0.5)
      quarantineSinceUpdate = null;
    }

    // ── ТЗ: выход из direction карантина — Механизм 2: shadow trades для заблокированных направлений ──
    if (quarantine) {
      const { rows: shadowRows } = await pool.query(
        `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl, is_win FROM shadow_closed_trades
         WHERE strategy=$1 AND direction=$2
           AND is_direction_shadow = true
           AND closed_at::timestamptz > NOW() - INTERVAL '30 days'
         ORDER BY closed_at DESC LIMIT 50`,
        [strat, direction]
      );

      const SHADOW_MIN_TRADES = 50; // было 20 — 20 сделок недостаточно в аномальный период
      const SHADOW_MIN_PF = 0.85;   // было 0.8 — чуть строже

      if (shadowRows.length >= SHADOW_MIN_TRADES) {
        const sPnls = (shadowRows as Record<string,unknown>[]).map(r => Number(r["pnl"]));
        const sWinPnl = sPnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
        const sLossPnl = Math.abs(sPnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
        const sPF = sLossPnl > 0 ? sWinPnl / sLossPnl : sWinPnl > 0 ? 2.0 : 0;

        if (sPF >= SHADOW_MIN_PF) {
          // Shadow PF восстановился — снять карантин с минимальным весом
          quarantine = false;
          newWeight = 0.3;
          quarantineSinceUpdate = null;
          changes.push(`🔄 ${strat} ${direction}: карантин снят по shadow (PF ${sPF.toFixed(2)}, n=${shadowRows.length}) → вес 30%`);

          // Доп. проверка — shadow PF не должен кардинально расходиться
          // с историческим реальным PF направления (аномалия ночного рынка)
          const realRecent = await getRecentDirectionStats(strat, direction);
          if (realRecent.trades >= 10 && sPF > realRecent.pf * 3) {
            quarantine = true;
            newWeight = 0.1;
            quarantineSinceUpdate = new Date().toISOString();
            changes.push(`⚠️ ${strat} ${direction}: shadow PF ${sPF.toFixed(2)} аномально выше реального ${realRecent.pf.toFixed(2)} — карантин продлён`);
          }
        }
      }
    }

    // ── Минимальный вес по направлению — не давать направлению уйти в 0
    // даже под карантином, чтобы сохранить данные для обучения
    const MIN_DIRECTION_WEIGHT = 0.20; // для карантинных направлений
    newWeight = Math.max(
      quarantine ? 0.10 : MIN_DIRECTION_WEIGHT,
      Math.min(1.5, newWeight)
    );

    if (quarantine || Math.abs(newWeight - Number(row["weight"])) > 0.005) {
      changes.push(
        `${quarantine?"⚠️":newWeight>Number(row["weight"])?"📈":"📉"} ${strat} ${direction}: ` +
        `вес ${(Number(row["weight"])*100).toFixed(0)}%→${(newWeight*100).toFixed(0)}% ` +
        `(PF ${pf.toFixed(2)}, n=${dTrades})${quarantine?" — карантин по направлению":""}`
      );
    }

    if (quarantineSinceUpdate === undefined) {
      await pool.query(
        `UPDATE strategy_direction_stats
         SET weight=$3, quarantine=$4, trust_score=$5, updated_at=$6
         WHERE strategy=$1 AND direction=$2`,
        [strat, direction, newWeight, quarantine, Math.round(wr*100), new Date().toISOString()]
      );
    } else {
      await pool.query(
        `UPDATE strategy_direction_stats
         SET weight=$3, quarantine=$4, trust_score=$5, updated_at=$6, quarantine_since=$7
         WHERE strategy=$1 AND direction=$2`,
        [strat, direction, newWeight, quarantine, Math.round(wr*100), new Date().toISOString(), quarantineSinceUpdate]
      );
    }
  }

  return changes.length > 0 ? changes.join("\n") : "Изменений нет — все стратегии в норме";
}

export async function getClosedTradeCount(): Promise<number> {
  const {rows} = await pool.query("SELECT COUNT(*) as cnt FROM paper_closed_trades");
  return Number((rows[0] as Record<string,unknown>)["cnt"]);
}

async function getVersionCounter(): Promise<string> {
  const {rows} = await pool.query("SELECT COUNT(*) as cnt FROM strategy_versions");
  const n=Number((rows[0] as Record<string,unknown>)["cnt"])+1;
  return `v1.${n}`;
}

export async function snapshotStrategyVersion(changes:string): Promise<void> {
  const {rows:wRows} = await pool.query("SELECT * FROM factor_weights WHERE id=1");
  const weights=wRows.length ? wRows[0] as Record<string,unknown> : {};
  const {rows:statsRows} = await pool.query(
    "SELECT pnl_percent FROM paper_closed_trades WHERE pnl_percent IS NOT NULL ORDER BY closed_at DESC LIMIT 100"
  );
  const pnls=statsRows.map(r=>Number((r as Record<string,unknown>)["pnl_percent"]));
  const wins=pnls.filter(p=>p>0);
  const losses=pnls.filter(p=>p<=0);
  const wr=pnls.length?wins.length/pnls.length*100:0;
  const winPnl=wins.reduce((a,b)=>a+b,0);
  const lossPnl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
  const mean=pnls.length?pnls.reduce((a,b)=>a+b,0)/pnls.length:0;
  const std=pnls.length>1?Math.sqrt(pnls.reduce((a,b)=>a+(b-mean)**2,0)/(pnls.length-1)):0;
  const sharpe=std>0?mean/std:0;
  let eq=100; const curve=[100];
  for (const p of [...pnls].reverse()) { eq*=(1+p/100); curve.push(eq); }
  let peak=curve[0]??100, dd=0;
  for (const v of curve) { if(v>peak)peak=v; dd=Math.max(dd,peak>0?(peak-v)/peak*100:0); }
  const rf=dd>0?((eq-100)/dd):0;
  const label=await getVersionCounter();

  await pool.query("UPDATE strategy_versions SET is_best=false WHERE is_best=true");
  await pool.query(
    `INSERT INTO strategy_versions(created_at,weights,win_rate,profit_factor,trade_count,is_best,version_label,total_return,max_drawdown,sharpe_ratio,recovery_factor,notes)
     VALUES($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11)`,
    [new Date().toISOString(),JSON.stringify(weights),wr,pf,pnls.length,label,eq-100,dd,sharpe,rf,changes]
  );
  const {rows:all} = await pool.query("SELECT id FROM strategy_versions ORDER BY created_at DESC OFFSET 10");
  for (const r of all as Record<string,unknown>[])
    await pool.query("DELETE FROM strategy_versions WHERE id=$1",[r["id"]]);
  logger.info({label,pf,wr,sharpe},"Strategy version snapshot saved");
}

export async function checkAndRollback(): Promise<string|null> {
  const {rows} = await pool.query(
    "SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 2"
  );
  if (rows.length<2) return null;
  const cur=rows[0] as Record<string,unknown>;
  const prev=rows[1] as Record<string,unknown>;
  const curPF=Number(cur["profit_factor"]);
  const prevPF=Number(prev["profit_factor"]);
  if (prevPF>0.5 && curPF<prevPF*0.8) {
    const bestWeights=(prev["weights"] as Record<string,unknown>);
    await pool.query(
      "UPDATE factor_weights SET trend=$1,volume=$2,momentum=$3,levels=$4,pattern=$5 WHERE id=1",
      [bestWeights["trend"],bestWeights["volume"],bestWeights["momentum"],bestWeights["levels"],bestWeights["pattern"]]
    );
    logger.warn({curPF,prevPF},"Strategy rolled back to previous version");
    return `🔄 *Откат стратегии*\nТекущий PF ${curPF.toFixed(2)} хуже предыдущего ${prevPF.toFixed(2)} на >20%.\nВосстановлена версия ${cur["version_label"]??prev["version_label"]}.`;
  }
  return null;
}

export async function generateLearningReport(): Promise<string> {
  const tradeCount=await getClosedTradeCount();
  const {rows:statRows} = await pool.query("SELECT * FROM strategy_stats");
  const {rows:wRows}    = await pool.query("SELECT strategy,weight,disabled,quarantine,trust_score FROM strategy_weights");
  const {rows:vRows}    = await pool.query("SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 2");

  const stratLines:string[]=[];
  for (const r of statRows as Record<string,unknown>[]) {
    const strat=r["strategy"] as StrategyName;
    const trades=Number(r["trades"]);
    if (trades<5) continue;
    const wins=Number(r["wins"]);
    const winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
    const pf=lossPnl>0?winPnl/lossPnl:winPnl>0?99:0;
    const wr=(wins/trades*100).toFixed(1);
    const wRow=wRows.find(w=>(w as Record<string,unknown>)["strategy"]===strat) as Record<string,unknown>|undefined;
    const weight=wRow?Number(wRow["weight"]):1;
    const dis=wRow?Boolean(wRow["disabled"]):false;
    const quar=wRow?Boolean(wRow["quarantine"]):false;
    const trust=wRow?Number(wRow["trust_score"]):0;
    const sampleTag = trades < 30 ? " ⚠️<30сд" : "";
    const icon=dis?"🚫":quar?"⚠️":weight>=1.3?"🔥":weight<=0.5?"📉":"✅";
    stratLines.push(`${icon} ${strat}: WR ${wr}% | PF ${pf===99?"∞":pf.toFixed(2)} | Trust ${trust}/100 | Вес ${(weight*100).toFixed(0)}%${sampleTag}`);
  }

  let vLine="";
  if (vRows.length>=2) {
    const c=vRows[0] as Record<string,unknown>, p=vRows[1] as Record<string,unknown>;
    const diff=Number(c["profit_factor"])-Number(p["profit_factor"]);
    vLine=`\n📊 ${p["version_label"]}→${c["version_label"]}: PF ${Number(p["profit_factor"]).toFixed(2)}→${Number(c["profit_factor"]).toFixed(2)} (${diff>=0?"+":""}${diff.toFixed(2)})`;
  }

  const reportLabel=`v${Math.floor(tradeCount/100)}.${tradeCount%100<50?0:5}`;
  const summary=[`🧠 *AI Learning Report — ${reportLabel}*`,`📊 Сделок: ${tradeCount}`,"",`📐 *Стратегии:*`,...stratLines,vLine].filter(Boolean).join("\n");

  const {rows:dirRows} = await pool.query(`
    SELECT sds.strategy, sds.direction, sds.trades, sds.wins, sds.win_pnl, sds.loss_pnl,
      COALESCE(sw.weight, 1) AS weight, COALESCE(sw.quarantine, false) AS quarantine
    FROM strategy_direction_stats sds
    LEFT JOIN strategy_weights sw ON sw.strategy = sds.strategy`);
  type DirEntry = {trades:number;wins:number;winPnl:number;lossPnl:number};
  const dirByStrat:Record<string,{dirs:Record<string,DirEntry>;weight:number;quarantine:boolean}>={};
  for (const r of dirRows as Record<string,unknown>[]) {
    const strat=r["strategy"] as string, dir=r["direction"] as string;
    const trades=Number(r["trades"]);
    if (trades<5) continue;
    if (!dirByStrat[strat]) dirByStrat[strat]={dirs:{},weight:Number(r["weight"]),quarantine:Boolean(r["quarantine"])};
    dirByStrat[strat]!.dirs[dir]={trades,wins:Number(r["wins"]),winPnl:Number(r["win_pnl"]),lossPnl:Number(r["loss_pnl"])};
  }
  const dirLines:string[]=[];
  for (const [strat,entry] of Object.entries(dirByStrat)) {
    for (const d of ["LONG","SHORT"]) {
      const s=entry.dirs[d]; if(!s) continue;
      const wr=(s.wins/s.trades*100).toFixed(0);
      const pf=s.lossPnl>0?(s.winPnl/s.lossPnl).toFixed(2):"∞";
      const wPct=(entry.weight*100).toFixed(0);
      const statusIcon=entry.quarantine?"⚠️":"✅";
      dirLines.push(`${(strat+"_"+d).padEnd(22)}WR${wr}% PF${pf} | Вес ${wPct}% ${statusIcon}`);
    }
  }
  const dirSection = dirLines.length ? ["","📊 *LONG vs SHORT:*",...dirLines].join("\n") : "";
  const fullSummary = dirSection ? summary + dirSection : summary;

  await pool.query(
    "INSERT INTO learning_reports(version_label,created_at,trade_count_at_report,summary,report_json) VALUES($1,$2,$3,$4,$5)",
    [reportLabel,new Date().toISOString(),tradeCount,summary,JSON.stringify({strategies:stratLines,tradeCount})]
  );
  return fullSummary;
}

export async function getLearningHistory(): Promise<string> {
  const {rows:vRows}   = await pool.query("SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 10");
  const {rows:rRows}   = await pool.query("SELECT version_label,created_at,summary FROM learning_reports ORDER BY created_at DESC LIMIT 3");
  const {rows:regRows} = await pool.query("SELECT strategy,regime,trades,wins,win_pnl,loss_pnl FROM strategy_regime_stats");

  if (!vRows.length) return "📚 *История обучения*\n\nДанных пока нет — нужно минимум 20 сделок для первого снапшота.";

  const vLines=vRows.map(r=>{
    const row=r as Record<string,unknown>;
    const label=(row["version_label"] as string)??"—";
    const pf=Number(row["profit_factor"]);
    const wr=Number(row["win_rate"]);
    const n=Number(row["trade_count"]);
    const best=Boolean(row["is_best"]);
    const date=(row["created_at"] as string).slice(0,10);
    const dd=Number(row["max_drawdown"]);
    return `${best?"⭐":"  "} ${label} [${date}] PF ${pf.toFixed(2)} | WR ${wr.toFixed(1)}% | n=${n} | DD ${dd.toFixed(1)}%`;
  });

  const regByStrat:Record<string,string[]>={};
  const REGIME_LABEL:Record<string,string>={trend_up:"📈↑",trend_down:"📉↓",sideways:"↔️",high_vol:"⚡",low_vol:"😴"};
  for (const r of regRows as Record<string,unknown>[]) {
    const strat=r["strategy"] as string;
    const trades=Number(r["trades"]);
    if (trades<5) continue;
    const wins=Number(r["wins"]),winPnl=Number(r["win_pnl"]),lossPnl=Number(r["loss_pnl"]);
    const pf=lossPnl>0?winPnl/lossPnl:99;
    const wr=(wins/trades*100).toFixed(0);
    const regime=r["regime"] as string;
    if(!regByStrat[strat]) regByStrat[strat]=[];
    regByStrat[strat]!.push(`  ${REGIME_LABEL[regime]??regime}: PF ${pf===99?"∞":pf.toFixed(2)} WR${wr}% n=${trades}`);
  }
  const regLines:string[]=[];
  for (const [s,lines] of Object.entries(regByStrat)) { regLines.push(`*${s}:*`,...lines); }

  const lastReports=rRows.length ? ["","📋 *Последние отчёты:*",...rRows.map(r=>(r as Record<string,unknown>)["version_label"] as string)] : [];

  return ["📚 *История обучения AI*","","🔖 *Версии стратегии:*",...vLines,
    ...(regLines.length?["","🌍 *По режиму рынка:*",...regLines]:[]),
    ...lastReports].join("\n");
}

// ── Strategy evolution history ─────────────────────────────────────────────────
export async function getStrategyEvolutionHistory(strategy?: StrategyName): Promise<string> {
  const whereClause = strategy ? "WHERE strategy=$1" : "";
  const params = strategy ? [strategy] : [];
  const {rows} = await pool.query(
    `SELECT strategy,changed_at,prev_weight,new_weight,prev_pf,new_pf,trust_score,reason
     FROM strategy_history ${whereClause} ORDER BY changed_at DESC LIMIT 20`,
    params
  );

  if (!rows.length) return "📈 *История изменений стратегий*\n\nИзменений пока нет — нужно минимум 30 сделок.";

  const lines: string[] = strategy
    ? [`📈 *История: ${strategy}*`, ""]
    : ["📈 *История изменений стратегий*", ""];

  for (const r of rows as Record<string,unknown>[]) {
    const strat = r["strategy"] as string;
    const date  = (r["changed_at"] as string).slice(0,10);
    const prevW = (Number(r["prev_weight"])*100).toFixed(0);
    const newW  = (Number(r["new_weight"])*100).toFixed(0);
    const prevPF= Number(r["prev_pf"]).toFixed(2);
    const newPF = Number(r["new_pf"]).toFixed(2);
    const trust = Number(r["trust_score"]);
    const reason= r["reason"] as string;
    const arrow = Number(newW) > Number(prevW) ? "↑" : Number(newW) < Number(prevW) ? "↓" : "→";
    lines.push(`${arrow} *${strategy ? "" : strat + " "}*[${date}] Вес: ${prevW}%→${newW}% | PF: ${prevPF}→${newPF} | Trust: ${trust}`);
    lines.push(`  _${reason}_`);
  }
  return lines.join("\n");
}

// ── Weekly Strategy Ranking (TZ §4) ──────────────────────────────────────────
export async function generateWeeklyRanking(): Promise<string> {
  const {rows:statRows} = await pool.query("SELECT * FROM strategy_stats ORDER BY strategy");
  const {rows:wRows}    = await pool.query("SELECT strategy,weight,trust_score,quarantine FROM strategy_weights");

  const MEDALS = ["🥇","🥈","🥉","4️⃣"];
  const stratRows = ["TREND","BREAKOUT","VOLUME_IMPULSE","MEAN_REVERSION"] as StrategyName[];

  const entries: Array<{strat:StrategyName;pf:number;wr:number;trades:number;weight:number;trust:number}> = [];

  for (const strat of stratRows) {
    const s = (statRows as Record<string,unknown>[]).find(r => r["strategy"] === strat);
    const w = (wRows    as Record<string,unknown>[]).find(r => r["strategy"] === strat);
    const trades   = s ? Number(s["trades"])   : 0;
    const wins     = s ? Number(s["wins"])     : 0;
    const winPnl   = s ? Number(s["win_pnl"])  : 0;
    const lossPnl  = s ? Number(s["loss_pnl"]) : 0;
    const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 99 : 0;
    const wr = trades > 0 ? wins / trades : 0;
    const weight = w ? Number(w["weight"]) : 1;
    const trust  = w ? Number(w["trust_score"]) : 0;
    entries.push({strat, pf, wr, trades, weight, trust});
  }

  // Sort by weight desc (weights already reflect PF performance)
  entries.sort((a, b) => b.weight - a.weight);

  const STRAT_NAMES: Record<string,string> = {
    TREND:"Trend", BREAKOUT:"Breakout",
    VOLUME_IMPULSE:"Volume Impulse", MEAN_REVERSION:"Mean Reversion",
  };

  const now = new Date();
  const weekStr = `${now.getDate().toString().padStart(2,"0")}.${(now.getMonth()+1).toString().padStart(2,"0")}.${now.getFullYear()}`;

  const lines = [
    `📊 *Еженедельный рейтинг стратегий — ${weekStr}*`,
    `_Используется при выборе сделок на следующей неделе_`,
    ``,
  ];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const medal = MEDALS[i] ?? `${i+1}.`;
    const pfStr = e.pf >= 99 ? "∞" : e.pf === 0 ? "—" : e.pf.toFixed(2);
    const wrStr = e.trades > 0 ? `${(e.wr*100).toFixed(0)}%` : "—";
    const sampleTag = e.trades < 20 ? ` ⚠️ мало данных (${e.trades} сд)` : `n=${e.trades}`;
    lines.push(`${medal} *${STRAT_NAMES[e.strat] ?? e.strat}*`);
    lines.push(`PF ${pfStr} | WR ${wrStr} | Trust ${e.trust}/100 | ${sampleTag}`);
    lines.push(`Вес: ${(e.weight*100).toFixed(0)}% — ${pfToTargetWeight(e.pf) === e.weight ? "точно по таблице" : e.weight >= 1.0 ? "приоритет" : e.weight <= 0.2 ? "исследование" : "адаптация"}`);
    lines.push(``);
  }

  lines.push(`_Следующий пересчёт — воскресенье 20:00_`);
  return lines.join("\n");
}
