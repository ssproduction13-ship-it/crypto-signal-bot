-- Aggregate strategy × direction quarantine is independent from the
-- strategy × direction × regime entity quarantine.
CREATE TABLE IF NOT EXISTS strategy_direction_weights (
  strategy TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  quarantine BOOLEAN NOT NULL DEFAULT false,
  trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  win_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  loss_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  cycles_below_threshold INTEGER NOT NULL DEFAULT 0,
  quarantine_since TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (strategy, direction)
);

INSERT INTO strategy_direction_weights(strategy, direction)
SELECT s.strategy, d.direction
FROM (VALUES
  ('TREND'), ('BREAKOUT'), ('VOLUME_IMPULSE'), ('MEAN_REVERSION')
) AS s(strategy)
CROSS JOIN (VALUES ('LONG'), ('SHORT')) AS d(direction)
ON CONFLICT (strategy, direction) DO NOTHING;

ALTER TABLE shadow_positions ADD COLUMN IF NOT EXISTS shadow_source TEXT;
ALTER TABLE shadow_closed_trades ADD COLUMN IF NOT EXISTS shadow_source TEXT;
ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS stop_loss DOUBLE PRECISION;
ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS tp2 DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS idx_shadow_source
  ON shadow_closed_trades(shadow_source, closed_at);