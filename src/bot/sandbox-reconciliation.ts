import type { KucoinPosition } from "./kucoin-futures-client.js";
import type { LocalSandboxPosition } from "./sandbox-position-storage.js";

export interface PositionDiscrepancy {
  key: string;
  reason: "missing_local" | "missing_exchange" | "size_mismatch";
  localSize: number;
  exchangeSize: number;
}

export interface SandboxReconciliationResult {
  ok: boolean;
  discrepancies: PositionDiscrepancy[];
}

const POSITION_EPSILON = 1e-8;

function positionKey(position: {
  futuresSymbol: string;
  direction: "LONG" | "SHORT";
}): string {
  return `${position.futuresSymbol.toUpperCase()}:${position.direction}`;
}

function normalizeExchangePosition(
  position: KucoinPosition,
): { futuresSymbol: string; direction: "LONG" | "SHORT"; size: number } | null {
  const rawQty = Number(position.currentQty);
  if (!Number.isFinite(rawQty) || Math.abs(rawQty) <= POSITION_EPSILON) return null;

  const direction: "LONG" | "SHORT" =
    position.side === "short" || rawQty < 0 ? "SHORT" : "LONG";

  return {
    futuresSymbol: position.symbol,
    direction,
    size: Math.abs(rawQty),
  };
}

export function reconcileSandboxPositions(
  exchangePositions: readonly KucoinPosition[],
  localPositions: readonly LocalSandboxPosition[],
): SandboxReconciliationResult {
  const exchange = new Map<string, { size: number }>();
  for (const rawPosition of exchangePositions) {
    const position = normalizeExchangePosition(rawPosition);
    if (!position) continue;
    const key = positionKey(position);
    const existing = exchange.get(key);
    exchange.set(key, { size: (existing?.size ?? 0) + position.size });
  }

  const local = new Map<string, { size: number }>();
  for (const position of localPositions) {
    if (!Number.isFinite(position.size) || position.size <= POSITION_EPSILON) continue;
    const key = positionKey(position);
    const existing = local.get(key);
    local.set(key, { size: (existing?.size ?? 0) + position.size });
  }

  const discrepancies: PositionDiscrepancy[] = [];
  const keys = new Set([...exchange.keys(), ...local.keys()]);
  for (const key of keys) {
    const exchangeSize = exchange.get(key)?.size ?? 0;
    const localSize = local.get(key)?.size ?? 0;
    if (!exchangeSize && localSize) {
      discrepancies.push({ key, reason: "missing_exchange", localSize, exchangeSize });
    } else if (exchangeSize && !localSize) {
      discrepancies.push({ key, reason: "missing_local", localSize, exchangeSize });
    } else if (Math.abs(exchangeSize - localSize) > POSITION_EPSILON) {
      discrepancies.push({ key, reason: "size_mismatch", localSize, exchangeSize });
    }
  }

  return { ok: discrepancies.length === 0, discrepancies };
}

export function assertSandboxPositionsReconciled(
  result: SandboxReconciliationResult,
): void {
  if (result.ok) return;
  const details = result.discrepancies
    .map(
      (item) =>
        `${item.key} ${item.reason} local=${item.localSize} exchange=${item.exchangeSize}`,
    )
    .join("; ");
  throw new Error(`Sandbox position reconciliation failed: ${details}`);
}