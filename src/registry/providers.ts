import type {
  BuiltinProviderName,
  ModelAlias,
  ModelDefinition,
  ProviderCapabilities,
  ProviderDefinition,
  ProviderName,
  ResolvedProvider,
} from "../types.js";
import { BUILTIN_PROVIDER_NAMES, isBuiltinProviderName } from "../types.js";

const BUILTIN_PROVIDER_BY_DEFINITION_ID: Record<string, BuiltinProviderName> = {
  "provider.openai": "openai",
  "provider.xai": "xai",
  "provider.google": "google",
  "provider.anthropic": "anthropic",
};

const OPENAI_CAPABILITIES: ProviderCapabilities = {
  supportsVision: true,
  supportsStructuredOutput: true,
  hostedAvailable: true,
  localDevAvailable: false,
  synthesisEligible: true,
  judgeEligible: false,
};

const XAI_CAPABILITIES: ProviderCapabilities = {
  supportsVision: false,
  supportsStructuredOutput: true,
  hostedAvailable: true,
  localDevAvailable: false,
  synthesisEligible: false,
  judgeEligible: false,
};

const GEMINI_CAPABILITIES: ProviderCapabilities = {
  supportsVision: true,
  supportsStructuredOutput: false,
  hostedAvailable: true,
  localDevAvailable: false,
  synthesisEligible: false,
  judgeEligible: false,
};

const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  supportsVision: true,
  supportsStructuredOutput: false,
  hostedAvailable: true,
  localDevAvailable: false,
  synthesisEligible: true,
  judgeEligible: true,
};

export const BUILTIN_PROVIDER_DEFINITIONS: Record<BuiltinProviderName, ProviderDefinition> = {
  openai: {
    id: "provider.openai",
    provider: "openai",
    displayName: "OpenAI",
    protocol: "openai-compatible",
    billingMode: "platform_paid",
    providerScope: "builtin",
    isEnabled: true,
    authEnvVar: "OPENAI_API_KEY",
    authHeaderName: "Authorization",
    authHeaderPrefix: "Bearer",
    capabilities: OPENAI_CAPABILITIES,
    isFreeEligible: false,
    isPremiumOnly: false,
  },
  xai: {
    id: "provider.xai",
    provider: "xai",
    displayName: "xAI",
    protocol: "openai-compatible",
    billingMode: "platform_paid",
    providerScope: "builtin",
    isEnabled: true,
    baseUrl: "https://api.x.ai/v1",
    authEnvVar: "XAI_API_KEY",
    authHeaderName: "Authorization",
    authHeaderPrefix: "Bearer",
    capabilities: XAI_CAPABILITIES,
    isFreeEligible: false,
    isPremiumOnly: false,
  },
  google: {
    id: "provider.google",
    provider: "google",
    displayName: "Google Gemini",
    protocol: "gemini-native",
    billingMode: "platform_paid",
    providerScope: "builtin",
    isEnabled: true,
    authEnvVar: "GEMINI_API_KEY",
    authHeaderName: "x-goog-api-key",
    capabilities: GEMINI_CAPABILITIES,
    isFreeEligible: false,
    isPremiumOnly: false,
  },
  anthropic: {
    id: "provider.anthropic",
    provider: "anthropic",
    displayName: "Anthropic",
    protocol: "anthropic-native",
    billingMode: "platform_paid",
    providerScope: "builtin",
    isEnabled: true,
    authEnvVar: "ANTHROPIC_API_KEY",
    authHeaderName: "x-api-key",
    capabilities: ANTHROPIC_CAPABILITIES,
    isFreeEligible: false,
    isPremiumOnly: true,
  },
};

export const MODEL_CATALOG: ModelDefinition[] = [
  {
    id: "model.openai.gpt-5.2",
    providerDefinitionId: BUILTIN_PROVIDER_DEFINITIONS.openai.id,
    modelId: "gpt-5.2",
    displayName: "OpenAI GPT-5.2",
    capabilities: OPENAI_CAPABILITIES,
    synthesisEligible: true,
    judgeEligible: false,
    pricing: {},
    isEnabled: true,
  },
  {
    id: "model.xai.grok-4",
    providerDefinitionId: BUILTIN_PROVIDER_DEFINITIONS.xai.id,
    modelId: "grok-4",
    displayName: "xAI Grok 4",
    capabilities: XAI_CAPABILITIES,
    synthesisEligible: false,
    judgeEligible: false,
    pricing: {},
    isEnabled: true,
  },
  {
    id: "model.google.gemini-2.5-flash",
    providerDefinitionId: BUILTIN_PROVIDER_DEFINITIONS.google.id,
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    capabilities: GEMINI_CAPABILITIES,
    synthesisEligible: false,
    judgeEligible: false,
    pricing: {},
    isEnabled: true,
  },
  {
    id: "model.anthropic.claude-sonnet-4-5-20250929",
    providerDefinitionId: BUILTIN_PROVIDER_DEFINITIONS.anthropic.id,
    modelId: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet 4.5",
    capabilities: ANTHROPIC_CAPABILITIES,
    synthesisEligible: true,
    judgeEligible: true,
    pricing: {},
    isEnabled: true,
  },
];

