/**
 * Phase 8 — Synthesis and judge provider eligibility rules
 *
 * Centralizes the logic for determining which of the run's active providers
 * can be used for the synthesis LLM call and for the optional judge/reranker
 * step.  Eligibility is driven by the registered capability flags
 * (synthesisEligible / judgeEligible) so it remains in one place and does
 * not need to be re-specified in calling code.
 *
 * Preferred order rationale:
 *  - Anthropic Claude is preferred for synthesis/judging because it reliably
 *    follows structured output instructions, has strong instruction-following,
 *    and is registered as judgeEligible in the built-in catalogue.
 *  - OpenAI GPT is the synthesis fallback (synthesisEligible but not judgeEligible
 *    by default).
 *  - xAI and Gemini are not synthesis-eligible by default; they are fast
 *    analysis providers rather than structured-reasoning providers.
 */

import type { ProviderName } from "../../types.js";
import {
  getSynthesisEligibleProviders,
  getJudgeEligibleProviders,
  providerHasConfiguredEnvKey,
} from "../../registry/providers.js";

// ---------------------------------------------------------------------------
// Preference order constants
// ---------------------------------------------------------------------------

/** Preference order for synthesis provider selection. */
const SYNTHESIS_PREFERENCE: ProviderName[] = ["anthropic", "openai", "xai", "google"];

/** Preference order for judge provider selection. */
const JUDGE_PREFERENCE: ProviderName[] = ["anthropic", "openai"];

// ---------------------------------------------------------------------------
// Eligibility filters
// ---------------------------------------------------------------------------

/**
 * Return the subset of `available` providers that are:
 *  1. markedEligible for synthesis in the registry, AND
 *  2. have a configured API key in the current environment
 */
export function filterSynthesisEligible(available: ProviderName[]): ProviderName[] {
  const eligible = new Set(getSynthesisEligibleProviders());
  return available.filter((p) => eligible.has(p) && providerHasConfiguredEnvKey(p));
}

/**
 * Return the subset of `available` providers that are:
 *  1. marked judgeEligible in the registry, AND
 *  2. have a configured API key in the current environment
 */
export function filterJudgeEligible(available: ProviderName[]): ProviderName[] {
  const eligible = new Set(getJudgeEligibleProviders());
  return available.filter((p) => eligible.has(p) && providerHasConfiguredEnvKey(p));
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/**
 * Select the synthesis provider from the active `available` list.
 *
 * Priority:
 *  1. First synthesis-eligible provider in SYNTHESIS_PREFERENCE order
 *  2. Any synthesis-eligible provider not covered by the preference list
 *  3. First available provider as last resort (so synthesis is never silently
 *     skipped due to a preference list gap)
 *
 * Returns `undefined` only when `available` is empty.
 */
export function selectSynthesisProvider(available: ProviderName[]): ProviderName | undefined {
  const eligible = filterSynthesisEligible(available);

  for (const p of SYNTHESIS_PREFERENCE) {
    if (eligible.includes(p)) return p;
  }
  if (eligible.length > 0) return eligible[0];

  // Last resort: any provider with a key, even if not synthesis-eligible
  // (ensures synthesis is attempted when the eligible set is empty)
  for (const p of SYNTHESIS_PREFERENCE) {
    if (available.includes(p) && providerHasConfiguredEnvKey(p)) return p;
  }
  return available.find((p) => providerHasConfiguredEnvKey(p)) ?? available[0];
}

/**
 * Select the judge provider from the active `available` list.
 *
 * Returns `undefined` when no judge-eligible provider with a configured key
 * is available — in which case the judge step is skipped.
 */
export function selectJudgeProvider(available: ProviderName[]): ProviderName | undefined {
  const eligible = filterJudgeEligible(available);

  for (const p of JUDGE_PREFERENCE) {
    if (eligible.includes(p)) return p;
  }
  return eligible[0];
}

/**
 * Check whether the synthesis and judge providers are distinct so the
 * orchestrator can log or schedule them appropriately.
 */
export function areSynthesisAndJudgeSameProvider(
  synthProvider: ProviderName,
  judgeProvider: ProviderName,
): boolean {
  return synthProvider === judgeProvider;
}
