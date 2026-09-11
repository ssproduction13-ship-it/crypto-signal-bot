import assert from "node:assert/strict";
import test from "node:test";
import { calculateSandboxContractSize } from "../sandbox-sizing.ts";

test("calculates linear futures contract size from risk and multiplier", () => {
  assert.equal(
    calculateSandboxContractSize({
      accountBalance: 10_000,
      riskPercent: 1,
      entryPrice: 100,
      stopLoss: 95,
      multiplier: 0.001,
      lotSize: 1,
    }),
    20_000,
  );
});

test("rounds contract size down to the exchange lot size", () => {
  assert.equal(
    calculateSandboxContractSize({
      accountBalance: 1_000,
      riskPercent: 1,
      entryPrice: 100,
      stopLoss: 99,
      multiplier: 0.1,
      lotSize: 10,
    }),
    100,
  );
});

test("caps contract size at the exchange max order quantity", () => {
  assert.equal(
    calculateSandboxContractSize({
      accountBalance: 10_000,
      riskPercent: 1,
      entryPrice: 100,
      stopLoss: 99,
      multiplier: 0.001,
      lotSize: 1,
      maxOrderQty: 500,
    }),
    500,
  );
});

test("returns zero for invalid risk geometry", () => {
  assert.equal(
    calculateSandboxContractSize({
      accountBalance: 10_000,
      riskPercent: 1,
      entryPrice: 100,
      stopLoss: 100,
      multiplier: 0.001,
      lotSize: 1,
    }),
    0,
  );
});