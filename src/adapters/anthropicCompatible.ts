import Anthropic from "@anthropic-ai/sdk";
import type { ProviderName, RawProviderResponse, ResolvedProvider } from "../types.js";
import type { ProviderAdapter, ProviderDispatchInput } from "../core/providers/adapter.js";
import { promptTextFromMessages } from "../core/providers/adapter.js";

/**
 * AnthropicCompatibleAdapter
 *
 * Handles any provider that speaks the Anthropic Messages wire format but is
 * NOT the official Anthropic endpoint — e.g., a self-hosted proxy, an
 * OpenRouter Anthropic-mode endpoint, or a future hosted provider that
 * adopted the Anthropic API shape.
 *
 * Uses the official @anthropic-ai/sdk client but overrides baseURL and
 * apiKey at dispatch time from the resolved provider definition.
 */
export class AnthropicCompatibleAdapter implements ProviderAdapter {
  readonly protocol = "anthropic-compatible" as const;

  supports(_provider: ProviderName): boolean {
    // Accepts any provider routed through this protocol — determined by the
    // registry, not hard-coded provider names.
    return true;
  }

  async dispatch(input: ProviderDispatchInput): Promise<RawProviderResponse> {
    const resolved = input.metadata?.resolvedProvider as ResolvedProvider | undefined;

    if (!resolved?.baseUrl) {
      return {
        provider: input.provider,
        model: input.model,
        text: "",
        error: `anthropic-compatible adapter requires a baseUrl in the provider definition for provider "${input.provider}"`,
      };
    }

    const apiKey = resolved.authEnvVar ? (process.env[resolved.authEnvVar] ?? "") : "";
    if (!apiKey) {
      return {
        provider: input.provider,
        model: input.model,
        text: "",
        error: `No API key found. Set ${resolved.authEnvVar ?? "the appropriate env var"} for provider "${input.provider}"`,
      };
    }

    const client = new Anthropic({ baseURL: resolved.baseUrl, apiKey });

    const prompt = promptTextFromMessages(input.messages);
    const maxTokens = input.maxTokens ?? 1800;

    try {
      const message = await client.messages.create({
        model: input.model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });

      const text =
        message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("") ?? "";

      return {
        provider: input.provider,
        model: input.model,
        text,
        raw: message as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return {
        provider: input.provider,
        model: input.model,
        text: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
