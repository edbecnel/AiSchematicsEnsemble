import { GoogleGenAI } from "@google/genai";
import type { InputImage, ModelAnswer } from "../types.js";
import { getDefaultModelForProvider } from "../registry/providers.js";

export async function askGemini(prompt: string, model = getDefaultModelForProvider("google"), images?: InputImage[]): Promise<ModelAnswer> {
  try {
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const imgs = Array.isArray(images) ? images.filter(Boolean) : [];

    const contents = imgs.length
      ? [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...imgs.map((img) => ({
                inlineData: {
                  mimeType: img.mimeType,
                  data: img.base64,
                },
              })),
            ],
          },
        ]
      : prompt;

    const resp: any = await client.models.generateContent({
      model,
      contents,
    });

    const text = resp.text ?? "";
    return { provider: "google", model, text };
  } catch (e: any) {
    return { provider: "google", model, text: "", error: String(e?.message ?? e) };
  }
}
