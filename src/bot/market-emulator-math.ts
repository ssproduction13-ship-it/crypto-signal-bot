export interface BookLevel {
  price: number;
  baseSize: number;
}

export interface FillResult {
  fillPrice: number;
  slippagePct: number;
  slippageCost: number;
  requestedSize: number;
  filledSize: number;
}

export function calculateRealisticFill(
  levels: readonly BookLevel[],
  requestedSize: number,
): FillResult {
  if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
    throw new Error("Emulator fill size must be positive");
  }
  const usable = levels.filter((level) => level.price > 0 && level.baseSize > 0);
  if (!usable.length) throw new Error("KuCoin Futures order book is empty");

  let remaining = requestedSize;
  let totalCost = 0;
  let filledSize = 0;
  for (const level of usable) {
    const take = Math.min(remaining, level.baseSize);
    totalCost += take * level.price;
    filledSize += take;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }

  // The endpoint is depth-20. If an unusually large virtual position
  // exhausts it, use the last visible level and expose the degradation
  // through the resulting slippage rather than silently returning no fill.
  if (remaining > 1e-12) {
    const lastPrice = usable[usable.length - 1]!.price;
    totalCost += remaining * lastPrice;
    filledSize += remaining;
  }

  const fillPrice = totalCost / filledSize;
  const bestPrice = usable[0]!.price;
  return {
    fillPrice,
    slippagePct: Math.abs((fillPrice - bestPrice) / bestPrice) * 100,
    slippageCost: Math.abs(fillPrice - bestPrice) * requestedSize,
    requestedSize,
    filledSize,
  };
}