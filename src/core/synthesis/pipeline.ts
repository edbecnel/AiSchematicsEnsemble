/**
 * Phase 8 — Synthesis/consensus/judge pipeline
 *
 * Orchestrates the full Phase 8 pipeline in this order:
 *
 *   1. Eligibility   — select synthesis and (optionally) judge providers
 *   2. Consensus     — pure-computation clustering of normalized findings
 *   3. Judge         — optional LLM-based reranking/adjudication
 *   4. Synthesis     — LLM-based final ensembling
 *
 * Invariants enforced here:
 *  - Synthesis failure NEVER marks an otherwise successful analysis run as failed.
 *  - Judge step failure falls through gracefully; the pipeline continues without it.
 *  - Raw ensemble results are always preserved regardless of synthesis outcome.
 *  - At minimum, the consensus result is always returned when the pipeline is
 *    attempted (so callers always have structured findings even with no LLM).
 *
 * This module has no dependency on orchestration/run.ts — it is a standalone
 * pipeline that can be imported by the orchestration layer without circular
 * imports.
 */

import type {
  AnalysisContextPackage,
  InputImage,
  NormalizedFinding,
  NormalizedProviderResult,
  ProviderName,
  SynthesisOutput,
  SynthesisPipelineResult,
} from "../../types.js";
import { computeConsensus } from "./consensus.js";
import { selectSynthesisProvider, selectJudgeProvider } from "./eligibility.js";
import { runJudge } from "./judge.js";
import { buildPromptMessagesWithProfile } from "../prompts/profiles.js";
import { promptTextFromMessages } from "../providers/adapter.js";
import { dispatchPrompt } from "../providers/resolver.js";
import { dispatchResultFromRaw, normalizeDispatchResult } from "../dispatch/normalizer.js";
import { getDefaultModelForProvider } from "../../registry/providers.js";

// ---------------------------------------------------------------------------
// Logger contract (minimal, avoids importing from orchestration/run.ts)
// ---------------------------------------------------------------------------

export interface PipelineLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function noop(): void {}
export const SILENT_LOGGER: PipelineLogger = { info: noop, warn: noop, error: noop };

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

export interface RunSynthesisPipelineArgs {
  context: AnalysisContextPackage;
  results: NormalizedProviderResult[];
  /** Active providers for the current run (determines eligibility candidates). */
  providers: ProviderName[];
  /** Per-provider model overrides (mirrors ExecuteRunInput fields). */
  openaiModel?: string;
  grokModel?: string;
  geminiModel?: string;
  claudeModel?: string;
  /** Inline images forwarded from the original run. */
  allImages?: InputImage[];
  /**
   * Whether to run the judge step. Default: true.
   * Explicitly pass false to skip judging (e.g. in testing or offline mode).
   */
  enableJudge?: boolean;
  logger?: PipelineLogger;
}

// ---------------------------------------------------------------------------
// Model selection helper
// ---------------------------------------------------------------------------

function modelForProvider(provider: ProviderName, args: RunSynthesisPipelineArgs): string {
  switch (provider) {
    case "openai":    return args.openaiModel   ?? getDefaultModelForProvider(provider);
    case "xai":       return args.grokModel     ?? getDefaultModelForProvider(provider);
    case "google":    return args.geminiModel   ?? getDefaultModelForProvider(provider);
    case "anthropic": return args.claudeModel   ?? getDefaultModelForProvider(provider);
  }

  return getDefaultModelForProvider(provider);
}

// ---------------------------------------------------------------------------
// SynthesisOutput derivation
// ---------------------------------------------------------------------------

/**
 * Derive a structured SynthesisOutput from a synthesis NormalizedProviderResult
 * and any available judge output.
 *
 * Priority:
 *  - Judge's prioritizedFindings override the synthesis findings when present.
 *  - Judge's openQuestions supplement the synthesis's missingInfo.
 *  - Judge's confidenceNotes are appended as output confidenceNotes.
 */
