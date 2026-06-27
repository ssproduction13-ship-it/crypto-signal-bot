import app from "./app.js";
  import { logger } from "./lib/logger.js";
  import { startBot } from "./bot/index.js";
  import { setupGeminiProvider } from "./bot/gemini-provider.js";
  import { initDb } from "./lib/db.js";
  import { syncPositionsCount } from "./bot/risk-manager.js";

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
  