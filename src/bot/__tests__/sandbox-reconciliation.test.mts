import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSandboxPositionsReconciled,
  reconcileSandboxPositions,
} from "../sandbox-reconciliation.ts";

const local = {
  id: "position-1",
  chatId: 1,
  symbol: "BTCUSDT",
  futuresSymbol: "XBTUSDTM",
  direction: "LONG" as const,
  size: 3,
  entryPrice: 90_000,
  stopLoss: 89_000,
  tp1: 92_000,
  tp2: 95_000,
  orderId: "order-1",
  updatedAt: new Date(0).toISOString(),
};

test("accepts matching exchange and local positions", () => {
  const result = reconcileSandboxPositions(
    [{ symbol: "XBTUSDTM", currentQty: 3, side: "long" }],
    [local],
  );
  assert.deepEqual(result, { ok: true, discrepancies: [] });
  assert.doesNotThrow(() => assertSandboxPositionsReconciled(result));
});

test("blocks when an exchange position has no local mirror", () => {
  const result = reconcileSandboxPositions(
    [{ symbol: "XBTUSDTM", currentQty: 3, side: "long" }],
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(result.discrepancies[0]?.reason, "missing_local");
  assert.throws(
    () => assertSandboxPositionsReconciled(result),
    /Sandbox position reconciliation failed/,
  );
});

test("blocks when the local size differs from the exchange", () => {
  const result = reconcileSandboxPositions(
    [{ symbol: "XBTUSDTM", currentQty: 4, side: "long" }],
    [local],
  );
  assert.equal(result.ok, false);
  assert.equal(result.discrepancies[0]?.reason, "size_mismatch");
  assert.equal(result.discrepancies[0]?.localSize, 3);
  assert.equal(result.discrepancies[0]?.exchangeSize, 4);
});

test("ignores flat exchange positions", () => {
  const result = reconcileSandboxPositions(
    [{ symbol: "XBTUSDTM", currentQty: 0, side: "long" }],
    [],
  );
  assert.deepEqual(result, { ok: true, discrepancies: [] });
});