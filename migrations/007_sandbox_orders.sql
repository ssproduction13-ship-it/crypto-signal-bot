-- Sandbox execution bookkeeping.
-- This table is deliberately separate from paper-trading tables so the
-- control-period simulation cannot be contaminated by exchange execution.

CREATE TABLE IF NOT EXISTS sandbox_orders (
  id BIGSERIAL PRIMARY KEY,
  internal_signal_id TEXT NOT NULL UNIQUE,
  client_oid TEXT NOT NULL UNIQUE,
  order_id TEXT,
  chat_id BIGINT NOT NULL,
  symbol TEXT NOT NULL,
  futures_symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
  size NUMERIC(20,8) NOT NULL,
  entry_price NUMERIC(20,8),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'filled', 'cancelled', 'rejected', 'unknown')),
  reject_reason TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}',
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  filled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sandbox_orders_pending
  ON sandbox_orders(status, created_at);

CREATE INDEX IF NOT EXISTS idx_sandbox_orders_order_id
  ON sandbox_orders(order_id);