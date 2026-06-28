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

export async function runDataCleanup(chatId: number): Promise<CleanupResult> {
  // Step 1 — Count before dedup
  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM paper_closed_trades WHERE chat_id=$1",
    [chatId]
  );
  const totalBefore: number = (countRows[0] as { cnt: number }).cnt;

  // Step 2 — Deduplicate: keep earliest close per unique position+outcome
  const dedupeResult = await pool.query(
    `WITH ranked AS (
       SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY chat_id, symbol, direction, entry_price, opened_at, outcome
           ORDER BY closed_at ASC
         ) AS rn
       FROM paper_closed_trades WHERE chat_id=$1
     )
     DELETE FROM paper_closed_trades
     WHERE chat_id=$1 AND id IN (SELECT id FROM ranked WHERE rn > 1)`,
    [chatId]
  );
  const dupesRemoved = dedupeResult.rowCount ?? 0;
  const tradesKept   = totalBefore - dupesRemoved;

  // Step 3 — Get account state
  const { rows: accRows } = await pool.query(
    "SELECT balance, initial_balance FROM paper_accounts WHERE chat_id=$1",
    [chatId]
  );
  const oldBalance     = accRows.length ? Number((accRows[0] as Record<string,unknown>)["balance"])          : 0;
  const initialBalance = accRows.length ? Number((accRows[0] as Record<string,unknown>)["initial_balance"])  : 10000;

  // Step 4 — Fetch all clean trades and compute balance in JS
  //   pnl already has close commission deducted.
  //   Open commission ≈ same rate on same notional.
  //   For TP1: original size = 2× trade.size → open_comm = 2× close_comm.
  //   For others: open_comm ≈ close_comm.
  const { rows: trades } = await pool.query(
    `SELECT pnl, commission, slippage, entry_price, size, outcome
     FROM paper_closed_trades WHERE chat_id=$1`,
    [chatId]
  );

  let totalPnl       = 0;
  let totalCloseComm = 0;
  let estOpenComm    = 0;
  let totalSlippage  = 0;

  for (const row of trades) {
    const t = row as {
      pnl: number | string;
      commission: number | string | null;
      slippage:   number | string | null;
      entry_price: number | string;
      size:        number | string;
      outcome:     string;
    };

    const pnl        = Number(t.pnl);
    const entryPrice = Number(t.entry_price);
    const size       = Number(t.size);
    const slippage   = Number(t.slippage ?? 0);
    const closeComm  = t.commission !== null && t.commission !== undefined
      ? Number(t.commission)
      : entryPrice * size * COMMISSION_RATE;
    const openComm   = t.outcome === "TP1" ? closeComm * 2 : closeComm;

    totalPnl       += pnl;
    totalCloseComm += closeComm;
    estOpenComm    += openComm;
    totalSlippage  += slippage;
  }

  const newBalance      = Math.max(initialBalance + totalPnl - estOpenComm, 0);
  const totalCommission = totalCloseComm + estOpenComm;

  // Step 5 — Update paper_accounts using only simple scalars (no inline arithmetic in SQL)
  const newBalanceRounded  = Math.round(newBalance      * 100) / 100;
  const peakBalance        = Math.max(newBalanceRounded, initialBalance);
  const totalCommRounded   = Math.round(totalCommission * 100) / 100;
  const totalSlippageRound = Math.round(totalSlippage   * 100) / 100;

  await pool.query(
    `INSERT INTO paper_accounts
       (chat_id, balance, initial_balance, peak_balance, total_commission, total_slippage)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chat_id) DO UPDATE SET
       balance          = $2,
       peak_balance     = $4,
       total_commission = $5,
       total_slippage   = $6`,
    [chatId, newBalanceRounded, initialBalance, peakBalance, totalCommRounded, totalSlippageRound]
  );

  // Step 6 — Reset strategy performance tables (trained on phantom trades)
  await pool.query("DELETE FROM strategy_stats         WHERE 1=1");
  await pool.query("DELETE FROM strategy_regime_stats  WHERE 1=1");
  await pool.query("DELETE FROM strategy_loss_reasons  WHERE 1=1");

  // Step 7 — Reset strategy weights to neutral
  await pool.query(
    `UPDATE strategy_weights SET
       weight                 = 1.0,
       disabled               = false,
       disabled_until         = NULL,
       quarantine             = false,
       trust_score            = 50,
       cycles_below_threshold = 0,
       updated_at             = NOW()`
  );

  // Step 8 — Reset time/instrument analytics and stale learning data
  await pool.query("DELETE FROM time_analytics        WHERE 1=1");
  await pool.query("DELETE FROM instrument_analytics  WHERE 1=1");
  await pool.query("DELETE FROM strategy_versions     WHERE 1=1");
  await pool.query("DELETE FROM learning_reports      WHERE 1=1");

  logger.info(
    { chatId, dupesRemoved, tradesKept, oldBalance, newBalance: newBalanceRounded },
    "Data cleanup complete"
  );

  return { dupesRemoved, tradesKept, oldBalance, newBalance: newBalanceRounded, initialBalance };
}
