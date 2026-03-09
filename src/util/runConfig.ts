import fs from "fs-extra";
import path from "node:path";
import { z } from "zod";

const RunConfigSchema = z
  .object({
    questionPath: z.string().optional(),
    questionText: z.string().optional(),
    questionFilename: z.string().optional(),
    baselineNetlistPath: z.string().optional(),
    baselineNetlistText: z.string().optional(),
    baselineNetlistFilename: z.string().optional(),
    baselineImagePath: z.string().optional(),
    baselineImage: z
      .object({
        mimeType: z.string(),
        base64: z.string(),
        filename: z.string().optional(),
      })
      .strict()
      .optional(),
    traceImagePaths: z.array(z.string()).optional(),
    traceImages: z
      .array(
        z
          .object({
            mimeType: z.string(),
            base64: z.string(),
            filename: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    bundleIncludes: z.boolean().optional(),
    outdir: z.string().optional(),
    /** DPI to render schematic.png (Graphviz). Higher = larger PNG. */
    schematicDpi: z.coerce.number().int().min(1).max(2400).optional(),
    openaiModel: z.string().optional(),
    grokModel: z.string().optional(),
    geminiModel: z.string().optional(),
    claudeModel: z.string().optional(),
    enabledProviders: z.array(z.enum(["openai", "xai", "google", "anthropic"])).optional(),
  })
  .strict();

export type RunConfig = z.infer<typeof RunConfigSchema>;

function cleanString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

export async function readRunConfig(configPath: string): Promise<RunConfig> {
  const abs = path.resolve(configPath);
  const ok = await fs.pathExists(abs);
  if (!ok) throw new Error(`Config file not found: ${configPath}`);

  const raw = await fs.readJson(abs);
  const parsed = RunConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`Invalid config JSON: ${msg}`);
  }

  // Normalize: convert blank strings to undefined.
  const cfg = parsed.data;

  const bi = cfg.baselineImage;
  const baselineImage =
    bi && cleanString(bi.mimeType) && cleanString(bi.base64)
      ? {
          mimeType: String(bi.mimeType).trim(),
          base64: String(bi.base64).trim(),
          filename: cleanString(bi.filename),
        }
      : undefined;

  const traceImagePaths = Array.isArray(cfg.traceImagePaths)
    ? cfg.traceImagePaths.map((p) => cleanString(p)).filter((p): p is string => Boolean(p))
    : undefined;

  const traceImagesRaw = Array.isArray(cfg.traceImages) ? cfg.traceImages : undefined;
  const traceImages = traceImagesRaw?.length
    ? traceImagesRaw
        .map((img) => {
          const mt = cleanString((img as any)?.mimeType);
          const b64 = cleanString((img as any)?.base64);
          if (!mt || !b64) return undefined;
          const fn = cleanString((img as any)?.filename);
          return fn ? { mimeType: mt, base64: b64, filename: fn } : { mimeType: mt, base64: b64 };
        })
        .filter((x): x is { mimeType: string; base64: string; filename?: string } => Boolean(x))
    : undefined;

  return {
    questionPath: cleanString(cfg.questionPath),
    questionText: cleanString(cfg.questionText),
    questionFilename: cleanString(cfg.questionFilename),
    baselineNetlistPath: cleanString(cfg.baselineNetlistPath),
    baselineNetlistText: cleanString(cfg.baselineNetlistText),
    baselineNetlistFilename: cleanString(cfg.baselineNetlistFilename),
    baselineImagePath: cleanString(cfg.baselineImagePath),
    baselineImage,
    traceImagePaths: traceImagePaths && traceImagePaths.length ? traceImagePaths : undefined,
    traceImages: traceImages && traceImages.length ? (traceImages as any) : undefined,
    bundleIncludes: cfg.bundleIncludes,
    outdir: cleanString(cfg.outdir),
    schematicDpi: typeof cfg.schematicDpi === "number" && Number.isFinite(cfg.schematicDpi) ? cfg.schematicDpi : undefined,
    openaiModel: cleanString(cfg.openaiModel),
    grokModel: cleanString(cfg.grokModel),
    geminiModel: cleanString(cfg.geminiModel),
    claudeModel: cleanString(cfg.claudeModel),
    enabledProviders: Array.isArray(cfg.enabledProviders) && cfg.enabledProviders.length ? cfg.enabledProviders : undefined,
  };
}

export function mergeRunConfig(cli: {
  question?: unknown;
  baselineNetlist?: unknown;
  baselineImage?: unknown;
  traceImage?: unknown;
  bundleIncludes?: unknown;
  outdir?: unknown;
  schematicDpi?: unknown;
  openaiModel?: unknown;
  grokModel?: unknown;
  geminiModel?: unknown;
  claudeModel?: unknown;
}, cfg: RunConfig): RunConfig {
  // CLI wins when explicitly set (including booleans)
  const merged: RunConfig = {
    ...cfg,
  };

  const q = cleanString(cli.question);
  if (q) merged.questionPath = q;

  const bn = cleanString(cli.baselineNetlist);
  if (bn) merged.baselineNetlistPath = bn;

  const bi = cleanString(cli.baselineImage);
  if (bi) merged.baselineImagePath = bi;

  if (Array.isArray((cli as any).traceImage)) {
    const t = (cli as any).traceImage.map((p: any) => cleanString(p)).filter(Boolean);
    if (t.length) merged.traceImagePaths = t as string[];
  } else {
    const t1 = cleanString((cli as any).traceImage);
    if (t1) merged.traceImagePaths = [t1];
  }

  if (typeof cli.bundleIncludes === "boolean") merged.bundleIncludes = cli.bundleIncludes;

  const outdir = cleanString(cli.outdir);
  if (outdir) merged.outdir = outdir;

  const schematicDpiRaw = cleanString(cli.schematicDpi);
  if (schematicDpiRaw) {
    const n = Number.parseInt(schematicDpiRaw, 10);
    if (Number.isFinite(n) && n > 0) merged.schematicDpi = n;
  }

  const om = cleanString(cli.openaiModel);
  if (om) merged.openaiModel = om;

  const gm = cleanString(cli.grokModel);
  if (gm) merged.grokModel = gm;

  const gem = cleanString(cli.geminiModel);
  if (gem) merged.geminiModel = gem;

  const cm = cleanString(cli.claudeModel);
  if (cm) merged.claudeModel = cm;

  return merged;
}
