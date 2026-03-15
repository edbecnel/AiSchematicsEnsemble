/**
 * Phase J.5 — Auto-detect: scan a SPICE netlist for component instantiations
 * that reference model names with no matching .SUBCKT definition in the
 * accompanying text or library files.
 *
 * Detection strategy:
 *   1. Parse X-element lines (subcircuit instances) from the netlist.
 *   2. Collect the model name each instance references (last token on the line,
 *      before any PARAMS: keyword).
 *   3. Scan the combined lib text for .SUBCKT declarations.
 *   4. Return any referenced model names that have no corresponding declaration.
 *
 * Eligibility filtering:
 *   - Model names composed entirely of SPICE primitives are excluded
 *     (R, C, L, V, I, etc. do not need .SUBCKT definitions).
 *   - Names that look like passive component values are excluded.
 *   - A confidence score is produced per candidate; low-confidence items are
 *     returned with a flag so callers can decide whether to auto-generate.
 *
 * Guardrails (per Phase J.5 guardrails):
 *   - This module NEVER patches the netlist. It only reports findings.
 *   - Low-confidence candidates are returned but flagged, not acted on silently.
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type DetectionConfidence = "high" | "medium" | "low";

export interface MissingSubcktCandidate {
  /** Model name referenced in the netlist. */
  modelName: string;
  /** All X-element reference designators that instantiate this model. */
  refdesignators: string[];
  /** Confidence that this is a genuinely missing .SUBCKT (not a ngspice primitive). */
  confidence: DetectionConfidence;
  /**
   * Human-readable reason (e.g. "Referenced 3 times, no matching .SUBCKT found").
   */
  reason: string;
  /**
   * True when auto-generation is considered appropriate.
   * Only set for "high" confidence candidates.
   */
  eligibleForAutoGeneration: boolean;
}

export interface DetectMissingSubcktsResult {
  /** All candidates with at least medium confidence. */
  candidates: MissingSubcktCandidate[];
  /** Lower-confidence candidates — returned for visibility but not auto-generated. */
  lowConfidenceCandidates: MissingSubcktCandidate[];
  /** All model names referenced in the netlist. */
  allReferencedModels: string[];
  /** All .SUBCKT names found in the libs/netlist. */
  declaredSubckts: string[];
}

// ---------------------------------------------------------------------------
// Known SPICE primitive classes (not subcircuits)
// ---------------------------------------------------------------------------

// Single-character SPICE element prefixes that never need a .SUBCKT definition.
const PRIMITIVE_PREFIXES = new Set(["R", "C", "L", "V", "I", "D", "Q", "M", "J", "E", "F", "G", "H", "K", "T", "U", "W", "S", "Z"]);

// Well-known ngspice built-in model names and type prefixes
const KNOWN_BUILTIN_MODELS = new Set([
  "NMOS", "PMOS", "NPN", "PNP", "NJF", "PJF",
  "D", "SW", "CSW", "URC", "LTRA", "TRANLINE",
  "VDMOS", "BSIM3", "BSIM4", "HICUM", "PSP",
]);

// Patterns that look like passive component names, not model references
const PASSIVE_PATTERN = /^[0-9]|^[RCL][0-9]/i;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

interface XElement {
  refdes: string;
  nodes: string[];
  modelName: string;
  rawLine: string;
}

/**
 * Parse X-element (subcircuit instantiation) lines from a SPICE netlist.
 * Format: Xname node1 node2 ... [PARAMS: ...] MODELNAME
 * The model name is the last token before an optional PARAMS: keyword.
 */
