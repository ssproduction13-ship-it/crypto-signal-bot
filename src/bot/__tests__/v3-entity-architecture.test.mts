import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const schedulerSource = readFileSync(
  new URL("../scheduler.ts", import.meta.url),
  "utf8",
);
const learningEngineSource = readFileSync(
  new URL("../learning-engine.ts", import.meta.url),
  "utf8",
);

test("v3.0 trade decision uses strategy × direction × regime entities", () => {
  assert.match(schedulerSource, /const entityKey = `\$\{strat\}_\$\{sig\.score\.direction\}_\$\{regime\}`/);
  assert.match(schedulerSource, /gate\.pass\("Entity Regime"/);
  assert.match(schedulerSource, /gate\.pass\("Entity Weight"/);

  // Legacy strategy-level controls must not be part of the real-trade gate.
  assert.doesNotMatch(schedulerSource, /isStrategyBlockedInRegime/);
  assert.doesNotMatch(schedulerSource, /TREND Sideways Filter/);
  assert.doesNotMatch(schedulerSource, /loadStrategyWeights/);
});

test("v3.0 selection derives regime performance from the full entity", () => {
  assert.match(
    learningEngineSource,
    /const entity = getEntity\(sig\.strategy, sig\.direction as "LONG"\|"SHORT", regime\)/,
  );
  assert.match(
    learningEngineSource,
    /getRecentEntityStats\(entity\)[\s\S]*?const regimePF = recent\.trades > 0/,
  );

  // The old direction-agnostic strategy_regime_stats lookup must not return
  // to strategy selection and mix LONG evidence with SHORT evidence.
  assert.doesNotMatch(
    learningEngineSource,
    /SELECT win_pnl,loss_pnl FROM strategy_regime_stats/,
  );
});

test("trade quality floors stay above bootstrap noise", () => {
  assert.match(schedulerSource, /export const MIN_FINAL_SCORE = 20/);
  assert.match(schedulerSource, /sig\.score\.total < minScore/);
  assert.match(schedulerSource, /const BASE_MIN = 55/);
  assert.match(schedulerSource, /Math\.max\(Math\.min\(cachedMinScore, userCeil\), 55\)/);
  assert.match(schedulerSource, /sig\.confidence\.score < 30/);
});
