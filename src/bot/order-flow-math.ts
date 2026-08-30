export interface OrderFlowSignal {
  imbalance: number;
  direction: "bid" | "ask" | "neutral";
}

export function calculateOrderBookImbalance(
  bids: readonly [number, number][],
  asks: readonly [number, number][],
): OrderFlowSignal {
  const bidVolume = bids.reduce((sum, [, size]) => sum + Math.max(0, size), 0);
  const askVolume = asks.reduce((sum, [, size]) => sum + Math.max(0, size), 0);
  const total = bidVolume + askVolume;
  const imbalance = total > 0 ? (bidVolume - askVolume) / total : 0;
  return {
    imbalance,
    direction: imbalance > 0.2 ? "bid" : imbalance < -0.2 ? "ask" : "neutral",
  };
}