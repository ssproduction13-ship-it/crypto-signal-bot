import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { StrategyName } from "./strategies.js";
import type { MarketCondition } from "./chaos-filter.js";
import type { MarketRating } from "./market-rating.js";

export type MarketRegime = "trend_up"|"trend_down"|"sideways"|"high_vol"|"low_vol";
export type StrategyStatus = "active"|"quarantine"|"disabled";

export type StrategyEntity =
  | "TREND_LONG" | "TREND_SHORT"
  | "VOLUME_IMPULSE_LONG" | "VOLUME_IMPULSE_SHORT"
  | "MEAN_REVERSION_LONG" | "MEAN_REVERSION_SHORT"
  | "BREAKOUT_LONG" | "BREAKOUT_SHORT";

export function getEntity(strategy: StrategyName, direction: "LONG"|"SHORT"): StrategyEntity {
  return `${strategy}_${direction}` as StrategyEntity;
}

export interface EntityTrustResult {
  entity: StrategyEntity;
  trustScore: number;
  status: StrategyStatus;
  weight: number;
  trades: number;
  winRate: number;
  profitFactor: number;
}

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
    "SELECT entity, weight, quarantine FROM strategy_entity_weights"
  );

  const scored: Array<{sig:StrategySignalInput;trustScore:number;regimePF:number;weight:number;finalScore:number}> = [];

  for (const sig of signals) {
    const entity = getEntity(sig.strategy, sig.direction as "LONG"|"SHORT");
    const wRow = (wRows as Record<string,unknown>[]).find(r => r["entity"] === entity);
    // Learning mode: never fully exclude an entity — min weight 0.10 (TZ §2 exploration floor)
    const weight = Math.max(0.10, wRow ? Number(wRow["weight"]) : 1);
    const isQuarantine = wRow ? Boolean(wRow["quarantine"]) : false;
    const effectiveWeight = isQuarantine
      ? 0.10  // exploration floor — карантинные сущности скорятся минимальным весом
      : Math.max(0.10, weight);
    // Убрано: continue при карантине — пусть Entity Guard в scheduler решает

    const recent = await getRecentEntityStats(entity);
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
      * Math.max(0.30, effectiveWeight)  // ← floor 30%: при bootstrap даже слабый weight даёт FinalScore > 5
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

// ── Get all entity statuses (8-entity architecture) ──────────────────────────
export async function getAllEntityStatuses(
  regime: MarketRegime = "sideways"
): Promise<EntityTrustResult[]> {
  const ENTITIES: StrategyEntity[] = [
    "TREND_LONG", "TREND_SHORT",
    "VOLUME_IMPULSE_LONG", "VOLUME_IMPULSE_SHORT",
    "MEAN_REVERSION_LONG", "MEAN_REVERSION_SHORT",
    "BREAKOUT_LONG", "BREAKOUT_SHORT",
  ];
  const {rows:ewRows} = await pool.query(
    "SELECT entity, weight, quarantine, trust_score FROM strategy_entity_weights"
  );
  const results: EntityTrustResult[] = [];
  for (const entity of ENTITIES) {
    const recent = await getRecentEntityStats(entity);
    const wRow = (ewRows as Record<string,unknown>[]).find(r => r["entity"] === entity);
    const weight = wRow ? Number(wRow["weight"]) : 1.0;
    const isQuarantine = wRow ? Boolean(wRow["quarantine"]) : false;
    const entityParts = entity.split("_");
    const entityDir = entityParts.pop() as string;
    const entityStrat = entityParts.join("_") as StrategyName;
    const trustScore = await calcTrustScore(entityStrat, recent.trades, recent.wins, recent.winPnl, recent.lossPnl, recent.totalPnl, regime);
    const wr = recent.trades > 0 ? recent.wins / recent.trades : 0;
    const status: StrategyStatus = isQuarantine ? "quarantine" : "active";
    results.push({ entity, trustScore, status, weight, trades: recent.trades, winRate: wr, profitFactor: recent.pf });
    void entityDir;
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
         AND closed_at::timestamptz >= (SELECT COALESCE(reset_at, '1970-01-01'::timestamptz) FROM paper_accounts LIMIT 1)
       ORDER BY closed_at DESC
       LIMIT $2`,
      [strategy, ADAPTATION_WINDOW]
    );
    // Fall back to strategy_stats when live trades table has less history
    const { rows: ssRows } = await pool.query(
      `SELECT trades, wins, win_pnl, loss_pnl, total_pnl FROM strategy_stats WHERE strategy=$1`,
      [strategy as string]
    ).catch(() => ({ rows: [] }));
    const ss = (ssRows as Record<string, unknown>[])[0];
    const ssTrades = ss ? Number(ss["trades"]) : 0;
    // Only fall back to cached stats on a true cold start (zero live trades).
    // Using < 30 caused the fallback to override live Test-2.0 data with stale
    // Test-1.0 numbers when an entity had fewer than 30 recent trades.
    if (rows.length === 0 && ssTrades > 0) {
      const wins     = ss ? Number(ss["wins"])      : 0;
      const winPnl   = ss ? Number(ss["win_pnl"])   : 0;
      const lossPnl  = ss ? Number(ss["loss_pnl"])  : 0;
      const totalPnl = ss ? Number(ss["total_pnl"]) : 0;
      const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
      return { trades: ssTrades, wins, winPnl, lossPnl, totalPnl, pf };
    }
    const pnls = (rows as Record<string, unknown>[]).map(r => Number(r["pnl"]) || 0);
    const trades   = pnls.length;
    const wins     = pnls.filter(p => p > 0).length;
    const winPnl   = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const lossPnl  = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
    return { trades, wins, winPnl, lossPnl, totalPnl, pf };
  }

  // NOTE (ТЗ Шаг 9.3): getRecentDirectionStats was here as a leftover from the
  // pre-entity direction-quarantine system. It was never called anywhere after
  // the migration to per-entity (strategy×direction) adaptation, so it has
  // been removed as dead code. getRecentStrategyStats above is intentionally
  // KEPT (deviation from a literal reading of Шаг 9.3): it still backs
  // getAllStrategyStatuses()/strategy_weights, which Шаг 9.4 explicitly says
  // to keep populated for backward compatibility (scheduler.ts Trust Score /
  // Strategy PF gates and other consumers read it).

  async function getRecentEntityStats(entity: StrategyEntity): Promise<{
    trades: number; wins: number; winPnl: number; lossPnl: number; totalPnl: number; pf: number;
  }> {
    const parts = entity.split("_");
    const direction = parts.pop() as string;
    const strategy = parts.join("_");
    const { rows } = await pool.query(
      `SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl
       FROM paper_closed_trades
       WHERE strategy=$1
         AND direction=$2
         AND outcome NOT IN ('TIMEOUT_STALE')
         AND closed_at::timestamptz >= (SELECT COALESCE(reset_at, '1970-01-01'::timestamptz) FROM paper_accounts LIMIT 1)
       ORDER BY closed_at DESC
       LIMIT $3`,
      [strategy, direction, ADAPTATION_WINDOW]
    );
    // Fall back to strategy_direction_stats when live trades table has less history
    // (handles DB resets where paper_closed_trades was wiped but analytics tables are preserved)
    const { rows: sdsRows } = await pool.query(
      `SELECT trades, wins, win_pnl, loss_pnl, total_pnl
       FROM strategy_direction_stats WHERE strategy=$1 AND direction=$2`,
      [strategy, direction]
    ).catch(() => ({ rows: [] }));
    const sds = (sdsRows as Record<string, unknown>[])[0];
    const sdsTrades = sds ? Number(sds["trades"]) : 0;
    // Only fall back to cached stats on a true cold start (zero live trades).
    if (rows.length === 0 && sdsTrades > 0) {
      const wins     = sds ? Number(sds["wins"])      : 0;
      const winPnl   = sds ? Number(sds["win_pnl"])   : 0;
      const lossPnl  = sds ? Number(sds["loss_pnl"])  : 0;
      const totalPnl = sds ? Number(sds["total_pnl"]) : 0;
      const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
      return { trades: sdsTrades, wins, winPnl, lossPnl, totalPnl, pf };
    }
    const pnls = (rows as Record<string, unknown>[]).map(r => Number(r["pnl"]) || 0);
    const trades   = pnls.length;
    const wins     = pnls.filter(p => p > 0).length;
    const winPnl   = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const lossPnl  = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const pf = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
    return { trades, wins, winPnl, lossPnl, totalPnl, pf };
  }

  let _adaptationRunning = false;

  export async function runAdaptationCycle(_chatIds:Set<number>): Promise<string> {
  if (_adaptationRunning) {
    logger.warn("runAdaptationCycle: already running, skipping concurrent call");
    return "";
  }
  _adaptationRunning = true;
  try {
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

  // ── Entity adaptation: 8 independent strategy×direction units ────────────────
  const {rows:ewRows} = await pool.query(
    "SELECT entity, weight, quarantine, cycles_below_threshold FROM strategy_entity_weights"
  );
  const entityCurW: Record<string, {weight:number;cycles:number;quarantine:boolean}> = {};
  for (const r of ewRows as Record<string,unknown>[])
    entityCurW[r["entity"] as string] = {
      weight: Number(r["weight"]),
      cycles: Number(r["cycles_below_threshold"]),
      quarantine: Boolean(r["quarantine"]),
    };

  const ENTITIES: StrategyEntity[] = [
    "TREND_LONG", "TREND_SHORT",
    "VOLUME_IMPULSE_LONG", "VOLUME_IMPULSE_SHORT",
    "MEAN_REVERSION_LONG", "MEAN_REVERSION_SHORT",
    "BREAKOUT_LONG", "BREAKOUT_SHORT",
  ];

  for (const entity of ENTITIES) {
    const recent = await getRecentEntityStats(entity);
    const { trades, wins, winPnl, lossPnl, totalPnl, pf } = recent;
    const isNegativeReturn = totalPnl < 0;

    if (trades < 10) continue;

    const entityParts = entity.split("_");
    const entityDir = entityParts.pop() as string;
    const entityStrat = entityParts.join("_") as StrategyName;

    const cur = entityCurW[entity] ?? { weight: 1.0, cycles: 0, quarantine: false };
    const trustScore = await calcTrustScore(entityStrat, trades, wins, winPnl, lossPnl, totalPnl, "sideways");

    let newWeight = cur.weight;
    let newQuarantine = cur.quarantine;

    if (trades >= 50 && pf < 0.5 && isNegativeReturn && !cur.quarantine) {
      newQuarantine = true;
      newWeight = 0.10;
      changes.push(`⚠️ ${entity}: → карантин (PF ${pf.toFixed(2)}, n=${trades})`);
    } else if (cur.quarantine && pf >= 1.0 && !isNegativeReturn) {
      newQuarantine = false;
      newWeight = Math.min(0.50, cur.weight + 0.10);
      changes.push(`✅ ${entity}: выход из карантина (PF ${pf.toFixed(2)})`);
    } else {
      const targetW = pfToTargetWeight(pf);
      const confidenceScale = trades >= 100 ? 1.0 : trades >= 50 ? 0.7 : trades >= 20 ? 0.3 : 0.1;
      const blendedW = cur.weight + (targetW - cur.weight) * confidenceScale * 0.15;
      newWeight = Math.max(0.10, Math.min(1.50, blendedW));
      if (Math.abs(newWeight - cur.weight) > 0.005) {
        const dirIcon = newWeight > cur.weight ? "📈" : "📉";
        changes.push(`${dirIcon} ${entity}: вес ${(cur.weight*100).toFixed(0)}%→${(newWeight*100).toFixed(0)}% (PF ${pf.toFixed(2)}, n=${trades})`);
      }
    }

    // Мягкий карантин при PF 0.50-0.75 и 10+ сделках
    if (!newQuarantine && trades >= 10 && pf < 0.75 && isNegativeReturn) {
      newWeight = Math.min(newWeight, 0.25);
      if (Math.abs(newWeight - cur.weight) > 0.005) {
        changes.push(`📉 ${entity}: мягкий лимит (PF ${pf.toFixed(2)}, n=${trades}) → вес ${(newWeight*100).toFixed(0)}%`);
      }
    }

    // Дополнительное условие — при PF < 0.4 жёсткий мягкий лимит без проверки totalPnl
    if (!newQuarantine && trades >= 10 && pf < 0.40) {
      newWeight = Math.min(newWeight, 0.15);
      changes.push(`📉 ${entity}: жёсткий мягкий лимит (PF ${pf.toFixed(2)}, n=${trades}) → вес ${(newWeight*100).toFixed(0)}%`);
    }

    const MIN_ENTITY_WEIGHT = 0.10;
    newWeight = Math.max(newWeight, newQuarantine ? MIN_ENTITY_WEIGHT : 0.20);

    await pool.query(
      `UPDATE strategy_entity_weights
       SET weight=$2, quarantine=$3, trust_score=$4, updated_at=$5
       WHERE entity=$1`,
      [entity, newWeight, newQuarantine, trustScore, new Date().toISOString()]
    );
    void entityDir; // used above for calcTrustScore
  }

  // ── Keep strategy_weights in sync for backward compat (readiness-index, reports) ──
  const STRATS = ["TREND","BREAKOUT","VOLUME_IMPULSE","MEAN_REVERSION"] as StrategyName[];
  for (const strat of STRATS) {
    const recentS = await getRecentStrategyStats(strat);
    const { trades: sT, wins: sW, winPnl: sWP, lossPnl: sLP, totalPnl: sTP, pf: sPF } = recentS;
    if (sT < 20) continue;
    const confidenceScale = sT >= 100 ? 1.0 : sT >= 50 ? 0.7 : sT >= 20 ? 0.3 : 0;
    const {rows:swRow} = await pool.query(
      "SELECT weight,quarantine,cycles_below_threshold FROM strategy_weights WHERE strategy=$1", [strat]
    );
    const sw = swRow[0] as Record<string,unknown>|undefined;
    const curW = sw ? Number(sw["weight"]) : 1.0;
    const curQ = sw ? Boolean(sw["quarantine"]) : false;
    const curC = sw ? Number(sw["cycles_below_threshold"]) : 0;
    const trustScore = await calcTrustScore(strat, sT, sW, sWP, sLP, sTP, "sideways");
    const isNeg = sTP < 0;
    let newW = curW;
    let newQ = curQ;
    if (sT >= 20 && sPF < 0.5 && isNeg && !curQ) {
      newQ = true; newW = Math.max(0.35, curW - 0.10);
    } else if (curQ && sPF >= 1.0 && !isNeg) {
      newQ = false; newW = Math.min(1.0, curW + 0.05);
    } else {
      const targetW = pfToTargetWeight(sPF);
      const blended = curW + (targetW - curW) * confidenceScale * 0.15;
      newW = Math.max(0.35, Math.min(1.50, blended));
    }
    await pool.query(
      `UPDATE strategy_weights SET weight=$2,quarantine=$3,cycles_below_threshold=$4,trust_score=$5,updated_at=$6 WHERE strategy=$1`,
      [strat, newW, newQ, sPF < 0.5 ? curC + 1 : Math.max(0, curC - 1), trustScore, new Date().toISOString()]
    );
  }

  return changes.length > 0 ? changes.join("\n") : "Изменений нет — все стратегии в норме";
  } finally {
    _adaptationRunning = false;
  }
}

/**
 * Decay цикл — еженедельный «забыватель» старых данных.
 *
 * Умножает все накопленные PnL-суммы в аналитических таблицах на DECAY_FACTOR.
 * Таблицы хранят числа как DOUBLE PRECISION (не целые), поэтому дробное умножение корректно.
 *
 * Эффект: новые сделки, добавленные после decay, имеют пропорционально бо́льший вес.
 * Пример: через ~3 месяца (13 недель) старые данные весят 0.95^13 ≈ 0.51 от исходного.
 *
 * PF (win_pnl / loss_pnl) внутри старых данных не меняется — оба множатся одинаково.
 * Но когда новые сделки добавляются un-decayed, они сдвигают PF в свою сторону.
 */
export async function runDecayCycle(): Promise<string> {
  const DECAY = 0.95;
  const cols  = "trades = trades * $1, wins = wins * $1, win_pnl = win_pnl * $1, loss_pnl = loss_pnl * $1, total_pnl = total_pnl * $1";
  const results: string[] = [];

  const tables = [
    "strategy_regime_stats",
    "strategy_direction_stats",
    "instrument_analytics",
    "instrument_regime_stats",
  ] as const;

  for (const table of tables) {
    try {
      const { rowCount } = await pool.query(`UPDATE ${table} SET ${cols}`, [DECAY]);
      results.push(`${table}: ${rowCount ?? 0} rows`);
    } catch (err) {
      results.push(`${table}: ошибка — ${String(err)}`);
    }
  }

  // Плавное снижение trust_score для entity, по которым не было сделок 30+ дней
  try {
    await pool.query(
      `UPDATE strategy_entity_weights
       SET trust_score = GREATEST(0, trust_score - 5)
       WHERE updated_at < NOW() - INTERVAL '30 days'`,
    );
  } catch { /* ignore */ }

  return `Decay ×${DECAY} применён:\n` + results.join("\n");
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
    "SELECT COALESCE(pnl_equity_pct, pnl_percent) AS pnl FROM paper_closed_trades ORDER BY closed_at DESC LIMIT 100"
  );
  const pnls=statsRows.map(r=>Number((r as Record<string,unknown>)["pnl"]));
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

  const {rows:entitySnap} = await pool.query(
    "SELECT entity, weight, quarantine, trust_score FROM strategy_entity_weights"
  );
  const notesPayload = JSON.stringify({ reason: changes, entityWeights: entitySnap });

  await pool.query("UPDATE strategy_versions SET is_best=false WHERE is_best=true");
  await pool.query(
    `INSERT INTO strategy_versions(created_at,weights,win_rate,profit_factor,trade_count,is_best,version_label,total_return,max_drawdown,sharpe_ratio,recovery_factor,notes)
     VALUES($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11)`,
    [new Date().toISOString(),JSON.stringify(weights),wr,pf,pnls.length,label,eq-100,dd,sharpe,rf,notesPayload]
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

      let entityRestoreNote = "";
      try {
        const prevNotes = JSON.parse((prev["notes"] as string) ?? "{}") as { entityWeights?: Array<Record<string, unknown>> };
        const prevEntityWeights = prevNotes.entityWeights;
        if (prevEntityWeights && prevEntityWeights.length > 0) {
          for (const ew of prevEntityWeights) {
            await pool.query(
              "UPDATE strategy_entity_weights SET weight=$2, quarantine=$3 WHERE entity=$1",
              [ew["entity"], ew["weight"], ew["quarantine"]]
            );
          }
          entityRestoreNote = `\nВосстановлены веса ${prevEntityWeights.length} сущностей.`;
        }
      } catch (err) {
        logger.warn({ err }, "Failed to restore entity_weights from snapshot notes");
      }

      logger.warn({curPF,prevPF},"Strategy rolled back to previous version");
    return `🔄 *Откат стратегии*\nТекущий PF ${curPF.toFixed(2)} хуже предыдущего ${prevPF.toFixed(2)} на >20%.\nВосстановлена версия ${cur["version_label"]??prev["version_label"]}.${entityRestoreNote}`;
  }
  return null;
}

export async function generateLearningReport(): Promise<string> {
  const tradeCount=await getClosedTradeCount();
  const {rows:vRows} = await pool.query("SELECT * FROM strategy_versions ORDER BY created_at DESC LIMIT 2");

  // ТЗ Шаг 8: единый список из 8 сущностей (strategy×direction) вместо
  // отдельной секции "4 стратегии" + отдельной секции "LONG vs SHORT".
  const {rows:entityRows} = await pool.query(
    "SELECT entity, strategy, direction, trades, wins, win_pnl, loss_pnl, weight, quarantine FROM strategy_entity_weights ORDER BY strategy, direction"
  );
  const entityLines:string[]=[];
  for (const r of entityRows as Record<string,unknown>[]) {
    const entity=r["entity"] as string;
    const trades=Number(r["trades"]);
    if (trades<5) { entityLines.push(`▪️ ${entity.padEnd(22)}bootstrap (${trades}/5 сделок)`); continue; }
    const wins=Number(r["wins"]);
    const winPnl=Number(r["win_pnl"]);
    const lossPnl=Number(r["loss_pnl"]);
    const weight=Number(r["weight"]);
    const quarantine=Boolean(r["quarantine"]);
    const wr=(wins/trades*100).toFixed(0);
    const pf=lossPnl>0?(winPnl/lossPnl).toFixed(2):"∞";
    const wPct=(weight*100).toFixed(0);
    const sampleTag = trades < 30 ? " ⚠️<30сд" : "";
    const icon = quarantine ? "⚠️" : weight>=1.3 ? "🔥" : weight<=0.5 ? "📉" : "✅";
    entityLines.push(`${icon} ${entity.padEnd(22)}WR ${wr}% | PF ${pf} | Вес ${wPct}%${sampleTag}`);
  }

  let vLine="";
  if (vRows.length>=2) {
    const c=vRows[0] as Record<string,unknown>, p=vRows[1] as Record<string,unknown>;
    const diff=Number(c["profit_factor"])-Number(p["profit_factor"]);
    vLine=`\n📊 ${p["version_label"]}→${c["version_label"]}: PF ${Number(p["profit_factor"]).toFixed(2)}→${Number(c["profit_factor"]).toFixed(2)} (${diff>=0?"+":""}${diff.toFixed(2)})`;
  }

  const reportLabel=`v${Math.floor(tradeCount/100)}.${tradeCount%100<50?0:5}`;
  const summary=[`🧠 *AI Learning Report — ${reportLabel}*`,`📊 Сделок: ${tradeCount}`,"",`📐 *Сущности (strategy×direction):*`,...entityLines,vLine].filter(Boolean).join("\n");

  await pool.query(
    "INSERT INTO learning_reports(version_label,created_at,trade_count_at_report,summary,report_json) VALUES($1,$2,$3,$4,$5)",
    [reportLabel,new Date().toISOString(),tradeCount,summary,JSON.stringify({entities:entityRows,tradeCount})]
  );
  return summary;
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

  const MEDALS = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  // Derive strategy list dynamically from DB — handles any number of strategies
  const stratRows = [...new Set((statRows as Record<string,unknown>[]).map(r => r["strategy"] as string))]
    .filter(Boolean).sort() as StrategyName[];

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
  const getStratName = (s: string) => STRAT_NAMES[s] ?? s.replace(/_/g, " ");

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
    lines.push(`${medal} *${getStratName(e.strat)}*`);
    lines.push(`PF ${pfStr} | WR ${wrStr} | Trust ${e.trust}/100 | ${sampleTag}`);
    lines.push(`Вес: ${(e.weight*100).toFixed(0)}% — ${pfToTargetWeight(e.pf) === e.weight ? "точно по таблице" : e.weight >= 1.0 ? "приоритет" : e.weight <= 0.2 ? "исследование" : "адаптация"}`);
    lines.push(``);
  }

  lines.push(`_Следующий пересчёт — воскресенье 20:00_`);
  return lines.join("\n");
}
