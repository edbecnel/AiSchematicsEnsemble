import { GoogleGenAI } from "@google/genai";
import type { InputImage, ModelAnswer } from "../types.js";

export async function askGemini(prompt: string, model = "gemini-2.5-flash", image?: InputImage): Promise<ModelAnswer> {
  try {
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const contents = image
      ? [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: image.mimeType,
                  data: image.base64,
                },
              },
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
