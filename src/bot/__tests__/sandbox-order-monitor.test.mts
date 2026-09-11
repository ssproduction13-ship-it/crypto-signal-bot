import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSandboxOrderUpdate } from "../sandbox-order-status.ts";

test("normalizes an open order as submitted", () => {
  assert.deepEqual(
    normalizeSandboxOrderUpdate({
      id: "order-1",
      clientOid: "client-1",
      status: "open",
      isActive: true,
      dealSize: 0,
    }),
    {
      clientOid: "client-1",
      orderId: "order-1",
      status: "submitted",
      raw: {
        id: "order-1",
        clientOid: "client-1",
        status: "open",
        isActive: true,
        dealSize: 0,
      },
    },
  );
});

test("normalizes a done order with fills as filled", () => {
  assert.equal(
    normalizeSandboxOrderUpdate({
      orderId: "order-1",
      clientOid: "client-1",
      status: "done",
      dealSize: 2,
    }).status,
    "filled",
  );
});

test("normalizes cancelled orders before checking fill state", () => {
  assert.equal(
    normalizeSandboxOrderUpdate({
      orderId: "order-1",
      clientOid: "client-1",
      status: "done",
      cancelExist: true,
      dealSize: 0,
    }).status,
    "cancelled",
  );
});