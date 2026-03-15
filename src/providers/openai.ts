import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { InputImage, ModelAnswer } from "../types.js";
import { getDefaultModelForProvider } from "../registry/providers.js";

export async function askOpenAI(prompt: string, model = getDefaultModelForProvider("openai"), images?: InputImage[]): Promise<ModelAnswer> {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const imgs = Array.isArray(images) ? images.filter(Boolean) : [];

    const input = imgs.length
      ? ([
          {
            role: "user" as const,
            content: [
              { type: "input_text" as const, text: prompt },
              ...imgs.map((img) => ({
                type: "input_image" as const,
                image_url: `data:${img.mimeType};base64,${img.base64}`,
                detail: "auto" as const,
              })),
            ],
          },
        ] satisfies ResponseInput)
      : prompt;

    const resp = await client.responses.create({
      model,
      input,
    });

    return { provider: "openai", model, text: resp.output_text ?? "" };
  } catch (e: any) {
    return { provider: "openai", model, text: "", error: String(e?.message ?? e) };
  }
}
