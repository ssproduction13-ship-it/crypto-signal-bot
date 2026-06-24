import { pool } from "../lib/db.js";
  import { logger } from "../lib/logger.js";

  export interface JournalEntry {
    id: string;
    chatId: number;
    symbol: string;
    interval: string;
    direction: "LONG" | "SHORT";
    entryPrice: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    score: number;
    confidence: number;
    timestamp: string;
    closedAt?: string;
    closePrice?: number;
    outcome?: "TP1" | "TP2" | "SL" | "MANUAL";
    pnlPercent?: number;
    errorAnalysis?: string;
    factors: Record<string, number>;
  }

  export interface PaperPosition {
    id: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    entryPrice: number;
    size: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    openedAt: string;
    chatId: number;
  }

  export interface PaperAccount {
    balance: number;
    initialBalance: number;
    positions: PaperPosition[];
    closedTrades: ClosedPaperTrade[];
  }

  export interface ClosedPaperTrade {
    id: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    entryPrice: number;
    closePrice: number;
    size: number;
    pnl: number;
    pnlPercent: number;
    outcome: string;
    openedAt: string;
    closedAt: string;
  }

  export interface FactorWeights {
    trend: number;
    volume: number;
    momentum: number;
    levels: number;
    pattern: number;
  }

  export interface UserSettings {
    noTradeMode: boolean;
    minScore: number;
    riskPercent: number;
    accountSize: number;
  }

  const DEFAULT_WEIGHTS: FactorWeights = {
    trend: 0.30,
    volume: 0.25,
    momentum: 0.20,
    levels: 0.15,
    pattern: 0.10,
  };

  const DEFAULT_SETTINGS: UserSettings = {
    noTradeMode: false,
    minScore: 70,
    riskPercent: 1,
    accountSize: 1000,
  };

  function rowToJournalEntry(row: Record<string, unknown>): JournalEntry {
    return {
      id: row["id"] as string,
      chatId: Number(row["chat_id"]),
      symbol: row["symbol"] as string,
      interval: row["interval"] as string,
      direction: row["direction"] as "LONG" | "SHORT",
      entryPrice: Number(row["entry_price"]),
      stopLoss: Number(row["stop_loss"]),
      tp1: Number(row["tp1"]),
      tp2: Number(row["tp2"]),
      score: Number(row["score"]),
      confidence: Number(row["confidence"]),
      timestamp: row["timestamp"] as string,
      closedAt: (row["closed_at"] as string | null) ?? undefined,
      closePrice: row["close_price"] != null ? Number(row["close_price"]) : undefined,
      outcome: (row["outcome"] as JournalEntry["outcome"]) ?? undefined,
      pnlPercent: row["pnl_percent"] != null ? Number(row["pnl_percent"]) : undefined,
      errorAnalysis: (row["error_analysis"] as string | null) ?? undefined,
      factors: (row["factors"] as Record<string, number>) ?? {},
    };
  }

  export async function loadJournal(): Promise<JournalEntry[]> {
    const { rows } = await pool.query(
      "SELECT * FROM journal_entries ORDER BY timestamp DESC"
    );
    return rows.map(rowToJournalEntry);
  }

  export async function addJournalEntry(entry: JournalEntry): Promise<void> {
    await pool.query(
      `INSERT INTO journal_entries
         (id, chat_id, symbol, interval, direction, entry_price, stop_loss, tp1, tp2,
          score, confidence, timestamp, factors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        entry.id, entry.chatId ?? 0, entry.symbol, entry.interval, entry.direction,
        entry.entryPrice, entry.stopLoss, entry.tp1, entry.tp2,
        entry.score, entry.confidence, entry.timestamp,
        JSON.stringify(entry.factors),
      ]
    );
  }

  export async function updateJournalEntry(
    id: string,
    update: Partial<JournalEntry>
  ): Promise<boolean> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (update.closedAt !== undefined)      { sets.push(`closed_at=$${i++}`);     vals.push(update.closedAt); }
    if (update.closePrice !== undefined)    { sets.push(`close_price=$${i++}`);   vals.push(update.closePrice); }
    if (update.outcome !== undefined)       { sets.push(`outcome=$${i++}`);       vals.push(update.outcome); }
    if (update.pnlPercent !== undefined)    { sets.push(`pnl_percent=$${i++}`);   vals.push(update.pnlPercent); }
    if (update.errorAnalysis !== undefined) { sets.push(`error_analysis=$${i++}`); vals.push(update.errorAnalysis); }
    if (sets.length === 0) return false;
    vals.push(id);
    const { rowCount } = await pool.query(
      `UPDATE journal_entries SET ${sets.join(",")} WHERE id=$${i}`,
      vals
    );
    return (rowCount ?? 0) > 0;
  }

  function rowToPosition(row: Record<string, unknown>): PaperPosition {
    return {
      id: row["id"] as string,
      chatId: Number(row["chat_id"]),
      symbol: row["symbol"] as string,
      direction: row["direction"] as "LONG" | "SHORT",
      entryPrice: Number(row["entry_price"]),
      size: Number(row["size"]),
      stopLoss: Number(row["stop_loss"]),
      tp1: Number(row["tp1"]),
      tp2: Number(row["tp2"]),
      openedAt: row["opened_at"] as string,
    };
  }

  function rowToClosedTrade(row: Record<string, unknown>): ClosedPaperTrade {
    return {
      id: row["id"] as string,
      symbol: row["symbol"] as string,
      direction: row["direction"] as "LONG" | "SHORT",
      entryPrice: Number(row["entry_price"]),
      closePrice: Number(row["close_price"]),
      size: Number(row["size"]),
      pnl: Number(row["pnl"]),
      pnlPercent: Number(row["pnl_percent"]),
      outcome: row["outcome"] as string,
      openedAt: row["opened_at"] as string,
      closedAt: row["closed_at"] as string,
    };
  }

  export async function loadPaperAccount(chatId: number): Promise<PaperAccount> {
    const [accRes, posRes, closedRes] = await Promise.all([
      pool.query("SELECT * FROM paper_accounts WHERE chat_id=$1", [chatId]),
      pool.query("SELECT * FROM paper_positions WHERE chat_id=$1", [chatId]),
      pool.query(
        "SELECT * FROM paper_closed_trades WHERE chat_id=$1 ORDER BY closed_at DESC",
        [chatId]
      ),
    ]);
    const acc = (accRes.rows[0] as Record<string, unknown> | undefined);
    return {
      balance: acc ? Number(acc["balance"]) : 10000,
      initialBalance: acc ? Number(acc["initial_balance"]) : 10000,
      positions: posRes.rows.map(rowToPosition),
      closedTrades: closedRes.rows.map(rowToClosedTrade),
    };
  }

  export async function savePaperAccount(
    chatId: number,
    account: PaperAccount
  ): Promise<void> {
    await pool.query(
      `INSERT INTO paper_accounts (chat_id, balance, initial_balance) VALUES ($1,$2,$3)
       ON CONFLICT (chat_id) DO UPDATE SET balance=EXCLUDED.balance`,
      [chatId, account.balance, account.initialBalance]
    );

    await pool.query("DELETE FROM paper_positions WHERE chat_id=$1", [chatId]);
    for (const pos of account.positions) {
      await pool.query(
        `INSERT INTO paper_positions
           (id, chat_id, symbol, direction, entry_price, size, stop_loss, tp1, tp2, opened_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [pos.id, chatId, pos.symbol, pos.direction, pos.entryPrice, pos.size,
         pos.stopLoss, pos.tp1, pos.tp2, pos.openedAt]
      );
    }

    for (const t of account.closedTrades) {
      await pool.query(
        `INSERT INTO paper_closed_trades
           (id, chat_id, symbol, direction, entry_price, close_price, size,
            pnl, pnl_percent, outcome, opened_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [t.id, chatId, t.symbol, t.direction, t.entryPrice, t.closePrice,
         t.size, t.pnl, t.pnlPercent, t.outcome, t.openedAt, t.closedAt]
      );
    }
  }

  export async function loadWeights(): Promise<FactorWeights> {
    const { rows } = await pool.query("SELECT * FROM factor_weights WHERE id=1");
    if (rows.length === 0) return { ...DEFAULT_WEIGHTS };
    const r = rows[0] as Record<string, unknown>;
    return {
      trend:    Number(r["trend"]),
      volume:   Number(r["volume"]),
      momentum: Number(r["momentum"]),
      levels:   Number(r["levels"]),
      pattern:  Number(r["pattern"]),
    };
  }

  export async function saveWeights(w: FactorWeights): Promise<void> {
    await pool.query(
      `INSERT INTO factor_weights (id, trend, volume, momentum, levels, pattern)
       VALUES (1,$1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE
         SET trend=EXCLUDED.trend, volume=EXCLUDED.volume,
             momentum=EXCLUDED.momentum, levels=EXCLUDED.levels, pattern=EXCLUDED.pattern`,
      [w.trend, w.volume, w.momentum, w.levels, w.pattern]
    );
  }

  export async function loadSettings(chatId: number): Promise<UserSettings> {
    const { rows } = await pool.query(
      "SELECT * FROM user_settings WHERE chat_id=$1", [chatId]
    );
    if (rows.length === 0) return { ...DEFAULT_SETTINGS };
    const r = rows[0] as Record<string, unknown>;
    return {
      noTradeMode:  Boolean(r["no_trade_mode"]),
      minScore:     Number(r["min_score"]),
      riskPercent:  Number(r["risk_percent"]),
      accountSize:  Number(r["account_size"]),
    };
  }

  export async function saveSettings(
    chatId: number,
    settings: UserSettings
  ): Promise<void> {
    await pool.query(
      `INSERT INTO user_settings (chat_id, no_trade_mode, min_score, risk_percent, account_size)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (chat_id) DO UPDATE
         SET no_trade_mode=EXCLUDED.no_trade_mode, min_score=EXCLUDED.min_score,
             risk_percent=EXCLUDED.risk_percent, account_size=EXCLUDED.account_size`,
      [chatId, settings.noTradeMode, settings.minScore, settings.riskPercent, settings.accountSize]
    );
  }

  export function genId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  logger.info("PostgreSQL storage initialized");
  