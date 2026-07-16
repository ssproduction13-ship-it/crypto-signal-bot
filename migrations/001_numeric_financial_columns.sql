-- Migration 001: Replace DOUBLE PRECISION / REAL with NUMERIC(20,8) on all financial columns.
--
-- Why: DOUBLE PRECISION (IEEE 754 float) accumulates rounding errors on every arithmetic
-- operation. After hundreds of trades the balance and PnL figures drift from reality.
-- NUMERIC is exact-precision decimal — no floating-point error at any scale.
--
-- Safety: all casts are widening (float → numeric preserves all significant digits).
-- Run once on the production database; safe to run multiple times (USING clause is idempotent
-- if the column is already NUMERIC).
--
-- Usage:  psql $DATABASE_URL -f migrations/001_numeric_financial_columns.sql

BEGIN;

-- paper_accounts ─────────────────────────────────────────────────────────────
ALTER TABLE paper_accounts
  ALTER COLUMN balance          TYPE NUMERIC(20,8) USING balance::NUMERIC(20,8),
  ALTER COLUMN initial_balance  TYPE NUMERIC(20,8) USING initial_balance::NUMERIC(20,8),
  ALTER COLUMN peak_balance     TYPE NUMERIC(20,8) USING peak_balance::NUMERIC(20,8);

-- paper_positions ────────────────────────────────────────────────────────────
ALTER TABLE paper_positions
  ALTER COLUMN entry_price TYPE NUMERIC(20,8) USING entry_price::NUMERIC(20,8),
  ALTER COLUMN size        TYPE NUMERIC(20,8) USING size::NUMERIC(20,8),
  ALTER COLUMN stop_loss   TYPE NUMERIC(20,8) USING stop_loss::NUMERIC(20,8),
  ALTER COLUMN tp1         TYPE NUMERIC(20,8) USING tp1::NUMERIC(20,8),
  ALTER COLUMN tp2         TYPE NUMERIC(20,8) USING tp2::NUMERIC(20,8);

-- paper_closed_trades ────────────────────────────────────────────────────────
ALTER TABLE paper_closed_trades
  ALTER COLUMN entry_price TYPE NUMERIC(20,8) USING entry_price::NUMERIC(20,8),
  ALTER COLUMN close_price TYPE NUMERIC(20,8) USING close_price::NUMERIC(20,8),
  ALTER COLUMN size        TYPE NUMERIC(20,8) USING size::NUMERIC(20,8),
  ALTER COLUMN pnl         TYPE NUMERIC(20,8) USING pnl::NUMERIC(20,8),
  ALTER COLUMN pnl_percent TYPE NUMERIC(20,8) USING pnl_percent::NUMERIC(20,8);

-- Conditional: pnl_equity_pct may or may not exist (added by a later migration)
DO $$ BEGIN
  ALTER TABLE paper_closed_trades ALTER COLUMN pnl_equity_pct TYPE NUMERIC(20,8) USING pnl_equity_pct::NUMERIC(20,8);
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- factor_weights ─────────────────────────────────────────────────────────────
ALTER TABLE factor_weights
  ALTER COLUMN trend    TYPE NUMERIC(10,8) USING trend::NUMERIC(10,8),
  ALTER COLUMN volume   TYPE NUMERIC(10,8) USING volume::NUMERIC(10,8),
  ALTER COLUMN momentum TYPE NUMERIC(10,8) USING momentum::NUMERIC(10,8),
  ALTER COLUMN levels   TYPE NUMERIC(10,8) USING levels::NUMERIC(10,8),
  ALTER COLUMN pattern  TYPE NUMERIC(10,8) USING pattern::NUMERIC(10,8);

-- strategy_weights ───────────────────────────────────────────────────────────
ALTER TABLE strategy_weights
  ALTER COLUMN weight TYPE NUMERIC(10,8) USING weight::NUMERIC(10,8);

-- strategy_stats ─────────────────────────────────────────────────────────────
ALTER TABLE strategy_stats
  ALTER COLUMN total_pnl TYPE NUMERIC(20,8) USING total_pnl::NUMERIC(20,8),
  ALTER COLUMN win_pnl   TYPE NUMERIC(20,8) USING win_pnl::NUMERIC(20,8),
  ALTER COLUMN loss_pnl  TYPE NUMERIC(20,8) USING loss_pnl::NUMERIC(20,8);

-- strategy_regime_stats ──────────────────────────────────────────────────────
ALTER TABLE strategy_regime_stats
  ALTER COLUMN win_pnl   TYPE NUMERIC(20,8) USING win_pnl::NUMERIC(20,8),
  ALTER COLUMN loss_pnl  TYPE NUMERIC(20,8) USING loss_pnl::NUMERIC(20,8),
  ALTER COLUMN total_pnl TYPE NUMERIC(20,8) USING total_pnl::NUMERIC(20,8);

