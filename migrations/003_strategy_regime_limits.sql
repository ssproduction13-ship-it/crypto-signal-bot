-- Strategy × regime guard configuration. Safe to run repeatedly.
-- Defaults preserve the previous hard-coded thresholds:
-- interval buckets need 5 trades, aggregate buckets need 10,
-- and a bucket is blocked below PF 0.70 or WR 38%.
CREATE TABLE IF NOT EXISTS strategy_regime_limits (
  strategy text NOT NULL,
  regime text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  min_interval_trades integer NOT NULL DEFAULT 5,
  min_aggregate_trades integer NOT NULL DEFAULT 10,
  min_profit_factor double precision NOT NULL DEFAULT 0.70,
  min_win_rate double precision NOT NULL DEFAULT 0.38,
  PRIMARY KEY (strategy, regime)
);

INSERT INTO strategy_regime_limits
  (strategy, regime, enabled, min_interval_trades, min_aggregate_trades,
   min_profit_factor, min_win_rate)
SELECT s.strategy, r.regime, true, 5, 10, 0.70, 0.38
FROM (VALUES
  ('TREND'), ('BREAKOUT'), ('VOLUME_IMPULSE'), ('MEAN_REVERSION')
) AS s(strategy)
CROSS JOIN (VALUES
  ('trend_up'), ('trend_down'), ('sideways'),
  ('high_vol'), ('low_vol'), ('unknown')
) AS r(regime)
ON CONFLICT (strategy, regime) DO NOTHING;