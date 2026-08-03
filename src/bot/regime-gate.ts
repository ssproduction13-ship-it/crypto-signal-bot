export interface RegimeStatsDecision {
  blocked: boolean;
  profitFactor: number;
  winRate: number;
}

/** Evaluate one regime-statistics bucket without database or runtime dependencies. */
export function evaluateRegimeStats(
  trades: number,
  wins: number,
  winPnl: number,
  lossPnl: number,
  minTrades: number,
): RegimeStatsDecision | null {
  if (trades < minTrades || trades <= 0) return null;
  const profitFactor = lossPnl > 0 ? winPnl / lossPnl : winPnl > 0 ? 2.0 : 0;
  const winRate = wins / trades;
  return { blocked: profitFactor < 0.7 || winRate < 0.38, profitFactor, winRate };
}