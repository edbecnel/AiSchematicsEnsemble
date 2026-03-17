/**
 * Phase D — Structured component fact extraction.
 *
 * Uses AI to extract canonical ExtractedComponentFact[] from raw datasheet
 * text/notes. This is deliberately a SEPARATE step from model synthesis (Phase E)
 * so that:
 *   - review is possible at the intermediate facts stage
 *   - model synthesis can be re-run without re-doing extraction
 *   - the machine-readable facts JSON is an auditable artifact
 *
 * Extraction is done in two passes:
 *   1. An AI call that returns structured JSON (or tagged sections).
 *   2. A local parser that normalizes the AI output into ExtractedComponentFact[].
 *
 * If the AI returns malformed output, partial facts are preserved with
 * lower confidence rather than failing the entire run.
 */

import path from "node:path";
import fs from "fs-extra";

import { dispatchPrompt } from "../../core/providers/resolver.js";
import { getDefaultModelForProvider } from "../../registry/providers.js";
import type { ProviderName } from "../../types.js";
import type { ExtractedComponentFact, SubcktLibRequest, SubcktPinDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Extraction input / output
// ---------------------------------------------------------------------------

export interface ExtractFactsInput {
  request: SubcktLibRequest;
  /** Combined datasheet text from Phase C. */
  datasheetText: string;
  /** Sections already identified by the ingestion step. */
  identifiedSections?: Array<{ kind: string; heading: string; text: string }>;
  /** Provider to use for extraction. Defaults to anthropic. */
  provider?: ProviderName;
  /** Model override. */
  model?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface ExtractFactsResult {
  facts: ExtractedComponentFact[];
  /** Inferred/confirmed pin list extracted as part of fact extraction. */
  inferredPins: SubcktPinDefinition[];
  /** Raw AI response text, kept for audit. */
  rawExtractorOutput: string;
  /** Warnings generated during extraction or parsing. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(args: {
  componentName: string;
  manufacturer?: string;
  partNumber?: string;
  userNotes?: string;
  knownPinMap?: SubcktPinDefinition[];
  datasheetText: string;
  sections?: Array<{ kind: string; heading: string; text: string }>;
}): string {
  const { componentName, manufacturer, partNumber, userNotes, knownPinMap, datasheetText, sections } = args;

  const componentId = [
    componentName,
    manufacturer ? `(${manufacturer})` : "",
    partNumber && partNumber !== componentName ? `Part: ${partNumber}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const knownPinsBlock =
    knownPinMap?.length
      ? `\nUSER-PROVIDED PIN MAP:\n${knownPinMap.map((p) => `  ${p.pinOrder}. ${p.pinName}${p.direction ? ` [${p.direction}]` : ""}${p.description ? ` — ${p.description}` : ""}`).join("\n")}\n`
      : "";

  const notesBlock = userNotes?.trim()
    ? `\nUSER NOTES:\n${userNotes.trim()}\n`
    : "";

  const sectionSummary =
    sections?.length
      ? `\nIDENTIFIED SECTIONS: ${sections.map((s) => `${s.kind}:"${s.heading}"`).join(", ")}\n`
      : "";

  const rawTextBlock = datasheetText.trim()
    ? `\nDATASHEET EXTRACTED TEXT (may be imperfect PDF extraction):\n\`\`\`\n${datasheetText.slice(0, 24_000).trim()}\n\`\`\`\n`
    : "\n(No datasheet text available — use component name and notes only.)\n";

  return `You are an expert analog/digital circuit engineer extracting structured component facts for use in SPICE simulation model generation.

COMPONENT: ${componentId}
${knownPinsBlock}${notesBlock}${sectionSummary}${rawTextBlock}

TASK: Extract ALL relevant component facts from the datasheet text above that are useful for generating an ngspice-compatible SPICE simulation model (.SUBCKT).

Return a JSON structure with two fields:

1. "facts": array of fact objects, each with:
   - "category": one of "identity" | "pin" | "supply" | "threshold" | "timing" | "transfer" | "absolute_max" | "recommended_operating" | "behavior" | "limitation" | "unknown"
   - "key": short property name (e.g. "VCC_max", "propagation_delay_tpHL", "Input_A_threshold")
   - "value": the value as a formatted string with units (e.g. "5.5 V", "15 ns typ", "2.0 V min")
   - "evidence": array of 1-3 short verbatim excerpts from the text supporting this fact
   - "confidence": 0.0 to 1.0 (high = confirmed from text; low = inferred or unclear)

2. "pins": array of pin objects in ORDER as they appear in the .SUBCKT port list, each with:
   - "pinOrder": 1-based integer
   - "pinName": canonical SPICE-safe name (no spaces, use underscores)
   - "direction": one of "in" | "out" | "inout" | "pwr" | "gnd" | "passive" (omit if unclear)
   - "description": short human-readable description (optional)

IMPORTANT RULES:
- Prefer explicit datasheet values over guesses. If a value is not in the datasheet, set confidence ≤ 0.3.
- For uncertain values, still include the fact with low confidence and note the uncertainty in evidence.
- Never fabricate precision that is not in the source data.
- Pin names must be SPICE-safe (alphanumeric + underscores, no special chars).
- If pinout is unknown, estimate from component type/function with very low confidence.
- Return ONLY the JSON object, nothing else.

REQUIRED OUTPUT FORMAT (JSON only, no markdown wrap):
{
  "facts": [...],
  "pins": [...]
}`;
}

// ---------------------------------------------------------------------------
// AI response parser
// ---------------------------------------------------------------------------

interface RawExtractorResponse {
  facts?: unknown[];
  pins?: unknown[];
}

function parseFact(raw: unknown, index: number): ExtractedComponentFact | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const category = String(r["category"] ?? "unknown") as ExtractedComponentFact["category"];
  const key = String(r["key"] ?? `fact_${index}`).trim();
  const value = String(r["value"] ?? "").trim();
  const evidenceRaw = Array.isArray(r["evidence"]) ? r["evidence"] : [];
  const evidence = evidenceRaw.map(String).filter(Boolean);
  const confidence = Math.max(0, Math.min(1, Number(r["confidence"]) || 0.5));

  if (!key || !value) return null;

  return { category, key, value, evidence, confidence };
}

function parsePin(raw: unknown, fallbackOrder: number): SubcktPinDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const pinOrder = Number.isFinite(Number(r["pinOrder"])) ? Math.max(1, Number(r["pinOrder"])) : fallbackOrder;
  const pinName = String(r["pinName"] ?? "").trim().replace(/[^a-zA-Z0-9_]/g, "_");
  if (!pinName) return null;

  const dirRaw = String(r["direction"] ?? "").toLowerCase();
  const validDirs = new Set(["in", "out", "inout", "pwr", "gnd", "passive"]);
  const direction = validDirs.has(dirRaw) ? (dirRaw as SubcktPinDefinition["direction"]) : undefined;
  const description = String(r["description"] ?? "").trim() || undefined;

  return { pinOrder, pinName, direction, description };
}

function parseExtractorResponse(text: string): {
  facts: ExtractedComponentFact[];
  pins: SubcktPinDefinition[];
  warnings: string[];
} {
  const warnings: string[] = [];

  // Strip markdown code fences if present
  let jsonText = text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "").trim();
  }

  let parsed: RawExtractorResponse;
  try {
    const rawParsed = JSON.parse(jsonText);
    if (typeof rawParsed !== "object" || rawParsed === null) {
      warnings.push("Extractor returned non-object JSON. Facts array empty.");
      return { facts: [], pins: [], warnings };
    }
    parsed = rawParsed as RawExtractorResponse;
  } catch {
    // Try to extract JSON from a larger body
    const match = jsonText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]) as RawExtractorResponse;
      } catch {
        warnings.push("Extractor response is not valid JSON. Facts array empty.");
        return { facts: [], pins: [], warnings };
      }
    } else {
      warnings.push("No JSON object found in extractor response. Facts array empty.");
      return { facts: [], pins: [], warnings };
    }
  }

  const rawFacts = Array.isArray(parsed.facts) ? parsed.facts : [];
  const rawPins  = Array.isArray(parsed.pins)  ? parsed.pins  : [];

  const facts: ExtractedComponentFact[] = [];
  for (let i = 0; i < rawFacts.length; i++) {
    const f = parseFact(rawFacts[i], i + 1);
    if (f) {
      facts.push(f);
    } else {
      warnings.push(`Skipped malformed fact at index ${i}.`);
    }
  }

  const pins: SubcktPinDefinition[] = [];
  for (let i = 0; i < rawPins.length; i++) {
    const p = parsePin(rawPins[i], i + 1);
    if (p) {
      pins.push(p);
    } else {
      warnings.push(`Skipped malformed pin at index ${i}.`);
    }
  }

  // Sort pins by pinOrder
  pins.sort((a, b) => a.pinOrder - b.pinOrder);

  return { facts, pins, warnings };
}

// ---------------------------------------------------------------------------
// Fact persistence helpers
// ---------------------------------------------------------------------------

function factsToMarkdown(
  facts: ExtractedComponentFact[],
  pins: SubcktPinDefinition[],
  componentName: string,
): string {
  const lines: string[] = [
    `# Extracted Component Facts: ${componentName}`,
    "",
    `_${facts.length} facts extracted, ${pins.length} pins identified._`,
    "",
  ];

  // Group by category
  const byCategory = new Map<string, ExtractedComponentFact[]>();
  for (const f of facts) {
    const arr = byCategory.get(f.category) ?? [];
    arr.push(f);
    byCategory.set(f.category, arr);
  }

  for (const [cat, catFacts] of byCategory) {
    lines.push(`## ${cat}`);
    lines.push("");
    for (const f of catFacts) {
      const conf = Math.round(f.confidence * 100);
      lines.push(`### ${f.key}: ${f.value} (confidence ${conf}%)`);
      if (f.evidence.length) {
        lines.push("*Evidence:*");
        for (const e of f.evidence) lines.push(`- "${e}"`);
      }
      lines.push("");
    }
  }

  if (pins.length) {
    lines.push("## Pin List");
    lines.push("");
    lines.push("| Order | Name | Direction | Description |");
    lines.push("|-------|------|-----------|-------------|");
    for (const p of pins) {
      lines.push(`| ${p.pinOrder} | ${p.pinName} | ${p.direction ?? "-"} | ${p.description ?? ""} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Top-level extractor
// ---------------------------------------------------------------------------

/**
 * Use an AI provider to extract structured component facts from datasheet text.
 * Persists results to `runDir` if provided.
 */
export async function extractComponentFacts(
  args: ExtractFactsInput,
  runDir?: string,
): Promise<ExtractFactsResult> {
  const { request, datasheetText, identifiedSections, log } = args;
  const info = log ?? ((m: string) => console.log(m));
  const warnings: string[] = [];

  const provider = args.provider ?? "anthropic";
  const model = args.model ?? getDefaultModelForProvider(provider);

  const prompt = buildExtractionPrompt({
    componentName: request.componentName,
    manufacturer: request.manufacturer,
    partNumber: request.partNumber,
    userNotes: request.userNotes,
    knownPinMap: request.knownPinMap,
    datasheetText,
    sections: identifiedSections,
  });

  info(`Extracting component facts with ${provider} (${model})...`);

  let rawOutput = "";
  try {
    const answer = await dispatchPrompt({
      provider,
      model,
      prompt,
      maxTokens: 2000,
      metadata: { step: "subckt-fact-extraction", component: request.componentName },
    });

    rawOutput = answer.text ?? "";

    if (answer.error) {
      warnings.push(`Provider returned an error: ${answer.error}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Fact extraction failed: ${msg}`);
    return {
      facts: [],
      inferredPins: request.knownPinMap ?? [],
      rawExtractorOutput: rawOutput,
      warnings,
    };
  }

  const parsed = parseExtractorResponse(rawOutput);
  warnings.push(...parsed.warnings);

  // Merge user-supplied pin map with extracted pins; prefer user map
  let finalPins = parsed.pins;
  if (request.knownPinMap?.length) {
    const userNames = new Set(request.knownPinMap.map((p) => p.pinName));
    const additionalPins = finalPins.filter((p) => !userNames.has(p.pinName));
    finalPins = [...request.knownPinMap, ...additionalPins].sort((a, b) => a.pinOrder - b.pinOrder);
  }

  info(`  → ${parsed.facts.length} facts, ${finalPins.length} pins extracted`);

  // Persist
  if (runDir) {
    await fs.outputJson(
      path.join(runDir, "extracted-facts.json"),
      { facts: parsed.facts, pins: finalPins, warnings },
      { spaces: 2 },
    );
    await fs.outputFile(
      path.join(runDir, "extracted-facts.md"),
      factsToMarkdown(parsed.facts, finalPins, request.componentName),
      "utf-8",
    );
  }

  return {
    facts: parsed.facts,
    inferredPins: finalPins,
    rawExtractorOutput: rawOutput,
    warnings,
  };
}
