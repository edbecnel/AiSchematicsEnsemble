/**
 * Phase B — SUBCKT utility: full "create" flow orchestrator.
 *
 * This is the single entry point for the create workflow:
 *   ingestArtifacts → extractComponentFacts → synthesizeSubcktModel
 *     → validateSubcktCandidate → package outputs
 *
 * It mirrors the pattern of executeRun() in src/core/orchestration/run.ts:
 * decisions and persistent state live in the run directory, callers get
 * back a typed result, and no individual step failure collapses the whole run.
 */

import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";

import { ingestArtifacts, persistIngestResults } from "./ingest.js";
import { extractComponentFacts } from "./extract/factExtractor.js";
import { synthesizeSubcktModel } from "./synthesis/synthesize.js";
import { validateSubcktCandidate } from "./validate/validate.js";
import { makeSubcktRunDir } from "./runDir.js";
import type { ProviderName } from "../types.js";
import type {
  SubcktLibRequest,
  SubcktLibResult,
  SubcktProviderRoleConfig,
  SubcktProviderTarget,
  SubcktRunRecord,
  SubcktRunStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface CreateSubcktInput extends SubcktLibRequest {
  /**
   * Root directory for SUBCKT run output folders.
   * Defaults to "subckt_runs".
   */
  outdir?: string;
  /** Provider for fact extraction. Defaults to "anthropic". */
  extractionProvider?: ProviderName;
  /** Provider for model synthesis. Defaults to "anthropic". */
  synthesisProvider?: ProviderName;
  /** Model override for fact extraction. */
  extractionModel?: string;
  /** Model override for synthesis. */
  synthesisModel?: string;
  /** Shared role-based provider/model overrides reused from main run config. */
  providerRoles?: SubcktProviderRoleConfig;
  /** Run ngspice smoke test when available. Defaults to true. */
  runSmokeTest?: boolean;
  /** Optional logger. */
  log?: (msg: string) => void;
}

function resolveProviderTarget(
  explicitProvider: ProviderName | undefined,
  explicitModel: string | undefined,
  roleTarget: SubcktProviderTarget | undefined,
): SubcktProviderTarget | undefined {
  const provider = roleTarget?.provider ?? explicitProvider;
  const model = roleTarget?.model ?? explicitModel;
  return provider || model ? { provider: provider ?? "anthropic", model } : undefined;
}

export interface CreateSubcktOutput {
  runId: string;
  runDir: string;
  status: SubcktRunStatus;
  result: SubcktLibResult | null;
  warnings: string[];
  outputs: {
    libPath?: string;
    modelJsonPath?: string;
    extractedFactsJsonPath?: string;
    extractedFactsMdPath?: string;
    validationJsonPath?: string;
    smokeTestCirPath?: string;
    smokeTestLogPath?: string;
    kicadNotesMdPath?: string;
    requestJsonPath: string;
  };
}

// ---------------------------------------------------------------------------
// KiCad notes builder (Phase G placeholder — produces usable minimal output)
// ---------------------------------------------------------------------------

function buildKicadNotesMd(result: SubcktLibResult): string {
  const { modelName, pins, validation, assumptions, limitations, smokeTestNetlist } = result;
  const lines: string[] = [
    `# KiCad Integration Notes: ${modelName}`,
    "",
    `## Suggested KiCad Symbol Field Values`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Spice_Model | ${modelName} |`,
    `| Spice_Netlist_Enabled | Y |`,
    `| Spice_Lib | <path-to-your-library>/${modelName}.lib |`,
    "",
    `## Pin Mapping`,
    "",
    "The generated .SUBCKT port order is:",
    "",
  ];

  for (const p of pins.sort((a, b) => a.pinOrder - b.pinOrder)) {
    const dir = p.direction ? ` [${p.direction}]` : "";
    const desc = p.description ? ` — ${p.description}` : "";
    lines.push(`${p.pinOrder}. **${p.pinName}**${dir}${desc}`);
  }

  lines.push(
    "",
    "⚠️  **Important:** KiCad symbol pin numbers may NOT match the .SUBCKT port order.",
    "You must manually verify the `Spice_Pin_Sequence` or pin mapping in your symbol.",
    "",
    "### Example .SUBCKT instantiation (in a netlist or testbench):",
    "```spice",
    `X1 ${pins.map((p) => p.pinName.toLowerCase()).join(" ")} ${modelName}`,
    "```",
  );

  lines.push(
    "",
    "## Example Testbench / Bench Verification Notes",
    "",
    "Use a simple verification setup before relying on the model in a larger design:",
    "",
    "- Start with a minimal testbench containing only the power rails, the generated `.SUBCKT`, and one representative stimulus source.",
    "- Drive one input or control pin at a time and verify that the output polarity, threshold behavior, and pin roles match the datasheet expectations.",
    "- Confirm supply current, output swing, and any obvious clamp/limit behavior against the datasheet or bench measurements.",
    "- If the device is timing-sensitive, run at least one transient test with realistic rise/fall times rather than only ideal DC checks.",
    "- Treat mismatches as either a pin-mapping problem or a model-limitation problem first; do not assume the surrounding circuit is wrong.",
  );

  if (validation.ngspiceRan) {
    lines.push(
      "",
      "### Smoke-test artifacts",
      "",
      validation.smokeTestPassed
        ? "- An `ngspice` smoke test was executed successfully for this generated model."
        : "- An `ngspice` smoke test was attempted but did not pass cleanly; review the validation issues and log output.",
      "- Review `validation.json` for the structured validation result.",
      "- If present in the run folder, use `smoke-test.cir` as the starting point for further simulation refinement.",
      "- If present in the run folder, review `smoke-test.log` for parser/runtime diagnostics.",
    );
  } else {
    lines.push(
      "",
      "### Smoke-test follow-up",
      "",
      "- `ngspice` smoke testing was not executed in this run.",
      "- Create a minimal transient or DC operating-point testbench and verify the generated model before integrating it into a larger schematic.",
    );
  }

  if (smokeTestNetlist?.trim()) {
    lines.push(
      "",
      "### Example smoke-test netlist excerpt",
      "```spice",
      smokeTestNetlist.trim(),
      "```",
    );
  }

  lines.push("", "## Validation Summary", "");
  lines.push(`**Status:** \`${validation.status}\``);

  if (validation.issues.length) {
    lines.push("", "**Issues:**", "");
    for (const issue of validation.issues) {
      lines.push(`- [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}`);
    }
  }

  if (assumptions.length) {
    lines.push("", "## Modelling Assumptions", "");
    for (const a of assumptions) lines.push(`- ${a}`);
  }

  if (limitations.length) {
    lines.push("", "## Known Limitations", "");
    for (const l of limitations) lines.push(`- ${l}`);
  }

  lines.push(
    "",
    "---",
    "⚠️ This model is a **simulation approximation** generated by AI.",
    "Always verify against the original datasheet before use in production.",
    "",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Persist helpers
// ---------------------------------------------------------------------------

async function persistRunRecord(record: SubcktRunRecord, runDir: string): Promise<string> {
  const recordPath = path.join(runDir, "request.json");
  await fs.outputJson(recordPath, record, { spaces: 2 });
  return recordPath;
}

// ---------------------------------------------------------------------------
// Main create flow
// ---------------------------------------------------------------------------

/**
 * Execute the full SUBCKT utility create workflow.
 *
 * Returns a CreateSubcktOutput even when steps fail — partial results are
 * preserved and warnings summarize what happened.
 */
export async function createSubckt(input: CreateSubcktInput): Promise<CreateSubcktOutput> {
  const log = input.log ?? ((m: string) => console.log(m));
  const allWarnings: string[] = [];

  const runId = input.runId ?? crypto.randomUUID();
  const runDir = await makeSubcktRunDir(input.componentName, input.outdir ?? "subckt_runs");
  const artifactDir = path.join(runDir, "artifacts");

  log(`SUBCKT run ${runId}`);
  log(`Component: ${input.componentName}${input.partNumber ? ` (${input.partNumber})` : ""}`);
  log(`Run directory: ${runDir}`);

  const request: SubcktLibRequest = {
    runId,
    componentName: input.componentName,
    manufacturer: input.manufacturer,
    partNumber: input.partNumber,
    userNotes: input.userNotes,
    datasheetUrl: input.datasheetUrl,
    datasheetPdfPath: input.datasheetPdfPath,
    knownPinMap: input.knownPinMap,
    abstractionLevel: input.abstractionLevel,
  };

  // Write initial run record
  const runRecord: SubcktRunRecord = {
    runId,
    status: "running",
    request,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    runDir,
    outputs: {},
  };
  const requestJsonPath = await persistRunRecord(runRecord, runDir);

  const outputPaths: CreateSubcktOutput["outputs"] = { requestJsonPath };
  const extractionTarget = resolveProviderTarget(
    input.extractionProvider,
    input.extractionModel,
    input.providerRoles?.factExtraction,
  );
  const synthesisTarget = resolveProviderTarget(
    input.synthesisProvider,
    input.synthesisModel,
    input.providerRoles?.modelSynthesis,
  );

  try {
    // --- Phase C: Artifact ingestion ---
    log("\n[1/4] Ingesting artifacts...");
    const ingestResult = await ingestArtifacts({ request, artifactDir, log });
    allWarnings.push(...ingestResult.warnings);
    await persistIngestResults(ingestResult, runDir);

    // --- Phase D: Component fact extraction ---
    log("\n[2/4] Extracting component facts...");
    const factResult = await extractComponentFacts(
      {
        request,
        datasheetText: ingestResult.combinedDatasheetText,
        identifiedSections: ingestResult.artifacts.flatMap((a) =>
          a.sections.map((s) => ({ kind: s.kind, heading: s.heading, text: s.text })),
        ),
        provider: extractionTarget?.provider,
        model: extractionTarget?.model,
        log,
      },
      runDir,
    );
    allWarnings.push(...factResult.warnings);

    outputPaths.extractedFactsJsonPath = path.join(runDir, "extracted-facts.json");
    outputPaths.extractedFactsMdPath   = path.join(runDir, "extracted-facts.md");

    // --- Phase E: Model synthesis ---
    log("\n[3/4] Synthesizing .SUBCKT model...");
    const synthResult = await synthesizeSubcktModel(
      {
        request,
        facts: factResult.facts,
        pins: factResult.inferredPins,
        provider: synthesisTarget?.provider,
        model: synthesisTarget?.model,
        log,
      },
      runDir,
    );
    allWarnings.push(...synthResult.warnings);

    const candidate = synthResult.candidate;

    // --- Phase F: Validation ---
    log("\n[4/4] Validating .SUBCKT model...");
    const validation = await validateSubcktCandidate(candidate, runDir, {
      runSmokeTest: input.runSmokeTest !== false,
      log,
    });
    allWarnings.push(
      ...validation.issues
        .filter((i) => i.severity === "critical" || i.severity === "high")
        .map((i) => `[${i.severity.toUpperCase()}] ${i.code}: ${i.message}`),
    );

    outputPaths.validationJsonPath = path.join(runDir, "validation.json");

    if (await fs.pathExists(path.join(runDir, "smoke-test.cir"))) {
      outputPaths.smokeTestCirPath = path.join(runDir, "smoke-test.cir");
    }
    if (await fs.pathExists(path.join(runDir, "smoke-test.log"))) {
      outputPaths.smokeTestLogPath = path.join(runDir, "smoke-test.log");
    }

    // --- Package outputs ---
    const libText = candidate.subcktText;
    const libPath = path.join(runDir, `${candidate.modelName.toLowerCase()}.lib`);
    await fs.outputFile(libPath, libText, "utf-8");
    outputPaths.libPath = libPath;

    const libResult: SubcktLibResult = {
      runId,
      modelName: candidate.modelName,
      libText,
      pins: candidate.pins,
      extractedFacts: factResult.facts,
      assumptions: candidate.assumptions,
      limitations: candidate.limitations,
      validation,
      suggestedKicadInstructions: [],
      smokeTestNetlist: validation.smokeTestLog ? await fs.readFile(path.join(runDir, "smoke-test.cir"), "utf-8").catch(() => undefined) : undefined,
      completedAt: new Date().toISOString(),
    };

    const modelJsonPath = path.join(runDir, "generated.model.json");
    await fs.outputJson(modelJsonPath, libResult, { spaces: 2 });
    outputPaths.modelJsonPath = modelJsonPath;

    // KiCad notes (Phase G placeholder)
    const kicadNotes = buildKicadNotesMd(libResult);
    const kicadNotesPath = path.join(runDir, "kicad-notes.md");
    await fs.outputFile(kicadNotesPath, kicadNotes, "utf-8");
    outputPaths.kicadNotesMdPath = kicadNotesPath;

    // Finalize run record
    const finalStatus: SubcktRunStatus =
      validation.status === "failed-validation" ? "failed" :
      validation.issues.length > 0 ? "failed-with-warnings" :
      "succeeded";

    runRecord.status = finalStatus;
    runRecord.completedAt = new Date().toISOString();
    runRecord.outputs = {
      libPath,
      modelJsonPath,
      extractedFactsJsonPath: outputPaths.extractedFactsJsonPath,
      extractedFactsMdPath: outputPaths.extractedFactsMdPath,
      validationJsonPath: outputPaths.validationJsonPath,
      smokeTestCirPath: outputPaths.smokeTestCirPath,
      smokeTestLogPath: outputPaths.smokeTestLogPath,
      kicadNotesMdPath: kicadNotesPath,
    };
    await persistRunRecord(runRecord, runDir);

    log(`\nDone. Status: ${finalStatus}`);

    return {
      runId,
      runDir,
      status: finalStatus,
      result: libResult,
      warnings: allWarnings,
      outputs: outputPaths,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    allWarnings.push(`Run failed: ${msg}`);

    runRecord.status = "failed";
    runRecord.completedAt = new Date().toISOString();
    await persistRunRecord(runRecord, runDir).catch(() => {});

    log(`\nRun failed: ${msg}`);

    return {
      runId,
      runDir,
      status: "failed",
      result: null,
      warnings: allWarnings,
      outputs: outputPaths,
    };
  }
}
