export interface StrategyRegimeLimits {
  enabled: boolean;
  minIntervalTrades: number;
  minAggregateTrades: number;
  minProfitFactor: number;
  minWinRate: number;
}

// These are the former hard-coded guard values. Keeping them as the local
// fallback makes a partially migrated database safe and preserves the
// established TREND/sideways and TREND/low_vol behaviour.
export const DEFAULT_STRATEGY_REGIME_LIMITS: StrategyRegimeLimits = {
  enabled: true,
  minIntervalTrades: 5,
  minAggregateTrades: 10,
  minProfitFactor: 0.70,
  minWinRate: 0.38,
};

export function getDefaultStrategyRegimeLimits(
  _strategy: string,
  _regime: string,
): StrategyRegimeLimits {
  return { ...DEFAULT_STRATEGY_REGIME_LIMITS };
}