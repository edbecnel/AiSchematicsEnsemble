/**
 * Phase 3 — Dispatch pipeline and normalization
 *
 * Responsibilities:
 *  - Classify raw provider error strings into the canonical error taxonomy
 *  - Convert RawProviderResponse → NormalizedDispatchResult
 *  - Parse structured tagged sections and fenced code blocks from provider text
 *  - Score parse quality so downstream stages can rank or skip outputs
 *  - Normalize a dispatch result into a fully-typed NormalizedProviderResult
 */

import type {
  DispatchStatus,
  NormalizedDispatchResult,
  NormalizedFinding,
  NormalizedProviderError,
  NormalizedProviderResult,
  ProviderErrorCategory,
  RawProviderResponse,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const AUTH_PATTERNS = [
  /\b(401|403|unauthorized|forbidden|invalid.*key|api.?key|authentication|auth.*fail)/i,
];
const TIMEOUT_PATTERNS = [/\b(timeout|timed.?out|deadline|request.*too.*long)/i];
const UNAVAILABLE_PATTERNS = [/\b(503|502|overloaded|unavailable|rate.?limit|capacity|quota)/i];
const ATTACHMENT_PATTERNS = [/\b(unsupported.*type|cannot.*process.*file|image.*format|file.*too.*large)/i];
const MALFORMED_PATTERNS = [/\b(invalid.*json|parse.*error|malformed|unexpected.*token|decode.*error)/i];

/**
 * Classify a raw error string from a provider into the canonical taxonomy.
 * Returns `undefined` only when `message` is blank (i.e. no error).
 */
export function classifyProviderError(message: string | undefined): NormalizedProviderError | undefined {
  if (!message || message.trim() === "") return undefined;

  let category: ProviderErrorCategory = "unknown";
  let retryable = false;

  if (AUTH_PATTERNS.some((p) => p.test(message))) {
    category = "auth";
    retryable = false;
  } else if (TIMEOUT_PATTERNS.some((p) => p.test(message))) {
    category = "timeout";
    retryable = true;
  } else if (UNAVAILABLE_PATTERNS.some((p) => p.test(message))) {
    category = "provider_unavailable";
    retryable = true;
  } else if (ATTACHMENT_PATTERNS.some((p) => p.test(message))) {
    category = "unsupported_attachment";
    retryable = false;
  } else if (MALFORMED_PATTERNS.some((p) => p.test(message))) {
    category = "malformed_output";
    retryable = false;
  }

  return { category, message, retryable };
}

// ---------------------------------------------------------------------------
// RawProviderResponse → NormalizedDispatchResult
// ---------------------------------------------------------------------------

export function dispatchResultFromRaw(response: RawProviderResponse): NormalizedDispatchResult {
  const error = classifyProviderError(response.error);
  const status: DispatchStatus =
    response.status ?? (error ? "failed" : response.text ? "succeeded" : "failed");

  return {
    provider: response.provider,
    model: response.model,
    status,
    text: response.text,
    error,
    raw: response.raw,
    usage: response.usage,
    latencyMs: response.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Structured output parser (XML-style tags)
// ---------------------------------------------------------------------------

interface ParsedSections {
  markdown?: string;
  spice?: string;
  json?: string;
}

const TAG_MD_OPEN = "<final_markdown>";
const TAG_MD_CLOSE = "</final_markdown>";
const TAG_SPICE_OPEN = "<spice_netlist>";
const TAG_SPICE_CLOSE = "</spice_netlist>";
const TAG_JSON_OPEN = "<circuit_json>";
const TAG_JSON_CLOSE = "</circuit_json>";

function extractBetweenTags(text: string, open: string, close: string): string | undefined {
  const i = text.indexOf(open);
  const j = text.indexOf(close);
  if (i === -1 || j === -1 || j <= i) return undefined;
  const content = text.substring(i + open.length, j).trim();
  return content || undefined;
}

/**
 * Parse XML-style sectioned output as produced by the main ensemble prompt.
 * Returns `undefined` if no known tags are present at all.
 */
export function parseStructuredOutput(text: string): ParsedSections | undefined {
  const markdown = extractBetweenTags(text, TAG_MD_OPEN, TAG_MD_CLOSE);
  const spice = extractBetweenTags(text, TAG_SPICE_OPEN, TAG_SPICE_CLOSE);
  const json = extractBetweenTags(text, TAG_JSON_OPEN, TAG_JSON_CLOSE);

  if (!markdown && !spice && !json) return undefined;
  return { markdown, spice, json };
}

// ---------------------------------------------------------------------------
// Fallback parser (fenced code blocks + heading sections)
// ---------------------------------------------------------------------------

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)\n```/g;

function extractFencedBlock(text: string, langs: string[]): string | undefined {
  const want = langs.map((l) => l.trim().toLowerCase());
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lang = (m[1] ?? "").trim().toLowerCase();
    const body = (m[2] ?? "").trim();
    if (!body) continue;
    if (want.length === 0 || want.includes(lang)) return body;
  }
  return undefined;
}

/**
 * Fallback parser for provider responses that do not use the structured tags.
 * Extracts SPICE and JSON from fenced code blocks; treats remaining text as markdown.
 */
export function parseFallbackSections(text: string): ParsedSections {
  const spice = extractFencedBlock(text, ["spice", "netlist", "sp"]);
  const json = extractFencedBlock(text, ["json"]);

  // Remove fenced blocks from the text to produce a cleaner markdown summary
  let markdown = text.replace(FENCE_RE, "").trim();
  if (!markdown) markdown = text.trim();

  return {
    markdown: markdown || undefined,
    spice,
    json,
  };
}

// ---------------------------------------------------------------------------
// Parse-quality scoring
// ---------------------------------------------------------------------------

/**
 * Score how well the provider followed the expected output format.
 *
 * Weight breakdown (sum = 1.0):
 *  - Markdown section present: 0.40
 *  - SPICE netlist present:    0.35
 *  - Circuit JSON present:     0.25
 */
export function scoreParseQuality(sections: ParsedSections): number {
  let score = 0;
  if (sections.markdown && sections.markdown.length > 20) score += 0.40;
  if (sections.spice && sections.spice.length > 10) score += 0.35;
  if (sections.json && sections.json.length > 2) score += 0.25;
  return Math.round(score * 100) / 100;
}

// ---------------------------------------------------------------------------
// Markdown section text extraction
// ---------------------------------------------------------------------------

/** Split a Markdown string by heading lines and return named sections. */
function splitMarkdownSections(md: string): Map<string, string> {
  const sections = new Map<string, string>();
  // Split on lines that start with one or more # characters
  const parts = md.split(/^#{1,4}\s+/m);
  // parts[0] is the text before any heading — treat as preamble
  if (parts[0]?.trim()) {
    sections.set("__preamble__", parts[0].trim());
  }
  const headingRe = /^(#{1,4})\s+(.+)/m;
  let lastHeading = "";
  for (const part of parts.slice(1)) {
    const lines = part.split("\n");
    const heading = (lines[0] ?? "").trim().toLowerCase();
    const body = lines.slice(1).join("\n").trim();
    lastHeading = heading;
    if (body) sections.set(heading, body);
  }
  void lastHeading; // suppress unused-var lint
  return sections;
}

/** Extract bullet list items from a block of text. */
function extractBullets(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s\-\*\u2022]+/, "").trim())
    .filter((l) => l.length > 3);
}

const FINDING_KEYWORDS = ["finding", "issue", "problem", "concern", "result", "observation"];
const ASSUMPTION_KEYWORDS = ["assumption"];
const MISSING_KEYWORDS = ["missing", "unknown", "open question", "clarif"];
const ACTION_KEYWORDS = ["recommend", "action", "next step", "fix", "experiment", "bench"];

function headingMatches(heading: string, keywords: string[]): boolean {
  return keywords.some((kw) => heading.includes(kw));
}

interface ExtractedTextSections {
  summary: string;
  findings: NormalizedFinding[];
  assumptions: string[];
  missingInfo: string[];
  recommendedActions: string[];
}

/**
 * Best-effort extraction of structured fields from an unstructured markdown
 * string.  Used when the provider did not follow the tagged output format.
 */
export function extractTextSections(markdown: string): ExtractedTextSections {
  const sectionMap = splitMarkdownSections(markdown);

  let summary = sectionMap.get("__preamble__") ?? "";
  const findings: NormalizedFinding[] = [];
  const assumptions: string[] = [];
  const missingInfo: string[] = [];
  const recommendedActions: string[] = [];

  for (const [heading, body] of sectionMap.entries()) {
    if (heading === "__preamble__") continue;

    const bullets = extractBullets(body);

    if (!summary && (heading.includes("summary") || heading.includes("overview"))) {
      summary = body.split("\n")[0] ?? "";
    } else if (headingMatches(heading, FINDING_KEYWORDS)) {
      for (const b of bullets) {
        findings.push({ title: b, summary: b });
      }
    } else if (headingMatches(heading, ASSUMPTION_KEYWORDS)) {
      assumptions.push(...bullets);
    } else if (headingMatches(heading, MISSING_KEYWORDS)) {
      missingInfo.push(...bullets);
    } else if (headingMatches(heading, ACTION_KEYWORDS)) {
      recommendedActions.push(...bullets);
    }
  }

  // If no summary was found, use the first sentence of preamble or first line
  if (!summary) {
    const firstLine = markdown.split("\n").find((l) => l.trim().length > 10) ?? "";
    summary = firstLine.trim();
  }

  return { summary, findings, assumptions, missingInfo, recommendedActions };
}

// ---------------------------------------------------------------------------
// Top-level normalizer
// ---------------------------------------------------------------------------

/**
 * Produce a fully-typed NormalizedProviderResult from a NormalizedDispatchResult.
 *
 * Strategy:
 *  1. Try structured tag parser first (ensemble prompt format)
 *  2. Fall back to fenced-code-block + heading parser
 *  3. Score parse quality
 *  4. Extract semantic fields from the markdown section
 */
export function normalizeDispatchResult(dispatch: NormalizedDispatchResult): NormalizedProviderResult {
  // Failed dispatches return a minimal error result
  if (dispatch.status === "failed" || dispatch.status === "timed_out" || dispatch.status === "cancelled") {
    return {
      provider: dispatch.provider,
      model: dispatch.model,
      status: dispatch.status,
      summary: dispatch.error?.message ?? "Provider returned no output",
      findings: [],
      assumptions: [],
      missingInfo: [],
      recommendedActions: [],
      parseQuality: 0,
      confidenceHint: "Provider failed; result excluded from synthesis",
      error: dispatch.error,
    };
  }

  const text = dispatch.text ?? "";

  // Attempt structured parse first, fall back if nothing found
  const structured = parseStructuredOutput(text);
  const sections: ParsedSections = structured ?? parseFallbackSections(text);
  const wasStructured = structured !== undefined;

  const quality = scoreParseQuality(sections);

  // Extract semantic fields from the markdown section
  const extracted = extractTextSections(sections.markdown ?? text);

  // Parse circuit JSON — tolerate malformed JSON gracefully
  let circuitJson: string | undefined;
  if (sections.json) {
    try {
      JSON.parse(sections.json); // validate
      circuitJson = sections.json;
    } catch {
      // malformed; omit
    }
  }

  const confidenceHint =
    quality >= 0.75
      ? "High parse quality — all required sections found"
      : quality >= 0.40
        ? "Partial parse quality — some sections missing"
        : wasStructured
          ? "Low parse quality — provider did not follow output format"
          : "Low parse quality — fallback parser used; review output";

  return {
    provider: dispatch.provider,
    model: dispatch.model,
    status: dispatch.status,
    summary: extracted.summary,
    findings: extracted.findings,
    assumptions: extracted.assumptions,
    missingInfo: extracted.missingInfo,
    recommendedActions: extracted.recommendedActions,
    spiceNetlist: sections.spice,
    circuitJson,
    parseQuality: quality,
    confidenceHint,
    error: dispatch.error,
  };
}
