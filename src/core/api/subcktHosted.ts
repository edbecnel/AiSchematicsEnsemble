import { assertProviderAccess } from "../providers/accessPolicy.js";
import {
  createSubckt,
  refineSubckt,
  type CreateSubcktInput,
  type CreateSubcktOutput,
  type RefineSubcktInput,
  type RefineSubcktOutput,
  type SubcktProviderAccessGuard,
} from "../../subckt/index.js";
import type { ProviderName } from "../../types.js";

export interface HostedSubcktPolicyOptions {
  allowPremiumProviders?: boolean;
  allowCustomEndpoints?: boolean;
  hasActiveByokCredential?: (provider: ProviderName) => boolean;
}

export function createHostedSubcktProviderAccessGuard(
  opts: HostedSubcktPolicyOptions = {},
): SubcktProviderAccessGuard {
  return async ({ provider }) => {
    assertProviderAccess({
      provider,
      mode: "hosted",
      hasActiveByokCredential: opts.hasActiveByokCredential?.(provider) ?? false,
      allowPremiumProviders: opts.allowPremiumProviders,
      allowCustomEndpoints: opts.allowCustomEndpoints,
    });
  };
}

export async function createHostedSubckt(
  input: CreateSubcktInput,
  policy: HostedSubcktPolicyOptions = {},
): Promise<CreateSubcktOutput> {
  return createSubckt({
    ...input,
    assertProviderAccess: createHostedSubcktProviderAccessGuard(policy),
  });
}

export async function refineHostedSubckt(
  input: RefineSubcktInput,
  policy: HostedSubcktPolicyOptions = {},
): Promise<RefineSubcktOutput> {
  return refineSubckt({
    ...input,
    assertProviderAccess: createHostedSubcktProviderAccessGuard(policy),
  });
}
