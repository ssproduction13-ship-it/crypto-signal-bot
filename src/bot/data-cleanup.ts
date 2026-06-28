import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const COMMISSION_RATE = 0.001;

export interface CleanupResult {
  dupesRemoved: number;
  tradesKept: number;
  oldBalance: number;
  newBalance: number;
  initialBalance: number;
}

/**
 * Deduplicate paper_closed_trades and recalculate balance.
 *
 * Phantom-close bug: concurrent checkPaperPositions cycles used genId() which
 * generates a new unique ID each time, bypassing ON CONFLICT(id). This caused
 * the same position to be recorded as closed 2-3 times per trigger event.
 *
 * Dedup key: (chat_id, symbol, direction, entry_price, opened_at, outcome)
 * — keeps the earliest closure for each unique position+outcome combination.
 *
 * Balance formula:
 *   new_balance = initial_balance + SUM(pnl) - SUM(estimated_open_commission)
 *   pnl already includes close commission (deducted in buildCloseRecord).
 *   Open commission ≈ close commission (same 0.1% rate, similar notional).
 *   TP1 trades: original size was 2× trade.size → open_comm = 2× close_comm.
 *   Other trades: open_comm ≈ close_comm.
 */
export async function runDataCleanup(chatId: number): Promise<CleanupResult> {
  const { rows: countBefore } = await pool.query(
    "SELECT COUNT(*) as cnt FROM paper_closed_trades WHERE chat_id=$1", [chatId]
  );
  const totalBefore = Number((countBefore[0] as Record<string,unknown>)["cnt"]);

  // Step 1 — Deduplicate: keep earliest close per unique position+outcome
  const dedupeResult = await pool.query(`
    WITH ranked AS (
      SELECT id,
        ROW_NUMBER() OVER (
          PARTITION BY chat_id, symbol, direction, entry_price, opened_at, outcome
          ORDER BY closed_at ASC
        ) AS rn
      FROM paper_closed_trades
      WHERE chat_id = $1
    )
    DELETE FROM paper_closed_trades
    WHERE chat_id = $1
      AND id IN (SELECT id FROM ranked WHERE rn > 1)
  `, [chatId]);

  const dupesRemoved = dedupeResult.rowCount ?? 0;
  const tradesKept = totalBefore - dupesRemoved;

  // Step 2 — Get current account state
  const { rows: accRows } = await pool.query(
    "SELECT balance, initial_balance FROM paper_accounts WHERE chat_id=$1", [chatId]
  );
  const oldBalance = accRows.length ? Number((accRows[0] as Record<string,unknown>)["balance"]) : 0;
  const initialBalance = accRows.length ? Number((accRows[0] as Record<string,unknown>)["initial_balance"]) : 10000;

  // Step 3 — Aggregate clean trade stats
  const { rows: aggRows } = await pool.query(`
    SELECT
      COALESCE(SUM(pnl), 0)                                           AS total_pnl,
      COALESCE(SUM(COALESCE(commission, entry_price * size * $2)), 0) AS total_close_comm,
      COALESCE(SUM(COALESCE(slippage,   0)), 0)                       AS total_slippage,
      -- TP1: open size was 2× trade.size → open_comm = 2× close_comm
      COALESCE(SUM(CASE WHEN outcome='TP1'
                   THEN COALESCE(commission, entry_price * size * $2) * 2
                   ELSE COALESCE(commission, entry_price * size * $2)
                   END), 0)                                           AS est_open_comm
    FROM paper_closed_trades
    WHERE chat_id = $1
  `, [chatId, COMMISSION_RATE]);

  const agg = aggRows[0] as Record<string, unknown>;
  const totalPnl      = Number(agg["total_pnl"]);
  const totalCloseComm = Number(agg["total_close_comm"]);
  const totalSlippage  = Number(agg["total_slippage"]);
  const estOpenComm    = Number(agg["est_open_comm"]);

  // new_balance = initial + sum(pnl) - estimated_open_commissions
  const newBalance = Math.max(initialBalance + totalPnl - estOpenComm, 0);
  const totalCommission = totalCloseComm + estOpenComm;

  // Step 4 — Update paper_accounts
  await pool.query(`
    INSERT INTO paper_accounts(chat_id, balance, initial_balance, peak_balance, total_commission, total_slippage)
    VALUES ($1, $2, $3, GREATEST($2, $3), $4, $5)
    ON CONFLICT(chat_id) DO UPDATE SET
      balance          = $2,
      peak_balance     = GREATEST($2, paper_accounts.initial_balance),
      total_commission = $4,
      total_slippage   = $5
  `, [chatId, newBalance, initialBalance, totalCommission, totalSlippage]);

  // Step 5 — Reset strategy performance tables (trained on phantom trades)
  await pool.query("DELETE FROM strategy_stats WHERE 1=1");
  await pool.query("DELETE FROM strategy_regime_stats WHERE 1=1");
  await pool.query("DELETE FROM strategy_loss_reasons WHERE 1=1");

  // Step 6 — Reset strategy weights to neutral (remove quarantine, re-enable all)
  await pool.query(`
    UPDATE strategy_weights SET
      weight                  = 1.0,
      disabled                = false,
      disabled_until          = NULL,
      quarantine              = false,
      trust_score             = 50,
      cycles_below_threshold  = 0,
      updated_at              = NOW()
  `);

  // Step 7 — Reset time/instrument analytics
  await pool.query("DELETE FROM time_analytics WHERE 1=1");
  await pool.query("DELETE FROM instrument_analytics WHERE 1=1");

  // Step 8 — Clear stale strategy snapshots and learning reports
  await pool.query("DELETE FROM strategy_versions WHERE 1=1");
  await pool.query("DELETE FROM learning_reports WHERE 1=1");

  logger.info(
    { chatId, dupesRemoved, tradesKept, oldBalance, newBalance },
    "Data cleanup complete"
  );

  return { dupesRemoved, tradesKept, oldBalance, newBalance, initialBalance };
}
