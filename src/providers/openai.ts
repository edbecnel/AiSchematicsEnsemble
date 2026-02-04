import OpenAI from "openai";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { InputImage, ModelAnswer } from "../types.js";

export async function askOpenAI(prompt: string, model = "gpt-5.2", image?: InputImage): Promise<ModelAnswer> {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const input = image
      ? ([
          {
            role: "user" as const,
            content: [
              { type: "input_text" as const, text: prompt },
              {
                type: "input_image" as const,
                image_url: `data:${image.mimeType};base64,${image.base64}`,
                detail: "auto" as const,
              },
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
