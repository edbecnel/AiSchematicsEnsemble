import { AnthropicCompatibleAdapter } from "../../adapters/anthropicCompatible.js";
import { AnthropicNativeAdapter } from "../../adapters/anthropicNative.js";
import { GeminiNativeAdapter } from "../../adapters/geminiNative.js";
import { OpenAICompatibleAdapter } from "../../adapters/openaiCompatible.js";
import { resolveProvider } from "../../registry/providers.js";
import type { ModelAnswer, ProviderName, ProviderProtocol } from "../../types.js";
import type { ProviderAdapter } from "./adapter.js";
import { modelAnswerFromRaw, singleUserPromptMessage } from "./adapter.js";

const adapterRegistry: Record<ProviderProtocol, ProviderAdapter | undefined> = {
  "openai-compatible": new OpenAICompatibleAdapter(),
  "anthropic-native": new AnthropicNativeAdapter(),
  "anthropic-compatible": new AnthropicCompatibleAdapter(),
  "gemini-native": new GeminiNativeAdapter(),
};

export function getProviderAdapter(protocol: ProviderProtocol): ProviderAdapter {
  const adapter = adapterRegistry[protocol];
  if (!adapter) {
    throw new Error(`No provider adapter registered for protocol: ${protocol}`);
  }
  return adapter;
}

export async function dispatchPrompt(args: {
  provider: ProviderName;
  model: string;
  prompt: string;
  images?: import("../../types.js").InputImage[];
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}): Promise<ModelAnswer> {
  const resolved = resolveProvider({ provider: args.provider, model: args.model });
  const adapter = getProviderAdapter(resolved.protocol);
  const response = await adapter.dispatch({
    provider: resolved.provider,
    model: resolved.model,
    messages: singleUserPromptMessage(args.prompt),
    images: args.images,
    maxTokens: args.maxTokens,
    metadata: {
      ...args.metadata,
      resolvedProvider: resolved,
    },
  });
  return modelAnswerFromRaw(response);
}
