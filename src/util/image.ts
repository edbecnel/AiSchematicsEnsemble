import fs from "fs-extra";
import path from "node:path";
import type { InputImage } from "../types.js";

function mimeFromExt(ext: string): string | undefined {
  const e = ext.toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  return undefined;
}

export async function loadImageAsBase64(filePath: string): Promise<InputImage> {
  const ext = path.extname(filePath);
  const mimeType = mimeFromExt(ext);
  if (!mimeType) throw new Error(`Unsupported image extension: ${ext} (use .png/.jpg/.jpeg/.webp)`);

  const buf = await fs.readFile(filePath);
  return {
    mimeType,
    base64: buf.toString("base64"),
    filename: path.basename(filePath),
  };
}
