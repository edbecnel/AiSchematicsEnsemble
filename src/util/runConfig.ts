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

    // Generic reference images (preferred)
    referenceImagePaths: z
      .array(
        z
          .object({
            tag: z.string(),
            path: z.string(),
          })
          .strict(),
      )
      .optional(),
    referenceImages: z
      .array(
        z
          .object({
            tag: z.string(),
            mimeType: z.string(),
            base64: z.string(),
            filename: z.string().optional(),
          })
          .strict(),
      )
      .optional(),

    // Legacy: oscilloscope traces (deprecated; mapped into reference images)
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
    /**
     * Optional SUBCKT integration config.
     * When mode is "manual", generates .lib files for the listed components.
     */
    subcktIntegration: z
      .object({
        mode: z.enum(["disabled", "manual", "auto_detect"]),
        components: z
          .array(
            z
              .object({
                refdes: z.string().optional(),
                symbolName: z.string().optional(),
                componentName: z.string(),
                manufacturer: z.string().optional(),
                datasheetUrl: z.string().optional(),
                datasheetPdfPath: z.string().optional(),
                abstractionLevel: z.enum(["behavioral", "macro", "datasheet_constrained"]).optional(),
              })
              .strict(),
          )
          .optional(),
        requireValidationPass: z.boolean().optional(),
        includeLibsInReport: z.boolean().optional(),
        patchFinalCir: z.boolean().optional(),
        providerRoles: z
          .object({
            factExtraction: z
              .object({ provider: z.enum(["openai", "xai", "google", "anthropic"]), model: z.string().optional() })
              .optional(),
            modelSynthesis: z
              .object({ provider: z.enum(["openai", "xai", "google", "anthropic"]), model: z.string().optional() })
              .optional(),
            judgeRepair: z
              .object({ provider: z.enum(["openai", "xai", "google", "anthropic"]), model: z.string().optional() })
              .optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .strict();

export type RunConfig = z.infer<typeof RunConfigSchema>;

function cleanString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function sanitizeTag(v: unknown): string {
  const raw = String(v ?? "").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned || "ref";
}

function defaultTagFromPath(p: string): string {
  const base = path.basename(String(p || "").trim());
  const stem = base.replace(/\.[^./\\]+$/g, "");
  return sanitizeTag(stem || base || "ref");
}

function parseRefImageSpec(spec: unknown): { tag: string; path: string } | undefined {
  const s = cleanString(spec);
  if (!s) return undefined;

  // Format: tag=path (preferred)
  const eq = s.indexOf("=");
  if (eq > 0) {
    const tagRaw = s.slice(0, eq);
    const pathRaw = s.slice(eq + 1);
    const p = cleanString(pathRaw);
    if (p) return { tag: sanitizeTag(tagRaw), path: p };
  }

  // Fallback: just a path; tag is derived from filename.
  return { tag: defaultTagFromPath(s), path: s };
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

  const referenceImagePaths = Array.isArray(cfg.referenceImagePaths)
    ? cfg.referenceImagePaths
        .map((x) => {
          const tag = sanitizeTag((x as any)?.tag);
          const p = cleanString((x as any)?.path);
          if (!p) return undefined;
          return { tag, path: p };
        })
        .filter((x): x is { tag: string; path: string } => Boolean(x))
    : undefined;

  const referenceImagesRaw = Array.isArray(cfg.referenceImages) ? cfg.referenceImages : undefined;
  const referenceImages = referenceImagesRaw?.length
    ? referenceImagesRaw
        .map((img) => {
          const tag = sanitizeTag((img as any)?.tag);
          const mt = cleanString((img as any)?.mimeType);
          const b64 = cleanString((img as any)?.base64);
          if (!mt || !b64) return undefined;
          const fn = cleanString((img as any)?.filename);
          return fn ? { tag, mimeType: mt, base64: b64, filename: fn } : { tag, mimeType: mt, base64: b64 };
        })
        .filter((x): x is { tag: string; mimeType: string; base64: string; filename?: string } => Boolean(x))
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
    referenceImagePaths: referenceImagePaths && referenceImagePaths.length ? (referenceImagePaths as any) : undefined,
    referenceImages: referenceImages && referenceImages.length ? (referenceImages as any) : undefined,
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
    subcktIntegration: cfg.subcktIntegration,
  };
}

export function mergeRunConfig(cli: {
  question?: unknown;
  baselineNetlist?: unknown;
  baselineImage?: unknown;
  refImage?: unknown;
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

  // Generic reference images: --ref-image tag=path (repeatable)
  const refSpecs = Array.isArray((cli as any).refImage) ? (cli as any).refImage : (cli as any).refImage ? [(cli as any).refImage] : [];
  const parsedRefs = refSpecs.map(parseRefImageSpec).filter(Boolean) as Array<{ tag: string; path: string }>;
  if (parsedRefs.length) {
    merged.referenceImagePaths = parsedRefs as any;
  }

  // Legacy alias: --trace-image <path> (repeatable). Map into referenceImagePaths too.
  if (Array.isArray((cli as any).traceImage)) {
    const t = (cli as any).traceImage.map((p: any) => cleanString(p)).filter(Boolean);
    if (t.length) merged.traceImagePaths = t as string[];
  } else {
    const t1 = cleanString((cli as any).traceImage);
    if (t1) merged.traceImagePaths = [t1];
  }

  const legacyTrace = Array.isArray(merged.traceImagePaths) ? merged.traceImagePaths : [];
  if (legacyTrace.length) {
    const legacyTagged = legacyTrace.map((p) => ({ tag: defaultTagFromPath(p), path: p }));
    const existing = Array.isArray((merged as any).referenceImagePaths) ? ((merged as any).referenceImagePaths as any[]) : [];
    const combined = [...existing, ...legacyTagged].filter((x) => x && cleanString(x.path));
    if (combined.length) (merged as any).referenceImagePaths = combined;
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
