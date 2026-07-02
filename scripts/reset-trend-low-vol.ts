import { pool } from "../src/lib/db.js";

  async function run(): Promise<void> {
    const res = await pool.query(
      "DELETE FROM strategy_regime_stats WHERE strategy = 'TREND' AND regime = 'low_vol'"
    );
    console.log(`Deleted ${res.rowCount} row(s) from strategy_regime_stats (TREND/low_vol).`);
    await pool.end();
  }

  run().catch(err => { console.error(err); process.exit(1); });
  