-- strategy_direction_stats (was REAL — worse than DOUBLE PRECISION) ──────────
ALTER TABLE strategy_direction_stats
  ALTER COLUMN win_pnl   TYPE NUMERIC(20,8) USING win_pnl::NUMERIC(20,8),
  ALTER COLUMN loss_pnl  TYPE NUMERIC(20,8) USING loss_pnl::NUMERIC(20,8),
  ALTER COLUMN total_pnl TYPE NUMERIC(20,8) USING total_pnl::NUMERIC(20,8);

-- time_analytics ─────────────────────────────────────────────────────────────
ALTER TABLE time_analytics
  ALTER COLUMN win_pnl   TYPE NUMERIC(20,8) USING win_pnl::NUMERIC(20,8),
  ALTER COLUMN loss_pnl  TYPE NUMERIC(20,8) USING loss_pnl::NUMERIC(20,8),
  ALTER COLUMN total_pnl TYPE NUMERIC(20,8) USING total_pnl::NUMERIC(20,8);

-- instrument_analytics ───────────────────────────────────────────────────────
ALTER TABLE instrument_analytics
  ALTER COLUMN win_pnl         TYPE NUMERIC(20,8) USING win_pnl::NUMERIC(20,8),
  ALTER COLUMN loss_pnl        TYPE NUMERIC(20,8) USING loss_pnl::NUMERIC(20,8),
  ALTER COLUMN total_pnl       TYPE NUMERIC(20,8) USING total_pnl::NUMERIC(20,8),
  ALTER COLUMN priority_weight TYPE NUMERIC(10,8) USING priority_weight::NUMERIC(10,8);

-- strategy_entity_weights ────────────────────────────────────────────────────
ALTER TABLE strategy_entity_weights
  ALTER COLUMN weight   TYPE NUMERIC(10,8) USING weight::NUMERIC(10,8),
  ALTER COLUMN win_pnl  TYPE NUMERIC(20,8) USING win_pnl::NUMERIC(20,8),
  ALTER COLUMN loss_pnl TYPE NUMERIC(20,8) USING loss_pnl::NUMERIC(20,8);

-- shadow tables ──────────────────────────────────────────────────────────────
ALTER TABLE shadow_positions
  ALTER COLUMN entry_price TYPE NUMERIC(20,8) USING entry_price::NUMERIC(20,8),
  ALTER COLUMN size        TYPE NUMERIC(20,8) USING size::NUMERIC(20,8),
  ALTER COLUMN stop_loss   TYPE NUMERIC(20,8) USING stop_loss::NUMERIC(20,8),
  ALTER COLUMN tp1         TYPE NUMERIC(20,8) USING tp1::NUMERIC(20,8),
  ALTER COLUMN tp2         TYPE NUMERIC(20,8) USING tp2::NUMERIC(20,8);

ALTER TABLE shadow_closed_trades
  ALTER COLUMN entry_price   TYPE NUMERIC(20,8) USING entry_price::NUMERIC(20,8),
  ALTER COLUMN close_price   TYPE NUMERIC(20,8) USING close_price::NUMERIC(20,8),
  ALTER COLUMN pnl_percent   TYPE NUMERIC(20,8) USING pnl_percent::NUMERIC(20,8);

DO $$ BEGIN
  ALTER TABLE shadow_closed_trades ALTER COLUMN pnl_equity_pct TYPE NUMERIC(20,8) USING pnl_equity_pct::NUMERIC(20,8);
EXCEPTION WHEN undefined_column THEN NULL; END $$;

-- journal_entries ─────────────────────────────────────────────────────────────
ALTER TABLE journal_entries
  ALTER COLUMN entry_price TYPE NUMERIC(20,8) USING entry_price::NUMERIC(20,8),
  ALTER COLUMN stop_loss   TYPE NUMERIC(20,8) USING stop_loss::NUMERIC(20,8),
  ALTER COLUMN tp1         TYPE NUMERIC(20,8) USING tp1::NUMERIC(20,8),
  ALTER COLUMN tp2         TYPE NUMERIC(20,8) USING tp2::NUMERIC(20,8);

DO $$ BEGIN
  ALTER TABLE journal_entries ALTER COLUMN close_price TYPE NUMERIC(20,8) USING close_price::NUMERIC(20,8);
EXCEPTION WHEN undefined_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE journal_entries ALTER COLUMN pnl_percent TYPE NUMERIC(20,8) USING pnl_percent::NUMERIC(20,8);
EXCEPTION WHEN undefined_column THEN NULL; END $$;

COMMIT;
