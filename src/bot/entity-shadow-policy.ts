/**
 * Decides which rejected signals should keep teaching the strategy×direction×regime
 * entity model without opening a real paper position.
 *
 * Quality and market-safety failures deliberately stay out of this list: a
 * shadow position is useful for measuring an adaptive decision, not for
 * bypassing a broken risk setup or a directionless signal.
 */
export type ShadowPolicyStep = {
  check: string;
  result: "PASS" | "FAIL" | "SKIP";
};

const ADAPTIVE_REJECT_CHECKS = new Set([
  "Карантин",
  "Режим рынка",
  "Entity Guard",
  "Entity Cooldown",
  "Trust Score",
  "Entity Trust Score",
  "Вес стратегии",
  "Strategy PF",
  "TREND Sideways Filter",
]);

export function shouldOpenEntityShadow(
  steps: readonly ShadowPolicyStep[],
  direction: string,
): boolean {
  if (direction === "NEUTRAL") return false;
  const firstFailure = steps.find((step) => step.result === "FAIL");
  return firstFailure ? ADAPTIVE_REJECT_CHECKS.has(firstFailure.check) : false;
}
