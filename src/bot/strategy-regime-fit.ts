import type { MarketRegime } from "./learning-engine.js";
import type { StrategyName } from "./strategies.js";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Conservative defaults for strategy × regime routing. The database-backed
 * strategy_regime_limits table remains the source of truth for performance
 * thresholds; this map only prevents known poor matches from being enabled by
 * an empty or partially migrated database.
 */
export const DEFAULT_REGIME_FIT: Record<StrategyName, Partial<Record<MarketRegime, boolean>>> = {
  TREND: { trend_up: true, trend_down: true, sideways: false, high_vol: true, low_vol: false, unknown: true },
  BREAKOUT: { trend_up: true, trend_down: true, sideways: true, high_vol: true, low_vol: false, unknown: true },
  VOLUME_IMPULSE: { trend_up: true, trend_down: true, sideways: true, high_vol: true, low_vol: true, unknown: true },
  MEAN_REVERSION: { trend_up: true, trend_down: true, sideways: true, high_vol: false, low_vol: true, unknown: true },
  UNKNOWN: { unknown: true },
};

/** Minimum signal Score for strategy × regime combinations that need extra evidence. */
export const STRATEGY_REGIME_SCORE_PENALTY: Record<
  StrategyName,
  Partial<Record<MarketRegime, number>>
> = {
  TREND: { sideways: 72 },
  BREAKOUT: { low_vol: 70 },
  VOLUME_IMPULSE: { low_vol: 70 },
  MEAN_REVERSION: { trend_up: 68, trend_down: 68 },
  UNKNOWN: {},
};

export const MIN_STRATEGY_REGIME_PENALTY_TRADES = 20;

export function getStrategyRegimeScorePenalty(
  strategy: StrategyName,
  regime: MarketRegime,
  entityTrades = MIN_STRATEGY_REGIME_PENALTY_TRADES,
): number | null {
  // During bootstrap, the base Score and safety filters remain active, but
  // this extra strategy/regime restriction does not reduce evidence flow.
  if (entityTrades < MIN_STRATEGY_REGIME_PENALTY_TRADES) return null;
  return STRATEGY_REGIME_SCORE_PENALTY[strategy]?.[regime] ?? null;
}

export function isDefaultRegimeFit(strategy: StrategyName, regime: MarketRegime): boolean {
  return DEFAULT_REGIME_FIT[strategy]?.[regime] ?? true;
}

export async function isStrategyRegimeFitEnabled(
  strategy: StrategyName,
  regime: MarketRegime,
): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      "SELECT enabled FROM strategy_regime_fit WHERE strategy=$1 AND regime=$2",
      [strategy, regime],
    );
    if (rows.length) return Boolean((rows[0] as Record<string, unknown>)["enabled"]);
  } catch (err) {
    logger.debug({ err, strategy, regime }, "Strategy/regime fit unavailable — using defaults");
  }
  return isDefaultRegimeFit(strategy, regime);
}
