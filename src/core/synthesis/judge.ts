/**
 * Phase 8 — Optional judge/reranker stage
 *
 * The judge step uses a judge-eligible LLM to:
 *  1. Rerank and prioritize findings from the consensus step
 *  2. Identify open questions that no analysis provider answered adequately
 *  3. Produce confidence notes about the overall analysis quality
 *
 * Invariants:
 *  - Judge failure is non-fatal: the pipeline returns gracefully without a
 *    JudgeOutput and synthesis still proceeds.
 *  - The judge is dispatched to a separate judge-eligible provider/model, not
 *    the synthesis provider — unless they happen to be the same.
 *  - The judge prompt is built using the "judge" PromptProfileId so it
 *    remains decoupled from the synthesis prompt.
 */

import type {
  AnalysisContextPackage,
  ConsensusCluster,
  ConsensusResult,
  JudgeOutput,
  NormalizedFinding,
  NormalizedProviderResult,
  ProviderName,
} from "../../types.js";
import { buildPromptMessagesWithProfile, JUDGE_OUTPUT_TAGS } from "../prompts/profiles.js";
import { promptTextFromMessages } from "../providers/adapter.js";
import { dispatchPrompt } from "../providers/resolver.js";
import { getDefaultModelForProvider } from "../../registry/providers.js";

// ---------------------------------------------------------------------------
// Judge output parser
// ---------------------------------------------------------------------------

function extractBetweenTags(text: string, open: string, close: string): string | undefined {
  const i = text.indexOf(open);
  const j = text.indexOf(close);
  if (i === -1 || j === -1 || j <= i) return undefined;
  return text.substring(i + open.length, j).trim() || undefined;
}

function parseBulletList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s\-\*\u2022]+/, "").trim())
    .filter((l) => l.length > 3);
}

type KnownSeverity = NonNullable<NormalizedFinding["severity"]>;
const KNOWN_SEVERITIES: KnownSeverity[] = ["info", "low", "medium", "high", "critical"];

function normalizeSeverity(raw: string): KnownSeverity | undefined {
  const lower = raw.toLowerCase();
  return KNOWN_SEVERITIES.find((s) => s === lower);
}

/**
 * Parse a prioritized-findings bullet of the form:
 *   `- [severity] Title: justification`
 *   `- Title: justification`
 *   `- Title` (bare)
 */
function parseFindingBullet(line: string): NormalizedFinding {
  // Try [severity] Title: summary
  const withSeverity = line.match(/^\[(\w+)\]\s+([^:]+):\s*(.+)$/);
  if (withSeverity) {
    const [, sev, title, summary] = withSeverity;
    return {
      title: (title ?? line).trim(),
      severity: normalizeSeverity(sev ?? ""),
      summary: (summary ?? title ?? line).trim(),
    };
  }

  // Try Title: summary (no severity tag)
  const withColon = line.match(/^([^:]+):\s*(.+)$/);
  if (withColon) {
    const [, title, summary] = withColon;
    return { title: (title ?? line).trim(), summary: (summary ?? line).trim() };
  }

  return { title: line.trim(), summary: line.trim() };
}

/**
 * Parse the judge model's raw output into structured JudgeOutput fields.
 * All parsing is best-effort; missing sections produce empty arrays.
 */
function parseJudgeOutput(text: string): Omit<JudgeOutput, "rawText" | "judgeProvider" | "judgeModel"> {
  const findingsBlock = extractBetweenTags(
    text,
    JUDGE_OUTPUT_TAGS.findingsOpen,
    JUDGE_OUTPUT_TAGS.findingsClose,
  );
  const questionsBlock = extractBetweenTags(
    text,
    JUDGE_OUTPUT_TAGS.questionsOpen,
    JUDGE_OUTPUT_TAGS.questionsClose,
  );
  const confidenceBlock = extractBetweenTags(
    text,
    JUDGE_OUTPUT_TAGS.confidenceOpen,
    JUDGE_OUTPUT_TAGS.confidenceClose,
  );

  const prioritizedFindings: NormalizedFinding[] = findingsBlock
    ? parseBulletList(findingsBlock).map(parseFindingBullet).filter(Boolean)
    : [];

  const openQuestions = questionsBlock ? parseBulletList(questionsBlock) : [];
  const confidenceNotes = confidenceBlock ? parseBulletList(confidenceBlock) : [];

  return { prioritizedFindings, openQuestions, confidenceNotes };
}

// ---------------------------------------------------------------------------
// Prompt input builder
// ---------------------------------------------------------------------------

/** Render a set of ConsensusCluster records into a plain-text block for the judge prompt. */
function renderClustersForPrompt(clusters: ConsensusCluster[]): string {
  if (!clusters.length) return "(No finding clusters produced by consensus step)";

  return clusters
    .map((c, i) => {
      const providers = [...new Set(c.members.map((m) => m.sourceProvider))].join(", ");
      const sev = c.maxSeverity ? ` [${c.maxSeverity}]` : "";
      const agreement = `${(c.agreementScore * 100).toFixed(0)}% agreement`;
      const outlierFlag = c.isOutlier ? " (outlier)" : "";
      const header = `${i + 1}. ${c.title}${sev} — ${agreement}${outlierFlag} (providers: ${providers})`;
      const memberLines = c.members
        .map((m) => `   ↳ [${m.sourceProvider}/${m.sourceModel}] ${m.summary}`)
        .join("\n");
      return `${header}\n${memberLines}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RunJudgeArgs {
  context: AnalysisContextPackage;
  consensus: ConsensusResult;
  results: NormalizedProviderResult[];
  judgeProvider: ProviderName;
  judgeModel?: string;
  /** Input images forwarded from the original run (for providers that support vision). */
  allImages?: import("../../types.js").InputImage[];
}

/**
 * Invoke the judge/reranker LLM step.
 *
 * Returns a JudgeOutput on success, or undefined if the call failed or
 * produced no parseable output.  Never throws.
 */
export async function runJudge(args: RunJudgeArgs): Promise<JudgeOutput | undefined> {
  const { context, consensus, results, judgeProvider, allImages } = args;
  const judgeModel = args.judgeModel ?? getDefaultModelForProvider(judgeProvider);
  const maxTokens = judgeProvider === "anthropic" ? 1600 : undefined;

  // Build judge prompt input
  const clusterText = renderClustersForPrompt(consensus.clusters);
  const analysisSummaries = results
    .filter((r) => r.status === "succeeded" && r.summary)
    .map((r) => ({ provider: r.provider, model: r.model, summary: r.summary }));

  const messages = buildPromptMessagesWithProfile(context, "judge", {
    judgeInput: {
      consensusSummary: `${consensus.agreementSummary}\n${consensus.disagreementSummary}`.trim(),
      clusterText,
      analysisSummaries,
    },
  });
  const promptText = promptTextFromMessages(messages);

  try {
    const answer = await dispatchPrompt({
      provider: judgeProvider,
      model: judgeModel,
      prompt: promptText,
      images: allImages,
      maxTokens,
      metadata: { step: "judge" },
    });

    if (answer.error || !answer.text?.trim()) {
      return undefined;
    }

    const parsed = parseJudgeOutput(answer.text);
    if (!parsed.prioritizedFindings.length && !parsed.openQuestions.length) {
      // Judge produced no parseable output — skip
      return undefined;
    }

    return {
      ...parsed,
      rawText: answer.text,
      judgeProvider,
      judgeModel,
    };
  } catch {
    return undefined;
  }
}
