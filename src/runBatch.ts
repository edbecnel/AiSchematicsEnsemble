import "dotenv/config";
import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { execa } from "execa";

import { makeRunDir } from "./util/runDir.js";
import { readTextIfExists, writeJson, writeText } from "./util/io.js";
import { loadImageAsBase64 } from "./util/image.js";
import { bundleSpiceIncludes } from "./util/spiceIncludes.js";
import { askOpenAI } from "./providers/openai.js";
import { askGrok } from "./providers/xai.js";
import { askGemini } from "./providers/gemini.js";
import { askClaude } from "./providers/anthropic.js";
import { buildEnsemblePrompt, parseEnsembleOutputs } from "./ensemble.js";
import { parseNetlist } from "./netlist/parse.js";
import { netlistToDot } from "./netlist/graph.js";
import { writeReportDocx } from "./report/docx.js";
import { writeReportPdf } from "./report/pdf.js";
import { convertDocxToPdfViaLibreOffice } from "./report/docxToPdf.js";
import type { InputImage, ModelAnswer, ProviderName } from "./types.js";

export type RunBatchOptions = {
  questionPath?: string;
  questionText?: string;
  questionFilename?: string;
  baselineNetlistPath?: string;
  baselineNetlistText?: string;
  baselineNetlistFilename?: string;
  baselineImagePath?: string;
  baselineImage?: InputImage;
  bundleIncludes?: boolean;
  outdir?: string;
  /** DPI for schematic.png rendering (Graphviz). */
  schematicDpi?: number;
  openaiModel?: string;
  grokModel?: string;
  geminiModel?: string;
  claudeModel?: string;
  /** Providers to query in the fanout step. If omitted, runs all providers. */
  enabledProviders?: ProviderName[];
  /** If true, may prompt for missing baseline inputs when run in a TTY. */
  allowPrompts?: boolean;
};

export type RunBatchResult = {
  runDir: string;
  outputs: {
    reportDocx: string;
    reportPdf: string;
    finalCir: string;
    finalMd: string;
    schematicDot: string;
    schematicPng?: string;
    schematicSvg?: string;
    baselineCir?: string;
    baselineOriginalCir?: string;
    baselineIncludesJson?: string;
    baselineImage?: string;
    answersJson: string;
  };
};

export type RunBatchLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type BaselineNetlist = { text?: string; sourcePath?: string };

async function maybePromptForBaselineNetlist(existingPath?: string): Promise<BaselineNetlist> {
  if (!process.stdin.isTTY) return {};

  const { createInterface } = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");

  const rl = createInterface({ input, output });
  try {
    const yn = (await rl.question("No baseline netlist provided. Add one now? [y/N]: ")).trim().toLowerCase();
    if (!(yn === "y" || yn === "yes")) return {};

    const mode = (await rl.question("Provide baseline as (f)ile path or (p)aste? [f/p]: ")).trim().toLowerCase();

    if (mode.startsWith("f")) {
      const fp = (await rl.question("Path to netlist file (.cir): ")).trim();
      if (!fp) return {};
      const ok = await fs.pathExists(fp);
      if (!ok) return {};
      const text = await fs.readFile(fp, "utf-8");
      return { text, sourcePath: fp };
    }

    console.log(chalk.cyan("Paste SPICE netlist now. End with a line containing only ---END---"));
    const lines: string[] = [];
    while (true) {
      const line = await rl.question("");
      if (line.trim() === "---END---") break;
      lines.push(line);
    }
    const pasted = lines.join("\n").trim();
    return pasted ? { text: pasted } : {};
  } finally {
    rl.close();
  }
}

async function loadBaselineNetlist(pathMaybe?: string, allowPrompts = true): Promise<BaselineNetlist> {
  if (pathMaybe && pathMaybe.trim()) {
    const fromFile = await readTextIfExists(pathMaybe);
    if (fromFile && fromFile.trim()) return { text: fromFile, sourcePath: pathMaybe };
  }
  if (!allowPrompts) return {};
  return maybePromptForBaselineNetlist(pathMaybe);
}

async function maybePromptForBaselineImage(existingPath?: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;

  const { createInterface } = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");

  const rl = createInterface({ input, output });
  try {
    const yn = (await rl.question("Add a schematic screenshot image? [y/N]: ")).trim().toLowerCase();
    if (!(yn === "y" || yn === "yes")) return undefined;

    const fp = (await rl.question("Path to image file (.png/.jpg/.jpeg/.webp): ")).trim();
    if (!fp) return undefined;
    const ok = await fs.pathExists(fp);
    if (!ok) return undefined;
    return fp;
  } finally {
    rl.close();
  }
}

