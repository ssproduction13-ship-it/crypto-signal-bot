import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { welchTTest } from "./stat-significance.js";

export interface ShadowComparison {
  featureName: string;
  agreeField: string;
  agreeCount: number;
  disagreeCount: number;
  agreeMeanPnl: number;
  disagreeMeanPnl: number;
  pValue: number;
  isSignificant: boolean;
  effect: "positive" | "negative" | "none";
}

/**
 * Store an observation without changing trading behaviour. The returned id
 * lets the caller attach the observation to the eventual closed trade.
 */
export async function recordShadowFeature(
  featureName: string,
  symbol: string,
  payload: Record<string, unknown>,
): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO shadow_features(feature_name, symbol, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [featureName, symbol, JSON.stringify(payload)],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    // Do not silently lose shadow data: missing observations make an
    // experiment look neutral when it may simply be unwired.
    logger.error({ err, featureName, symbol }, "recordShadowFeature failed");
    return null;
  }
}

/** Attach one or more observations to the closed trade that produced them. */
export async function linkShadowFeatures(
  featureIds: readonly number[],
  tradeId: string,
): Promise<void> {
  if (!featureIds.length) return;
  try {
    await pool.query(
      `UPDATE shadow_features
          SET trade_id = $1
        WHERE id = ANY($2::int[])`,
      [tradeId, [...featureIds]],
    );
  } catch (err) {
    logger.error({ err, featureIds, tradeId }, "linkShadowFeatures failed");
  }
}

/**
 * Compare PnL of observations where a feature agreed with the signal against
 * observations where it disagreed. Only linked, closed trades are included.
 * Significance is intentionally conservative: both groups need five samples,
 * p < 0.05, and the effect must be non-zero.
 */
export async function compareShadowOutcomes(
  featureName: string,
  agreeField: string,
): Promise<ShadowComparison> {
  const { rows } = await pool.query<{ agrees: boolean | null; pnl: string }>(
    `SELECT (sf.payload ->> $2)::boolean AS agrees, pct.pnl_percent::text AS pnl
       FROM shadow_features sf
       JOIN paper_closed_trades pct ON pct.id = sf.trade_id
      WHERE sf.feature_name = $1
        AND sf.trade_id IS NOT NULL
        AND (sf.payload ->> $2) IN ('true', 'false')
        AND pct.pnl_percent IS NOT NULL`,
    [featureName, agreeField],
  );

  const agree = rows.filter((row) => row.agrees === true).map((row) => Number(row.pnl));
  const disagree = rows.filter((row) => row.agrees === false).map((row) => Number(row.pnl));
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const agreeMeanPnl = mean(agree);
  const disagreeMeanPnl = mean(disagree);
  const { pValue } = welchTTest(agree, disagree);
  const delta = agreeMeanPnl - disagreeMeanPnl;
  const isSignificant = agree.length >= 5 && disagree.length >= 5 && pValue < 0.05 && delta !== 0;

  return {
    featureName,
    agreeField,
    agreeCount: agree.length,
    disagreeCount: disagree.length,
    agreeMeanPnl,
    disagreeMeanPnl,
    pValue,
    isSignificant,
    effect: delta > 0 ? "positive" : delta < 0 ? "negative" : "none",
  };
}