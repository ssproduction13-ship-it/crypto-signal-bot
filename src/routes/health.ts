import { Router, type IRouter } from "express";
import { pool } from "../lib/db.js";

  const router: IRouter = Router();

  // BUG-09/BUG-10: expose pool stats so external monitors (UptimeRobot, Railway healthcheck,
  // custom Telegram pinger) can detect DB saturation without SSH access.
  // Fields:
  //   total    — active + idle connections (≤ max)
  //   idle     — available immediately
  //   waiting  — requests queued because all connections are busy; should be 0 in normal ops
  router.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      db: {
        total:   pool.totalCount,
        idle:    pool.idleCount,
        waiting: pool.waitingCount,
      },
    });
  });

  export default router;
  