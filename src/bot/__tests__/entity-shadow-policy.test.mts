import assert from "node:assert/strict";
import test from "node:test";
import { shouldOpenEntityShadow } from "../entity-shadow-policy.ts";

test("entity shadow policy", async (t) => {
  await t.test("shadows adaptive regime rejection", () => {
    assert.equal(
      shouldOpenEntityShadow([
        { check: "Режим рынка", result: "FAIL" },
        { check: "MTF фильтр (4H)", result: "SKIP" },
      ], "LONG"),
      true,
    );
  });

  await t.test("shadows strategy/entity recovery rejections", () => {
    for (const check of [
      "Карантин",
      "Entity Guard",
      "Entity Cooldown",
      "Trust Score",
      "Entity Trust Score",
      "Вес стратегии",
      "TREND Sideways Filter",
    ]) {
      assert.equal(shouldOpenEntityShadow([{ check, result: "FAIL" }], "SHORT"), true, check);
    }
  });

  await t.test("does not shadow safety or quality rejections", () => {
    for (const check of [
      "Рынок: хаос",
      "Funding Rate",
      "Направление",
      "Score",
      "Confidence",
      "ATR Filter",
      "FinalScore Gate",
      "MTF фильтр (4H)",
      "Instrument Banned",
    ]) {
      assert.equal(shouldOpenEntityShadow([{ check, result: "FAIL" }], "LONG"), false, check);
    }
  });

  await t.test("does not turn neutral signals into shadow positions", () => {
    assert.equal(shouldOpenEntityShadow([{ check: "Режим рынка", result: "FAIL" }], "NEUTRAL"), false);
  });
});
