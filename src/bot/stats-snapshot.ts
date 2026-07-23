/**
 * stats-snapshot.ts
 *
 * Periodic JSON snapshots of all analytics tables.
 * Snapshots are saved to `stats_snapshots` in PostgreSQL.
 * Auto-pruned to keep only the last MAX_SNAPSHOTS rows.
 *
 * API:
 *   saveStatsSnapshot(type)       — write a new snapshot row (auto-prunes old)
 *   restoreFromSnapshot(id?)      — upsert analytics tables from latest (or id) snapshot
 *   listSnapshots(limit?)         — return metadata for recent snapshots
 */

import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of snapshots to keep — oldest are deleted automatically. */
const MAX_SNAPSHOTS = 30;

export type SnapshotType = "daily" | "pre-cleanup" | "manual";

export interface SnapshotMeta {
  id: number;
  created_at: string;
  type: SnapshotType;
  instrument_count: number;
  time_rows: number;
  strategy_rows: number;
  direction_rows: number;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read all four analytics tables and persist them as a single JSONB row.
 * Automatically deletes oldest snapshots if count exceeds MAX_SNAPSHOTS.
 * Returns the new snapshot id.
 */
export async function saveStatsSnapshot(type: SnapshotType = "manual"): Promise<number> {
  const [ia, ta, ss, sds] = await Promise.all([
    pool.query("SELECT * FROM instrument_analytics"),
    pool.query("SELECT * FROM time_analytics"),
    pool.query("SELECT * FROM strategy_stats"),
    pool.query("SELECT * FROM strategy_direction_stats"),
  ]);

  const data = {
    instrument_analytics:      ia.rows,
    time_analytics:            ta.rows,
    strategy_stats:            ss.rows,
    strategy_direction_stats:  sds.rows,
    saved_at: new Date().toISOString(),
  };

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO stats_snapshots
       (type, instrument_count, time_rows, strategy_rows, direction_rows, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      type,
      ia.rows.length,
      ta.rows.length,
      ss.rows.length,
      sds.rows.length,
      JSON.stringify(data),
    ]
  );

  const id = rows[0]!.id;
  logger.info(
    { id, type, instruments: ia.rows.length, timeRows: ta.rows.length },
    "Stats snapshot saved"
  );

  // Auto-prune: keep only the last MAX_SNAPSHOTS rows
  try {
    const pruneResult = await pool.query(
      `DELETE FROM stats_snapshots
       WHERE id NOT IN (
         SELECT id FROM stats_snapshots ORDER BY id DESC LIMIT $1
       )`,
      [MAX_SNAPSHOTS]
    );
    if ((pruneResult.rowCount ?? 0) > 0) {
      logger.info({ deleted: pruneResult.rowCount, kept: MAX_SNAPSHOTS }, "stats_snapshots auto-pruned");
    }
  } catch (pruneErr) {
    logger.warn({ pruneErr }, "stats_snapshots auto-prune failed — snapshot saved but old rows not deleted");
  }

