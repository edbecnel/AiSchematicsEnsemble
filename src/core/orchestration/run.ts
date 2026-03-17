/**
 * Phase 7.5 / Phase 8 — End-to-end run orchestration service
 *
 * This module is the single coordinator for the full run lifecycle.
 * All entrypoints (CLI, UI server, future hosted API) should call
 * executeRun() rather than implement their own orchestration logic.
 *
 * Lifecycle:
 *   createRun → buildAnalysisContext → dispatchRun → normalizeDispatchResults
 *     → synthesizeRun (Phase 8: consensus → judge → synthesis, fault-tolerant) → finalizeRun
 *
 * Guardrails:
 *   - Partial success is always preserved: if some providers fail, the run
 *     continues with the successful results.
 *   - Synthesis failure never marks an otherwise successful analysis run as failed.
 *   - All run/dispatch/result records are persisted via the StorageBackend so
 *     the same contract works in local/dev and future hosted modes.
 *   - Report writing (docx/pdf/schematic) is called here but isolated to
 *     finalizeRun() — callers never drive report generation themselves.
 *   - A clean SUBCKT integration point is preserved at the finalizeRun()
 *     boundary via the optional SubcktIntegration hook.
 */

import crypto from "node:crypto";
import { execa } from "execa";

import { buildAnalysisContext, type BuildContextInput } from "../artifacts/context.js";
import { buildPromptMessagesWithProfile } from "../prompts/profiles.js";
import { promptTextFromMessages } from "../providers/adapter.js";
import { dispatchPrompt } from "../providers/resolver.js";
import { dispatchResultFromRaw, normalizeDispatchResult } from "../dispatch/normalizer.js";
import { runSynthesisPipeline } from "../synthesis/pipeline.js";
import { createLocalStorage, type StorageBackend } from "../storage/store.js";
import {
  dispatchRequestKey,
  dispatchResponseKey,
  dispatchResultKey,
  finalCirKey,
  finalReportJsonKey,
  finalReportMdKey,
  reportDocxKey,
  reportPdfKey,
  runContextKey,
  runRecordKey,
  schematicDotKey,
} from "../storage/keys.js";
import {
  getDefaultModelForProvider,
  getProviderEnvVar,
  providerHasConfiguredEnvKey,
} from "../../registry/providers.js";
import { parseNetlist } from "../../netlist/parse.js";
import { netlistToDot } from "../../netlist/graph.js";
import { writeReportDocx } from "../../report/docx.js";
import { writeReportPdf } from "../../report/pdf.js";
import { convertDocxToPdfViaLibreOffice } from "../../report/docxToPdf.js";
import { makeRunDir } from "../../util/runDir.js";
import { BUILTIN_PROVIDER_NAMES } from "../../types.js";
import type {
  AnalysisContextPackage,
  BuiltinProviderName,
  DispatchStatus,
  InputImage,
  NormalizedDispatchResult,
  NormalizedProviderResult,
  ProviderName,
  Run,
  RunDispatch,
  RunResult,
  RunStatus,
  SynthesisPipelineResult,
  TaggedImagePath,
  TaggedInputImage,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Public input / output types
// ---------------------------------------------------------------------------

export interface ExecuteRunInput extends BuildContextInput {
  /** Providers to include. Defaults to all that have configured API keys. */
  enabledProviders?: ProviderName[];
  /** Per-provider model overrides. */
  openaiModel?: string;
  grokModel?: string;
  geminiModel?: string;
  claudeModel?: string;
  /** Base dir for run directory. Defaults to "runs". */
  outdir?: string;
  /** DPI for schematic.png rendering via Graphviz. */
  schematicDpi?: number;
  /** Whether to run the synthesis/ensemble step. Default: true. */
  synthesize?: boolean;
  /**
   * Optional hook called after normalization and before finalize.
   * Provides a clean integration point for the SUBCKT utility to inject
   * generated .lib content and updated .cir before final report writing.
   */
  subcktIntegration?: SubcktIntegration;
  /** Inline images passed directly to dispatch (baseline + references). */
  allImages?: InputImage[];
}

/**
 * Payload for SUBCKT utility integration output.
 * When present, finalizeRun() includes the generated lib content and updated
 * netlist in the report deliverables.
 */
export interface SubcktIntegration {
  /** Generated SPICE .lib content to embed in the report. */
  generatedLibContent?: string;
  /** Updated .cir with SUBCKT references resolved. */
  updatedCir?: string;
  /** Notes to add to the report (SUBCKT provenance, component mappings, etc.). */
  notes?: string[];
}

export interface ExecuteRunOutput {
  runId: string;
  runDir: string;
  status: RunStatus;
  run: Run;
  context: AnalysisContextPackage;
  dispatches: RunDispatch[];
  results: NormalizedProviderResult[];
  /** Phase 8 synthesis/consensus/judge pipeline result. */
  synthesis: SynthesisPipelineResult;
  finalMarkdown: string;
  spiceNetlist: string;
  circuitJson: string;
  outputs: {
    reportDocx: string;
    reportPdf: string;
    finalMd: string;
    finalCir: string;
    finalJson: string;
    schematicDot: string;
    schematicPng?: string;
    schematicSvg?: string;
    answersJson: string;
  };
}

export type RunLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

function defaultLogger(): RunLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_PROVIDERS: BuiltinProviderName[] = [...BUILTIN_PROVIDER_NAMES];

function newId(): string {
  return crypto.randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

function modelForProvider(provider: ProviderName, input: ExecuteRunInput): string {
  switch (provider) {
    case "openai":   return input.openaiModel  ?? getDefaultModelForProvider(provider);
    case "xai":      return input.grokModel    ?? getDefaultModelForProvider(provider);
    case "google":   return input.geminiModel  ?? getDefaultModelForProvider(provider);
    case "anthropic":return input.claudeModel  ?? getDefaultModelForProvider(provider);
  }

  return getDefaultModelForProvider(provider);
}

// ---------------------------------------------------------------------------
// createRun
// ---------------------------------------------------------------------------

export function createRun(args: {
  contextPackageId: string;
  providerDefinitionIds: string[];
  promptProfileId: string;
  runId?: string;
}): Run {
  return {
    id: args.runId ?? newId(),
    status: "pending",
    promptProfileId: (args.promptProfileId as Run["promptProfileId"]) ?? "analysis",
    providerDefinitionIds: args.providerDefinitionIds,
    contextPackageId: args.contextPackageId,
    createdAt: isoNow(),
  };
}

// ---------------------------------------------------------------------------
// resolveProvidersForRun
// ---------------------------------------------------------------------------

/**
 * Determine which providers will actually be dispatched for this run.
 * Warns when a requested provider has no configured API key.
 */
export function resolveProvidersForRun(
  requested: ProviderName[] | undefined,
  logger: RunLogger,
): ProviderName[] {
  const candidates = requested ?? ALL_PROVIDERS.filter((p) => providerHasConfiguredEnvKey(p));

  if (!candidates.length) {
    throw new Error(
      requested === undefined
        ? "No providers enabled — no API keys detected. Set OPENAI_API_KEY / XAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY."
        : "No providers enabled. Select at least one provider.",
    );
  }

  for (const p of candidates) {
    const envVar = getProviderEnvVar(p);
    if (envVar && !process.env[envVar]) {
      logger.warn(`Warning: ${envVar} not set — ${p} calls will fail.`);
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// dispatchRun — fanout to all providers, preserving partial success
// ---------------------------------------------------------------------------

export async function dispatchRun(args: {
  run: Run;
  context: AnalysisContextPackage;
  providers: ProviderName[];
  input: ExecuteRunInput;
  storage: StorageBackend;
  logger: RunLogger;
}): Promise<{ dispatches: RunDispatch[]; rawResults: NormalizedDispatchResult[] }> {
  const { run, context, providers, input, storage, logger } = args;

  // Build the analysis prompt text once for all providers
  const messages = buildPromptMessagesWithProfile(context, "analysis");
  const promptText = promptTextFromMessages(messages);

  const jobs = providers.map(async (provider): Promise<{ dispatch: RunDispatch; raw: NormalizedDispatchResult }> => {
    const dispatchId = newId();
    const model = modelForProvider(provider, input);
    const maxTokens = provider === "anthropic" ? 1200 : undefined;
    const startedAt = isoNow();

    // Persist the request payload
    const requestPayload = { provider, model, messages };
    try {
      await storage.writeJson(dispatchRequestKey(run.id, dispatchId), requestPayload);
    } catch { /* non-fatal — best-effort persistence */ }

    let dispatch: RunDispatch = {
      id: dispatchId,
      runId: run.id,
      providerDefinitionId: provider, // simplified: use provider name as ID in local mode
      provider,
      model,
      status: "running",
      createdAt: isoNow(),
      startedAt,
      requestStorageKey: dispatchRequestKey(run.id, dispatchId),
    };

    let rawResult: NormalizedDispatchResult;
    const t0 = Date.now();

    try {
      const answer = await dispatchPrompt({
        provider,
        model,
        prompt: promptText,
        images: input.allImages,
        maxTokens,
      });

      const latencyMs = Date.now() - t0;
      const raw = {
        provider: answer.provider,
        model: answer.model,
        text: answer.text,
        error: answer.error,
        latencyMs,
        raw: answer.meta?.["raw"] as unknown,
        usage: answer.meta?.["usage"] as NormalizedDispatchResult["usage"],
      };

      rawResult = dispatchResultFromRaw(raw);
      dispatch = {
        ...dispatch,
        status: rawResult.status,
        completedAt: isoNow(),
        latencyMs,
        usage: rawResult.usage,
        responseStorageKey: dispatchResponseKey(run.id, dispatchId),
        error: rawResult.error,
      };

      try {
        await storage.writeJson(dispatchResponseKey(run.id, dispatchId), raw);
      } catch { /* non-fatal */ }

      logger.info(`  ${provider} (${model}): ${rawResult.status} in ${latencyMs}ms`);
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const errMsg = err instanceof Error ? err.message : String(err);
      const raw = {
        provider,
        model,
        text: "",
        status: "failed" as const,
        error: errMsg,
        latencyMs,
      };
      rawResult = {
        provider,
        model,
        status: "failed",
        text: "",
        error: { category: "unknown", message: errMsg, retryable: false },
        latencyMs,
      };
      dispatch = {
        ...dispatch,
        status: "failed",
        completedAt: isoNow(),
        latencyMs,
        error: rawResult.error,
      };
      try {
        await storage.writeJson(dispatchResponseKey(run.id, dispatchId), raw);
      } catch { /* non-fatal */ }
      logger.error(`  ${provider} (${model}): failed — ${errMsg}`);
    }

    return { dispatch, raw: rawResult };
  });

  // Promise.allSettled preserves partial success
  const settled = await Promise.allSettled(jobs);
  const dispatches: RunDispatch[] = [];
  const rawResults: NormalizedDispatchResult[] = [];

  for (let i = 0; i < settled.length; i += 1) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      dispatches.push(s.value.dispatch);
      rawResults.push(s.value.raw);
    } else {
      const provider = providers[i] ?? "unknown-provider";
      const model = providers[i] ? modelForProvider(providers[i], input) : "";
      const dispatchId = newId();
      const message = `Unexpected dispatch job rejection: ${String(s.reason)}`;

      logger.error(message);

      dispatches.push({
        id: dispatchId,
        runId: run.id,
        providerDefinitionId: provider,
        provider,
        model,
        status: "failed",
        createdAt: isoNow(),
        startedAt: isoNow(),
        completedAt: isoNow(),
        requestStorageKey: dispatchRequestKey(run.id, dispatchId),
        responseStorageKey: dispatchResponseKey(run.id, dispatchId),
        error: { category: "unknown", message, retryable: false },
      });

      rawResults.push({
        provider,
        model,
        status: "failed",
        text: "",
        error: { category: "unknown", message, retryable: false },
      });
    }
  }

  return { dispatches, rawResults };
}

// ---------------------------------------------------------------------------
// normalizeDispatchResults
// ---------------------------------------------------------------------------

export function normalizeDispatchResults(
  rawResults: NormalizedDispatchResult[],
  storage: StorageBackend,
  runId: string,
  dispatches: RunDispatch[],
): NormalizedProviderResult[] {
  return rawResults.map((raw, idx) => {
    const result = normalizeDispatchResult(raw);
    // Best-effort persistence of result JSON
    const dispatch = dispatches[idx];
    if (dispatch) {
      storage
        .writeJson(dispatchResultKey(runId, dispatch.id), result)
        .catch(() => { /* non-fatal */ });
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// synthesizeRun — Phase 8: consensus → judge → synthesis pipeline
// ---------------------------------------------------------------------------

/**
 * Orchestrate the Phase 8 synthesis/consensus/judge pipeline for a completed
 * analysis run.  Delegates to runSynthesisPipeline in core/synthesis.
 *
 * Invariants:
 *  - Never throws: all failures are captured in the returned SynthesisPipelineResult.
 *  - An unsuccessful or skipped pipeline never invalidates the analysis results.
 */
export async function synthesizeRun(args: {
  run: Run;
  context: AnalysisContextPackage;
  results: NormalizedProviderResult[];
  providers: ProviderName[];
  input: ExecuteRunInput;
  logger: RunLogger;
  /** Whether to run the judge step. Default: true. */
  enableJudge?: boolean;
}): Promise<SynthesisPipelineResult> {
  const { context, results, providers, input, logger } = args;

  return runSynthesisPipeline({
    context,
    results,
    providers,
    openaiModel: input.openaiModel,
    grokModel: input.grokModel,
    geminiModel: input.geminiModel,
    claudeModel: input.claudeModel,
    allImages: input.allImages,
    enableJudge: args.enableJudge,
    logger,
  });
}

// ---------------------------------------------------------------------------
// finalizeRun — write all output files and reports
// ---------------------------------------------------------------------------

interface FinalizeRunArgs {
  run: Run;
  context: AnalysisContextPackage;
  results: NormalizedProviderResult[];
  synthesis: ExecuteRunOutput["synthesis"];
  input: ExecuteRunInput;
  storage: StorageBackend;
  runDir: string;
  logger: RunLogger;
}

interface FinalizeRunOutput {
  finalMarkdown: string;
  spiceNetlist: string;
  circuitJson: string;
  outputs: ExecuteRunOutput["outputs"];
}

export async function finalizeRun(args: FinalizeRunArgs): Promise<FinalizeRunOutput> {
  const { run, context, results, synthesis, input, storage, runDir, logger } = args;

  // Pick best outputs: prefer synthesis result, fall back to best-quality individual result
  const primary =
    synthesis.synthesis ??
    [...results]
      .filter((r) => r.status === "succeeded")
      .sort((a, b) => b.parseQuality - a.parseQuality)[0];

  const finalMarkdown = primary?.summary
    ? buildFinalMarkdown(primary, results, context, synthesis)
    : "(No output generated — all providers failed)";

  const spiceNetlist =
    primary?.spiceNetlist ??
    results.find((r) => r.spiceNetlist)?.spiceNetlist ??
    "";

  const circuitJson = primary?.circuitJson ?? "";

  // Apply SUBCKT integration if provided
  const subckt = input.subcktIntegration;
  const finalCirText = buildFinalCir(spiceNetlist, subckt);
  const finalMdText = buildFinalMd(finalMarkdown, subckt);
  const finalJsonText = buildFinalJson(circuitJson, results, synthesis);

  // Write text outputs via storage backend
  await Promise.all([
    storage.writeText(finalReportMdKey(run.id),   finalMdText),
    storage.writeText(finalCirKey(run.id),         finalCirText),
    storage.writeJson(finalReportJsonKey(run.id),  JSON.parse(finalJsonText.trim() || "{}")),
  ]);

  // Write raw answers
  const answersData = results.map((r) => ({
    provider: r.provider,
    model: r.model,
    status: r.status,
    text: r.summary,
    findings: r.findings,
    parseQuality: r.parseQuality,
    confidenceHint: r.confidenceHint,
    errorCategory: r.error?.category,
    error: r.error?.message,
  }));
  await storage.writeJson("answers.json", answersData);

  for (const r of results) {
    const safeModel = r.model.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fname = `answers/${r.provider}_${safeModel}.md`;
    const body = r.error ? `# ERROR\n\n${r.error.message}` : r.summary;
    await storage.writeText(fname, `# ${r.provider} | ${r.model}\n\n${body}\n`);
  }

  // Schematic diagram
  let schematicPng: string | undefined;
  let schematicSvg: string | undefined;
  const schematicDotLoc = storage.resolveLocation(schematicDotKey(run.id));

  try {
    const netlistSource = (spiceNetlist || context.extractedTexts.find(
      (e) => context.artifacts.find((a) => a.id === e.artifactId && a.kind === "netlist"),
    )?.text) ?? "";

    const comps = parseNetlist(netlistSource);
    if (comps.length) {
      const dot = netlistToDot(comps);
      await storage.writeText(schematicDotKey(run.id), dot);

      const pngPath = storage.resolveLocation("schematic.png");
      const svgPath = storage.resolveLocation("schematic.svg");
      const dpi = Number.isFinite(input.schematicDpi) && (input.schematicDpi ?? 0) > 0 ? input.schematicDpi! : 600;

      try {
        await execa("dot", [`-Gdpi=${dpi}`, "-Tpng", schematicDotLoc, "-o", pngPath]);
        schematicPng = pngPath;
        logger.info("Rendered schematic.png via Graphviz.");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.warn("Graphviz failed to render schematic.png; wrote schematic.dot only.");
        } else {
          logger.warn("Graphviz 'dot' not found; wrote schematic.dot only.");
        }
      }

      if (schematicPng || netlistSource.trim()) {
        try {
          await execa("dot", ["-Tsvg", schematicDotLoc, "-o", svgPath]);
          schematicSvg = svgPath;
        } catch { /* non-fatal */ }
      }
    } else {
      await storage.writeText(schematicDotKey(run.id), "digraph G { /* no components parsed */ }");
    }
  } catch (e: unknown) {
    logger.warn(`Schematic generation skipped: ${(e as Error)?.message ?? String(e)}`);
  }

  // Report docx
  const reportDocxLoc = storage.resolveLocation(reportDocxKey(run.id));
  const reportPdfLoc  = storage.resolveLocation(reportPdfKey(run.id));

  logger.info("Writing report.docx...");
  const answersForReport = results.map((r) => ({
    heading: `${r.provider} | ${r.model}`,
    markdown: r.error ? `# ERROR\n\n${r.error.message}` : (r.summary || "(No output)"),
  }));

  const baselineNetlistArtifact = context.artifacts.find((a) => a.kind === "netlist");
  const baselineNetlistText = baselineNetlistArtifact
    ? context.extractedTexts.find((e) => e.artifactId === baselineNetlistArtifact.id)?.text
    : undefined;

  // Find any saved baseline schematic image path from storage refs
  const imgArtifact = context.artifacts.find((a) => a.kind === "image");
  const baselineSchematicPath = imgArtifact?.storageRef
    ? storage.resolveLocation(imgArtifact.storageRef)
    : undefined;

  await writeReportDocx({
    outPath: reportDocxLoc,
    title: "AI Schematics — Ensemble Report",
    question: context.userInstructions,
    finalMarkdown: finalMarkdown || finalMdText,
    spiceNetlist: spiceNetlist || baselineNetlistText || "",
    baselineSchematicPath,
    connectivitySchematicPngPath: schematicPng,
    answers: answersForReport,
  });

  logger.info("Writing report-auto.pdf...");
  const converted = await convertDocxToPdfViaLibreOffice({ docxPath: reportDocxLoc, pdfOutPath: reportPdfLoc });
  if (converted.ok) {
    logger.info(`Rendered report-auto.pdf from report.docx via ${converted.method}.`);
  } else {
    logger.warn(`DOCX→PDF conversion not available (${converted.reason}); falling back to built-in PDF renderer.`);
    await writeReportPdf({
      outPath: reportPdfLoc,
      title: "AI Schematics — Ensemble Report",
      question: context.userInstructions,
      finalMarkdown: finalMarkdown || finalMdText,
      spiceNetlist: spiceNetlist || baselineNetlistText || "",
      baselineSchematicPath,
      connectivitySchematicPngPath: schematicPng,
      answers: answersForReport,
    });
  }

  return {
    finalMarkdown,
    spiceNetlist,
    circuitJson,
    outputs: {
      reportDocx:   reportDocxLoc,
      reportPdf:    reportPdfLoc,
      finalMd:      storage.resolveLocation(finalReportMdKey(run.id)),
      finalCir:     storage.resolveLocation(finalCirKey(run.id)),
      finalJson:    storage.resolveLocation(finalReportJsonKey(run.id)),
      schematicDot: schematicDotLoc,
      schematicPng,
      schematicSvg,
      answersJson:  storage.resolveLocation("answers.json"),
    },
  };
}

// ---------------------------------------------------------------------------
// executeRun — top-level lifecycle coordinator
// ---------------------------------------------------------------------------

export async function executeRun(
  input: ExecuteRunInput,
  logger: RunLogger = defaultLogger(),
): Promise<ExecuteRunOutput> {
  // 1. Prepare run directory and storage backend
  const runDir = await makeRunDir(input.outdir ?? "runs");
  const storage = createLocalStorage(runDir);
  logger.info(`Run directory: ${runDir}`);

  // 2. Resolve providers
  const providers = resolveProvidersForRun(input.enabledProviders, logger);
  logger.info(`Providers: ${providers.join(", ")}`);

  // 3. Assemble analysis context (artifact text extraction, provenance)
  const context = await buildAnalysisContext({ ...input });
  await storage.writeJson(runContextKey(context.id), context);

  // 4. Create and persist Run record
  const run = createRun({
    contextPackageId: context.id,
    providerDefinitionIds: providers,
    promptProfileId: context.promptProfileId,
  });
  run.startedAt = isoNow();
  run.status = "running";
  run.contextStorageKey = runContextKey(context.id);
  await storage.writeJson(runRecordKey(run.id), run);

  try {
    // 5. Fanout dispatch — partial success preserved
    logger.info("Querying analysis providers...");
    const { dispatches, rawResults } = await dispatchRun({
      run, context, providers, input, storage, logger,
    });

    // 6. Normalize all dispatch results
    const results = normalizeDispatchResults(rawResults, storage, run.id, dispatches);

    const successCount = results.filter((r) => r.status === "succeeded").length;
    const failureCount = results.filter((r) => r.status !== "succeeded").length;
    logger.info(`Analysis complete: ${successCount} succeeded, ${failureCount} failed`);

    // 7. Synthesis — optional, fault-tolerant
    const doSynthesize = input.synthesize !== false;
    let synthesis: ExecuteRunOutput["synthesis"] = { attempted: false, succeeded: false };

    if (doSynthesize && successCount > 0) {
      synthesis = await synthesizeRun({ run, context, results, providers, input, logger });
    } else if (!doSynthesize) {
      logger.info("Synthesis step skipped (synthesize=false).");
    } else {
      logger.warn("Synthesis step skipped — no successful analysis results.");
    }

    // 8. Finalize: write outputs, schematic, reports
    logger.info("Finalizing run outputs...");
    const finalized = await finalizeRun({
      run, context, results, synthesis, input, storage, runDir, logger,
    });

    // 9. Update and persist final Run record
    const finalStatus: RunStatus =
      successCount === 0 ? "failed" :
      failureCount > 0   ? "partial" :
                           "succeeded";

    run.status = finalStatus;
    run.completedAt = isoNow();
    run.reportStorageKey = reportDocxKey(run.id);
    await storage.writeJson(runRecordKey(run.id), run);

    logger.info(`Run ${run.id} — ${finalStatus}`);

    return {
      runId:   run.id,
      runDir,
      status:  finalStatus,
      run,
      context,
      dispatches,
      results,
      synthesis,
      ...finalized,
    };
  } catch (err) {
    run.status = "failed";
    run.completedAt = isoNow();
    await storage.writeJson(runRecordKey(run.id), run).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helper text builders
// ---------------------------------------------------------------------------

function buildFinalMarkdown(
  primary: NormalizedProviderResult,
  all: NormalizedProviderResult[],
  _context: AnalysisContextPackage,
  synthesis?: SynthesisPipelineResult,
): string {
  const lines: string[] = [
    `## Summary\n\n${primary.summary}`,
  ];

  // Use judge-prioritized findings when available, otherwise synthesis/primary findings
  const displayFindings =
    synthesis?.judge?.prioritizedFindings.length
      ? synthesis.judge.prioritizedFindings
      : synthesis?.synthesisOutput?.findings.length
        ? synthesis.synthesisOutput.findings
        : primary.findings;

  if (displayFindings.length) {
    const findingLabel =
      synthesis?.judge ? "## Prioritized Findings (Judge-Ranked)\n" : "## Findings\n";
    lines.push(`\n${findingLabel}`);
    for (const f of displayFindings) {
      const sev = f.severity ? ` [${f.severity}]` : "";
      lines.push(`- **${f.title}**${sev}: ${f.summary}`);
    }
  }

  // Prioritized actions (from synthesisOutput if available, else from primary)
  const prioritizedActions =
    synthesis?.synthesisOutput?.prioritizedActions.length
      ? synthesis.synthesisOutput.prioritizedActions
      : primary.recommendedActions;

  if (prioritizedActions.length) {
    lines.push("\n## Prioritized Actions\n");
    for (const a of prioritizedActions) lines.push(`- ${a}`);
  }

  // Open questions (judge + synthesis missing info)
  const openQuestions = [
    ...(synthesis?.judge?.openQuestions ?? []),
    ...(synthesis?.synthesisOutput?.openQuestions ?? primary.missingInfo),
  ].filter((q, i, arr) => arr.indexOf(q) === i);

  if (openQuestions.length) {
    lines.push("\n## Open Questions\n");
    for (const q of openQuestions) lines.push(`- ${q}`);
  }

  // Confidence notes (judge + synthesis + primary)
  const confidenceNotes = [
    ...(synthesis?.synthesisOutput?.confidenceNotes ?? []),
    ...(primary.confidenceHint ? [primary.confidenceHint] : []),
  ];

  if (confidenceNotes.length) {
    lines.push("\n## Confidence Notes\n");
    for (const n of confidenceNotes) lines.push(`- ${n}`);
  }

  // Consensus summary (Phase 8)
  if (synthesis?.consensus) {
    lines.push("\n## Ensemble Consensus\n");
    lines.push(synthesis.consensus.agreementSummary);
    if (synthesis.consensus.disagreementSummary) {
      lines.push(`\n${synthesis.consensus.disagreementSummary}`);
    }
    const conf = synthesis.consensus.ensembleConfidence;
    lines.push(`\n*Ensemble confidence: ${(conf * 100).toFixed(0)}%*`);
  }

  // Per-provider parse quality summary
  lines.push("\n## Provider Quality Summary\n");
  for (const r of all) {
    const status = r.status === "succeeded" ? `✓ (quality ${r.parseQuality})` : `✗ ${r.error?.category ?? "failed"}`;
    lines.push(`- ${r.provider} / ${r.model}: ${status}`);
  }

  return lines.join("\n");
}

function buildFinalCir(spice: string, subckt?: SubcktIntegration): string {
  if (!spice.trim()) {
    return [
      "* ERROR: No SPICE netlist produced.",
      ".end",
      "",
    ].join("\n");
  }

  const parts = [spice.trim()];

  if (subckt?.updatedCir?.trim()) {
    parts.push("\n* --- SUBCKT-integrated version ---");
    parts.push(subckt.updatedCir.trim());
  }

  if (subckt?.generatedLibContent?.trim()) {
    parts.push("\n* --- Generated .lib content ---");
    parts.push(subckt.generatedLibContent.trim());
  }

  return parts.join("\n") + "\n";
}

function buildFinalMd(markdown: string, subckt?: SubcktIntegration): string {
  const parts = [markdown];
  if (subckt?.notes?.length) {
    parts.push("\n## SUBCKT Integration Notes\n");
    for (const n of subckt.notes) parts.push(`- ${n}`);
  }
  return parts.join("\n");
}

function buildFinalJson(
  circuitJson: string,
  results: NormalizedProviderResult[],
  synthesis?: SynthesisPipelineResult,
): string {
  try {
    const base = circuitJson ? (JSON.parse(circuitJson) as Record<string, unknown>) : {};
    const enriched = {
      ...base,
      _meta: {
        providerCount: results.length,
        successCount: results.filter((r) => r.status === "succeeded").length,
        parseQualities: Object.fromEntries(
          results.map((r) => [`${r.provider}/${r.model}`, r.parseQuality]),
        ),
        ...(synthesis?.consensus && {
          ensembleConfidence: synthesis.consensus.ensembleConfidence,
          consensusClusterCount: synthesis.consensus.clusters.length,
          outlierCount: synthesis.consensus.clusters.filter((c) => c.isOutlier).length,
        }),
        ...(synthesis?.synthesisOutput && {
          prioritizedActions: synthesis.synthesisOutput.prioritizedActions,
          openQuestions: synthesis.synthesisOutput.openQuestions,
          confidenceNotes: synthesis.synthesisOutput.confidenceNotes,
        }),
        ...(synthesis?.judge && {
          judgeProvider: synthesis.judge.judgeProvider,
          judgeModel: synthesis.judge.judgeModel,
          judgeOpenQuestions: synthesis.judge.openQuestions,
        }),
      },
    };
    return JSON.stringify(enriched, null, 2) + "\n";
  } catch {
    return JSON.stringify({ assumptions: [], probes: [], bom: [], notes: [] }, null, 2) + "\n";
  }
}
