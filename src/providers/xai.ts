import OpenAI from "openai";
import type { InputImage, ModelAnswer } from "../types.js";
import { getDefaultModelForProvider } from "../registry/providers.js";

export async function askGrok(prompt: string, model = getDefaultModelForProvider("xai"), _images?: InputImage[]): Promise<ModelAnswer> {
  try {
    const client = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: "https://api.x.ai/v1",
    });
    const resp = await client.responses.create({
      model,
      input: prompt,
    });
    return { provider: "xai", model, text: resp.output_text ?? "" };
  } catch (e: any) {
    return { provider: "xai", model, text: "", error: String(e?.message ?? e) };
  }
}
