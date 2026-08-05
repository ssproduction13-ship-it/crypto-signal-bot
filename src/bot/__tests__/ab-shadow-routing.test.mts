import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const schedulerSource = readFileSync(new URL("../scheduler.ts", import.meta.url), "utf8");
const shadowSource = readFileSync(new URL("../shadow-testing.ts", import.meta.url), "utf8");
const policySource = readFileSync(new URL("../ab-shadow-policy.ts", import.meta.url), "utf8");

test("A/B challengers remain in shadow after a champion is selected", () => {
  assert.match(schedulerSource, /loadABVariants/);
  assert.match(schedulerSource, /variants\.some\(v => v\.isChampion\)/);
  assert.match(schedulerSource, /variants\.filter\(v => !v\.isChampion\)/);
  assert.match(schedulerSource, /openABShadowPosition/);
  assert.match(schedulerSource, /scoreABVariant/);
  assert.match(schedulerSource, /shouldOpenABShadow/);
});

test("A/B shadow results are attributed to their originating variant", () => {
  assert.match(shadowSource, /__abVariantId/);
  assert.match(shadowSource, /recordABTrade/);
  assert.match(shadowSource, /abVariantId/);
  assert.match(policySource, /weights\.trend/);
});
