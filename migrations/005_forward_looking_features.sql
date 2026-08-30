-- Forward-looking features: economic blackout calendar, order-flow snapshots,
-- and configurable strategy x market-regime fit.

CREATE TABLE IF NOT EXISTS economic_events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GLOBAL',
  impact TEXT NOT NULL DEFAULT 'medium',
  event_at TIMESTAMPTZ NOT NULL,
  blackout_before_minutes INTEGER NOT NULL DEFAULT 15,
  blackout_after_minutes INTEGER NOT NULL DEFAULT 15,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (impact IN ('low', 'medium', 'high')),
  CHECK (blackout_before_minutes BETWEEN 0 AND 1440),
  CHECK (blackout_after_minutes BETWEEN 0 AND 1440)
);

CREATE INDEX IF NOT EXISTS idx_economic_events_at
  ON economic_events(event_at);

CREATE TABLE IF NOT EXISTS order_flow_snapshots (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  bid_volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  ask_volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  imbalance DOUBLE PRECISION NOT NULL DEFAULT 0,
  open_interest DOUBLE PRECISION,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_flow_symbol_time
  ON order_flow_snapshots(symbol, captured_at DESC);

CREATE TABLE IF NOT EXISTS strategy_regime_fit (
  strategy TEXT NOT NULL,
  regime TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (strategy, regime)
);

INSERT INTO strategy_regime_fit(strategy, regime, enabled)
SELECT s.strategy, r.regime,
       CASE
         WHEN s.strategy = 'TREND' AND r.regime IN ('sideways', 'low_vol') THEN false
         ELSE true
       END
  FROM (VALUES
    ('TREND'), ('BREAKOUT'), ('VOLUME_IMPULSE'), ('MEAN_REVERSION')
  ) AS s(strategy)
  CROSS JOIN (VALUES
    ('trend_up'), ('trend_down'), ('sideways'),
    ('high_vol'), ('low_vol'), ('unknown')
  ) AS r(regime)
ON CONFLICT (strategy, regime) DO NOTHING;
