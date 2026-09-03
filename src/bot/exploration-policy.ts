/**
 * Bounded evidence collection for new strategy × direction × regime entities.
 * Market, direction, volatility, MTF and portfolio safety gates remain unchanged.
 */
export const BOOTSTRAP_ENTITY_TRADES = 20;
export const BOOTSTRAP_FINAL_SCORE_MIN = 5;
export const MATURE_FINAL_SCORE_MIN = 8;
export const BOOTSTRAP_RISK_CAP_MULTIPLIER = 0.5;

export function finalScoreMinimum(entityTrades: number): number {
  return entityTrades < BOOTSTRAP_ENTITY_TRADES
    ? BOOTSTRAP_FINAL_SCORE_MIN
    : MATURE_FINAL_SCORE_MIN;
}

export function capBootstrapRisk(baseRiskPct: number, effectiveRiskPct: number, entityTrades: number): number {
  if (entityTrades >= BOOTSTRAP_ENTITY_TRADES) return effectiveRiskPct;
  return Math.min(effectiveRiskPct, baseRiskPct * BOOTSTRAP_RISK_CAP_MULTIPLIER);
}
