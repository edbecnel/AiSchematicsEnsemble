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
    bundleIncludes: z.boolean().optional(),
    outdir: z.string().optional(),
    openaiModel: z.string().optional(),
    grokModel: z.string().optional(),
    geminiModel: z.string().optional(),
    claudeModel: z.string().optional(),
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

  return {
    questionPath: cleanString(cfg.questionPath),
    questionText: cleanString(cfg.questionText),
    questionFilename: cleanString(cfg.questionFilename),
    baselineNetlistPath: cleanString(cfg.baselineNetlistPath),
    baselineNetlistText: cleanString(cfg.baselineNetlistText),
    baselineNetlistFilename: cleanString(cfg.baselineNetlistFilename),
    baselineImagePath: cleanString(cfg.baselineImagePath),
    baselineImage,
    bundleIncludes: cfg.bundleIncludes,
    outdir: cleanString(cfg.outdir),
    openaiModel: cleanString(cfg.openaiModel),
    grokModel: cleanString(cfg.grokModel),
    geminiModel: cleanString(cfg.geminiModel),
    claudeModel: cleanString(cfg.claudeModel),
  };
}

export function mergeRunConfig(cli: {
  question?: unknown;
  baselineNetlist?: unknown;
  baselineImage?: unknown;
  bundleIncludes?: unknown;
  outdir?: unknown;
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

  if (typeof cli.bundleIncludes === "boolean") merged.bundleIncludes = cli.bundleIncludes;

  const outdir = cleanString(cli.outdir);
  if (outdir) merged.outdir = outdir;

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
