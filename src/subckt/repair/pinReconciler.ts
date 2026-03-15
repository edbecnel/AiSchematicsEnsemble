/**
 * Phase I — Pin name/order reconciliation.
 *
 * Compares the port list declared in a .SUBCKT header against an expected
 * pin definition set (from extracted facts or a user-supplied knownPinMap),
 * and reports mismatches, extra pins, or ordering differences.
 *
 * This module never reorders pins automatically — pin order changes affect
 * every call site and must be reviewed by the engineer. It produces a report
 * that goes into the change report and can drive a manual update.
 */

import type { SubcktPinDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PinMismatch {
  kind:
    | "name-mismatch"      // same position, different name
    | "order-mismatch"     // pin exists but at wrong position
    | "extra-in-model"     // pin in .SUBCKT not in expected list
    | "missing-in-model"   // pin in expected list not in .SUBCKT
    | "count-mismatch";    // different total pin counts
  pinOrder?: number;
  modelPinName?: string;
  expectedPinName?: string;
  note: string;
}

export interface PinReconcileResult {
  modelPins: SubcktPinDefinition[];
  expectedPins: SubcktPinDefinition[];
  isFullMatch: boolean;
  mismatches: PinMismatch[];
  /** Suggested canonical pin list (expected list when available, else model list). */
  suggestedPins: SubcktPinDefinition[];
}

// ---------------------------------------------------------------------------
// Parser: extract pins from .SUBCKT header
// ---------------------------------------------------------------------------

/**
 * Parse the .SUBCKT header line and extract pin definitions in declaration order.
 * Handles optional parameters (after the last port name, e.g. `PARAMS: VCC=5`).
 */
export function parsePinsFromSubcktHeader(subcktText: string): SubcktPinDefinition[] {
  const headerMatch = subcktText.match(/^\.subckt\s+\S+\s+(.*?)(?:\s+params:.*)?$/im);
  if (!headerMatch) return [];

  const portStr = headerMatch[1].trim();
  if (!portStr) return [];

  // Tokens up to an optional PARAMS: / PARAM: keyword
  const tokens = portStr.split(/\s+/);
  const ports: string[] = [];
  for (const t of tokens) {
    if (/^params?:/i.test(t)) break;
    if (t.includes("=")) break; // param assignment
    ports.push(t);
  }

  return ports.map((name, idx) => ({
    pinOrder: idx + 1,
    pinName: name,
    direction: undefined,
    description: undefined,
  }));
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Compare actual model pins (from .SUBCKT header) against expected pins
 * (from extracted facts or user-supplied map). Returns a full reconcile report.
 *
 * When `expectedPins` is empty the function returns a pass result immediately
 * (no expected data available to compare against).
 */
export function reconcilePins(
  modelPins: SubcktPinDefinition[],
  expectedPins: SubcktPinDefinition[],
): PinReconcileResult {
  const mismatches: PinMismatch[] = [];

  // No expected pin data — nothing to reconcile
  if (!expectedPins.length) {
    return {
      modelPins,
      expectedPins,
      isFullMatch: true,
      mismatches: [],
      suggestedPins: modelPins,
    };
  }

  // Count check
  if (modelPins.length !== expectedPins.length) {
    mismatches.push({
      kind: "count-mismatch",
      note: `Model has ${modelPins.length} pins, expected ${expectedPins.length}.`,
    });
  }

  // Build lookup maps
  const modelByOrder = new Map<number, SubcktPinDefinition>();
  const modelByName = new Map<string, SubcktPinDefinition>();
  for (const p of modelPins) {
    modelByOrder.set(p.pinOrder, p);
    modelByName.set(p.pinName.toUpperCase(), p);
  }

  const expectedByOrder = new Map<number, SubcktPinDefinition>();
  const expectedByName = new Map<string, SubcktPinDefinition>();
  for (const p of expectedPins) {
    expectedByOrder.set(p.pinOrder, p);
    expectedByName.set(p.pinName.toUpperCase(), p);
  }

  // Per-position comparison
  const maxOrder = Math.max(
    ...modelPins.map((p) => p.pinOrder),
    ...expectedPins.map((p) => p.pinOrder),
  );

  for (let i = 1; i <= maxOrder; i++) {
    const mp = modelByOrder.get(i);
    const ep = expectedByOrder.get(i);

    if (mp && !ep) {
      mismatches.push({
        kind: "extra-in-model",
        pinOrder: i,
        modelPinName: mp.pinName,
        note: `Position ${i}: model has pin "${mp.pinName}" but expected list ends before this position.`,
      });
      continue;
    }
    if (!mp && ep) {
      mismatches.push({
        kind: "missing-in-model",
        pinOrder: i,
        expectedPinName: ep.pinName,
        note: `Position ${i}: expected pin "${ep.pinName}" is absent from the model.`,
      });
      continue;
    }
    if (!mp || !ep) continue;

    if (mp.pinName.toUpperCase() !== ep.pinName.toUpperCase()) {
      // Might still be an order issue — check if the model pin exists elsewhere
      const expectedElsewhere = expectedByName.get(mp.pinName.toUpperCase());
      if (expectedElsewhere) {
        mismatches.push({
          kind: "order-mismatch",
          pinOrder: i,
          modelPinName: mp.pinName,
          expectedPinName: ep.pinName,
          note: `Position ${i}: model has "${mp.pinName}" but expected "${ep.pinName}". "${mp.pinName}" appears at expected position ${expectedElsewhere.pinOrder}.`,
        });
      } else {
        mismatches.push({
          kind: "name-mismatch",
          pinOrder: i,
          modelPinName: mp.pinName,
          expectedPinName: ep.pinName,
          note: `Position ${i}: model pin "${mp.pinName}" does not match expected "${ep.pinName}".`,
        });
      }
    }
  }

  // Check for model pins that exist in expected but at different positions
  for (const ep of expectedPins) {
    if (!modelByName.has(ep.pinName.toUpperCase())) {
      if (!mismatches.some((m) => m.kind === "missing-in-model" && m.expectedPinName === ep.pinName)) {
        mismatches.push({
          kind: "missing-in-model",
          pinOrder: ep.pinOrder,
          expectedPinName: ep.pinName,
          note: `Expected pin "${ep.pinName}" (position ${ep.pinOrder}) not found anywhere in model header.`,
        });
      }
    }
  }

  return {
    modelPins,
    expectedPins,
    isFullMatch: mismatches.length === 0,
    mismatches,
    suggestedPins: expectedPins.length ? expectedPins : modelPins,
  };
}

// ---------------------------------------------------------------------------
// Markdown summary
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable Markdown section summarising the reconcile result.
 */
export function formatPinReconcileReport(result: PinReconcileResult, modelName: string): string {
  const lines: string[] = [
    `## Pin Reconciliation: ${modelName}`,
    "",
    `**Model pins (${result.modelPins.length}):** ${result.modelPins.map((p) => p.pinName).join(", ")}`,
    `**Expected pins (${result.expectedPins.length}):** ${result.expectedPins.length ? result.expectedPins.map((p) => p.pinName).join(", ") : "(none — no expected data available)"}`,
    "",
  ];

  if (result.isFullMatch) {
    lines.push("✅ Pin list matches expected definition — no reconciliation required.");
    return lines.join("\n");
  }

  lines.push(`⚠️  **${result.mismatches.length} mismatch(es) detected:**`, "");
  for (const m of result.mismatches) {
    lines.push(`- \`${m.kind}\`: ${m.note}`);
  }
  lines.push(
    "",
    "**Note:** Pin reordering is NOT applied automatically because it would silently break every",
    "instantiation of this model. Review the mismatches and update the symbol pin mapping in KiCad.",
  );
  return lines.join("\n");
}