async function resolveBaselineImage(pathMaybe?: string, allowPrompts = true): Promise<string | undefined> {
  if (pathMaybe && pathMaybe.trim()) return pathMaybe;
  if (!allowPrompts) return undefined;
  return maybePromptForBaselineImage(pathMaybe);
}

function defaultLogger(): RunBatchLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}

function extFromMimeType(mimeType: string | undefined): string {
  const mt = String(mimeType || "").toLowerCase();
  if (mt === "image/png") return ".png";
  if (mt === "image/jpeg" || mt === "image/jpg") return ".jpg";
  if (mt === "image/webp") return ".webp";
  return ".bin";
}

const ALL_PROVIDERS: ProviderName[] = ["openai", "xai", "google", "anthropic"];

function providersWithApiKeysFromEnv(): ProviderName[] {
  const out: ProviderName[] = [];
  if (process.env.OPENAI_API_KEY) out.push("openai");
  if (process.env.XAI_API_KEY) out.push("xai");
  if (process.env.GEMINI_API_KEY) out.push("google");
  if (process.env.ANTHROPIC_API_KEY) out.push("anthropic");
  return out;
}

function normalizeEnabledProviders(enabled?: ProviderName[]): ProviderName[] {
  // If the caller did not explicitly choose providers, default to those that have keys.
  // This avoids noisy warnings (and failed calls) for providers the user isn't using.
  if (enabled === undefined) return providersWithApiKeysFromEnv();
  const set = new Set<ProviderName>();
  for (const p of enabled) {
    if (p === "openai" || p === "xai" || p === "google" || p === "anthropic") set.add(p);
  }
  return Array.from(set);
}

function modelForProvider(provider: ProviderName, opts: RunBatchOptions): string {
  switch (provider) {
    case "openai":
      return opts.openaiModel ?? "gpt-5.2";
    case "xai":
      return opts.grokModel ?? "grok-4";
    case "google":
      return opts.geminiModel ?? "gemini-2.5-flash";
    case "anthropic":
      return opts.claudeModel ?? "claude-sonnet-4-5-20250929";
  }
}

async function askProvider(args: {
  provider: ProviderName;
  prompt: string;
  model: string;
  image?: InputImage;
  maxTokens?: number;
}): Promise<ModelAnswer> {
  switch (args.provider) {
    case "openai":
      return askOpenAI(args.prompt, args.model, args.image);
    case "xai":
      return askGrok(args.prompt, args.model, args.image);
    case "google":
      return askGemini(args.prompt, args.model, args.image);
    case "anthropic":
      return askClaude(args.prompt, args.model, args.maxTokens ?? 1800, args.image);
  }
}

