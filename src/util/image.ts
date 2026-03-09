import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
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

export function base64ByteLength(b64: string): number {
  try {
    if (!b64) return 0;
    return Buffer.from(b64, "base64").length;
  } catch {
    return 0;
  }
}

function filenameWithJpgExt(filename: string | undefined, fallbackStem: string): string {
  const f = String(filename || "").trim();
  const stem = f ? f.replace(/\.[^./\\]+$/g, "") : fallbackStem;
  return stem + ".jpg";
}

/**
 * Best-effort shrink/recompress to fit a byte limit.
 *
 * Strategy:
 * - Convert to JPEG for best size/compatibility across providers.
 * - Iteratively downscale and reduce quality until under maxBytes.
 */
export async function shrinkImageToMaxBytes(
  img: InputImage,
  maxBytes: number,
): Promise<{ image: InputImage; changed: boolean; originalBytes: number; finalBytes: number }> {
  const originalBytes = base64ByteLength(img?.base64);
  if (!img?.base64 || !img?.mimeType) {
    return {
      image: img,
      changed: false,
      originalBytes,
      finalBytes: originalBytes,
    };
  }
  if (originalBytes > 0 && originalBytes <= maxBytes) {
    return {
      image: img,
      changed: false,
      originalBytes,
      finalBytes: originalBytes,
    };
  }

  const inputBuf = Buffer.from(img.base64, "base64");
  const base = sharp(inputBuf, { failOnError: false });
  const meta = await base.metadata().catch(() => ({} as any));
  const width0 = typeof meta?.width === "number" && meta.width > 0 ? meta.width : undefined;

  // Start at original width (capped), then step down.
  const startWidth = width0 ? Math.min(width0, 2200) : 1600;
  const minWidth = 420;

  const qualities = [82, 74, 68, 62, 56, 50, 44];
  const widthFactors = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.36, 0.3];

  let lastBuf: Buffer | undefined;
  for (const q of qualities) {
    for (const wf of widthFactors) {
      const w = Math.max(minWidth, Math.floor(startWidth * wf));
      const out = await base
        .clone()
        .resize({ width: w, withoutEnlargement: true })
        .jpeg({ quality: q, mozjpeg: true })
        .toBuffer();
      lastBuf = out;
      if (out.length <= maxBytes) {
        const outImg: InputImage = {
          mimeType: "image/jpeg",
          base64: out.toString("base64"),
          filename: filenameWithJpgExt(img.filename, "image"),
        };
        return {
          image: outImg,
          changed: true,
          originalBytes,
          finalBytes: out.length,
        };
      }
    }
  }

  // If we tried everything and it's still too large, return the smallest attempt for diagnostics.
  const finalBytes = lastBuf ? lastBuf.length : originalBytes;
  const outImg: InputImage = lastBuf
    ? {
        mimeType: "image/jpeg",
        base64: lastBuf.toString("base64"),
        filename: filenameWithJpgExt(img.filename, "image"),
      }
    : img;
  return {
    image: outImg,
    changed: Boolean(lastBuf),
    originalBytes,
    finalBytes,
  };
}
