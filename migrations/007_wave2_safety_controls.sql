-- Wave 2 safety controls: persistent execution mode and loss-limit baselines.
CREATE TABLE IF NOT EXISTS trading_mode_override (
  id SERIAL PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'emulator')),
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE risk_state
  ADD COLUMN IF NOT EXISTS daily_start_balance NUMERIC(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_start_balance NUMERIC(20,8) NOT NULL DEFAULT 0;