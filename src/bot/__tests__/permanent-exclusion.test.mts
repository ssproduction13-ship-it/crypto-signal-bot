import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const analyticsSource = readFileSync(
  new URL("../instrument-analytics.ts", import.meta.url),
  "utf8",
);
const indexSource = readFileSync(
  new URL("../index.ts", import.meta.url),
  "utf8",
);
const dbSource = readFileSync(
  new URL("../../lib/db.ts", import.meta.url),
  "utf8",
);

test("instrument bans count transitions and become permanent on the third", () => {
  assert.match(analyticsSource, /newStatus === "banned" && oldStatus !== "banned"/);
  assert.match(analyticsSource, /const nextPermanent = nextBanCount >= 3/);
  assert.match(analyticsSource, /permanently_excluded/);
  assert.match(analyticsSource, /excluded_at/);
  assert.match(analyticsSource, /ban_count/);
  assert.match(analyticsSource, /permanently_excluded=true/);
});

test("unexclude is whitelist-protected and validates the exchange symbol", () => {
  assert.match(indexSource, /ADMIN_CHAT_IDS/);
  assert.match(indexSource, /isWhitelistedAdmin/);
  assert.match(indexSource, /bot\.command\("unexclude"/);
  assert.match(indexSource, /validateSymbol\(symbol\)/);
});

test("database schema persists permanent exclusion state", () => {
  assert.match(dbSource, /permanently_excluded BOOLEAN NOT NULL DEFAULT false/);
  assert.match(dbSource, /excluded_at TIMESTAMPTZ DEFAULT NULL/);
  assert.match(dbSource, /ban_count INTEGER NOT NULL DEFAULT 0/);
});