import assert from "node:assert/strict";
import test from "node:test";
import { LocalFuturesMock } from "../local-futures-mock.ts";

const input = {
  internalSignalId: "signal-1",
  chatId: 1,
  symbol: "BTCUSDT",
  direction: "LONG" as const,
  entryPrice: 100,
  stopLoss: 95,
  tp1: 105,
  tp2: 110,
  riskPercent: 1,
  accountBalance: 10_000,
  multiplier: 0.001,
  lotSize: 1,
};

test("fills entry and creates stop/take-profit protection orders", () => {
  const mock = new LocalFuturesMock();
  const result = mock.open(input);

  assert.equal(result.success, true);
  assert.equal(result.status, "filled");
  assert.equal(mock.listOrders(result.clientOid).length, 4);
  assert.equal(mock.getPosition(result.clientOid)?.size, 20_000);
});

test("is idempotent for the same internal signal", () => {
  const mock = new LocalFuturesMock();
  const first = mock.open(input);
  const second = mock.open(input);

  assert.equal(second.status, "already_filled");
  assert.equal(second.orderId, first.orderId);
  assert.equal(mock.listOrders(first.clientOid).length, 4);
});

test("partial TP1 reduces size and keeps the remaining protection", () => {
  const mock = new LocalFuturesMock();
  const opened = mock.open(input);
  const afterTp1 = mock.trigger(opened.clientOid, "tp1");

  assert.equal(afterTp1?.size, 10_000);
  assert.equal(
    mock.listOrders(opened.clientOid).filter((order) => order.status === "submitted").length,
    2,
  );
});

test("TP2 closes the remaining position and cancels the stop", () => {
  const mock = new LocalFuturesMock();
  const opened = mock.open(input);
  mock.trigger(opened.clientOid, "tp1");
  assert.equal(mock.trigger(opened.clientOid, "tp2"), null);
  assert.equal(mock.getPosition(opened.clientOid), null);
  assert.equal(
    mock.listOrders(opened.clientOid).filter((order) => order.status === "cancelled").length,
    1,
  );
});

test("stop loss closes the position and cancels both take-profits", () => {
  const mock = new LocalFuturesMock();
  const opened = mock.open(input);
  assert.equal(mock.trigger(opened.clientOid, "stop_loss"), null);
  assert.equal(mock.getPosition(opened.clientOid), null);
  assert.equal(
    mock.listOrders(opened.clientOid).filter((order) => order.status === "cancelled").length,
    2,
  );
});