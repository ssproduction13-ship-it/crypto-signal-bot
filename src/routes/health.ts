import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

  const router: IRouter = Router();

  function poolStats() {
    return {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
  }

  router.get("/livez", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  async function readinessHandler(_req: Request, res: Response) {
    try {
      await pool.query("SELECT 1");
      res.status(200).json({
        status: "ok",
        db: poolStats(),
      });
    } catch (err) {
      logger.error({ err }, "Readiness check failed");
      res.status(503).json({
        status: "unavailable",
        db: poolStats(),
      });
    }
  }

  // /healthz remains an alias for existing monitors; Railway should use /readyz.
  router.get("/readyz", readinessHandler);
  router.get("/healthz", readinessHandler);

  export default router;
  