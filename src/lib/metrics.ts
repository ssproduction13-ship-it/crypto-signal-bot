/**
 * metrics.ts — Shared financial metric helpers.
 *
 * Centralises computations that were previously copy-pasted across report
 * modules so they can be fixed and tested in one place.
 */

/**
 * Computes Max Drawdown from a series of per-trade P&L percentages.
 *
 * Uses a *compounded* equity curve starting at 100 so the denominator is
 * always a real equity level — never a near-zero sum of small percentage
 * values that causes divisions by ≈0 and results like 2323 %.
 *
 * @param pnlPcts  Array of per-trade return %s, e.g. [+2.0, −3.5, +1.1]
 * @returns Max drawdown in percent (0–100).  e.g. 12.34 means 12.34 %
 */
export function computeMaxDrawdown(pnlPcts: number[]): number {
  if (pnlPcts.length === 0) return 0;
  let equity = 100;
  let peak   = 100;
  let maxDD  = 0;
  for (const p of pnlPcts) {
    equity *= (1 + p / 100);           // compound, NOT additive sum
    if (equity > peak) peak = equity;
    const cur = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (cur > maxDD) maxDD = cur;
  }
  return maxDD;
}

/**
 * Per-trade data needed for the MAE-aware drawdown variant.
 * stopLoss and entryPrice are optional — when absent the function falls back
 * to closed-P&L-only behaviour identical to computeMaxDrawdown.
 */
export interface TradeForDD {
  pnlPercent: number;
  maeR?: number | null;
  stopLoss?: number | null;
  entryPrice?: number | null;
}

/**
 * Computes Max Drawdown taking intra-trade unrealised P&L into account.
 *
 * BUG-07 fix: computeMaxDrawdown only sees P&L at close, so a trade that
 * dipped deep intra-bar and then recovered to a small win was invisible to
 * the drawdown metric. This variant also considers the worst price the
 * position reached (via maeR × stop distance) BEFORE booking the close.
 *
 * Worst-case unrealised P&L for a trade:
 *   stopDistPct = |entryPrice − stopLoss| / entryPrice × 100
 *   worstPct    = −(maeR × stopDistPct)   (always ≤ 0)
 *
 * @param trades  Chronological array of closed trades
 * @returns Max drawdown in percent (0–100)
 */
export function computeMaxDrawdownWithMAE(trades: TradeForDD[]): number {
  if (!trades.length) return 0;
  let equity = 100;
  let peak   = 100;
  let maxDD  = 0;

  for (const t of trades) {
    // ── Intra-trade worst-case dip ────────────────────────────────────────
    if (
      t.maeR != null && t.maeR > 0 &&
      t.stopLoss != null && t.stopLoss > 0 &&
      t.entryPrice != null && t.entryPrice > 0
    ) {
      const stopDistPct   = Math.abs(t.entryPrice - t.stopLoss) / t.entryPrice * 100;
      const worstPct      = -(t.maeR * stopDistPct);        // always ≤ 0
      const equityAtWorst = equity * (1 + worstPct / 100);
      const ddAtWorst     = peak > 0 ? (peak - equityAtWorst) / peak * 100 : 0;
      if (ddAtWorst > maxDD) maxDD = ddAtWorst;
    }

    // ── Book closed P&L ───────────────────────────────────────────────────
    equity *= (1 + t.pnlPercent / 100);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}
