import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { InputImage, ModelAnswer } from "../types.js";

export async function askClaude(
  prompt: string,
  model = "claude-sonnet-4-5-20250929",
  maxTokens = 1800,
  image?: InputImage,
): Promise<ModelAnswer> {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const content = image
      ? ([
          { type: "text" as const, text: prompt },
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType as any,
              data: image.base64,
            },
          },
        ] satisfies ContentBlockParam[])
      : prompt;

    const msg: any = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    });

    const text = msg.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    return { provider: "anthropic", model, text };
  } catch (e: any) {
    return { provider: "anthropic", model, text: "", error: String(e?.message ?? e) };
  }
}
