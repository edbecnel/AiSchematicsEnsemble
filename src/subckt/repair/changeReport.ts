/**
 * Phase I — Change report generation for SUBCKT repair flows.
 *
 * Produces a human-readable Markdown document describing every difference
 * between the original and repaired model. This report is written to
 * `repair-report.md` in the run directory alongside both model versions.
 */

import type { RewriteChange, SyntaxRewriteResult } from "./syntaxRewriter.js";
import type { PinReconcileResult } from "./pinReconciler.js";

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface ChangeReportInput {
  componentName: string;
  modelName: string;
  originalLibText: string;
  repairedLibText: string;
  syntaxRewrite: SyntaxRewriteResult;
  pinReconcile: PinReconcileResult;
  /** Additional change notes from the outer refine flow (e.g. full re-synthesis). */
  additionalNotes?: string[];
  /** ISO-8601 timestamp. */
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Minimal line-diff (no external deps)
// ---------------------------------------------------------------------------

interface DiffLine {
  kind: "context" | "removed" | "added";
  text: string;
  lineNumber?: number;
}

function simpleDiff(original: string, repaired: string): DiffLine[] {
  const origLines = original.split("\n");
  const repLines = repaired.split("\n");
  const result: DiffLine[] = [];

  const maxContext = 2;

  // Simple O(n) LCS-free diff for readability (not correctness in all edge-cases).
  // Good enough for SPICE netlists which are rarely longer than a few hundred lines.
  const origSet = new Map<string, number[]>();
  for (let i = 0; i < origLines.length; i++) {
    const key = origLines[i].trim();
    if (!origSet.has(key)) origSet.set(key, []);
    origSet.get(key)!.push(i);
  }

  const repSet = new Map<string, number[]>();
  for (let i = 0; i < repLines.length; i++) {
    const key = repLines[i].trim();
    if (!repSet.has(key)) repSet.set(key, []);
    repSet.get(key)!.push(i);
  }

  let oPos = 0;
  let rPos = 0;
  const contextBuffer: DiffLine[] = [];

  function flushContext() {
    const keep = contextBuffer.slice(-maxContext);
    for (const l of keep) result.push(l);
    contextBuffer.length = 0;
  }

  while (oPos < origLines.length || rPos < repLines.length) {
    const oLine = origLines[oPos]?.trim() ?? null;
    const rLine = repLines[rPos]?.trim() ?? null;

    if (oLine === rLine) {
      contextBuffer.push({ kind: "context", text: origLines[oPos] ?? "", lineNumber: oPos + 1 });
      oPos++;
      rPos++;
      continue;
    }

    flushContext();

    // Check if oLine appears soon in repLines (a line was inserted before it)
    if (oLine && rLine !== null) {
      const rFuture = repSet.get(oLine ?? "");
      const oFuture = origSet.get(rLine ?? "");

      const rDist = rFuture ? Math.min(...rFuture.filter((x) => x >= rPos)) - rPos : Infinity;
      const oDist = oFuture ? Math.min(...oFuture.filter((x) => x >= oPos)) - oPos : Infinity;

      if (rDist <= oDist) {
        // Lines were added in repaired
        result.push({ kind: "added", text: repLines[rPos] });
        rPos++;
        continue;
      }
    }

    if (oLine !== null) {
      result.push({ kind: "removed", text: origLines[oPos] });
      oPos++;
    } else if (rLine !== null) {
      result.push({ kind: "added", text: repLines[rPos] });
      rPos++;
    }
  }

  return result;
}

function formatDiff(diff: DiffLine[]): string {
  const shown: DiffLine[] = [];
  // Show only changed lines + 2 lines of context around them
  const changed = new Set<number>();
  for (let i = 0; i < diff.length; i++) {
    if (diff[i].kind !== "context") {
      for (let j = Math.max(0, i - 2); j <= Math.min(diff.length - 1, i + 2); j++) {
        changed.add(j);
      }
    }
  }

  let lastIdx = -1;
  for (let i = 0; i < diff.length; i++) {
    if (!changed.has(i)) continue;
    if (lastIdx >= 0 && i > lastIdx + 1) shown.push({ kind: "context", text: "… (lines omitted) …" });
    shown.push(diff[i]);
    lastIdx = i;
  }

  if (!shown.length) return "_No structural differences detected._\n";

  return shown.map((l) => {
    if (l.kind === "removed") return `- ${l.text}`;
    if (l.kind === "added") return `+ ${l.text}`;
    return `  ${l.text}`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Generate the full `repair-report.md` content.
 */
export function buildChangeReport(input: ChangeReportInput): string {
  const {
    componentName,
    modelName,
    originalLibText,
    repairedLibText,
    syntaxRewrite,
    pinReconcile,
    additionalNotes,
    generatedAt,
  } = input;

  const ts = generatedAt ?? new Date().toISOString();
  const lines: string[] = [
    `# SUBCKT Repair Report: ${componentName} (${modelName})`,
    "",
    `Generated: ${ts}`,
    "",
  ];

  // --- Summary ---
  lines.push("## Summary", "");

  const totalChanges = syntaxRewrite.appliedChanges.length;
  const manualItems = syntaxRewrite.manualReviewItems.length + (pinReconcile.isFullMatch ? 0 : pinReconcile.mismatches.length);

  if (totalChanges === 0 && manualItems === 0) {
    lines.push("No changes were required. The original model passed all repair checks.");
  } else {
    if (totalChanges > 0) lines.push(`- **${totalChanges} automatic change(s) applied.**`);
    if (manualItems > 0) lines.push(`- **${manualItems} item(s) require manual review.**`);
    if (syntaxRewrite.changed) lines.push("- Syntax was normalised automatically.");
    if (!pinReconcile.isFullMatch) lines.push("- Pin discrepancies were detected (see Pin Reconciliation section).");
    if (additionalNotes?.length) lines.push("- Model was re-synthesized by AI (see Additional Notes section).");
  }
  lines.push("");

  // --- Automatic changes ---
  if (syntaxRewrite.appliedChanges.length) {
    lines.push("## Automatic Changes Applied", "");
    lines.push("These changes were applied by the repair step and should not require further review:", "");
    for (const c of syntaxRewrite.appliedChanges) {
      lines.push(`### ${c.ruleId}`, "");
      lines.push(`**Why changed:** ${c.reason}`, "");
      if (c.originalLine && c.rewrittenLine !== null) {
        lines.push("```diff");
        lines.push(`- ${c.originalLine}`);
        lines.push(`+ ${c.rewrittenLine}`);
        lines.push("```", "");
      }
    }
  }

  // --- Manual review items ---
  if (syntaxRewrite.manualReviewItems.length) {
    lines.push("## Items Requiring Manual Review", "");
    lines.push("These issues were detected but NOT changed automatically:", "");
    for (const c of syntaxRewrite.manualReviewItems) {
      lines.push(`### ${c.ruleId}`, "");
      lines.push(`**Issue:** ${c.reason}`, "");
      if (c.originalLine) {
        lines.push("```spice");
        lines.push(c.originalLine);
        lines.push("```", "");
      }
    }
  }

  // --- Pin reconciliation ---
  lines.push("## Pin Reconciliation", "");
  if (pinReconcile.isFullMatch) {
    lines.push("✅ Pin list is consistent with the expected definition.");
  } else {
    lines.push(`⚠️  **${pinReconcile.mismatches.length} mismatch(es):**`, "");
    for (const m of pinReconcile.mismatches) {
      lines.push(`- \`${m.kind}\`: ${m.note}`);
    }
    lines.push(
      "",
      "> **Important:** Pin reordering was NOT applied automatically. Update the KiCad symbol",
      "> or netlist instantiation to match the intended pin order.",
    );
  }
  lines.push("");

  // --- Additional notes ---
  if (additionalNotes?.length) {
    lines.push("## Additional Notes", "");
    for (const note of additionalNotes) lines.push(`- ${note}`);
    lines.push("");
  }

  // --- Diff ---
  lines.push("## Model Diff", "");
  lines.push("```diff");
  const diff = simpleDiff(originalLibText.trim(), repairedLibText.trim());
  lines.push(formatDiff(diff));
  lines.push("```", "");

  // --- Original ---
  lines.push("## Original Model (preserved)", "");
  lines.push("```spice");
  lines.push(originalLibText.trim());
  lines.push("```", "");

  lines.push("---");
  lines.push("_This report was generated automatically by ai-schematics-ensemble. Verify all changes before use._");

  return lines.join("\n");
}
