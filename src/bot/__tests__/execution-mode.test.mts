import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXECUTION_MODE,
  parseExecutionMode,
} from "../../lib/execution-mode.ts";

test("execution mode defaults to simulated", () => {
  assert.equal(parseExecutionMode(undefined), DEFAULT_EXECUTION_MODE);
  assert.equal(parseExecutionMode(""), "simulated");
});

test("accepts the two supported execution modes", () => {
  assert.equal(parseExecutionMode("simulated"), "simulated");
  assert.equal(parseExecutionMode(" SANDBOX "), "sandbox");
});

test("rejects unknown execution modes", () => {
  assert.throws(
    () => parseExecutionMode("live"),
    /Expected "simulated" or "sandbox"/,
  );
});