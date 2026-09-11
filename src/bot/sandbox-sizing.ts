export interface ContractSizeInput {
  accountBalance: number;
  riskPercent: number;
  entryPrice: number;
  stopLoss: number;
  multiplier: number;
  lotSize: number;
  maxOrderQty?: number;
}

export function calculateSandboxContractSize(
  input: ContractSizeInput,
): number {
  const {
    accountBalance,
    riskPercent,
    entryPrice,
    stopLoss,
    multiplier,
    lotSize,
    maxOrderQty,
  } = input;
  const stopDistance = Math.abs(entryPrice - stopLoss);

  if (
    !Number.isFinite(accountBalance) ||
    !Number.isFinite(riskPercent) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopLoss) ||
    !Number.isFinite(multiplier) ||
    !Number.isFinite(lotSize) ||
    accountBalance <= 0 ||
    riskPercent <= 0 ||
    entryPrice <= 0 ||
    stopDistance <= 0 ||
    multiplier <= 0 ||
    lotSize <= 0
  ) {
    return 0;
  }

  const riskCapital = accountBalance * (riskPercent / 100);
  const rawContracts = riskCapital / (stopDistance * multiplier);
  const lotRounded = Math.floor(rawContracts / lotSize) * lotSize;
  if (lotRounded <= 0) return 0;
  return maxOrderQty && maxOrderQty > 0
    ? Math.min(lotRounded, maxOrderQty)
    : lotRounded;
}