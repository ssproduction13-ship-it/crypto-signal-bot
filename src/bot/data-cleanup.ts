import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { saveStatsSnapshot } from "./stats-snapshot.js";

const COMMISSION_RATE = 0.001;

export interface CleanupResult {
  dupesRemoved: number;
  tradesKept: number;
  oldBalance: number;
  newBalance: number;
  initialBalance: number;
  statsRebuilt: number; // rows inserted back into strategy_stats
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
  const oldBalance     = accRows.length ? Number((accRows[0] as Record<string,unknown>)["balance"])         : 0;
  const initialBalance = accRows.length ? Number((accRows[0] as Record<string,unknown>)["initial_balance"]) : 10000;

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

  // Step 5 — Update paper_accounts using only simple scalars
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

  // Step 5.5 — Save pre-cleanup snapshot so analytics can always be restored
  try {
    await saveStatsSnapshot("pre-cleanup");
  } catch (snapErr) {
    logger.warn({ snapErr }, "Pre-cleanup snapshot failed — continuing without it");
  }

  // Step 6 — Clear strategy performance tables (had phantom-inflated data)
  await pool.query("DELETE FROM strategy_stats         WHERE 1=1");
  await pool.query("DELETE FROM strategy_regime_stats  WHERE 1=1");
  await pool.query("DELETE FROM strategy_loss_reasons  WHERE 1=1");

  // Step 7 — Reset strategy weights to neutral (remove quarantine, re-enable all)
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

  // Step 8 — Clear time/instrument analytics and stale snapshots
  await pool.query("DELETE FROM time_analytics        WHERE 1=1");
  await pool.query("DELETE FROM instrument_analytics  WHERE 1=1");
  await pool.query("DELETE FROM strategy_versions     WHERE 1=1");
  await pool.query("DELETE FROM learning_reports      WHERE 1=1");

  // Step 9 — Rebuild strategy_stats from the now-clean paper_closed_trades.
  // Without this the learning engine shows 0 trades and can't evaluate strategies.
  // We aggregate: trades, wins, win_pnl (sum of positive pnl), loss_pnl (abs sum of
  // negative pnl), total_pnl — exactly the shape the learning engine expects.
  const rebuildResult = await pool.query(
    `INSERT INTO strategy_stats (strategy, trades, wins, win_pnl, loss_pnl, total_pnl)
     SELECT
       strategy,
       COUNT(*)::int                                          AS trades,
       COUNT(*) FILTER (WHERE pnl > 0)::int                  AS wins,
       COALESCE(SUM(pnl) FILTER (WHERE pnl > 0),  0)::numeric AS win_pnl,
       COALESCE(ABS(SUM(pnl) FILTER (WHERE pnl < 0)), 0)::numeric AS loss_pnl,
       COALESCE(SUM(pnl), 0)::numeric                         AS total_pnl
     FROM paper_closed_trades
     WHERE strategy IS NOT NULL
     GROUP BY strategy
     ON CONFLICT (strategy) DO UPDATE SET
       trades    = EXCLUDED.trades,
       wins      = EXCLUDED.wins,
       win_pnl   = EXCLUDED.win_pnl,
       loss_pnl  = EXCLUDED.loss_pnl,
       total_pnl = EXCLUDED.total_pnl`
  );
  const statsRebuilt = rebuildResult.rowCount ?? 0;

  logger.info(
    { chatId, dupesRemoved, tradesKept, oldBalance, newBalance: newBalanceRounded, statsRebuilt },
    "Data cleanup + stats rebuild complete"
  );

  return { dupesRemoved, tradesKept, oldBalance, newBalance: newBalanceRounded, initialBalance, statsRebuilt };
}
