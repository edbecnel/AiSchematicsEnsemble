import { getProviderDefinition } from "../../registry/providers.js";
import type { BillingMode, ProviderName } from "../../types.js";

export type ProviderAccessMode = "local-dev" | "hosted";

export type ProviderAccessReasonCode =
  | "ALLOWED"
  | "UNKNOWN_PROVIDER"
  | "PROVIDER_DISABLED"
  | "HOSTED_UNAVAILABLE"
  | "PREMIUM_REQUIRED"
  | "BYOK_REQUIRED"
  | "CUSTOM_ENDPOINTS_DISABLED";

export interface ProviderAccessDecision {
  allowed: boolean;
  provider: ProviderName;
  reasonCode: ProviderAccessReasonCode;
  reason: string;
  billingMode?: BillingMode;
  requiresByok: boolean;
  requiresPremium: boolean;
}

export interface EvaluateProviderAccessInput {
  provider: ProviderName;
  mode?: ProviderAccessMode;
  hasActiveByokCredential?: boolean;
  allowPremiumProviders?: boolean;
  allowCustomEndpoints?: boolean;
}

export class ProviderAccessError extends Error {
  readonly code: ProviderAccessReasonCode;
  readonly decision: ProviderAccessDecision;

  constructor(decision: ProviderAccessDecision) {
    super(decision.reason);
    this.name = "ProviderAccessError";
    this.code = decision.reasonCode;
    this.decision = decision;
  }
}

export function evaluateProviderAccess(input: EvaluateProviderAccessInput): ProviderAccessDecision {
  const mode = input.mode ?? "hosted";
  const hasActiveByokCredential = input.hasActiveByokCredential === true;
  const allowPremiumProviders = input.allowPremiumProviders === true;
  const allowCustomEndpoints = input.allowCustomEndpoints === true;
  const definition = getProviderDefinition(input.provider);

  if (!definition) {
    return {
      allowed: false,
      provider: input.provider,
      reasonCode: "UNKNOWN_PROVIDER",
      reason: `Provider is not registered for server-side access control: ${input.provider}`,
      requiresByok: false,
      requiresPremium: false,
    };
  }

  if (!definition.isEnabled) {
    return {
      allowed: false,
      provider: definition.provider,
      reasonCode: "PROVIDER_DISABLED",
      reason: `Provider is disabled: ${definition.displayName}`,
      billingMode: definition.billingMode,
      requiresByok: false,
      requiresPremium: false,
    };
  }

  if (mode === "hosted" && definition.capabilities.hostedAvailable === false) {
    return {
      allowed: false,
      provider: definition.provider,
      reasonCode: "HOSTED_UNAVAILABLE",
      reason: `Provider is not available for hosted execution: ${definition.displayName}`,
      billingMode: definition.billingMode,
      requiresByok: false,
      requiresPremium: false,
    };
  }

  if (definition.providerScope === "custom_endpoint" && !allowCustomEndpoints) {
    return {
      allowed: false,
      provider: definition.provider,
      reasonCode: "CUSTOM_ENDPOINTS_DISABLED",
      reason: `Custom endpoints are not enabled for this hosted execution path: ${definition.displayName}`,
      billingMode: definition.billingMode,
      requiresByok: false,
      requiresPremium: false,
    };
  }

  if (definition.billingMode === "user_byok" && !hasActiveByokCredential) {
    return {
      allowed: false,
      provider: definition.provider,
      reasonCode: "BYOK_REQUIRED",
      reason: `A valid BYOK credential is required for provider: ${definition.displayName}`,
      billingMode: definition.billingMode,
      requiresByok: true,
      requiresPremium: false,
    };
  }

  if (definition.isPremiumOnly && !allowPremiumProviders && !hasActiveByokCredential) {
    return {
      allowed: false,
      provider: definition.provider,
      reasonCode: "PREMIUM_REQUIRED",
      reason: `Provider requires premium access or valid BYOK: ${definition.displayName}`,
      billingMode: definition.billingMode,
      requiresByok: true,
      requiresPremium: true,
    };
  }

  return {
    allowed: true,
    provider: definition.provider,
    reasonCode: "ALLOWED",
    reason: `Provider access allowed: ${definition.displayName}`,
    billingMode: definition.billingMode,
    requiresByok: false,
    requiresPremium: false,
  };
}

export function assertProviderAccess(input: EvaluateProviderAccessInput): ProviderAccessDecision {
  const decision = evaluateProviderAccess(input);
  if (!decision.allowed) throw new ProviderAccessError(decision);
  return decision;
}
