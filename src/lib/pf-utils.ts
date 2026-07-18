/**
 * pf-utils.ts — Единый взвешенный расчёт Profit Factor.
 *
 * Все значения PF — в отчётах, гейтах открытия и движке обучения —
 * используют эту функцию, чтобы число было одинаковым везде.
 *
 * Формула: линейное time-decay взвешивание.
 * Самая свежая сделка получает вес 3.0, самая старая — 1.0.
 * Входной массив должен быть отсортирован DESC по closed_at
 * (index 0 = самая новая сделка).
 */

/** Размер скользящего окна (количество последних сделок) — совпадает с ADAPTATION_WINDOW в learning-engine */
export const WEIGHTED_PF_WINDOW = 150;

/**
 * Взвешенный Profit Factor с time-decay.
 *
 * @param pnls  Значения PnL (COALESCE(pnl_equity_pct, pnl_percent)),
 *              отсортированные DESC по closed_at — index 0 = самая новая сделка.
 * @returns     Взвешенный PF ≥ 0.
 *              0 — нет данных; 2.0 — нет убыточных сделок (условная замена ∞).
 */
export function calcWeightedPF(pnls: number[]): number {
  const n = pnls.length;
  if (n === 0) return 0;
  let weightedWin  = 0;
  let weightedLoss = 0;
  for (let i = 0; i < n; i++) {
    // index 0 (новейшая) → вес 3.0; index n-1 (старейшая) → вес 1.0
    const w = n > 1 ? 3.0 - (2.0 * i) / (n - 1) : 3.0;
    const p = pnls[i] ?? 0;
    if (p > 0) weightedWin  += p * w;
    else        weightedLoss += Math.abs(p) * w;
  }
  return weightedLoss > 0
    ? weightedWin / weightedLoss
    : weightedWin > 0 ? 2.0 : 0;
}
