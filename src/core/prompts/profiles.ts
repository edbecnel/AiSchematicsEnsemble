/**
 * Phase 4 — Prompt profile mechanism
 *
 * A prompt profile encapsulates the system-level instructions and formatting
 * rules used when constructing a NormalizedPromptMessage array from an
 * AnalysisContextPackage.  The three built-in profiles are:
 *
 *  - "analysis"          Main per-provider analysis fanout
 *  - "synthesis"         Post-fanout ensemble synthesis step
 *  - "structured-output" Requests explicit JSON-only responses
 *
 * Adding a new profile: implement a `PromptProfile` and register it in
 * `PROMPT_PROFILES`.  The rest of the dispatch path is unaffected.
 */

import type {
  AnalysisContextPackage,
  ExtractedArtifactText,
  NormalizedPromptMessage,
  PromptProfileId,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Profile contract
// ---------------------------------------------------------------------------

export interface PromptProfile {
  id: PromptProfileId;
  displayName: string;
  /**
   * Build the message sequence for this profile from the assembled context.
   * Returns an array that is ready to pass directly to a ProviderAdapter.
   */
  buildMessages(context: AnalysisContextPackage, extra?: PromptBuildExtra): NormalizedPromptMessage[];
}

/** Optional supplementary data that some profiles require (e.g. raw model answers for synthesis). */
export interface PromptBuildExtra {
  /** Raw text blocks from prior analysis step; used by the "synthesis" profile. */
  analysisAnswers?: Array<{ provider: string; model: string; text: string; error?: string }>;
  /**
   * Consensus + findings summary for the "judge" profile.
   * Formatted as plain text by the caller so the profile stays decoupled
   * from the ConsensusResult type.
   */
  judgeInput?: {
    /** Human-readable consensus summary block (built by pipeline.ts). */
    consensusSummary: string;
    /** Finding clusters rendered as plain text for the prompt. */
    clusterText: string;
    /** Every provider's full normalized answer summary for reference. */
    analysisSummaries: Array<{ provider: string; model: string; summary: string }>;
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TAG_MD_OPEN = "<final_markdown>";
const TAG_MD_CLOSE = "</final_markdown>";
const TAG_SPICE_OPEN = "<spice_netlist>";
const TAG_SPICE_CLOSE = "</spice_netlist>";
const TAG_JSON_OPEN = "<circuit_json>";
const TAG_JSON_CLOSE = "</circuit_json>";

const OUTPUT_FORMAT_BLOCK = `
OUTPUT FORMAT (MUST match exactly):
${TAG_MD_OPEN}
(Markdown report. Use headings/bullets. Keep it concise (target <= 400-600 words) so there is room for the SPICE netlist + JSON.)
${TAG_MD_CLOSE}

${TAG_SPICE_OPEN}
(Plain SPICE netlist ONLY — no Markdown, no code fences. Include .tran. Include .model definitions if needed.)
If you are uncertain, still output a BEST-EFFORT runnable netlist. Do NOT omit this block.
${TAG_SPICE_CLOSE}

${TAG_JSON_OPEN}
(Strict JSON. Must be valid. Include keys: assumptions[], probes[], bom[], notes[].)
Do NOT omit this block; if unknown, use empty arrays.
${TAG_JSON_CLOSE}
`.trim();

function extractedTextById(
  extractedTexts: ExtractedArtifactText[],
  id: string,
): string | undefined {
  return extractedTexts.find((e) => e.artifactId === id)?.text;
}

function buildContextBlock(context: AnalysisContextPackage): string {
  const lines: string[] = [];

  // Baseline netlist
  const netlistArtifact = context.artifacts.find((a) => a.kind === "netlist");
  if (netlistArtifact) {
    const text = extractedTextById(context.extractedTexts, netlistArtifact.id);
    if (text) {
      lines.push(
        "\nBASELINE NETLIST (treat as current ground truth topology):\n\n```spice\n" +
          text.trim() +
          "\n```\n",
      );
    }
  }

  // Inline image artifacts
  const imageArtifacts = context.artifacts.filter((a) => a.kind === "image");
  const baselineImg = imageArtifacts[0];
  if (baselineImg) {
    lines.push(
      `\nSCHEMATIC / IMAGE PROVIDED: ${baselineImg.filename ?? baselineImg.id}` +
        "\n- Use the attached image as reference for topology/components.\n",
    );
  }
  // Additional reference images
  for (const img of imageArtifacts.slice(1)) {
    const attachment = context.inlineAttachments?.find((a) => a.id === img.id);
    const tag = attachment?.tag ?? img.id;
    lines.push(`- REFERENCE IMAGE (${tag}): ${img.filename ?? img.id}`);
  }

  return lines.join("");
}

// ---------------------------------------------------------------------------
// Profile: analysis
// ---------------------------------------------------------------------------

const analysisProfile: PromptProfile = {
  id: "analysis",
  displayName: "Analysis",

  buildMessages(context, _extra): NormalizedPromptMessage[] {
    const contextBlock = buildContextBlock(context);

    const userContent = `You are an expert electrical engineer and experimentalist.
Your job is to analyze the provided circuit/schematic and give a careful technical recommendation.
Focus on testable, bench-verifiable advice.

QUESTION:
${context.userInstructions.trim()}
${contextBlock}

HARD REQUIREMENTS:
- If you propose a circuit, output a SPICE netlist that is runnable at a block level.
- Explicitly list disagreements or uncertainties and how to resolve them with measurements.
- Provide a minimal bench experiment plan.
- Flag safety risks (inductive spikes, battery hazards, etc.).
- If something is uncertain, state the missing info.

${OUTPUT_FORMAT_BLOCK}`;

    return [{ role: "user", text: userContent }];
  },
};

// ---------------------------------------------------------------------------
// Profile: synthesis
// ---------------------------------------------------------------------------

const synthesisProfile: PromptProfile = {
  id: "synthesis",
  displayName: "Synthesis",

  buildMessages(context, extra): NormalizedPromptMessage[] {
    const contextBlock = buildContextBlock(context);

    const answers = extra?.analysisAnswers ?? [];
    const answersBlock = answers
      .map((a) => {
        const header = `## Provider: ${a.provider} | Model: ${a.model}`;
        const body = a.error ? `(ERROR) ${a.error}` : (a.text ?? "").trim();
        return `${header}\n\n${body}\n`;
      })
      .join("\n---\n");

    const userContent = `You are an expert electrical engineer and experimentalist.
Your job is to ensemble multiple AI analysis outputs into a single careful recommendation.
We are working on arbitrary electrical circuits/schematics — focus on testable advice.

QUESTION:
${context.userInstructions.trim()}
${contextBlock}

MODEL OUTPUTS:
${answersBlock}

HARD REQUIREMENTS:
- If you propose a circuit, output a SPICE netlist that is runnable at a block level.
- Explicitly list disagreements and how to resolve them with measurements.
- Provide a minimal bench experiment plan.
- Flag safety risks (inductive spikes, battery hazards).
- If something is uncertain, state the missing info.

${OUTPUT_FORMAT_BLOCK}`;

    return [{ role: "user", text: userContent }];
  },
};

// ---------------------------------------------------------------------------
// Profile: structured-output
// ---------------------------------------------------------------------------

const structuredOutputProfile: PromptProfile = {
  id: "structured-output",
  displayName: "Structured Output",

  buildMessages(context, _extra): NormalizedPromptMessage[] {
    const contextBlock = buildContextBlock(context);

    const userContent = `You are an expert electrical engineer and experimentalist.
Analyze the provided circuit/schematic carefully and respond ONLY with a valid JSON object.

QUESTION:
${context.userInstructions.trim()}
${contextBlock}

Respond ONLY with a valid JSON object with these keys:
{
  "summary": "string — one paragraph",
  "findings": [{ "title": "string", "severity": "info|low|medium|high|critical", "summary": "string" }],
  "assumptions": ["string"],
  "missingInfo": ["string"],
  "recommendedActions": ["string"],
  "spiceNetlist": "string — plain SPICE netlist, no fences",
  "bom": [{ "ref": "string", "value": "string", "description": "string" }],
  "probes": ["string"],
  "notes": ["string"]
}

Do NOT include any text outside the JSON object. Omit a key if you have no data for it (use empty array not null).`;

    return [{ role: "user", text: userContent }];
  },
};

// ---------------------------------------------------------------------------
// Profile: judge
// ---------------------------------------------------------------------------

const JUDGE_FINDINGS_OPEN = "<judge_prioritized_findings>";
const JUDGE_FINDINGS_CLOSE = "</judge_prioritized_findings>";
const JUDGE_QUESTIONS_OPEN = "<judge_open_questions>";
const JUDGE_QUESTIONS_CLOSE = "</judge_open_questions>";
const JUDGE_CONFIDENCE_OPEN = "<judge_confidence_notes>";
const JUDGE_CONFIDENCE_CLOSE = "</judge_confidence_notes>";

export const JUDGE_OUTPUT_TAGS = {
  findingsOpen: JUDGE_FINDINGS_OPEN,
  findingsClose: JUDGE_FINDINGS_CLOSE,
  questionsOpen: JUDGE_QUESTIONS_OPEN,
  questionsClose: JUDGE_QUESTIONS_CLOSE,
  confidenceOpen: JUDGE_CONFIDENCE_OPEN,
  confidenceClose: JUDGE_CONFIDENCE_CLOSE,
};

const judgeProfile: PromptProfile = {
  id: "judge",
  displayName: "Judge / Reranker",

  buildMessages(context, extra): NormalizedPromptMessage[] {
    const ji = extra?.judgeInput;
    const contextBlock = buildContextBlock(context);

    const clusterSection = ji?.clusterText
      ? `\nFINDING CLUSTERS (from consensus step):\n${ji.clusterText}\n`
      : "";

    const summarySection = ji?.consensusSummary
      ? `\nCONSENSUS SUMMARY:\n${ji.consensusSummary}\n`
      : "";

    const analysisSummaries = ji?.analysisSummaries ?? [];
    const answersBlock = analysisSummaries.length
      ? analysisSummaries
          .map((a) => `## ${a.provider} / ${a.model}\n\n${a.summary.trim()}`)
          .join("\n\n---\n\n")
      : "(No individual summaries provided)";

    const outputFormat = `
OUTPUT FORMAT (MUST match exactly):

${JUDGE_FINDINGS_OPEN}
(List each finding on its own bullet line as: - [SEVERITY] Title: one-sentence justification)
Example: - [high] Inductive spike on MOSFET drain: gate drive may be insufficient to absorb energy at turn-off.
${JUDGE_FINDINGS_CLOSE}

${JUDGE_QUESTIONS_OPEN}
(One open question per bullet: - Question text)
${JUDGE_QUESTIONS_CLOSE}

${JUDGE_CONFIDENCE_OPEN}
(One confidence note per bullet: - Note text)
${JUDGE_CONFIDENCE_CLOSE}
`.trim();

    const userContent = `You are an expert electrical engineer acting as a judge and reranker.
You have received findings from multiple AI analysis models for the same circuit/schematic question.
Your job is to:
  1. Rerank and prioritize the findings from most to least critical.
  2. Identify open questions that none of the models answered adequately.
  3. Provide confidence notes about the overall analysis quality.

Be succinct: findings list should have at most 10 items; open questions at most 5; confidence notes at most 5.
Omit a section rather than filling it with low-value items.

QUESTION:
${context.userInstructions.trim()}
${contextBlock}
${summarySection}
${clusterSection}
INDIVIDUAL PROVIDER SUMMARIES:
${answersBlock}

${outputFormat}`;

    return [{ role: "user", text: userContent }];
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PROMPT_PROFILES: Record<PromptProfileId, PromptProfile> = {
  "analysis": analysisProfile,
  "synthesis": synthesisProfile,
  "structured-output": structuredOutputProfile,
  "judge": judgeProfile,
};

/**
 * Build a NormalizedPromptMessage array for the given context using the
 * profile registered under `context.promptProfileId`.
 */
export function buildPromptMessages(
  context: AnalysisContextPackage,
  extra?: PromptBuildExtra,
): NormalizedPromptMessage[] {
  const profile = PROMPT_PROFILES[context.promptProfileId];
  if (!profile) {
    throw new Error(`Unknown prompt profile ID: "${context.promptProfileId}"`);
  }
  return profile.buildMessages(context, extra);
}

/**
 * Build messages using an explicit profile ID, overriding the one set on the context.
 */
export function buildPromptMessagesWithProfile(
  context: AnalysisContextPackage,
  profileId: PromptProfileId,
  extra?: PromptBuildExtra,
): NormalizedPromptMessage[] {
  const profile = PROMPT_PROFILES[profileId];
  if (!profile) {
    throw new Error(`Unknown prompt profile ID: "${profileId}"`);
  }
  return profile.buildMessages(context, extra);
}