  return id;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restore analytics tables from a snapshot.
 * If `snapshotId` is omitted, the most recent snapshot is used.
 * Each table is restored via UPSERT so existing live data is overwritten
 * only for rows that existed in the snapshot — nothing else is touched.
 */
export async function restoreFromSnapshot(snapshotId?: number): Promise<SnapshotMeta> {
  // Resolve which snapshot to use
  const { rows: metaRows } = await pool.query<{ id: number; data: Record<string, unknown>; created_at: string; type: string }>(
    snapshotId
      ? "SELECT id, data, created_at, type FROM stats_snapshots WHERE id = $1"
      : "SELECT id, data, created_at, type FROM stats_snapshots ORDER BY id DESC LIMIT 1",
    snapshotId ? [snapshotId] : []
  );

  if (!metaRows.length) throw new Error("No snapshots found in stats_snapshots");

  const snap = metaRows[0]!;
  const d = snap.data as {
    instrument_analytics:     Record<string, unknown>[];
    time_analytics:           Record<string, unknown>[];
    strategy_stats:           Record<string, unknown>[];
    strategy_direction_stats: Record<string, unknown>[];
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── instrument_analytics ────────────────────────────────────────────────
    for (const row of d.instrument_analytics) {
      await client.query(
        `INSERT INTO instrument_analytics
           (symbol, trades, wins, win_pnl, loss_pnl, total_pnl, priority_weight, best_strategy, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (symbol) DO UPDATE SET
           trades          = EXCLUDED.trades,
           wins            = EXCLUDED.wins,
           win_pnl         = EXCLUDED.win_pnl,
           loss_pnl        = EXCLUDED.loss_pnl,
           total_pnl       = EXCLUDED.total_pnl,
           priority_weight = EXCLUDED.priority_weight,
           best_strategy   = EXCLUDED.best_strategy,
           updated_at      = EXCLUDED.updated_at`,
        [
          row["symbol"], row["trades"], row["wins"],
          row["win_pnl"], row["loss_pnl"], row["total_pnl"],
          row["priority_weight"], row["best_strategy"], row["updated_at"],
        ]
      );
    }

    // ── time_analytics ──────────────────────────────────────────────────────
    for (const row of d.time_analytics) {
      await client.query(
        `INSERT INTO time_analytics
           (hour_utc, trades, wins, win_pnl, loss_pnl, total_pnl)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (hour_utc) DO UPDATE SET
           trades    = EXCLUDED.trades,
           wins      = EXCLUDED.wins,
           win_pnl   = EXCLUDED.win_pnl,
           loss_pnl  = EXCLUDED.loss_pnl,
           total_pnl = EXCLUDED.total_pnl`,
        [
          row["hour_utc"], row["trades"], row["wins"],
          row["win_pnl"], row["loss_pnl"], row["total_pnl"],
        ]
      );
    }

    // ── strategy_stats ──────────────────────────────────────────────────────
    for (const row of d.strategy_stats) {
      await client.query(
        `INSERT INTO strategy_stats
           (strategy, trades, wins, win_pnl, loss_pnl, total_pnl)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (strategy) DO UPDATE SET
           trades    = EXCLUDED.trades,
           wins      = EXCLUDED.wins,
           win_pnl   = EXCLUDED.win_pnl,
           loss_pnl  = EXCLUDED.loss_pnl,
           total_pnl = EXCLUDED.total_pnl`,
        [
          row["strategy"], row["trades"], row["wins"],
          row["win_pnl"], row["loss_pnl"], row["total_pnl"],
        ]
      );
    }

    // ── strategy_direction_stats ────────────────────────────────────────────
    for (const row of d.strategy_direction_stats) {
      await client.query(
        `INSERT INTO strategy_direction_stats
           (strategy, direction, trades, wins, win_pnl, loss_pnl, total_pnl)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (strategy, direction) DO UPDATE SET
           trades    = EXCLUDED.trades,
           wins      = EXCLUDED.wins,
           win_pnl   = EXCLUDED.win_pnl,
           loss_pnl  = EXCLUDED.loss_pnl,
           total_pnl = EXCLUDED.total_pnl`,
        [
          row["strategy"], row["direction"], row["trades"],
          row["wins"], row["win_pnl"], row["loss_pnl"], row["total_pnl"],
        ]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const meta: SnapshotMeta = {
    id:               snap.id,
    created_at:       snap.created_at as string,
    type:             snap.type as SnapshotType,
    instrument_count: d.instrument_analytics.length,
    time_rows:        d.time_analytics.length,
    strategy_rows:    d.strategy_stats.length,
    direction_rows:   d.strategy_direction_stats.length,
  };

  logger.info(meta, "Stats snapshot restored");
  return meta;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Return metadata for recent snapshots (newest first). */
export async function listSnapshots(limit = 10): Promise<SnapshotMeta[]> {
  const { rows } = await pool.query<SnapshotMeta>(
    `SELECT id, created_at, type, instrument_count, time_rows, strategy_rows, direction_rows
     FROM stats_snapshots
     ORDER BY id DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}