export async function runBatch(opts: RunBatchOptions, logger: RunBatchLogger = defaultLogger()): Promise<RunBatchResult> {
  const allowPrompts = opts.allowPrompts ?? true;

  const enabledProviders = normalizeEnabledProviders(opts.enabledProviders);
  if (!enabledProviders.length) {
    throw new Error(
      opts.enabledProviders === undefined
        ? "No providers enabled (no API keys detected). Set OPENAI_API_KEY/XAI_API_KEY/GEMINI_API_KEY/ANTHROPIC_API_KEY, or explicitly set enabledProviders in the config/UI."
        : "No providers enabled. Select at least one provider.",
    );
  }

  const question = opts.questionText?.trim()
    ? opts.questionText
    : opts.questionPath
      ? await readTextIfExists(opts.questionPath)
      : undefined;
  if (!question?.trim()) {
    throw new Error(
      opts.questionPath
        ? `Could not read question file: ${opts.questionPath}`
        : "Missing required question input (provide questionPath or questionText)",
    );
  }

  const runDir = await makeRunDir(opts.outdir ?? "runs");
  await fs.mkdirp(path.join(runDir, "answers"));
  logger.info(`Run directory: ${runDir}`);

  // Persist embedded question for traceability
  if (opts.questionText?.trim() && !opts.questionPath) {
    const qName = (opts.questionFilename || "question.md").replace(/[^a-zA-Z0-9._-]/g, "_") || "question.md";
    await writeText(path.join(runDir, qName), opts.questionText);
  }

  // Baseline netlist
  const baselineLoaded = opts.baselineNetlistText?.trim()
    ? { text: opts.baselineNetlistText, sourcePath: undefined }
    : await loadBaselineNetlist(opts.baselineNetlistPath, allowPrompts);
  let baselineNetlist = baselineLoaded.text;
  const baselineNetlistSourcePath = baselineLoaded.sourcePath;

  let baselineOriginalCir: string | undefined;
  let baselineIncludesJson: string | undefined;
  let baselineCir: string | undefined;

  if (baselineNetlist) {
    if (opts.bundleIncludes && baselineNetlistSourcePath) {
      const bundled = await bundleSpiceIncludes({
        netlistText: baselineNetlist,
        baselineFilePath: baselineNetlistSourcePath,
        runDir,
        includesDirName: "includes",
      });

      baselineOriginalCir = path.join(runDir, "baseline_original.cir");
      baselineCir = path.join(runDir, "baseline.cir");
      baselineIncludesJson = path.join(runDir, "baseline_includes.json");

      await writeText(baselineOriginalCir, baselineNetlist);
      await writeText(baselineCir, bundled.bundledNetlist);
      await writeJson(baselineIncludesJson, {
        copied: bundled.copied.map((c) => ({
          directive: c.directive,
          originalSpecifier: c.originalSpecifier,
          resolvedSourcePath: c.resolvedSourcePath,
          destPath: c.destPath,
        })),
        missing: bundled.missing,
      });

      if (bundled.missing.length) {
        logger.warn(`Bundled includes: copied ${bundled.copied.length}, missing ${bundled.missing.length}`);
      } else {
        logger.info(`Bundled includes: copied ${bundled.copied.length}`);
      }

      // Use rewritten netlist for prompts
      baselineNetlist = bundled.bundledNetlist;
    } else {
      if (opts.bundleIncludes && !baselineNetlistSourcePath) {
        logger.warn("--bundle-includes was set, but the baseline netlist was pasted (no source file path). Skipping bundling.");
      }
      baselineCir = path.join(runDir, "baseline.cir");
      await writeText(baselineCir, baselineNetlist);
    }
  }

  // Baseline image
  const baselineImagePath = opts.baselineImage ? undefined : await resolveBaselineImage(opts.baselineImagePath, allowPrompts);

  let baselineImage: InputImage | undefined;
  let baselineImageFilename: string | undefined;
  let baselineImageSavedPath: string | undefined;

  if (opts.baselineImage) {
    baselineImage = opts.baselineImage;
    baselineImageFilename = baselineImage.filename || "baseline_schematic";
    const ext = extFromMimeType(baselineImage.mimeType);
    baselineImageSavedPath = path.join(runDir, `baseline_schematic${ext}`);
    await fs.writeFile(baselineImageSavedPath, Buffer.from(baselineImage.base64, "base64"));
  }

  if (baselineImagePath) {
    baselineImage = await loadImageAsBase64(baselineImagePath);
    baselineImageFilename = baselineImage.filename || "baseline_schematic";

    const ext = path.extname(baselineImagePath);
    baselineImageSavedPath = path.join(runDir, `baseline_schematic${ext}`);
    await fs.copy(baselineImagePath, baselineImageSavedPath);
  }

  // Fanout prompt
  const fanoutPrompt =
    question.trim() +
    (baselineNetlist
      ? `\n\nBASELINE NETLIST (current topology):\n\n\`\`\`spice\n${baselineNetlist.trim()}\n\`\`\`\n`
      : "") +
    (baselineImageFilename ? "\n\nNOTE: A schematic screenshot image is provided as context.\n" : "");

  // Fanout
  logger.info("Querying models...");

  // Best-effort env-key warnings (providers will still return structured errors if called without a key).
  if (enabledProviders.includes("openai") && !process.env.OPENAI_API_KEY) logger.warn("Warning: OPENAI_API_KEY not set. OpenAI calls will fail.");
  if (enabledProviders.includes("xai") && !process.env.XAI_API_KEY) logger.warn("Warning: XAI_API_KEY not set. Grok calls will fail.");
  if (enabledProviders.includes("google") && !process.env.GEMINI_API_KEY) logger.warn("Warning: GEMINI_API_KEY not set. Gemini calls will fail.");
  if (enabledProviders.includes("anthropic") && !process.env.ANTHROPIC_API_KEY) logger.warn("Warning: ANTHROPIC_API_KEY not set. Claude calls will fail.");

  const fanoutJobs = enabledProviders.map((provider) => {
    const model = modelForProvider(provider, opts);
    const maxTokens = provider === "anthropic" ? 1200 : undefined;
    return askProvider({ provider, prompt: fanoutPrompt, model, image: baselineImage, maxTokens });
  });
  const answers = await Promise.all<ModelAnswer>(fanoutJobs);

  const answersJson = path.join(runDir, "answers.json");
  await writeJson(answersJson, answers);

  for (const a of answers) {
    const safeModel = a.model.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fname = `${a.provider}_${safeModel}.md`;
    const body = a.error ? `# ERROR\n\n${a.error}` : a.text;
    await writeText(path.join(runDir, "answers", fname), `# ${a.provider} | ${a.model}\n\n${body}\n`);
  }

  // Ensemble
  // Prefer Claude as the ensembler when available, else fall back to the first enabled provider.
  const ensembleProvider: ProviderName = enabledProviders.includes("anthropic") ? "anthropic" : enabledProviders[0];
  const ensembleModel = modelForProvider(ensembleProvider, opts);
  if (ensembleProvider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    logger.warn("Warning: ANTHROPIC_API_KEY not set. Ensemble step will fail.");
  }

  logger.info(`Ensembling with ${ensembleProvider}...`);
  const ensemblePrompt = buildEnsemblePrompt({
    question,
    baselineNetlist,
    baselineImageFilename: baselineImageFilename ? path.basename(baselineImageSavedPath ?? baselineImageFilename) : undefined,
    answers,
  });

  const ensembleMaxTokens = ensembleProvider === "anthropic" ? 4800 : undefined;
  const ensemble = await askProvider({
    provider: ensembleProvider,
    prompt: ensemblePrompt,
    model: ensembleModel,
    image: baselineImage,
    maxTokens: ensembleMaxTokens,
  });
  await writeText(path.join(runDir, "ensemble_raw.txt"), ensemble.text || ensemble.error || "");

  if (ensemble.error || !ensemble.text) {
    throw new Error(`Ensemble failed: ${ensemble.error ?? "No text returned"}`);
  }

  const out = parseEnsembleOutputs(ensemble.text);
  const finalMd = path.join(runDir, "final.md");
  const finalCir = path.join(runDir, "final.cir");
  const finalJson = path.join(runDir, "final.json");

  const missingSpice = !out.spiceNetlist.trim();
  const missingJson = !out.circuitJson.trim();

  if (missingSpice) {
    logger.error(
      "Ensemble output did not include a <spice_netlist> block (or a recoverable SPICE code block). final.cir will contain an error placeholder.",
    );
  }
  if (missingJson) {
    logger.warn(
      "Ensemble output did not include a <circuit_json> block (or a recoverable JSON block). final.json will contain an error placeholder.",
    );
  }

  const finalMarkdownBest = out.finalMarkdown.trim()
    ? out.finalMarkdown
    : "# Ensemble output\n\n(Ensemble did not provide <final_markdown>; see ensemble_raw.txt.)\n";

  const finalMdText =
    finalMarkdownBest +
    (missingSpice
      ? "\n> WARNING: Missing SPICE netlist block; see ensemble_raw.txt.\n"
      : "");

  const finalCirText = missingSpice
    ? [
        "* ERROR: Ensemble output missing <spice_netlist> block.",
        "* See ensemble_raw.txt for the full model output.",
        "* baseline.cir contains the baseline topology netlist.",
        ".end",
        "",
      ].join("\n")
    : out.spiceNetlist;

  const finalJsonText = missingJson
    ? JSON.stringify(
        {
          error: "Ensemble output missing <circuit_json> block.",
          assumptions: [],
          probes: [],
          bom: [],
          notes: ["See ensemble_raw.txt for full model output."],
        },
        null,
        2,
      ) + "\n"
    : out.circuitJson;

  await writeText(finalMd, finalMdText);
  await writeText(finalCir, finalCirText);
  await writeText(finalJson, finalJsonText);

  // Connectivity diagram
  logger.info("Generating connectivity diagram...");
  let schematicPng: string | undefined;
  let schematicSvg: string | undefined;
  const schematicDot = path.join(runDir, "schematic.dot");
  try {
    const finalNetlist = out.spiceNetlist || "";
    const baselineNetlistText = baselineNetlist || "";

    let sourceLabel = "final";
    let schematicNetlist = finalNetlist;

    if (!finalNetlist.trim() && baselineNetlistText.trim()) {
      sourceLabel = "baseline";
      schematicNetlist = baselineNetlistText;
      logger.warn("Final netlist is empty; generating schematic from baseline netlist instead.");
    }

    let comps = parseNetlist(schematicNetlist);
    if (comps.length === 0 && sourceLabel !== "baseline" && baselineNetlistText.trim()) {
      const baselineComps = parseNetlist(baselineNetlistText);
      if (baselineComps.length) {
        sourceLabel = "baseline";
        schematicNetlist = baselineNetlistText;
        comps = baselineComps;
        logger.warn("Final netlist did not yield any components; generating schematic from baseline netlist instead.");
      }
    }

    let dot = netlistToDot(comps);
    if (sourceLabel !== "final") {
      dot = dot.replace(
        "digraph G {",
        `digraph G {\n  // NOTE: Rendered from ${sourceLabel} netlist because final netlist was empty or unparseable.`,
      );
    }
    await writeText(schematicDot, dot);

    const pngPath = path.join(runDir, "schematic.png");
    const svgPath = path.join(runDir, "schematic.svg");
    try {
      const dpiCandidate = opts.schematicDpi as number;
      const dpi = Number.isFinite(dpiCandidate) && dpiCandidate > 0 ? dpiCandidate : 600;
      await execa("dot", [`-Gdpi=${dpi}`, "-Tpng", schematicDot, "-o", pngPath]);
      schematicPng = pngPath;
      logger.info("Rendered schematic.png via Graphviz.");
    } catch (e: any) {
      if (String(e?.code ?? "") === "ENOENT") {
        logger.warn("Graphviz 'dot' not found; wrote schematic.dot only.");
      } else {
        logger.warn("Graphviz failed to render schematic.png; wrote schematic.dot only.");
      }
    }

    // SVG is ideal for zooming/printing.
    if (schematicPng || schematicNetlist.trim()) {
      try {
        await execa("dot", ["-Tsvg", schematicDot, "-o", svgPath]);
        schematicSvg = svgPath;
        logger.info("Rendered schematic.svg via Graphviz.");
      } catch (e: any) {
        if (String(e?.code ?? "") !== "ENOENT") {
          logger.warn("Graphviz failed to render schematic.svg; continuing.");
        }
      }
    }
  } catch (e: any) {
    logger.warn(`Schematic generation skipped: ${String(e?.message ?? e)}`);
  }

  // Word report
  logger.info("Writing report.docx...");
  const reportDocx = path.join(runDir, "report.docx");

  const answersForReport = answers.map((a) => {
    const body = a.error ? `# ERROR\n\n${a.error}` : (a.text || "(No output)");
    return { heading: `${a.provider} | ${a.model}`, markdown: body };
  });

  await writeReportDocx({
    outPath: reportDocx,
    title: "AI Schematics — Ensemble Report",
    question,
    finalMarkdown: finalMarkdownBest,
    spiceNetlist: out.spiceNetlist,
    baselineSchematicPath: baselineImageSavedPath,
    connectivitySchematicPngPath: schematicPng,
    answers: answersForReport,
  });

  const reportPdf = path.join(runDir, "report.pdf");
  logger.info("Writing report.pdf...");

  const converted = await convertDocxToPdfViaLibreOffice({ docxPath: reportDocx, pdfOutPath: reportPdf });
  if (converted.ok) {
    logger.info(`Rendered report.pdf from report.docx via ${converted.method}.`);
  } else {
    logger.warn(`DOCX→PDF conversion not available (${converted.reason}); falling back to built-in PDF renderer.`);
    await writeReportPdf({
      outPath: reportPdf,
      title: "AI Schematics — Ensemble Report",
      question,
      finalMarkdown: finalMarkdownBest,
      spiceNetlist: out.spiceNetlist,
      baselineSchematicPath: baselineImageSavedPath,
      connectivitySchematicPngPath: schematicPng,
      answers: answersForReport,
    });
  }

  logger.info("Done.");

  return {
    runDir,
    outputs: {
      reportDocx,
      reportPdf,
      finalCir,
      finalMd,
      schematicDot,
      schematicPng,
      schematicSvg,
      baselineCir,
      baselineOriginalCir,
      baselineIncludesJson,
      baselineImage: baselineImageSavedPath,
      answersJson,
    },
  };
}