export const MODEL_ALIASES: ModelAlias[] = [
  { id: "alias.openai.flagship", alias: "openai.flagship", targetModelDefinitionId: "model.openai.gpt-5.2", isDefault: true },
  { id: "alias.xai.flagship", alias: "xai.flagship", targetModelDefinitionId: "model.xai.grok-4", isDefault: true },
  { id: "alias.google.fast", alias: "google.fast", targetModelDefinitionId: "model.google.gemini-2.5-flash", isDefault: true },
  { id: "alias.anthropic.flagship", alias: "anthropic.flagship", targetModelDefinitionId: "model.anthropic.claude-sonnet-4-5-20250929", isDefault: true },
  { id: "alias.judge.default", alias: "judge.default", targetModelDefinitionId: "model.anthropic.claude-sonnet-4-5-20250929", isDefault: true },
];

export const DEFAULT_MODEL_BY_PROVIDER: Record<BuiltinProviderName, string> = {
  openai: "gpt-5.2",
  xai: "grok-4",
  google: "gemini-2.5-flash",
  anthropic: "claude-sonnet-4-5-20250929",
};

export function listProviderDefinitions(): ProviderDefinition[] {
  return BUILTIN_PROVIDER_NAMES.map((provider) => BUILTIN_PROVIDER_DEFINITIONS[provider]);
}

export function listModelDefinitions(): ModelDefinition[] {
  return [...MODEL_CATALOG];
}

export function getModelDefinitionById(id: string): ModelDefinition | undefined {
  return MODEL_CATALOG.find((model) => model.id === id);
}

export function getDefaultModelDefinitionForProvider(provider: ProviderName): ModelDefinition | undefined {
  const definition = getProviderDefinition(provider);
  if (!definition) return undefined;

  const normalizedProvider = normalizeBuiltinProviderReference(provider);
  const defaultModelId = definition.id && normalizedProvider
    ? DEFAULT_MODEL_BY_PROVIDER[normalizedProvider]
    : undefined;

  return MODEL_CATALOG.find((model) => {
    if (model.providerDefinitionId !== definition.id || !model.isEnabled) return false;
    return defaultModelId ? model.modelId === defaultModelId : true;
  });
}

export function normalizeBuiltinProviderReference(provider: ProviderName): BuiltinProviderName | undefined {
  if (isBuiltinProviderName(provider)) return provider;
  return BUILTIN_PROVIDER_BY_DEFINITION_ID[String(provider)];
}

export function getProviderDefinition(provider: ProviderName): ProviderDefinition | undefined {
  const normalizedProvider = normalizeBuiltinProviderReference(provider);
  return normalizedProvider ? BUILTIN_PROVIDER_DEFINITIONS[normalizedProvider] : undefined;
}

function requireBuiltinProvider(provider: ProviderName): BuiltinProviderName {
  const normalizedProvider = normalizeBuiltinProviderReference(provider);
  if (!normalizedProvider) {
    throw new Error(`No built-in provider definition registered for provider: ${provider}`);
  }
  return normalizedProvider;
}

export function getDefaultModelForProvider(provider: ProviderName): string {
  return DEFAULT_MODEL_BY_PROVIDER[requireBuiltinProvider(provider)];
}

export function getProviderEnvVar(provider: ProviderName): string | undefined {
  return getProviderDefinition(provider)?.authEnvVar;
}

export function providerHasConfiguredEnvKey(provider: ProviderName): boolean {
  const envVar = getProviderEnvVar(provider);
  return envVar ? Boolean(process.env[envVar]) : false;
}

export function resolveProvider(args: { provider: ProviderName; model?: string }): ResolvedProvider {
  const builtinProvider = requireBuiltinProvider(args.provider);
  const definition = BUILTIN_PROVIDER_DEFINITIONS[builtinProvider];
  return {
    provider: definition.provider,
    protocol: definition.protocol,
    model: args.model?.trim() || DEFAULT_MODEL_BY_PROVIDER[builtinProvider],
    baseUrl: definition.baseUrl,
    authEnvVar: definition.authEnvVar,
    authHeaderName: definition.authHeaderName,
    authHeaderPrefix: definition.authHeaderPrefix,
    capabilities: definition.capabilities,
    billingMode: definition.billingMode,
  };
}

/** Return all built-in provider names whose capabilities mark synthesisEligible=true. */
export function getSynthesisEligibleProviders(): BuiltinProviderName[] {
  return BUILTIN_PROVIDER_NAMES.filter((provider) => getDefaultModelDefinitionForProvider(provider)?.synthesisEligible === true);
}

/** Return all built-in provider names whose capabilities mark judgeEligible=true. */
export function getJudgeEligibleProviders(): BuiltinProviderName[] {
  return BUILTIN_PROVIDER_NAMES.filter((provider) => getDefaultModelDefinitionForProvider(provider)?.judgeEligible === true);
}
