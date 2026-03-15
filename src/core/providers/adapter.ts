import type {
  DispatchStatus,
  InputImage,
  ModelAnswer,
  NormalizedPromptMessage,
  ProviderName,
  ProviderProtocol,
  RawProviderResponse,
} from "../../types.js";

export interface ProviderDispatchInput {
  provider: ProviderName;
  model: string;
  messages: NormalizedPromptMessage[];
  images?: InputImage[];
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  protocol: ProviderProtocol;
  supports(provider: ProviderName): boolean;
  dispatch(input: ProviderDispatchInput): Promise<RawProviderResponse>;
}

export function promptTextFromMessages(messages: NormalizedPromptMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === "user") {
    return String(messages[0].text ?? "");
  }

  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function singleUserPromptMessage(prompt: string): NormalizedPromptMessage[] {
  return [{ role: "user", text: String(prompt ?? "") }];
}

export function modelAnswerFromRaw(response: RawProviderResponse): ModelAnswer {
  const status: DispatchStatus = response.status ?? (response.error ? "failed" : "succeeded");
  return {
    provider: response.provider,
    model: response.model,
    text: response.text,
    error: response.error,
    meta: {
      raw: response.raw,
      usage: response.usage,
      latencyMs: response.latencyMs,
      status,
    },
  };
}
