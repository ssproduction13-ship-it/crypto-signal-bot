export const DEFAULT_MAX_POSITION_SIZE_USD = 500;

export function getMaxPositionSizeUsd(): number {
  const configured = Number(process.env["MAX_POSITION_SIZE_USD"] ?? DEFAULT_MAX_POSITION_SIZE_USD);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_POSITION_SIZE_USD;
}

export interface PositionSizeCap {
  size: number;
  notional: number;
  capped: boolean;
}

export function capPositionSizeByNotional(
  entryPrice: number,
  size: number,
  maxNotional = getMaxPositionSizeUsd(),
): PositionSizeCap {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(size) || size <= 0) {
    return { size, notional: 0, capped: false };
  }

  const safeMax = Number.isFinite(maxNotional) && maxNotional > 0
    ? maxNotional
    : DEFAULT_MAX_POSITION_SIZE_USD;
  const notional = entryPrice * size;
  if (notional <= safeMax) return { size, notional, capped: false };

  const cappedSize = safeMax / entryPrice;
  return { size: cappedSize, notional: safeMax, capped: true };
}

export function capRiskPercentByNotional(params: {
  balance: number;
  entryPrice: number;
  stopLoss: number;
  riskPercent: number;
  maxNotional?: number;
}): { riskPercent: number; calculatedNotional: number; capped: boolean } {
  const { balance, entryPrice, stopLoss, riskPercent } = params;
  const stopDistance = Math.abs(entryPrice - stopLoss);
  const calculatedNotional = stopDistance > 0 && balance > 0 && entryPrice > 0
    ? (balance * (riskPercent / 100) / stopDistance) * entryPrice
    : 0;
  const maxNotional = params.maxNotional ?? getMaxPositionSizeUsd();

  if (
    !Number.isFinite(calculatedNotional) ||
    calculatedNotional <= 0 ||
    calculatedNotional <= maxNotional ||
    !Number.isFinite(riskPercent) ||
    riskPercent <= 0
  ) {
    return { riskPercent, calculatedNotional, capped: false };
  }

  return {
    riskPercent: riskPercent * (maxNotional / calculatedNotional),
    calculatedNotional,
    capped: true,
  };
}