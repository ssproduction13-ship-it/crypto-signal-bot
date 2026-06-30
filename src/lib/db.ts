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
  trail_atr DOUBLE PRECISION,
  market_regime TEXT NOT NULL DEFAULT 'sideways',
  interval TEXT NOT NULL DEFAULT '1h'
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
  CREATE TABLE IF NOT EXISTS decision_log (
    id            SERIAL PRIMARY KEY,
    symbol        TEXT NOT NULL,
    strategy      TEXT,
    direction     TEXT,
    regime        TEXT,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    steps         JSONB,
    verdict       TEXT NOT NULL,
    reject_reason TEXT,
    trade_id      TEXT,
    score         NUMERIC,
    confidence    NUMERIC
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
  // ── Release Candidate: 10 new modules ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS walk_forward_results (
    id            SERIAL PRIMARY KEY,
    strategy      TEXT NOT NULL,
    windows_count INTEGER NOT NULL DEFAULT 0,
    avg_train_pf  DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_test_pf   DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_train_wr  DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_test_wr   DOUBLE PRECISION NOT NULL DEFAULT 0,
    overfit_risk  TEXT NOT NULL DEFAULT 'high',
    is_valid      BOOLEAN NOT NULL DEFAULT false,
    summary       TEXT NOT NULL DEFAULT '',
    computed_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stat_significance_tests (
    id            SERIAL PRIMARY KEY,
    strategy      TEXT NOT NULL,
    baseline_pf   DOUBLE PRECISION NOT NULL DEFAULT 0,
    new_pf        DOUBLE PRECISION NOT NULL DEFAULT 0,
    baseline_wr   DOUBLE PRECISION NOT NULL DEFAULT 0,
    new_wr        DOUBLE PRECISION NOT NULL DEFAULT 0,
    pf_p_value    DOUBLE PRECISION NOT NULL DEFAULT 1,
    wr_p_value    DOUBLE PRECISION NOT NULL DEFAULT 1,
    should_apply  BOOLEAN NOT NULL DEFAULT false,
    reason        TEXT NOT NULL DEFAULT '',
    tested_at     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS market_drift_log (
    id                    SERIAL PRIMARY KEY,
    has_drift             BOOLEAN NOT NULL DEFAULT false,
    severity              TEXT NOT NULL DEFAULT 'none',
    recent_pf             DOUBLE PRECISION NOT NULL DEFAULT 0,
    historical_pf         DOUBLE PRECISION NOT NULL DEFAULT 0,
    recent_wr             DOUBLE PRECISION NOT NULL DEFAULT 0,
    historical_wr         DOUBLE PRECISION NOT NULL DEFAULT 0,
    confidence_reduction  DOUBLE PRECISION NOT NULL DEFAULT 0,
    activity_reduction    DOUBLE PRECISION NOT NULL DEFAULT 0,
    message               TEXT NOT NULL DEFAULT '',
    detected_at           TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS health_monitor_log (
    id             SERIAL PRIMARY KEY,
    overall_status TEXT NOT NULL DEFAULT 'healthy',
    trend          TEXT NOT NULL DEFAULT 'stable',
    alerts_count   INTEGER NOT NULL DEFAULT 0,
    p30_pf         DOUBLE PRECISION NOT NULL DEFAULT 0,
    p100_pf        DOUBLE PRECISION NOT NULL DEFAULT 0,
    p300_pf        DOUBLE PRECISION NOT NULL DEFAULT 0,
    checked_at     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_stability_index (
    id              SERIAL PRIMARY KEY,
    strategy        TEXT NOT NULL,
    stability_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    label           TEXT NOT NULL DEFAULT 'Watch',
    profit_factor   DOUBLE PRECISION NOT NULL DEFAULT 0,
    win_rate        DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_drawdown    DOUBLE PRECISION NOT NULL DEFAULT 0,
    pnl_volatility  DOUBLE PRECISION NOT NULL DEFAULT 0,
    consistency     DOUBLE PRECISION NOT NULL DEFAULT 0,
    trades          INTEGER NOT NULL DEFAULT 0,
    computed_at     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evolution_timeline (
    id                   SERIAL PRIMARY KEY,
    version              INTEGER NOT NULL,
    date                 TEXT NOT NULL,
    total_trades         INTEGER NOT NULL DEFAULT 0,
    profit_factor        DOUBLE PRECISION NOT NULL DEFAULT 0,
    win_rate             DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_drawdown         DOUBLE PRECISION NOT NULL DEFAULT 0,
    best_strategies      JSONB NOT NULL DEFAULT '[]',
    disabled_strategies  JSONB NOT NULL DEFAULT '[]',
    changed_params       JSONB NOT NULL DEFAULT '{}',
    new_hypotheses       JSONB NOT NULL DEFAULT '[]',
    summary              TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS cooldown_state (
    id                    SERIAL PRIMARY KEY,
    chat_id               BIGINT NOT NULL DEFAULT 0,
    level                 TEXT NOT NULL DEFAULT 'none',
    size_multiplier       DOUBLE PRECISION NOT NULL DEFAULT 1,
    min_confidence_boost  DOUBLE PRECISION NOT NULL DEFAULT 0,
    skip_probability      DOUBLE PRECISION NOT NULL DEFAULT 0,
    reason                TEXT NOT NULL DEFAULT '',
    active_since          TEXT,
    recent_pf             DOUBLE PRECISION NOT NULL DEFAULT 0,
    recent_drawdown       DOUBLE PRECISION NOT NULL DEFAULT 0,
    checked_at            TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS weekly_research (
    id                   SERIAL PRIMARY KEY,
    week_start           TEXT NOT NULL,
    week_end             TEXT NOT NULL,
    total_trades         INTEGER NOT NULL DEFAULT 0,
    week_pf              DOUBLE PRECISION NOT NULL DEFAULT 0,
    week_wr              DOUBLE PRECISION NOT NULL DEFAULT 0,
    improved             JSONB NOT NULL DEFAULT '[]',
    degraded             JSONB NOT NULL DEFAULT '[]',
    stronger_strategies  JSONB NOT NULL DEFAULT '[]',
    weaker_strategies    JSONB NOT NULL DEFAULT '[]',
    better_instruments   JSONB NOT NULL DEFAULT '[]',
    worse_instruments    JSONB NOT NULL DEFAULT '[]',
    new_patterns         JSONB NOT NULL DEFAULT '[]',
    new_hypotheses       JSONB NOT NULL DEFAULT '[]',
    full_text            TEXT NOT NULL DEFAULT '',
    generated_at         TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS readiness_index_log (
    id           SERIAL PRIMARY KEY,
    percent      DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_score  DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_trades INTEGER NOT NULL DEFAULT 0,
    pf           DOUBLE PRECISION NOT NULL DEFAULT 0,
    wr           DOUBLE PRECISION NOT NULL DEFAULT 0,
    max_drawdown DOUBLE PRECISION NOT NULL DEFAULT 0,
    computed_at  TEXT NOT NULL
  )`,
  // ── Final Decision Engine v1.0 ───────────────────────────────────────────
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS exit_reason TEXT",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS decision_trace JSONB",
  // ── Realistic Paper Trading v2.0 ─────────────────────────────────────────
  "ALTER TABLE paper_positions       ADD COLUMN IF NOT EXISTS equity_at_open DOUBLE PRECISION",
  "ALTER TABLE paper_closed_trades   ADD COLUMN IF NOT EXISTS commission DOUBLE PRECISION NOT NULL DEFAULT 0",
  "ALTER TABLE paper_closed_trades   ADD COLUMN IF NOT EXISTS slippage   DOUBLE PRECISION NOT NULL DEFAULT 0",
  "ALTER TABLE paper_closed_trades   ADD COLUMN IF NOT EXISTS pnl_equity_pct DOUBLE PRECISION",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS interval TEXT NOT NULL DEFAULT '1h'",
  // ── Partial entry (pending_entry) columns ────────────────────────────────
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS pending_entry_size    DOUBLE PRECISION",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS pending_entry_trigger DOUBLE PRECISION",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS llm_sentiment TEXT",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS llm_risk TEXT",
  "ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS llm_confidence INTEGER",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_sentiment TEXT",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_risk TEXT",
  "ALTER TABLE paper_closed_trades ADD COLUMN IF NOT EXISTS llm_confidence INTEGER",
  "ALTER TABLE paper_accounts        ADD COLUMN IF NOT EXISTS total_commission DOUBLE PRECISION NOT NULL DEFAULT 0",
  "ALTER TABLE paper_accounts        ADD COLUMN IF NOT EXISTS total_slippage   DOUBLE PRECISION NOT NULL DEFAULT 0",
  `CREATE TABLE IF NOT EXISTS decision_log (
    id            SERIAL PRIMARY KEY,
    symbol        TEXT NOT NULL,
    strategy      TEXT NOT NULL DEFAULT 'UNKNOWN',
    direction     TEXT NOT NULL,
    regime        TEXT NOT NULL DEFAULT 'unknown',
    timestamp     TEXT NOT NULL,
    steps         JSONB NOT NULL DEFAULT '[]',
    verdict       TEXT NOT NULL DEFAULT 'REJECT',
    reject_reason TEXT,
    trade_id      TEXT,
    score         DOUBLE PRECISION,
    confidence    DOUBLE PRECISION
  )`,
  // ── M1: add interval dimension to strategy_regime_stats ──────────────────
  // Existing rows get interval='ALL' (cross-interval aggregate, kept for fallback).
  // New rows store the actual trading interval so 15m and 1h stats are separate.
  "ALTER TABLE strategy_regime_stats ADD COLUMN IF NOT EXISTS interval TEXT NOT NULL DEFAULT 'ALL'",
  // Drop old (strategy,regime) PK so we can extend it with interval.
  // Safe: existing rows are unique on (strategy,regime,interval='ALL').
  "ALTER TABLE strategy_regime_stats DROP CONSTRAINT IF EXISTS strategy_regime_stats_pkey",
  "ALTER TABLE strategy_regime_stats ADD PRIMARY KEY (strategy, regime, interval)",
  // ── H2: link journal entries to paper positions ───────────────────────────
  "ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS position_id TEXT",
  "CREATE INDEX IF NOT EXISTS idx_je_position_id ON journal_entries(position_id)",
  // ── v1.1 DB Indexes — prevent full-table scans as trade history grows ────
  "CREATE INDEX IF NOT EXISTS idx_pct_strategy   ON paper_closed_trades(strategy)",
  "CREATE INDEX IF NOT EXISTS idx_pct_closed_at  ON paper_closed_trades(closed_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_pct_chat_id    ON paper_closed_trades(chat_id)",
  "CREATE INDEX IF NOT EXISTS idx_pp_chat_id     ON paper_positions(chat_id)",
  "CREATE INDEX IF NOT EXISTS idx_je_lookup      ON journal_entries(chat_id, symbol, direction)",
  "CREATE INDEX IF NOT EXISTS idx_je_closed_at   ON journal_entries(closed_at)",
  "CREATE INDEX IF NOT EXISTS idx_ss_strategy    ON strategy_stats(strategy)",
  "CREATE INDEX IF NOT EXISTS idx_ia_symbol      ON instrument_analytics(symbol)",
  "CREATE INDEX IF NOT EXISTS idx_dl_symbol      ON decision_log(symbol)",
  "CREATE INDEX IF NOT EXISTS idx_dl_strategy    ON decision_log(strategy)",
  // ── AI Watchlist: status column for instrument-level shadow-quarantine ──────
  "ALTER TABLE instrument_analytics ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'normal'",
];



export async function resetAllData(): Promise<number[]> {
  // Collect chatIds BEFORE truncating so we can notify them
  const { rows: chatRows } = await pool.query(
    "SELECT DISTINCT chat_id FROM paper_accounts"
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const chatIdList = chatRows.map((r) => Number(r["chat_id"]));

  // Truncate each table individually — skip if table does not exist yet
  const tables = [
    "paper_positions", "paper_closed_trades", "journal_entries",
    "trade_features", "strategy_stats", "strategy_regime_stats",
    "strategy_weights", "strategy_history", "strategy_versions",
    "factor_weights", "paper_accounts", "risk_state", "cooldown_state",
    "time_analytics", "instrument_analytics", "walk_forward_results",
    "learning_reports", "shadow_closed_trades", "missed_trades",
    "similar_trades", "ab_variants", "decision_traces", "decision_log",
  ];
  const client = await pool.connect();
  try {
    for (const t of tables) {
      await client.query(`TRUNCATE ${t} CASCADE`).catch(() => {
        // table does not exist yet — safe to ignore
      });
    }
    await client.query(
      "INSERT INTO factor_weights (id) VALUES (1) ON CONFLICT DO NOTHING"
    ).catch(() => {});
    logger.info({ tables: tables.length }, "resetAllData: all tables truncated");
  } finally { client.release(); }
  return chatIdList;
}

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
  