function deriveSynthesisOutput(
  synthResult: NormalizedProviderResult,
  judge?: import("../../types.js").JudgeOutput,
): SynthesisOutput {
  const findings: NormalizedFinding[] =
    judge?.prioritizedFindings.length
      ? judge.prioritizedFindings
      : synthResult.findings;

  const openQuestions = [
    ...(judge?.openQuestions ?? []),
    ...synthResult.missingInfo,
  ].filter((q, i, arr) => arr.indexOf(q) === i); // deduplicate

  return {
    summary: synthResult.summary,
    findings,
    openQuestions,
    prioritizedActions: synthResult.recommendedActions,
    confidenceNotes: [
      ...(judge?.confidenceNotes ?? []),
      ...(synthResult.confidenceHint ? [synthResult.confidenceHint] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Public pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the Phase 8 synthesis/consensus/judge pipeline.
 *
 * Always returns a SynthesisPipelineResult — never throws.
 */
export async function runSynthesisPipeline(
  args: RunSynthesisPipelineArgs,
): Promise<SynthesisPipelineResult> {
  const logger = args.logger ?? SILENT_LOGGER;
  const { context, results, providers, allImages } = args;
  const enableJudge = args.enableJudge !== false;

  const successfulResults = results.filter((r) => r.status === "succeeded");

  if (!successfulResults.length) {
    return {
      attempted: false,
      succeeded: false,
      error: "No successful analysis results available for synthesis pipeline",
    };
  }

  // ------------------------------------------------------------------
  // Step 1: Consensus (pure computation — always runs if we get here)
  // ------------------------------------------------------------------
  logger.info("Computing consensus clusters...");
  let consensus: import("../../types.js").ConsensusResult;
  try {
    consensus = computeConsensus(results);
    logger.info(
      `Consensus: ${consensus.clusters.length} cluster(s), ` +
        `confidence=${consensus.ensembleConfidence}, ` +
        `excluded=${consensus.excludedProviders.length}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Consensus clustering threw unexpectedly: ${msg}`);
    return { attempted: true, succeeded: false, error: `Consensus error: ${msg}` };
  }

  // ------------------------------------------------------------------
  // Step 2: Judge (optional LLM step)
  // ------------------------------------------------------------------
  let judge: import("../../types.js").JudgeOutput | undefined;

  if (enableJudge) {
    const judgeProvider = selectJudgeProvider(providers);
    if (judgeProvider) {
      const judgeModel = modelForProvider(judgeProvider, args);
      logger.info(`Running judge step with ${judgeProvider} (${judgeModel})...`);
      try {
        judge = await runJudge({
          context,
          consensus,
          results,
          judgeProvider,
          judgeModel,
          allImages,
        });
        if (judge) {
          logger.info(
            `Judge complete: ${judge.prioritizedFindings.length} prioritized findings, ` +
              `${judge.openQuestions.length} open questions`,
          );
        } else {
          logger.warn("Judge step returned no parseable output; skipping.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Judge step failed (non-fatal): ${msg}`);
      }
    } else {
      logger.info("No judge-eligible provider available; skipping judge step.");
    }
  } else {
    logger.info("Judge step disabled for this run.");
  }

  // ------------------------------------------------------------------
  // Step 3: Synthesis (LLM — optional, fault-tolerant)
  // ------------------------------------------------------------------
  const synthProvider = selectSynthesisProvider(providers);
  if (!synthProvider) {
    logger.warn("No synthesis-eligible provider available; returning consensus only.");
    return { attempted: true, succeeded: true, consensus, judge };
  }

  const synthModel = modelForProvider(synthProvider, args);
  const maxTokens = synthProvider === "anthropic" ? 4800 : undefined;

  logger.info(`Running synthesis with ${synthProvider} (${synthModel})...`);

  // Build analysis answers from successful results
  const analysisAnswers = successfulResults.map((r) => ({
    provider: r.provider,
    model: r.model,
    text: [
      r.summary,
      r.findings.map((f) => `- ${f.title}: ${f.summary}`).join("\n"),
      r.spiceNetlist ? `\nSPICE:\n${r.spiceNetlist}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    error: r.error?.message,
  }));

  const synthMessages = buildPromptMessagesWithProfile(context, "synthesis", {
    analysisAnswers,
  });
  const synthPrompt = promptTextFromMessages(synthMessages);

  let synthResult: NormalizedProviderResult;

  try {
    const synthAnswer = await dispatchPrompt({
      provider: synthProvider,
      model: synthModel,
      prompt: synthPrompt,
      images: allImages,
      maxTokens,
      metadata: { step: "synthesis" },
    });

    const rawDispatch = dispatchResultFromRaw({
      provider: synthAnswer.provider,
      model: synthAnswer.model,
      text: synthAnswer.text,
      error: synthAnswer.error,
      raw: synthAnswer.meta?.["raw"] as unknown,
      usage: synthAnswer.meta?.["usage"] as import("../../types.js").RawProviderResponse["usage"],
    });

    synthResult = normalizeDispatchResult(rawDispatch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Synthesis LLM call failed (non-fatal): ${msg}`);
    // Return what we have: consensus + optional judge, but no synthesis result
    return { attempted: true, succeeded: true, consensus, judge, error: `Synthesis LLM failed: ${msg}` };
  }

  if (synthResult.status === "failed") {
    const msg = synthResult.error?.message ?? "Synthesis provider returned an error";
    logger.warn(`Synthesis failed: ${msg}`);
    return {
      attempted: true,
      succeeded: true,
      consensus,
      judge,
      synthesis: synthResult,
      error: `Synthesis error: ${msg}`,
    };
  }

  logger.info(
    `Synthesis complete (parseQuality=${synthResult.parseQuality}, provider=${synthProvider})`,
  );

  const synthesisOutput = deriveSynthesisOutput(synthResult, judge);

  return {
    attempted: true,
    succeeded: true,
    consensus,
    judge,
    synthesis: synthResult,
    synthesisOutput,
  };
}
