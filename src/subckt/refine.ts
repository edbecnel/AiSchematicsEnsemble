/**
 * Phase B/I — SUBCKT utility: "refine" flow.
 *
 * Takes an existing .lib / .cir model file and optional updated datasheet
 * artifacts, runs an automatic syntax repair pass (Phase I), re-runs
 * validation, and — only if the model still fails — triggers a full AI
 * re-synthesis with the existing text as context.
 *
 * Phase I repair pipeline:
 *   1. `rewriteSubcktSyntax` — safe automatic syntax normalisation
 *   2. `parsePinsFromSubcktHeader` + `reconcilePins` — pin consistency check
 *   3. `buildChangeReport` — writes repair-report.md + preserves original.lib
 *   4. Validate repaired text — if passes, return succeeded WITHOUT AI
 */

import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";

import { validateSubcktCandidate, validateLibText } from "./validate/validate.js";
import { makeSubcktRunDir } from "./runDir.js";
import { createSubckt } from "./create.js";
import { rewriteSubcktSyntax } from "./repair/syntaxRewriter.js";
import { parsePinsFromSubcktHeader, reconcilePins } from "./repair/pinReconciler.js";
import { buildChangeReport } from "./repair/changeReport.js";
import type {
  SubcktLibRequest,
  SubcktLibResult,
  SubcktRunStatus,
} from "./types.js";
import type { SyntaxRewriteResult } from "./repair/syntaxRewriter.js";
import type { PinReconcileResult } from "./repair/pinReconciler.js";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface RefineSubcktInput {
  /**
   * Path to the existing .lib or .cir file to be refined.
   */
  existingModelPath: string;

  /**
   * Component name / part number — used for re-synthesis context and run dir.
   * If omitted the filename stem is used.
   */
  componentName?: string;

  /** Optional updated datasheet PDF path. */
  datasheetPdfPath?: string;
  /** Optional updated datasheet URL. */
  datasheetUrl?: string;
  /** Optional additional notes. */
  userNotes?: string;

  /**
   * When true — re-run full AI synthesis even if existing model passes
   * static validation (useful when the model is functionally wrong).
   */
  forceResynthesis?: boolean;

  /** Root directory for SUBCKT run output folders.  Defaults to "subckt_runs". */
  outdir?: string;
  /** Provider for re-synthesis.  Defaults to "anthropic". */
  provider?: "openai" | "xai" | "google" | "anthropic";
  /** Model override for re-synthesis. */
  model?: string;
  /** Run ngspice smoke test when available.  Defaults to true. */
  runSmokeTest?: boolean;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface RefineSubcktOutput {
  runId: string;
  runDir: string;
  status: SubcktRunStatus;
  result: SubcktLibResult | null;
  resynthesized: boolean;
  warnings: string[];
  /** Populated when a Phase I repair pass was executed. */
  repairResult?: {
    syntaxChanged: boolean;
    appliedChangesCount: number;
    manualReviewCount: number;
    pinMismatchCount: number;
    reportPath: string;
  };
}

// ---------------------------------------------------------------------------
// Main refine flow
// ---------------------------------------------------------------------------

export async function refineSubckt(input: RefineSubcktInput): Promise<RefineSubcktOutput> {
  const log = input.log ?? ((m: string) => console.log(m));
  const runId = crypto.randomUUID();
  const allWarnings: string[] = [];

  // Resolve component name from file stem if not provided
  const componentName =
    input.componentName ?? path.basename(input.existingModelPath, path.extname(input.existingModelPath));

  const runDir = await makeSubcktRunDir(componentName, input.outdir ?? "subckt_runs");

  log(`SUBCKT refine run ${runId}`);
  log(`Component: ${componentName}`);
  log(`Existing model: ${input.existingModelPath}`);
  log(`Run directory: ${runDir}`);

  // Read the existing model text
  const existingLibText = await fs.readFile(input.existingModelPath, "utf-8").catch((err) => {
    throw new Error(`Cannot read existing model file: ${err.message}`);
  });

  // -------------------------------------------------------------------------
  // Phase I — Syntax repair pass
  // -------------------------------------------------------------------------
  log("\n[1] Running syntax repair pass...");
  const syntaxResult: SyntaxRewriteResult = rewriteSubcktSyntax(existingLibText, componentName);

  const repairedText = syntaxResult.rewrittenText;
  const modelName = componentName.toUpperCase();

  // Pin reconciliation (no expected pins from datasheet at this point — pass empty)
  const modelPins = parsePinsFromSubcktHeader(repairedText);
  const pinReconcile: PinReconcileResult = reconcilePins(modelPins, []);

  let repairRepMd = "";
  let repairReportPath = "";
  let repairResult: RefineSubcktOutput["repairResult"];

  if (syntaxResult.changed || syntaxResult.appliedChanges.length || syntaxResult.manualReviewItems.length) {
    // Preserve the original model
    const originalPath = path.join(runDir, "original.lib");
    await fs.outputFile(originalPath, existingLibText, "utf-8");
    if (syntaxResult.changed) {
      const repairedPath = path.join(runDir, "repaired.lib");
      await fs.outputFile(repairedPath, repairedText, "utf-8");
    }

    repairRepMd = buildChangeReport({
      componentName,
      modelName,
      originalLibText: existingLibText,
      repairedLibText: repairedText,
      syntaxRewrite: syntaxResult,
      pinReconcile,
    });

    repairReportPath = path.join(runDir, "repair-report.md");
    await fs.outputFile(repairReportPath, repairRepMd, "utf-8");

    if (syntaxResult.appliedChanges.length) {
      log(`  Applied ${syntaxResult.appliedChanges.length} automatic repair(s).`);
    }
    if (syntaxResult.manualReviewItems.length) {
      allWarnings.push(`${syntaxResult.manualReviewItems.length} item(s) require manual review — see repair-report.md`);
      log(`  ⚠ ${syntaxResult.manualReviewItems.length} item(s) require manual review.`);
    }

    repairResult = {
      syntaxChanged: syntaxResult.changed,
      appliedChangesCount: syntaxResult.appliedChanges.length,
      manualReviewCount: syntaxResult.manualReviewItems.length,
      pinMismatchCount: pinReconcile.mismatches.length,
      reportPath: repairReportPath,
    };
  } else {
    log("  No syntax issues detected.");
  }

  // The text used for all subsequent validation is the repaired version
  const workingText = repairedText;

  // -------------------------------------------------------------------------
  // Validate (possibly repaired) model
  // -------------------------------------------------------------------------
  log("\n[2] Validating model...");
  const validationResult = await validateLibText(workingText, componentName, runDir, {
    runSmokeTest: input.runSmokeTest !== false,
    log,
  });
  allWarnings.push(
    ...validationResult.issues
      .filter((i) => i.severity === "critical" || i.severity === "high")
      .map((i) => `[${i.severity.toUpperCase()}] ${i.code}: ${i.message}`),
  );

  const passesValidation = validationResult.status !== "failed-validation";

  if (passesValidation && !input.forceResynthesis) {
    // Existing (possibly repaired) model is good — write it and return
    log("\nModel passes validation — no resynthesis required.");
    const outLibPath = path.join(runDir, `${componentName.toLowerCase()}.lib`);
    await fs.outputFile(outLibPath, workingText, "utf-8");

    // Parse the model's pins from the .SUBCKT line
    const subcktMatch = workingText.match(/^\.SUBCKT\s+(\S+)\s+(.*)/m);
    const rawPins = subcktMatch
      ? subcktMatch[2].trim().split(/\s+/).map((name, idx) => ({
          pinOrder: idx + 1,
          pinName: name,
          direction: undefined,
          description: undefined,
        }))
      : [];

    const libResult: SubcktLibResult = {
      runId,
      modelName: subcktMatch ? subcktMatch[1] : componentName.toUpperCase(),
      libText: workingText,
      pins: rawPins,
      extractedFacts: [],
      assumptions: [],
      limitations: repairResult ? [`Repair report: ${repairResult.reportPath}`] : [],
      validation: validationResult,
      completedAt: new Date().toISOString(),
    };

    await fs.outputJson(path.join(runDir, "generated.model.json"), libResult, { spaces: 2 });

    return {
      runId,
      runDir,
      status: "succeeded",
      result: libResult,
      resynthesized: false,
      warnings: allWarnings,
      repairResult,
    };
  }

  // Model needs improvement — run full create flow with (repaired) text as notes
  log(
    passesValidation
      ? "\nForce-resynthesis requested — running full create flow."
      : "\nModel failed validation — running full create flow.",
  );

  const existingModelNote = [
    "An existing model is provided below for reference and improvement.",
    "Attempt to correct any issues while preserving the intended topology.",
    syntaxResult.changed ? "Note: the model below has already been syntax-normalised by an automatic repair pass." : "",
    `\`\`\`spice\n${workingText}\n\`\`\``,
    input.userNotes ? `\nAdditional notes: ${input.userNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const request: SubcktLibRequest = {
    runId,
    componentName,
    datasheetPdfPath: input.datasheetPdfPath,
    datasheetUrl: input.datasheetUrl,
    userNotes: existingModelNote,
  };

  const createOutput = await createSubckt({
    ...request,
    outdir: input.outdir,
    synthesisProvider: input.provider,
    synthesisModel: input.model,
    extractionProvider: input.provider,
    extractionModel: input.model,
    runSmokeTest: input.runSmokeTest,
    log,
  });

  allWarnings.push(...createOutput.warnings);

  return {
    runId: createOutput.runId,
    runDir: createOutput.runDir,
    status: createOutput.status,
    result: createOutput.result,
    resynthesized: true,
    warnings: allWarnings,
    repairResult,
  };
}
