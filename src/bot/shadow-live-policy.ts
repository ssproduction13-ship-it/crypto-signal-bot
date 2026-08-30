import { compareShadowOutcomes, type ShadowComparison } from "./feature-shadow.js";
import { logger } from "../lib/logger.js";

export const MIN_LIVE_SHADOW_TRADES = 100;
const POLICY_CACHE_MS = 15 * 60 * 1000;

export interface ShadowLivePolicy {
  featureName: string;
  liveEnabled: boolean;
  comparison: ShadowComparison;
}

const cache = new Map<string, { expiresAt: number; policy: ShadowLivePolicy }>();

/**
 * Shadow features become live only after a meaningful sample and a positive,
 * statistically significant outcome. A disagreement can therefore reduce
 * size, while a missing or unconfirmed policy always returns the neutral factor.
 */
export async function getShadowLivePolicy(
  featureName: string,
  agreeField = "agrees",
): Promise<ShadowLivePolicy> {
  const cacheKey = `${featureName}:${agreeField}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.policy;

  try {
    const comparison = await compareShadowOutcomes(featureName, agreeField);
    const linkedTrades = comparison.agreeCount + comparison.disagreeCount;
    const policy: ShadowLivePolicy = {
      featureName,
      liveEnabled:
        linkedTrades >= MIN_LIVE_SHADOW_TRADES
        && comparison.isSignificant
        && comparison.effect === "positive",
      comparison,
    };
    cache.set(cacheKey, { expiresAt: Date.now() + POLICY_CACHE_MS, policy });
    return policy;
  } catch (err) {
    logger.warn({ err, featureName }, "Shadow live-policy check failed");
    return {
      featureName,
      liveEnabled: false,
      comparison: {
        featureName,
        agreeField,
        agreeCount: 0,
        disagreeCount: 0,
        agreeMeanPnl: 0,
        disagreeMeanPnl: 0,
        pValue: 1,
        isSignificant: false,
        effect: "none",
      },
    };
  }
}

export async function getShadowLiveMultiplier(
  featureName: string,
  observedAgreement: boolean | null | undefined,
  agreeMultiplier: number,
  disagreeMultiplier: number,
  agreeField = "agrees",
): Promise<number> {
  if (observedAgreement == null) return 1;
  const policy = await getShadowLivePolicy(featureName, agreeField);
  if (!policy.liveEnabled) return 1;
  return observedAgreement ? agreeMultiplier : disagreeMultiplier;
}

export function clearShadowLivePolicyCache(): void {
  cache.clear();
}
