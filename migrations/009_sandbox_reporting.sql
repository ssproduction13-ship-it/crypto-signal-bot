CREATE TABLE IF NOT EXISTS sandbox_closed_trades (
  id BIGSERIAL PRIMARY KEY,
  position_id TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  size NUMERIC(20,8) NOT NULL,
  entry_price NUMERIC(20,8) NOT NULL,
  exit_price NUMERIC(20,8) NOT NULL,
  multiplier NUMERIC(20,8) NOT NULL,
  realized_pnl NUMERIC(20,8) NOT NULL,
  exit_reason TEXT NOT NULL CHECK (exit_reason IN ('stop_loss', 'tp1', 'tp2')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sandbox_closed_trades_chat_closed
  ON sandbox_closed_trades(chat_id, closed_at DESC);

ALTER TABLE sandbox_positions
  ADD COLUMN IF NOT EXISTS multiplier NUMERIC(20,8) NOT NULL DEFAULT 1;