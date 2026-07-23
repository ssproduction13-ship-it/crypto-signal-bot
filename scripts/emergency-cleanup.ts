/**
 * emergency-cleanup.ts
 *
 * Экстренная очистка БД — запускать вручную когда база переполнена.
 * Удаляет старые/лишние записи из самых тяжёлых таблиц.
 *
 * Запуск:
 *   DATABASE_URL=... node --loader ts-node/esm scripts/emergency-cleanup.ts
 *
 * Или через ts-node:
 *   DATABASE_URL=... npx ts-node --esm scripts/emergency-cleanup.ts
 */

import pg from "pg";
const { Pool } = pg;

if (!process.env["DATABASE_URL"]) {
  console.error("❌ DATABASE_URL not set");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 20000,
});

async function run(): Promise<void> {
  console.log("🔌 Connecting to database…");
  const client = await pool.connect();

  try {
    // ── 0. Show DB size before ─────────────────────────────────────────────
    const { rows: sizeBefore } = await client.query(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"
    );
    console.log("📦 DB size before:", (sizeBefore[0] as { size: string }).size);

    // ── 1. decision_log — keep last 3000 rows ─────────────────────────────
    const { rowCount: dlDel } = await client.query(
      `DELETE FROM decision_log
       WHERE id NOT IN (
         SELECT id FROM decision_log ORDER BY id DESC LIMIT 3000
       )`
    );
    console.log(`🗑  decision_log: deleted ${dlDel ?? 0} old rows`);

    // ── 2. stats_snapshots — keep last 20 rows ────────────────────────────
    const { rowCount: ssDel } = await client.query(
      `DELETE FROM stats_snapshots
       WHERE id NOT IN (
         SELECT id FROM stats_snapshots ORDER BY id DESC LIMIT 20
       )`
    );
    console.log(`🗑  stats_snapshots: deleted ${ssDel ?? 0} old rows`);

    // ── 3. trade_features — keep last 8000 rows ───────────────────────────
    const { rowCount: tfDel } = await client.query(
      `DELETE FROM trade_features
       WHERE position_id NOT IN (
         SELECT position_id FROM trade_features ORDER BY saved_at DESC LIMIT 8000
       )`
    );
    console.log(`🗑  trade_features: deleted ${tfDel ?? 0} old rows`);

    // ── 4. similar_trades — keep last 5000 rows ───────────────────────────
    const { rowCount: stDel } = await client.query(
      `DELETE FROM similar_trades
       WHERE id NOT IN (
         SELECT id FROM similar_trades ORDER BY id DESC LIMIT 5000
       )`
    ).catch(() => ({ rowCount: 0 }));
    console.log(`🗑  similar_trades: deleted ${stDel ?? 0} old rows`);

    // ── 5. shadow_closed_trades — keep last 5000 rows ─────────────────────
    const { rowCount: sctDel } = await client.query(
      `DELETE FROM shadow_closed_trades
       WHERE id NOT IN (
         SELECT id FROM shadow_closed_trades ORDER BY id DESC LIMIT 5000
       )`
    ).catch(() => ({ rowCount: 0 }));
    console.log(`🗑  shadow_closed_trades: deleted ${sctDel ?? 0} old rows`);

    // ── 6. missed_trades — keep last 2000 rows ────────────────────────────
    const { rowCount: mtDel } = await client.query(
      `DELETE FROM missed_trades
       WHERE id NOT IN (
         SELECT id FROM missed_trades ORDER BY timestamp DESC LIMIT 2000
       )`
    ).catch(() => ({ rowCount: 0 }));
    console.log(`🗑  missed_trades: deleted ${mtDel ?? 0} old rows`);

    // ── 7. journal_entries — keep last 5000 rows ──────────────────────────
    const { rowCount: jeDel } = await client.query(
      `DELETE FROM journal_entries
       WHERE id NOT IN (
         SELECT id FROM journal_entries ORDER BY timestamp DESC LIMIT 5000
       )`
    ).catch(() => ({ rowCount: 0 }));
    console.log(`🗑  journal_entries: deleted ${jeDel ?? 0} old rows`);

    // ── 8. VACUUM to release disk space back to OS ────────────────────────
    console.log("🧹 Running VACUUM…");
    // Note: VACUUM cannot run inside a transaction, use pool directly
    client.release();
    await pool.query("VACUUM decision_log, stats_snapshots, trade_features").catch(e =>
      console.warn("⚠️  VACUUM partial error (non-fatal):", (e as Error).message)
    );

    // ── 9. Show DB size after ──────────────────────────────────────────────
    const { rows: sizeAfter } = await pool.query(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"
    );
    console.log("📦 DB size after: ", (sizeAfter[0] as { size: string }).size);
    console.log("✅ Emergency cleanup complete!");

  } catch (err) {
    client.release();
    console.error("❌ Cleanup error:", err);
    throw err;
  } finally {
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