export function parseXElements(netlistText: string): XElement[] {
  const elements: XElement[] = [];
  const lines = netlistText.split("\n");

  // Handle line continuations (+)
  const expanded: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("+") && expanded.length) {
      expanded[expanded.length - 1] += " " + t.slice(1).trim();
    } else {
      expanded.push(t);
    }
  }

  for (const line of expanded) {
    const t = line.trim();
    if (!/^X/i.test(t)) continue;
    if (t.startsWith("*")) continue; // comment

    // Split on PARAMS: or PARAM: to get the node/model tokens
    const paramIdx = t.search(/\s+params?:/i);
    const mainPart = paramIdx >= 0 ? t.slice(0, paramIdx) : t;
    const tokens = mainPart.trim().split(/\s+/);

    if (tokens.length < 2) continue;

    const refdes = tokens[0];
    // The last token is the model name; everything between are nodes
    const modelName = tokens[tokens.length - 1];
    const nodes = tokens.slice(1, tokens.length - 1);

    elements.push({ refdes, nodes, modelName, rawLine: line });
  }

  return elements;
}

/**
 * Collect all .SUBCKT names declared in the given text (netlist + any lib text).
 */
export function collectDeclaredSubckts(combinedText: string): Set<string> {
  const declared = new Set<string>();
  const lines = combinedText.split("\n");
  for (const line of lines) {
    const t = line.trim();
    const m = t.match(/^\.subckt\s+(\S+)/i);
    if (m) declared.add(m[1].toUpperCase());
  }
  return declared;
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

function scoreCandidate(modelName: string, refCount: number): DetectionConfidence {
  const up = modelName.toUpperCase();

  // Definite primitives: single or two-char all-uppercase names
  if (KNOWN_BUILTIN_MODELS.has(up)) return "low";
  if (PRIMITIVE_PREFIXES.has(up[0]) && up.length <= 2) return "low";
  if (PASSIVE_PATTERN.test(modelName)) return "low";

  // Longer, meaningful names referenced multiple times → high confidence
  if (modelName.length >= 4 && refCount >= 2) return "high";
  if (modelName.length >= 4) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Main detector
// ---------------------------------------------------------------------------

/**
 * Detect component model references in `netlistText` that have no matching
 * .SUBCKT declaration in `netlistText` + `libTexts`.
 *
 * @param netlistText   The final .cir text from the ensemble fanout.
 * @param libTexts      Optional additional .lib texts already in scope.
 */
export function detectMissingSubckts(
  netlistText: string,
  libTexts: string[] = [],
): DetectMissingSubcktsResult {
  const combinedLibText = [netlistText, ...libTexts].join("\n");
  const declared = collectDeclaredSubckts(combinedLibText);

  const xElements = parseXElements(netlistText);
  const allReferenced = [...new Set(xElements.map((x) => x.modelName.toUpperCase()))];

  // Group references by model name
  const byModel = new Map<string, string[]>(); // modelName(upper) → refdes[]
  for (const el of xElements) {
    const key = el.modelName.toUpperCase();
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(el.refdes);
  }

  const candidates: MissingSubcktCandidate[] = [];
  const lowConfidenceCandidates: MissingSubcktCandidate[] = [];

  for (const [modelUpper, refdes] of byModel.entries()) {
    // Skip models that are already declared
    if (declared.has(modelUpper)) continue;

    const confidence = scoreCandidate(modelUpper, refdes.length);
    const candidate: MissingSubcktCandidate = {
      modelName: modelUpper,
      refdesignators: refdes,
      confidence,
      reason: `Referenced ${refdes.length}× as X-element (${refdes.slice(0, 3).join(", ")}${refdes.length > 3 ? "…" : ""}), no .SUBCKT declaration found.`,
      eligibleForAutoGeneration: confidence === "high",
    };

    if (confidence === "low") {
      lowConfidenceCandidates.push(candidate);
    } else {
      candidates.push(candidate);
    }
  }

  // Sort by confidence (high first), then by ref count
  candidates.sort((a, b) => {
    const scoreMap: Record<DetectionConfidence, number> = { high: 2, medium: 1, low: 0 };
    const diff = scoreMap[b.confidence] - scoreMap[a.confidence];
    return diff !== 0 ? diff : b.refdesignators.length - a.refdesignators.length;
  });

  return {
    candidates,
    lowConfidenceCandidates,
    allReferencedModels: allReferenced,
    declaredSubckts: [...declared],
  };
}
