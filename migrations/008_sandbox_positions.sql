-- Local mirror of sandbox account positions.
-- Reconciliation compares this table to the exchange before new scans start.

CREATE TABLE IF NOT EXISTS sandbox_positions (
  id TEXT PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  symbol TEXT NOT NULL,
  futures_symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  size NUMERIC(20,8) NOT NULL,
  entry_price NUMERIC(20,8) NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sandbox_positions_open
  ON sandbox_positions(status, updated_at);