import { askOpenAI } from "../providers/openai.js";
import { askGrok } from "../providers/xai.js";
import type { ProviderName, RawProviderResponse } from "../types.js";
import type { ProviderAdapter, ProviderDispatchInput } from "../core/providers/adapter.js";
import { promptTextFromMessages } from "../core/providers/adapter.js";

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly protocol = "openai-compatible" as const;

  supports(provider: ProviderName): boolean {
    return provider === "openai" || provider === "xai";
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

    const prompt = promptTextFromMessages(input.messages);
    const answer =
      input.provider === "openai"
        ? await askOpenAI(prompt, input.model, input.images)
        : await askGrok(prompt, input.model, input.images);

    return {
      provider: answer.provider,
      model: answer.model,
      text: answer.text,
      error: answer.error,
      raw: answer.meta,
    } satisfies RawProviderResponse;
  }
}
