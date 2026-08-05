/**
 * Profit protection for paper positions.
 *
 * The original stop distance is kept separate from the live stop because the
 * live stop moves upward as profit is protected. This prevents the R-multiple
 * calculation from collapsing after the first stop adjustment.
 */
export const PROFIT_LOCK_TRIGGER_R = 2;
export const PROFIT_LOCK_R = 0.25;
export const TRAILING_TRIGGER_R = 3;
export const TRAILING_LOCK_R = 1;

export interface ProfitProtectionInput {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentStopLoss: number;
  initialRiskDistance: number;
  favorableR: number;
  stage: number;
}

export interface ProfitProtectionUpdate {
  stage: 1 | 2;
  stopLoss: number;
  lockR: number;
}

export function calculateProfitProtection(input: ProfitProtectionInput): ProfitProtectionUpdate | null {
  if (!Number.isFinite(input.initialRiskDistance) || input.initialRiskDistance <= 0) return null;
  const nextStage: 1 | 2 = input.favorableR >= TRAILING_TRIGGER_R ? 2 : 1;
  if (input.favorableR < PROFIT_LOCK_TRIGGER_R || input.stage >= nextStage) return null;
  const lockR = nextStage === 2 ? TRAILING_LOCK_R : PROFIT_LOCK_R;
  const target = input.direction === "LONG"
    ? input.entryPrice + input.initialRiskDistance * lockR
    : input.entryPrice - input.initialRiskDistance * lockR;
  const stopLoss = input.direction === "LONG"
    ? Math.max(input.currentStopLoss, target)
    : Math.min(input.currentStopLoss, target);
  return { stage: nextStage, stopLoss, lockR };
}
