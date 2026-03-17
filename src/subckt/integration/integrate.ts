/**
 * Phase H.5 — SUBCKT Ensemble integration, manual-first.
 *
 * Orchestrates SUBCKT model generation for all components listed in a
 * SubcktIntegrationConfig, patches the final .cir with .include directives,
 * and emits subckt-manifest.json into the run directory.
 *
 * Designed to be called from runBatch() / executeRun() after the ensemble
 * has produced a final .cir but before the report and outputs are written.
 *
 * Guardrails:
 *  - Never silently patches .cir — patchFinalCir must be explicitly true.
 *  - If requireValidationPass is true and any model fails validation, the
 *    result status is "failed" but outputs are still written for review.
 *  - Each component is generated independently: one failure does not stop
 *    processing of the remaining list.
 */

import path from "node:path";
import fs from "fs-extra";

import { createSubckt } from "../create.js";
import { patchResult } from "./patchCir.js";
import { detectMissingSubckts } from "../autoDetect/detector.js";
import type {
  SubcktIntegrationConfig,
  SubcktIntegrationResult,
  SubcktIntegrationArtifact,
  SubcktComponentSpec,
} from "../types.js";

// ---------------------------------------------------------------------------
// Main integration entry point
// ---------------------------------------------------------------------------

export interface RunSubcktIntegrationArgs {
  /** Integration config from the run config. */
  config: SubcktIntegrationConfig;
  /** Run root directory (where subckt-manifest.json and the subckt_runs/ dir will live). */
  runDir: string;
  /**
   * The final .cir text from the ensemble step.
   * Used when patchFinalCir is true to produce an updated .cir with .include lines.
   */
  finalCirText: string;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface RunSubcktIntegrationOutput {
  /** Integration-level status. */
  status: "succeeded" | "partial" | "failed" | "skipped";
  /** Canonical result record (written to subckt-manifest.json). */
  result: SubcktIntegrationResult;
  /** Absolute path to the written subckt-manifest.json. */
  manifestPath: string;
  /** Per-component generation errors, if any. */
  componentErrors: Array<{ componentName: string; error: string }>;
}

export async function runSubcktIntegration(
  args: RunSubcktIntegrationArgs,
): Promise<RunSubcktIntegrationOutput> {
  const { config, runDir, finalCirText } = args;
  const log = args.log ?? ((m: string) => console.log(m));

  // --- Guard: disabled or no components ---
  if (config.mode === "disabled") {
    return makeSkippedOutput(runDir, finalCirText);
  }

  let components: SubcktComponentSpec[] = config.components ?? [];

  // --- Phase J.5: auto_detect ---
  if (components.length === 0 && config.mode === "auto_detect") {
    log("subckt-integration: auto_detect mode — scanning netlist for missing SUBCKT definitions...");
    const detection = detectMissingSubckts(finalCirText);
    if (detection.candidates.length === 0) {
      log("  auto_detect: no missing high/medium confidence models detected — skipping.");
      return makeSkippedOutput(runDir, finalCirText);
    }
    const eligible = detection.candidates.filter((c) => c.eligibleForAutoGeneration);
    log(`  auto_detect: ${detection.candidates.length} candidate(s) found, ${eligible.length} eligible for generation.`);
    for (const c of detection.candidates) {
      if (!c.eligibleForAutoGeneration) {
        log(`  auto_detect: [${c.confidence}] ${c.modelName} — skipping (not high confidence)`);
        continue;
      }
      log(`  auto_detect: [${c.confidence}] ${c.modelName} — will generate (refs: ${c.refdesignators.join(", ")})`);
    }
    components = eligible.map((c) => ({
      componentName: c.modelName,
      refdes: c.refdesignators[0],
    }));
  } else if (components.length === 0) {
    log("subckt-integration: no components specified — skipping.");
    return makeSkippedOutput(runDir, finalCirText);
  }

  log(`\n=== SUBCKT Integration (mode: ${config.mode}) — ${components.length} component(s) ===`);

  const subcktRunsDir = path.join(runDir, "subckt_runs");
  const generatedArtifacts: SubcktIntegrationArtifact[] = [];
  const generatedLibPaths: string[] = [];
  const componentErrors: Array<{ componentName: string; error: string }> = [];
  const reportSummary: string[] = [];

  for (const spec of components) {
    const label = spec.refdes ? `${spec.componentName} (${spec.refdes})` : spec.componentName;
    log(`  Generating: ${label}`);

    try {
      const createOut = await createSubckt({
        componentName: spec.componentName,
        manufacturer: spec.manufacturer,
        datasheetPdfPath: spec.datasheetPdfPath,
        datasheetUrl: spec.datasheetUrl,
        abstractionLevel: spec.abstractionLevel ?? "behavioral",
        outdir: subcktRunsDir,
        runSmokeTest: true,
        providerRoles: config.providerRoles,
        log,
      });

      if (!createOut.result || createOut.status === "failed") {
        const msg = createOut.warnings.join("; ") || "generation failed";
        componentErrors.push({ componentName: spec.componentName, error: msg });
        reportSummary.push(`⚠ ${label}: generation failed — ${msg}`);
        log(`  ✗ ${label}: ${msg}`);
        continue;
      }

      const libPath = createOut.outputs.libPath!;
      generatedLibPaths.push(libPath);

      const artifact: SubcktIntegrationArtifact = {
        componentId: spec.refdes ?? spec.componentName,
        modelName: createOut.result.modelName,
        libArtifactPath: libPath,
        validationStatus: createOut.result.validation.status,
      };
      generatedArtifacts.push(artifact);

      const validNote =
        createOut.result.validation.status === "syntax-valid"
          ? "validated ✓"
          : `validation: ${createOut.result.validation.status}`;

      reportSummary.push(`• ${label}: ${createOut.result.modelName} — ${validNote}`);
      log(`  ✓ ${label}: ${createOut.result.modelName} [${createOut.result.validation.status}]`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      componentErrors.push({ componentName: spec.componentName, error: msg });
      reportSummary.push(`✗ ${label}: unexpected error — ${msg}`);
      log(`  ✗ ${label}: ${msg}`);
    }
  }

  // .cir patching
  let updatedCirText: string | undefined;
  if (config.patchFinalCir && generatedLibPaths.length) {
    const directives = generatedArtifacts.map((a) => ({
      modelName: a.modelName,
      // Use filename only — .include is relative to the run directory when
      // the lib is placed inside it, otherwise use the full absolute path.
      libPath: path.relative(runDir, a.libArtifactPath).replace(/\\/g, "/"),
    }));
    const pr = patchResult(finalCirText, directives);
    if (pr.changed) {
      updatedCirText = pr.patched;
      log(`  Patched final.cir with ${directives.length} .include directive(s).`);
    }
  }

  // Build manifest
  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: config.mode,
    components: generatedArtifacts,
    errors: componentErrors,
    patchedCir: Boolean(updatedCirText),
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  const manifestPath = path.join(runDir, "subckt-manifest.json");
  await fs.outputFile(manifestPath, manifestJson, "utf-8");

  const result: SubcktIntegrationResult = {
    generatedModels: generatedArtifacts,
    generatedLibPaths,
    updatedCirText,
    manifestJson,
    reportSummary,
  };

  // Determine overall status
  const allFailed = generatedArtifacts.length === 0 && componentErrors.length > 0;
  const anyFailed = componentErrors.length > 0;
  const validationFailed =
    config.requireValidationPass &&
    generatedArtifacts.some((a) => a.validationStatus === "failed-validation");

  const status =
    allFailed || validationFailed
      ? "failed"
      : anyFailed
        ? "partial"
        : "succeeded";

  log(
    `=== SUBCKT Integration done: ${generatedArtifacts.length} model(s) generated` +
      (componentErrors.length ? `, ${componentErrors.length} error(s)` : "") +
      ` [${status}] ===`,
  );

  return { status, result, manifestPath, componentErrors };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeSkippedOutput(runDir: string, _finalCirText: string): RunSubcktIntegrationOutput {
  const result: SubcktIntegrationResult = {
    generatedModels: [],
    generatedLibPaths: [],
    updatedCirText: undefined,
    manifestJson: JSON.stringify({ skipped: true, generatedAt: new Date().toISOString() }, null, 2) + "\n",
    reportSummary: [],
  };
  return {
    status: "skipped",
    result,
    manifestPath: path.join(runDir, "subckt-manifest.json"),
    componentErrors: [],
  };
}
