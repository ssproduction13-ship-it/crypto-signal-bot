import assert from "node:assert/strict";
import test from "node:test";
import { buildSandboxClientOid } from "../../lib/sandbox-order-identity.ts";

test("builds a deterministic 32-character clientOid", () => {
  const first = buildSandboxClientOid("signal-123");
  const second = buildSandboxClientOid("signal-123");

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{32}$/);
});

test("different internal signal IDs do not share a clientOid", () => {
  assert.notEqual(
    buildSandboxClientOid("signal-123"),
    buildSandboxClientOid("signal-124"),
  );
});

test("rejects an empty internal signal ID", () => {
  assert.throws(() => buildSandboxClientOid("   "), /must not be empty/);
});