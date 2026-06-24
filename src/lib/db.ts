import pg from "pg";
  import { logger } from "./logger.js";

  const { Pool } = pg;

  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  export const pool = new Pool({
    connectionString: process.env["DATABASE_URL"],
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected error on idle PostgreSQL client");
  });

  const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    chat_id BIGINT NOT NULL DEFAULT 0,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL,
    stop_loss DOUBLE PRECISION NOT NULL,
    tp1 DOUBLE PRECISION NOT NULL,
    tp2 DOUBLE PRECISION NOT NULL,
    score DOUBLE PRECISION NOT NULL DEFAULT 0,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    closed_at TEXT,
    close_price DOUBLE PRECISION,
    outcome TEXT,
    pnl_percent DOUBLE PRECISION,
    error_analysis TEXT,
    factors JSONB NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS paper_accounts (
    chat_id BIGINT PRIMARY KEY,
    balance DOUBLE PRECISION NOT NULL DEFAULT 10000,
    initial_balance DOUBLE PRECISION NOT NULL DEFAULT 10000
  );

  CREATE TABLE IF NOT EXISTS paper_positions (
    id TEXT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL,
    size DOUBLE PRECISION NOT NULL,
    stop_loss DOUBLE PRECISION NOT NULL,
    tp1 DOUBLE PRECISION NOT NULL,
    tp2 DOUBLE PRECISION NOT NULL,
    opened_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS paper_closed_trades (
    id TEXT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL,
    close_price DOUBLE PRECISION NOT NULL,
    size DOUBLE PRECISION NOT NULL,
    pnl DOUBLE PRECISION NOT NULL,
    pnl_percent DOUBLE PRECISION NOT NULL,
    outcome TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS factor_weights (
    id INTEGER PRIMARY KEY DEFAULT 1,
    trend DOUBLE PRECISION NOT NULL DEFAULT 0.30,
    volume DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    momentum DOUBLE PRECISION NOT NULL DEFAULT 0.20,
    levels DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    pattern DOUBLE PRECISION NOT NULL DEFAULT 0.10
  );

  INSERT INTO factor_weights (id) VALUES (1) ON CONFLICT DO NOTHING;

  CREATE TABLE IF NOT EXISTS user_settings (
    chat_id BIGINT PRIMARY KEY,
    no_trade_mode BOOLEAN NOT NULL DEFAULT false,
    min_score DOUBLE PRECISION NOT NULL DEFAULT 70,
    risk_percent DOUBLE PRECISION NOT NULL DEFAULT 1,
    account_size DOUBLE PRECISION NOT NULL DEFAULT 1000
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id BIGINT NOT NULL,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    PRIMARY KEY (chat_id, symbol)
  );
  `;

  export async function initDb(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(INIT_SQL);
      logger.info("PostgreSQL tables ready");
    } finally {
      client.release();
    }
  }
  