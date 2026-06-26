import pg from "pg";
import { logger } from "./logger.js";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  ssl: { rejectUnauthorized: false },
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
});
pool.on("error", (err) => logger.error({ err }, "PG idle client error"));

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY, chat_id BIGINT NOT NULL DEFAULT 0,
  symbol TEXT NOT NULL, interval TEXT NOT NULL, direction TEXT NOT NULL,
  entry_price DOUBLE PRECISION NOT NULL, stop_loss DOUBLE PRECISION NOT NULL,
  tp1 DOUBLE PRECISION NOT NULL, tp2 DOUBLE PRECISION NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0, confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL DEFAULT 'TREND',
  timestamp TEXT NOT NULL, closed_at TEXT, close_price DOUBLE PRECISION,
  outcome TEXT, pnl_percent DOUBLE PRECISION, error_analysis TEXT,
  factors JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS paper_accounts (
  chat_id BIGINT PRIMARY KEY,
  balance DOUBLE PRECISION NOT NULL DEFAULT 10000,
  initial_balance DOUBLE PRECISION NOT NULL DEFAULT 10000,
  peak_balance DOUBLE PRECISION NOT NULL DEFAULT 10000
);
CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY, chat_id BIGINT NOT NULL, symbol TEXT NOT NULL,
  direction TEXT NOT NULL, entry_price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL, stop_loss DOUBLE PRECISION NOT NULL,
  tp1 DOUBLE PRECISION NOT NULL, tp2 DOUBLE PRECISION NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'TREND',
  opened_at TEXT NOT NULL,
  breakeven_moved BOOLEAN NOT NULL DEFAULT false,
  trail_atr DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS paper_closed_trades (
  id TEXT PRIMARY KEY, chat_id BIGINT NOT NULL, symbol TEXT NOT NULL,
  direction TEXT NOT NULL, entry_price DOUBLE PRECISION NOT NULL,
  close_price DOUBLE PRECISION NOT NULL, size DOUBLE PRECISION NOT NULL,
  pnl DOUBLE PRECISION NOT NULL, pnl_percent DOUBLE PRECISION NOT NULL,
  outcome TEXT NOT NULL, strategy TEXT NOT NULL DEFAULT 'TREND',
  opened_at TEXT NOT NULL, closed_at TEXT NOT NULL
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
  min_score DOUBLE PRECISION NOT NULL DEFAULT 62,
  risk_percent DOUBLE PRECISION NOT NULL DEFAULT 1,
  account_size DOUBLE PRECISION NOT NULL DEFAULT 10000,
  auto_paper_trade BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS subscriptions (
  chat_id BIGINT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL,
  PRIMARY KEY (chat_id, symbol)
);
CREATE TABLE IF NOT EXISTS risk_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  daily_pnl_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  weekly_pnl_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  consecutive_losses INTEGER NOT NULL DEFAULT 0,
  open_positions_count INTEGER NOT NULL DEFAULT 0,
  trading_enabled BOOLEAN NOT NULL DEFAULT true,
  stop_reason TEXT,
  last_reset_date TEXT NOT NULL DEFAULT '2000-01-01',
  last_week_reset_date TEXT NOT NULL DEFAULT '2000-W01'
);
INSERT INTO risk_state (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS missed_trades (
  id TEXT PRIMARY KEY, symbol TEXT NOT NULL, interval TEXT NOT NULL,
  direction TEXT NOT NULL, entry_price DOUBLE PRECISION NOT NULL,
  stop_loss DOUBLE PRECISION NOT NULL, tp1 DOUBLE PRECISION NOT NULL,
  tp2 DOUBLE PRECISION NOT NULL, score DOUBLE PRECISION NOT NULL,
  filter_reason TEXT NOT NULL, timestamp TEXT NOT NULL,
  closed_at TEXT, virtual_outcome TEXT, virtual_pnl_percent DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS strategy_versions (
  id SERIAL PRIMARY KEY, created_at TEXT NOT NULL, weights JSONB NOT NULL,
  win_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  profit_factor DOUBLE PRECISION NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0, is_best BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS strategy_stats (
  strategy TEXT PRIMARY KEY,
  trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  win_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  loss_pnl DOUBLE PRECISION NOT NULL DEFAULT 0
);
INSERT INTO strategy_stats(strategy) VALUES('TREND'),('BREAKOUT'),('VOLUME_IMPULSE'),('MEAN_REVERSION')
ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ab_variants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  weights JSONB NOT NULL,
  trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  win_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  loss_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT false,
  is_champion BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications_log (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
  CREATE TABLE IF NOT EXISTS strategy_weights (
    strategy TEXT PRIMARY KEY,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    disabled BOOLEAN NOT NULL DEFAULT false,
    disabled_until TEXT,
    cycles_below_threshold INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '2000-01-01'
  );
  INSERT INTO strategy_weights(strategy) VALUES('TREND'),('BREAKOUT'),('VOLUME_IMPULSE'),('MEAN_REVERSION')
  ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS strategy_regime_stats (
    strategy TEXT NOT NULL, regime TEXT NOT NULL,
    trades INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
    win_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    loss_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (strategy, regime)
  );
  CREATE TABLE IF NOT EXISTS shadow_positions (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL, size DOUBLE PRECISION NOT NULL,
    stop_loss DOUBLE PRECISION NOT NULL, tp1 DOUBLE PRECISION NOT NULL, tp2 DOUBLE PRECISION NOT NULL,
    strategy TEXT NOT NULL, challenger_weights JSONB NOT NULL DEFAULT '{}',
    market_regime TEXT NOT NULL DEFAULT 'unknown', opened_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shadow_closed_trades (
    id TEXT PRIMARY KEY, symbol TEXT NOT NULL, direction TEXT NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL, close_price DOUBLE PRECISION NOT NULL,
    pnl_percent DOUBLE PRECISION NOT NULL, outcome TEXT NOT NULL,
    strategy TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT NOT NULL,
    is_win BOOLEAN NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS time_analytics (
    hour_of_day INTEGER NOT NULL, day_of_week INTEGER NOT NULL,
    trades INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
    win_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    loss_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (hour_of_day, day_of_week)
  );
  CREATE TABLE IF NOT EXISTS instrument_analytics (
    symbol TEXT PRIMARY KEY,
    trades INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
    win_pnl DOUBLE PRECISION NOT NULL DEFAULT 0, loss_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
    priority_weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    best_strategy TEXT NOT NULL DEFAULT 'TREND',
    updated_at TEXT NOT NULL DEFAULT '2000-01-01'
  );
  CREATE TABLE IF NOT EXISTS learning_reports (
    id SERIAL PRIMARY KEY, version_label TEXT NOT NULL,
    created_at TEXT NOT NULL, trade_count_at_report INTEGER NOT NULL,
    summary TEXT NOT NULL, report_json JSONB NOT NULL DEFAULT '{}'
  );
`;

const MIGRATIONS = [
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS breakeven_moved BOOLEAN NOT NULL DEFAULT false",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS trail_atr DOUBLE PRECISION",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'TREND'",
  "ALTER TABLE paper_accounts ADD COLUMN IF NOT EXISTS peak_balance DOUBLE PRECISION NOT NULL DEFAULT 10000",
  "ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS auto_paper_trade BOOLEAN NOT NULL DEFAULT true",
  "ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'TREND'",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'TREND'",
  // LLM analysis columns — required for insertPosition and insertClosedTrade
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS llm_sentiment TEXT",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS llm_risk TEXT",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS llm_confidence DOUBLE PRECISION",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_sentiment TEXT",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_risk TEXT",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_confidence DOUBLE PRECISION",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS market_regime TEXT NOT NULL DEFAULT 'unknown'",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS market_regime TEXT NOT NULL DEFAULT 'unknown'",
  "ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS version_label TEXT",
  "ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS total_return DOUBLE PRECISION NOT NULL DEFAULT 0",
  "ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS max_drawdown DOUBLE PRECISION NOT NULL DEFAULT 0",
  "ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS sharpe_ratio DOUBLE PRECISION NOT NULL DEFAULT 0",
  "ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS recovery_factor DOUBLE PRECISION NOT NULL DEFAULT 0",
  "ALTER TABLE strategy_versions ADD COLUMN IF NOT EXISTS notes TEXT",
  // Strategy Management Engine v2
  "ALTER TABLE strategy_weights ADD COLUMN IF NOT EXISTS quarantine BOOLEAN NOT NULL DEFAULT false",
  "ALTER TABLE strategy_weights ADD COLUMN IF NOT EXISTS trust_score DOUBLE PRECISION NOT NULL DEFAULT 0",
  `CREATE TABLE IF NOT EXISTS strategy_history (
    id SERIAL PRIMARY KEY,
    strategy TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    prev_weight DOUBLE PRECISION NOT NULL DEFAULT 1,
    new_weight  DOUBLE PRECISION NOT NULL DEFAULT 1,
    prev_pf     DOUBLE PRECISION NOT NULL DEFAULT 0,
    new_pf      DOUBLE PRECISION NOT NULL DEFAULT 0,
    trust_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_loss_reasons (
    strategy TEXT NOT NULL,
    reason   TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (strategy, reason)
  )`,
  // AI Learning Engine v3
  `CREATE TABLE IF NOT EXISTS trade_features (
    position_id  TEXT PRIMARY KEY,
    symbol       TEXT NOT NULL,
    strategy     TEXT NOT NULL,
    direction    TEXT NOT NULL,
    interval     TEXT NOT NULL,
    features     JSONB NOT NULL,
    pnl_percent  DOUBLE PRECISION,
    is_win       BOOLEAN,
    outcome      TEXT,
    saved_at     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feature_importance (
    factor           TEXT PRIMARY KEY,
    label            TEXT NOT NULL DEFAULT '',
    importance_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    wr_lift          DOUBLE PRECISION NOT NULL DEFAULT 0,
    pf_lift          DOUBLE PRECISION NOT NULL DEFAULT 0,
    trades           INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ai_research_reports (
    id              SERIAL PRIMARY KEY,
    date            TEXT NOT NULL,
    pattern         TEXT NOT NULL,
    hypothesis      TEXT NOT NULL,
    experiment      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'generated',
    result          TEXT,
    trade_count_at  INTEGER NOT NULL DEFAULT 0
  )`,
];


export async function initDb(): Promise<void> {
  if (!process.env["DATABASE_URL"])
    throw new Error("DATABASE_URL not set");
  const client = await pool.connect();
  try {
    await client.query(INIT_SQL);
    for (const sql of MIGRATIONS) await client.query(sql).catch(() => {});
    logger.info("PostgreSQL tables ready");
  } finally { client.release(); }
}
