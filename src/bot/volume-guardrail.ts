import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/** Minimum number of closed paper trades across the portfolio in any 24-hour window. */
export const MIN_DAILY_TRADES = 10;

export interface DailyVolumeGuardrailResult {
  ok: boolean;
  tradesLast24h: number;
}

/**
 * Makes sure the portfolio still produces enough observations for the
 * learning engine to validate changes. This is deliberately read-only:
 * callers must not automatically toggle features based on this result.
 */
export async function checkDailyVolumeGuardrail(): Promise<DailyVolumeGuardrailResult> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM paper_closed_trades
      WHERE closed_at >= now() - interval '24 hours'`,
  );
  const tradesLast24h = Number(rows[0]?.n ?? 0);
  const ok = tradesLast24h >= MIN_DAILY_TRADES;

  if (!ok) {
    logger.warn(
      { tradesLast24h, minimum: MIN_DAILY_TRADES },
      "Volume guardrail: суточный объём сделок ниже минимума",
    );
  }

  return { ok, tradesLast24h };
}