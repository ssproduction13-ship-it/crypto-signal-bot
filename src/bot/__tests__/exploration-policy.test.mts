import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_ENTITY_TRADES, BOOTSTRAP_FINAL_SCORE_MIN, capBootstrapRisk, finalScoreMinimum, MATURE_FINAL_SCORE_MIN } from "../exploration-policy.ts";

test("bootstrap exploration remains bounded", () => {
  assert.equal(finalScoreMinimum(0), BOOTSTRAP_FINAL_SCORE_MIN);
  assert.equal(finalScoreMinimum(19), BOOTSTRAP_FINAL_SCORE_MIN);
  assert.equal(finalScoreMinimum(BOOTSTRAP_ENTITY_TRADES), MATURE_FINAL_SCORE_MIN);
  assert.equal(capBootstrapRisk(2, 1.5, 0), 1);
  assert.equal(capBootstrapRisk(2, 0.6, 19), 0.6);
  assert.equal(capBootstrapRisk(2, 1.5, 20), 1.5);
});
