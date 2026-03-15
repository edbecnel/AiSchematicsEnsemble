import { askGemini } from "../providers/gemini.js";
import type { ProviderName, RawProviderResponse } from "../types.js";
import type { ProviderAdapter, ProviderDispatchInput } from "../core/providers/adapter.js";
import { promptTextFromMessages } from "../core/providers/adapter.js";

export class GeminiNativeAdapter implements ProviderAdapter {
  readonly protocol = "gemini-native" as const;

  supports(provider: ProviderName): boolean {
    return provider === "google";
  }

  async dispatch(input: ProviderDispatchInput): Promise<RawProviderResponse> {
    if (!this.supports(input.provider)) {
      return {
        provider: input.provider,
        model: input.model,
        text: "",
        error: `Provider ${input.provider} is not supported by ${this.protocol}`,
      };
    }

    const answer = await askGemini(promptTextFromMessages(input.messages), input.model, input.images);

    return {
      provider: answer.provider,
      model: answer.model,
      text: answer.text,
      error: answer.error,
      raw: answer.meta,
    } satisfies RawProviderResponse;
  }
}
