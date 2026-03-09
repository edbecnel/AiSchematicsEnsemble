import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { InputImage, ModelAnswer } from "../types.js";
import { base64ByteLength, shrinkImageToMaxBytes } from "../util/image.js";

export async function askClaude(
  prompt: string,
  model = "claude-sonnet-4-5-20250929",
  maxTokens = 1800,
  images?: InputImage[],
): Promise<ModelAnswer> {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const imgs = Array.isArray(images) ? images.filter(Boolean) : [];

    // Anthropic enforces a 5 MiB max per image for base64 payloads.
    // Downscale/compress oversized images so requests don't hard-fail.
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const TARGET_IMAGE_BYTES = MAX_IMAGE_BYTES - 64 * 1024;
    const preparedImgs: InputImage[] = [];
    let changedCount = 0;
    let omittedCount = 0;

    for (const img of imgs) {
      if (!img?.base64 || !img?.mimeType) continue;
      const bytes = base64ByteLength(img.base64);
      if (bytes > 0 && bytes <= MAX_IMAGE_BYTES) {
        preparedImgs.push(img);
        continue;
      }

      try {
        const shrunk = await shrinkImageToMaxBytes(img, TARGET_IMAGE_BYTES);
        if (shrunk.finalBytes > 0 && shrunk.finalBytes <= MAX_IMAGE_BYTES) {
          preparedImgs.push(shrunk.image);
          if (shrunk.changed) changedCount += 1;
        } else {
          omittedCount += 1;
        }
      } catch {
        // If compression fails for any reason, omit rather than failing the entire call.
        omittedCount += 1;
      }
    }

    const effectivePrompt =
      prompt +
      (changedCount || omittedCount
        ? `\n\nNOTE: ${changedCount ? `${changedCount} image(s) were downscaled/compressed` : ""}${
            changedCount && omittedCount ? "; " : ""
          }${omittedCount ? `${omittedCount} image(s) were omitted (too large)` : ""} to fit provider limits.\n`
        : "");

    const content = preparedImgs.length
      ? ([
          { type: "text" as const, text: effectivePrompt },
          ...preparedImgs.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mimeType as any,
              data: img.base64,
            },
          })),
        ] satisfies ContentBlockParam[])
      : effectivePrompt;

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
