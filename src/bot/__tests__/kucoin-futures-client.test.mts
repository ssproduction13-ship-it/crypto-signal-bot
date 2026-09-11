import assert from "node:assert/strict";
import test from "node:test";
import { getKucoinSandboxConfig } from "../kucoin-futures-client.ts";

const validEnv = {
  KUCOIN_SANDBOX_API_KEY: "key",
  KUCOIN_SANDBOX_API_SECRET: "secret",
  KUCOIN_SANDBOX_API_PASSPHRASE: "passphrase",
};

test("uses the sandbox URL and does not require a production URL", () => {
  assert.deepEqual(getKucoinSandboxConfig(validEnv), {
    baseUrl: "https://api-sandbox-futures.kucoin.com",
    apiKey: "key",
    apiSecret: "secret",
    apiPassphrase: "passphrase",
  });
});

test("normalizes a configured base URL", () => {
  assert.equal(
    getKucoinSandboxConfig({
      ...validEnv,
      KUCOIN_SANDBOX_BASE_URL: "https://sandbox.example.test///",
    }).baseUrl,
    "https://sandbox.example.test",
  );
});

test("requires all sandbox credentials", () => {
  assert.throws(
    () =>
      getKucoinSandboxConfig({
        KUCOIN_SANDBOX_API_KEY: "key",
        KUCOIN_SANDBOX_API_SECRET: "secret",
      }),
    /KUCOIN_SANDBOX_API_PASSPHRASE/,
  );
});

test("rejects a non-HTTPS base URL", () => {
  assert.throws(
    () =>
      getKucoinSandboxConfig({
        ...validEnv,
        KUCOIN_SANDBOX_BASE_URL: "http://localhost:8080",
      }),
    /must use HTTPS/,
  );
});