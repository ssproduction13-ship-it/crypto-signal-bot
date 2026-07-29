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
