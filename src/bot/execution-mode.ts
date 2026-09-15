import { pool } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export type ExecutionMode = "paper" | "emulator";

let cachedMode: ExecutionMode | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function normalizeMode(value: unknown): ExecutionMode {
  return value === "emulator" ? "emulator" : "paper";
}

export async function getCurrentExecutionMode(): Promise<ExecutionMode> {
  if (cachedMode && Date.now() - cachedAt < CACHE_TTL_MS) return cachedMode;

  try {
    const { rows } = await pool.query(
      "SELECT mode FROM trading_mode_override ORDER BY id DESC LIMIT 1",
    );
    const storedMode = rows[0]?.["mode"];
    const mode = storedMode ?? process.env["EXECUTION_MODE"] ?? "paper";
    cachedMode = normalizeMode(mode);
    cachedAt = Date.now();
    return cachedMode;
  } catch (err) {
    // A database failure must never turn paper trading into emulator execution.
    cachedMode = "paper";
    cachedAt = Date.now();
    logger.error({ err }, "getCurrentExecutionMode failed — falling back to paper (fail-closed)");
    return "paper";
  }
}

export async function setExecutionMode(mode: ExecutionMode, adminChatId: number): Promise<void> {
  await pool.query(
    "INSERT INTO trading_mode_override (mode, updated_by) VALUES ($1, $2)",
    [mode, adminChatId],
  );
  cachedMode = mode;
  cachedAt = Date.now();
  logger.warn({ mode, adminChatId }, "Execution mode changed via /set_mode");
}