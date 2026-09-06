import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const aggregateSql = `
  SELECT
    strategy,
    direction,
    COUNT(*)::int AS trades,
    COUNT(*) FILTER (
      WHERE COALESCE(pnl_equity_pct, pnl_percent) > 0
    )::int AS wins,
    COALESCE(SUM(CASE
      WHEN COALESCE(pnl_equity_pct, pnl_percent) > 0
      THEN COALESCE(pnl_equity_pct, pnl_percent)
      ELSE 0
    END), 0) AS win_pnl,
    COALESCE(SUM(CASE
      WHEN COALESCE(pnl_equity_pct, pnl_percent) <= 0
      THEN ABS(COALESCE(pnl_equity_pct, pnl_percent))
      ELSE 0
    END), 0) AS loss_pnl,
    COALESCE(SUM(COALESCE(pnl_equity_pct, pnl_percent)), 0) AS total_pnl
  FROM paper_closed_trades
  WHERE direction IN ('LONG', 'SHORT')
  GROUP BY strategy, direction
  ORDER BY strategy, direction
`;

const client = await pool.connect();

try {
  await client.query("BEGIN");
  // Freeze both the source and the denormalized target while rebuilding them.
  // This prevents a concurrent position close from being overwritten between
  // the aggregate read and the target update.
  await client.query(`
    LOCK TABLE paper_closed_trades IN SHARE MODE,
               strategy_direction_stats IN ACCESS EXCLUSIVE MODE
  `);

  const [{ rows: actualRows }, { rows: storedRows }] = await Promise.all([
    client.query(aggregateSql),
    client.query(`
      SELECT strategy, direction, trades, wins, win_pnl, loss_pnl, total_pnl
      FROM strategy_direction_stats
      ORDER BY strategy, direction
    `),
  ]);

  const actual = new Map(actualRows.map((row) => [
    `${row.strategy}:${row.direction}`,
    row,
  ]));
  const stored = new Map(storedRows.map((row) => [
    `${row.strategy}:${row.direction}`,
    row,
  ]));
  const keys = new Set([...actual.keys(), ...stored.keys()]);
  const mismatches = [];

  for (const key of [...keys].sort()) {
    const [strategy, direction] = key.split(":");
    const expected = actual.get(key);
    const current = stored.get(key);
    const fields = ["trades", "wins", "win_pnl", "loss_pnl", "total_pnl"];
    const differs = !expected || !current || fields.some((field) =>
      Number(expected?.[field] ?? 0) !== Number(current?.[field] ?? 0)
    );
    if (differs) {
      mismatches.push({
        strategy,
        direction,
        storedTrades: Number(current?.trades ?? 0),
        actualTrades: Number(expected?.trades ?? 0),
      });
    }
  }

  await client.query(`
    UPDATE strategy_direction_stats
       SET trades = 0,
           wins = 0,
           win_pnl = 0,
           loss_pnl = 0,
           total_pnl = 0,
           updated_at = NOW()
  `);

  for (const row of actualRows) {
    await client.query(
      `INSERT INTO strategy_direction_stats
         (strategy, direction, trades, wins, win_pnl, loss_pnl, total_pnl, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (strategy, direction) DO UPDATE SET
         trades = EXCLUDED.trades,
         wins = EXCLUDED.wins,
         win_pnl = EXCLUDED.win_pnl,
         loss_pnl = EXCLUDED.loss_pnl,
         total_pnl = EXCLUDED.total_pnl,
         updated_at = NOW()`,
      [
        row.strategy,
        row.direction,
        row.trades,
        row.wins,
        row.win_pnl,
        row.loss_pnl,
        row.total_pnl,
      ],
    );
  }
  await client.query("COMMIT");

  console.log(JSON.stringify({
    source: "paper_closed_trades",
    combinations: actualRows.length,
    mismatchesBeforeReconcile: mismatches,
    reconciled: true,
  }, null, 2));
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Direction stats reconciliation failed:", err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}