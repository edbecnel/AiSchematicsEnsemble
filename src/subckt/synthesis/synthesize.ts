/**
 * Phase E — SUBCKT model synthesis.
 *
 * Takes extracted component facts from Phase D and generates a concrete
 * ngspice-compatible .SUBCKT candidate.
 *
 * Design principles:
 *   - Prefer simpler behavioral models over fabricated transistor-level precision.
 *   - Never present a model as more accurate than the source data supports.
 *   - Always include a prominent assumptions/simplifications comment block.
 *   - Normalize .SUBCKT and .ENDS names to match exactly.
 *   - Preserve declared pin order from the extracted pin list.
 *   - Keep raw generator output for audit, normalize it before returning.
 */

import path from "node:path";
import fs from "fs-extra";

import { dispatchPrompt } from "../../core/providers/resolver.js";
import { getDefaultModelForProvider } from "../../registry/providers.js";
import type {
  ExtractedComponentFact,
  SubcktAbstractionLevel,
  SubcktCandidate,
  SubcktLibRequest,
  SubcktPinDefinition,
} from "../types.js";

// ---------------------------------------------------------------------------
// Synthesis input / output
// ---------------------------------------------------------------------------

export interface SynthesizeModelInput {
  request: SubcktLibRequest;
  facts: ExtractedComponentFact[];
  pins: SubcktPinDefinition[];
  /** Abstraction level. Defaults to request.abstractionLevel or "behavioral". */
  abstractionLevel?: SubcktAbstractionLevel;
  /** Provider to use. Defaults to "anthropic". */
  provider?: "openai" | "xai" | "google" | "anthropic";
  /** Model override. */
  model?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface SynthesizeModelResult {
  candidate: SubcktCandidate;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function abstractionLevelGuidance(level: SubcktAbstractionLevel): string {
  switch (level) {
    case "behavioral":
      return `Use a BEHAVIORAL model. Model the component's key functional behavior using SPICE primitives (V sources, I sources, R, C, L, E, F, G, H, switch elements, transmission lines, etc.). Do NOT attempt transistor-level topology unless the datasheet explicitly provides all transistor parameters. Keep it simple and simulable.`;
    case "macro":
      return `Use a MACRO model. Build a macro-model using SPICE sub-elements that capture the component's primary transfer function, input/output levels, drive capability, and protection limits. Use behavioral current sources where helpful.`;
    case "datasheet_constrained":
      return `Use a DATASHEET-CONSTRAINED model. Map all extracted datasheet parameters directly to model element values. Explicitly reference each used datasheet value in comments. Parameters you cannot confirm from the datasheet must be labelled as estimates with low confidence.`;
  }
}

function buildSynthesisPrompt(args: {
  componentName: string;
  partNumber?: string;
  manufacturer?: string;
  facts: ExtractedComponentFact[];
  pins: SubcktPinDefinition[];
  abstractionLevel: SubcktAbstractionLevel;
  modelName: string;
}): string {
  const { componentName, partNumber, manufacturer, facts, pins, abstractionLevel, modelName } = args;

  const componentId = [
    componentName,
    manufacturer ? `(${manufacturer})` : "",
    partNumber && partNumber !== componentName ? `Part#: ${partNumber}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Serialize facts by category
  const byCategory = new Map<string, string[]>();
  for (const f of facts) {
    const arr = byCategory.get(f.category) ?? [];
    arr.push(
      `  ${f.key} = ${f.value}` +
      (f.confidence < 0.5 ? ` [ESTIMATED, confidence ${Math.round(f.confidence * 100)}%]` : ""),
    );
    byCategory.set(f.category, arr);
  }

  const factsBlock = [...byCategory.entries()]
    .map(([cat, lines]) => `${cat.toUpperCase()}:\n${lines.join("\n")}`)
    .join("\n\n");

  const pinsBlock = pins.length
    ? pins
        .sort((a, b) => a.pinOrder - b.pinOrder)
        .map((p) => `  ${p.pinOrder}. ${p.pinName}${p.direction ? ` [${p.direction}]` : ""}${p.description ? ` — ${p.description}` : ""}`)
        .join("\n")
    : "  (No pin information available)";

  const guidance = abstractionLevelGuidance(abstractionLevel);

  return `You are an expert SPICE model engineer creating an ngspice-compatible .SUBCKT model.

COMPONENT: ${componentId}
MODEL NAME: ${modelName}
ABSTRACTION LEVEL: ${abstractionLevel.toUpperCase()}

${guidance}

EXTRACTED COMPONENT FACTS:
${factsBlock || "(No structured facts available — use component type knowledge)"}

PIN LIST (in .SUBCKT declaration order):
${pinsBlock}

TASK: Generate a complete, ngspice-compatible .SUBCKT definition for this component.

REQUIRED OUTPUT FORMAT:
Return your response using these exact XML-like tags:

<subckt_text>
.SUBCKT ${modelName} <pin1> <pin2> ...
* --- COMPONENT: ${componentId} ---
* --- MODEL TYPE: ${abstractionLevel} ---
* --- ASSUMPTIONS: ---
* <list each assumption on its own * comment line>
* --- LIMITATIONS: ---
* <list each limitation on its own * comment line>
*
<SPICE element lines>
.ENDS ${modelName}
</subckt_text>

<assumptions>
<one assumption per line>
</assumptions>

<limitations>
<one limitation per line>
</limitations>

<warnings>
<one warning per line, or "none">
</warnings>

RULES:
1. The .SUBCKT name and .ENDS name MUST be identical: "${modelName}"
2. Pin names in the .SUBCKT header MUST match the PIN LIST above exactly, in order.
3. All internal node names must be unique and SPICE-safe.
4. Every parameter value taken from the datasheet should be in a comment showing its source.
5. Parameters you must estimate should be clearly labeled with * ESTIMATED in a comment.
6. Keep the model simulable in ngspice — avoid vendor-specific syntax.
7. Do NOT include a .lib or .end directive — only the .SUBCKT block.
8. Be explicit about behavioral approximations and what they miss.`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function extractTag(text: string, tag: string): string | null {
  const open  = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  const end   = text.indexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start + open.length, end).trim();
}

function parseLines(block: string | null): string[] {
  if (!block) return [];
  return block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "none" && l !== "-");
}

interface ParsedSynthesisResponse {
  subcktText: string;
  assumptions: string[];
  limitations: string[];
  warnings: string[];
}

function parseSynthesisResponse(raw: string): ParsedSynthesisResponse {
  const subcktText = extractTag(raw, "subckt_text") ?? "";
  const assumptions = parseLines(extractTag(raw, "assumptions"));
  const limitations = parseLines(extractTag(raw, "limitations"));
  const warnings    = parseLines(extractTag(raw, "warnings"));

  return { subcktText, assumptions, limitations, warnings };
}

// ---------------------------------------------------------------------------
// SUBCKT normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes the raw .SUBCKT text produced by the AI:
 *   - Ensures .SUBCKT and .ENDS names match the expected model name.
 *   - Removes double blank lines.
 *   - Strips trailing whitespace.
 *   - Ensures the file ends with a single newline.
 */
function normalizeSubcktText(text: string, expectedName: string): {
  normalized: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  const outLines: string[] = [];

  let subcktLine: string | null = null;
  let endsLine:   string | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Detect and fix .SUBCKT header
    if (/^\.subckt\b/i.test(trimmed)) {
      const parts = trimmed.split(/\s+/);
      const declaredName = parts[1] ?? expectedName;
      if (declaredName.toLowerCase() !== expectedName.toLowerCase()) {
        warnings.push(`Normalized .SUBCKT name "${declaredName}" → "${expectedName}"`);
        parts[1] = expectedName;
      }
      subcktLine = parts.join(" ");
      outLines.push(subcktLine);
      continue;
    }

    // Detect and fix .ENDS line
    if (/^\.ends\b/i.test(trimmed)) {
      const parts = trimmed.split(/\s+/);
      const declaredName = parts[1];
      if (declaredName && declaredName.toLowerCase() !== expectedName.toLowerCase()) {
        warnings.push(`Normalized .ENDS name "${declaredName}" → "${expectedName}"`);
      }
      endsLine = `.ENDS ${expectedName}`;
      outLines.push(endsLine);
      continue;
    }

    outLines.push(trimmed);
  }

  if (!subcktLine) {
    warnings.push("No .SUBCKT directive found in generated output.");
    // Prepend a placeholder header
    outLines.unshift(`.SUBCKT ${expectedName} * GENERATED — add port list`);
  }
  if (!endsLine) {
    warnings.push("No .ENDS directive found in generated output.");
    outLines.push(`.ENDS ${expectedName}`);
  }

  // Collapse multiple consecutive blank lines to one
  const deduplicated: string[] = [];
  let prevBlank = false;
  for (const l of outLines) {
    const isBlank = !l.trim();
    if (isBlank && prevBlank) continue;
    deduplicated.push(l);
    prevBlank = isBlank;
  }

  return { normalized: deduplicated.join("\n").trim() + "\n", warnings };
}

// ---------------------------------------------------------------------------
// Model name normalization
// ---------------------------------------------------------------------------

/**
 * Produce a SPICE-safe model name from the component identifier.
 * Rules: alphanumeric + underscores, starting with a letter, max 64 chars.
 */
function toModelName(componentName: string, partNumber?: string): string {
  const base = partNumber?.trim() || componentName.trim();
  const safe = base
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefixed = /^[a-zA-Z]/i.test(safe) ? safe : `X_${safe}`;
  return prefixed.slice(0, 64).toUpperCase();
}

// ---------------------------------------------------------------------------
// Top-level synthesizer
// ---------------------------------------------------------------------------

/**
 * Synthesize an ngspice-compatible .SUBCKT candidate from extracted facts.
 * Persists the raw generator output and normalized candidate to `runDir`.
 */
export async function synthesizeSubcktModel(
  args: SynthesizeModelInput,
  runDir?: string,
): Promise<SynthesizeModelResult> {
  const { request, facts, pins, log } = args;
  const info = log ?? ((m: string) => console.log(m));
  const allWarnings: string[] = [];

  const level: SubcktAbstractionLevel =
    args.abstractionLevel ?? request.abstractionLevel ?? "behavioral";
  const provider = args.provider ?? "anthropic";
  const model    = args.model ?? getDefaultModelForProvider(provider);
  const modelName = toModelName(request.componentName, request.partNumber);

  const prompt = buildSynthesisPrompt({
    componentName: request.componentName,
    partNumber: request.partNumber,
    manufacturer: request.manufacturer,
    facts,
    pins,
    abstractionLevel: level,
    modelName,
  });

  info(`Synthesizing .SUBCKT model with ${provider} (${model})...`);

  let rawOutput = "";
  let parsed: ParsedSynthesisResponse = {
    subcktText: "",
    assumptions: [],
    limitations: [],
    warnings: [],
  };

  try {
    const answer = await dispatchPrompt({
      provider,
      model,
      prompt,
      maxTokens: 2400,
      metadata: { step: "subckt-synthesis", component: request.componentName, modelName },
    });

    rawOutput = answer.text ?? "";

    if (answer.error) {
      allWarnings.push(`Provider synthesis error: ${answer.error}`);
    }

    parsed = parseSynthesisResponse(rawOutput);
    allWarnings.push(...parsed.warnings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    allWarnings.push(`Synthesis failed: ${msg}`);

    // Return a placeholder candidate so the run can continue
    const placeholder = `.SUBCKT ${modelName} * PLACEHOLDER — synthesis failed\n* Error: ${msg}\n.ENDS ${modelName}\n`;
    return {
      candidate: {
        modelName,
        subcktText: placeholder,
        pins: pins,
        assumptions: ["Model generation failed — placeholder only."],
        limitations: ["This placeholder is not a valid simulation model."],
        warnings: [msg],
        abstractionLevel: level,
        rawGeneratorOutput: rawOutput,
      },
      warnings: allWarnings,
    };
  }

  // Persist raw output
  if (runDir) {
    await fs.outputFile(
      path.join(runDir, "candidate-raw.md"),
      [`# Raw Generator Output\n`, rawOutput].join("\n"),
      "utf-8",
    );
  }

  // Normalize
  const { normalized, warnings: normWarnings } = normalizeSubcktText(parsed.subcktText, modelName);
  allWarnings.push(...normWarnings);

  if (!parsed.subcktText.trim()) {
    allWarnings.push("Synthesis returned empty .SUBCKT block.");
  }

  info(`  → .SUBCKT ${modelName} synthesized (${normalized.length} chars, level=${level})`);

  const candidate: SubcktCandidate = {
    modelName,
    subcktText: normalized,
    pins,
    assumptions: parsed.assumptions,
    limitations: parsed.limitations,
    warnings: [...parsed.warnings, ...normWarnings],
    abstractionLevel: level,
    rawGeneratorOutput: rawOutput,
  };

  return { candidate, warnings: allWarnings };
}
