import app from "./app.js";
  import { logger } from "./lib/logger.js";
  import { startBot } from "./bot/index.js";
  import { setupGeminiProvider } from "./bot/gemini-provider.js";
  import { initDb } from "./lib/db.js";
  import { syncPositionsCount } from "./bot/risk-manager.js";

  // ── Month-long unattended operation: a single uncaught error/rejection in any
  // of the many cron jobs, WS handlers, or Telegram callbacks must NEVER take
  // down the whole process — otherwise training-data collection just stops
  // until someone notices and manually restarts on Railway. Log and keep running.
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaughtException — bot continues running");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandledRejection — bot continues running");
  });

  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  initDb()
    .then(() => syncPositionsCount())  // Resync counter with actual DB positions on every start
    .then(() => {
      app.listen(port, (err?: Error) => {
        if (err) {
          logger.error({ err }, "Error listening on port");
          process.exit(1);
        }
        logger.info({ port }, "Server listening");
      });

      setupGeminiProvider().then((ok) => {
        if (ok) logger.info("Gemini AI analysis enabled");
        else logger.warn("Gemini AI analysis disabled — check GEMINI_API_KEY");
      });

      startBot();
    })
    .catch((err: unknown) => {
      logger.error({ err }, "Failed to initialize database — shutting down");
      process.exit(1);
    });
  