import { logger } from "../lib/logger.js";
import { getSandboxPositions } from "./kucoin-futures-client.js";
import { loadLocalSandboxPositions } from "./sandbox-position-storage.js";
import {
  assertSandboxPositionsReconciled,
  reconcileSandboxPositions,
} from "./sandbox-reconciliation.js";

export async function reconcileSandboxStartup(): Promise<void> {
  const [exchangePositions, localPositions] = await Promise.all([
    getSandboxPositions(),
    loadLocalSandboxPositions(),
  ]);
  const result = reconcileSandboxPositions(exchangePositions, localPositions);
  if (!result.ok) {
    logger.error({ discrepancies: result.discrepancies }, "Sandbox startup reconciliation failed");
    assertSandboxPositionsReconciled(result);
  }
  logger.info(
    { exchangePositions: exchangePositions.length, localPositions: localPositions.length },
    "Sandbox startup reconciliation passed",
  );
}