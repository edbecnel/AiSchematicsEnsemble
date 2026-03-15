/**
 * Phase I — Safe automatic syntax repair for ngspice-incompatible .SUBCKT text.
 *
 * Policy: only rewrite constructs where the intended meaning is unambiguous
 * and the repair is provably reversible or equivalent. Any change that could
 * alter electrical behaviour is logged as a warning instead of applied.
 *
 * Each rewrite rule is a pure function (string → RewriteResult), making
 * the set of rewrites auditable and testable independently.
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RewriteChange {
  /** Short tag identifying the rule that triggered. */
  ruleId: string;
  /** Original line text (trimmed). */
  originalLine: string;
  /** Replacement line text (trimmed) or null when a line is removed. */
  rewrittenLine: string | null;
  /** Human-readable explanation for the change report. */
  reason: string;
  /** True if the change is safe to apply automatically. */
  safe: boolean;
}

export interface SyntaxRewriteResult {
  /** Rewritten .SUBCKT text. */
  rewrittenText: string;
  /** All changes that were applied. */
  appliedChanges: RewriteChange[];
  /** Issues that were detected but NOT auto-fixed (require manual review). */
  manualReviewItems: RewriteChange[];
  /** True when at least one change was applied. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

type LineRewriter = (
  line: string,
  lineIndex: number,
  allLines: string[],
  modelName: string,
) => { newLine: string | null; change?: RewriteChange } | null;

/**
 * Rule R01: Strip `${}` brace parameter syntax → `{}`.
 * Standard ngspice uses `{expr}` not `${expr}`.
 */
const ruleStripDollarBrace: LineRewriter = (line) => {
  if (!line.includes("${")) return null;
  const newLine = line.replace(/\$\{([^}]+)\}/g, "{$1}");
  if (newLine === line) return null;
  return {
    newLine,
    change: {
      ruleId: "R01-brace-syntax",
      originalLine: line,
      rewrittenLine: newLine,
      reason: "${...} brace syntax stripped to {expr} (ngspice standard).",
      safe: true,
    },
  };
};

/**
 * Rule R02: `.model` statement inside .SUBCKT → move before .SUBCKT.
 * ngspice allows .model at top level but not always inside subckt blocks.
 * We record these for extraction; the caller inserts them above the block.
 * Here we mark the lines for removal and collect them as pending hoisting.
 */
const ruleModelInsideSubckt: LineRewriter = (line) => {
  if (!/^\.model\b/i.test(line.trim())) return null;
  // We do NOT remove them in this pass — the hoistModelStatements() function
  // handles the structural rearrangement. Mark as manual review only.
  return {
    newLine: line, // unchanged
    change: {
      ruleId: "R02-nested-model",
      originalLine: line,
      rewrittenLine: null, // signals "needs hoisting, not rewritten in place"
      reason: ".model statement inside .SUBCKT should be at top level (hoisted by repair step).",
      safe: true,
    },
  };
};

/**
 * Rule R03: Normalize .SUBCKT and .ENDS keyword capitalisation to uppercase.
 */
const ruleNormaliseKeywordCase: LineRewriter = (line, _i, _all, modelName) => {
  const t = line.trim();

  const subcktMatch = t.match(/^\.subckt\b(.*)$/i);
  if (subcktMatch && t !== t.toUpperCase().slice(0, 7) + subcktMatch[1]) {
    const newLine = ".SUBCKT" + subcktMatch[1];
    // Only rewrite if it actually changes something
    if (newLine === t) return null;
    return {
      newLine,
      change: {
        ruleId: "R03-keyword-case",
        originalLine: t,
        rewrittenLine: newLine,
        reason: ".subckt keyword normalised to .SUBCKT.",
        safe: true,
      },
    };
  }

  const endsMatch = t.match(/^\.ends\b(.*)$/i);
  if (endsMatch) {
    // Also normalise .ends name to match modelName
    const endsName = endsMatch[1].trim();
    const newLine = endsName ? `.ENDS ${modelName}` : `.ENDS ${modelName}`;
    if (newLine === t) return null;
    return {
      newLine,
      change: {
        ruleId: "R03-keyword-case",
        originalLine: t,
        rewrittenLine: newLine,
        reason: ".ends keyword normalised to .ENDS and name aligned to model name.",
        safe: true,
      },
    };
  }

  return null;
};

/**
 * Rule R04: Remove lines containing only whitespace inside the subckt body.
 * Cosmetic only — collapsed to max one consecutive blank line.
 */
const ruleCollapseBlankLines: LineRewriter = (line, lineIndex, allLines) => {
  if (line.trim() !== "") return null;
  // Check if the previous non-blank line was also blank
  const prevBlanks = (() => {
    let count = 0;
    for (let i = lineIndex - 1; i >= 0; i--) {
      if (allLines[i].trim() === "") count++;
      else break;
    }
    return count;
  })();
  if (prevBlanks >= 1) {
    return {
      newLine: null, // remove this line
      change: {
        ruleId: "R04-blank-lines",
        originalLine: "",
        rewrittenLine: null,
        reason: "Consecutive blank line removed (cosmetic).",
        safe: true,
      },
    };
  }
  return null;
};

/**
 * Rule R05: `.lib` inside .SUBCKT body — flag as manual review; do not rename.
 * Removing a `.lib` could break the model. Caller must review.
 */
const ruleLibInsideSubckt: LineRewriter = (line) => {
  if (!/^\.lib\b/i.test(line.trim())) return null;
  return {
    newLine: line, // unchanged
    change: {
      ruleId: "R05-lib-inside-subckt",
      originalLine: line,
      rewrittenLine: null,
      reason: ".lib directive inside .SUBCKT block cannot be safely removed automatically. Manual review required.",
      safe: false,
    },
  };
};

const ALL_RULES: LineRewriter[] = [
  ruleStripDollarBrace,
  ruleModelInsideSubckt,
  ruleNormaliseKeywordCase,
  ruleCollapseBlankLines,
  ruleLibInsideSubckt,
];

// ---------------------------------------------------------------------------
// .model hoisting
// ---------------------------------------------------------------------------

/**
 * Move .model statements from inside the .SUBCKT body to just above the
 * .SUBCKT line. This is a structural operation applied after per-line rewrites.
 */
export function hoistModelStatements(text: string): { result: string; hoisted: string[] } {
  const lines = text.split("\n");
  const hoisted: string[] = [];
  let insideSubckt = false;
  const kept: string[] = [];
  const toHoist: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (/^\.subckt\b/i.test(t)) insideSubckt = true;
    if (/^\.ends\b/i.test(t)) insideSubckt = false;

    if (insideSubckt && /^\.model\b/i.test(t)) {
      toHoist.push(line);
      hoisted.push(t);
    } else {
      kept.push(line);
    }
  }

  if (!toHoist.length) return { result: text, hoisted: [] };

  // Insert hoisted lines just before the .SUBCKT line
  const subcktIdx = kept.findIndex((l) => /^\.subckt\b/i.test(l.trim()));
  if (subcktIdx < 0) return { result: text, hoisted: [] };

  const final = [
    ...kept.slice(0, subcktIdx),
    "* (Hoisted by repair) ----",
    ...toHoist,
    "* ----",
    ...kept.slice(subcktIdx),
  ];
  return { result: final.join("\n"), hoisted };
}

// ---------------------------------------------------------------------------
// Main rewrite entry point
// ---------------------------------------------------------------------------

/**
 * Apply all safe automatic syntax rules to `subcktText`.
 *
 * @param subcktText   Full .SUBCKT text (from .SUBCKT … to .ENDS).
 * @param modelName    Expected model name — used for .ENDS normalisation.
 */
export function rewriteSubcktSyntax(subcktText: string, modelName: string): SyntaxRewriteResult {
  const lines = subcktText.split("\n");
  const appliedChanges: RewriteChange[] = [];
  const manualReviewItems: RewriteChange[] = [];
  const rewrittenLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let currentLine = lines[i];
    let removed = false;

    for (const rule of ALL_RULES) {
      const result = rule(currentLine, i, lines, modelName);
      if (!result) continue;
      if (!result.change) continue;

      if (!result.change.safe) {
        // Don't apply — record for manual review
        manualReviewItems.push(result.change);
        continue;
      }

      // R02/null-rewrittenLine signals "to be hoisted" — handled structurally below
      if (result.change.ruleId === "R02-nested-model") {
        manualReviewItems.push(result.change); // record but don't apply here
        continue;
      }

      appliedChanges.push(result.change);

      if (result.newLine === null) {
        removed = true;
        break;
      }
      currentLine = result.newLine;
    }

    if (!removed) rewrittenLines.push(currentLine);
  }

  let rewrittenText = rewrittenLines.join("\n");

  // Structural pass: hoist .model statements
  const { result: hoisted, hoisted: hoistedList } = hoistModelStatements(rewrittenText);
  if (hoistedList.length) {
    rewrittenText = hoisted;
    for (const h of hoistedList) {
      appliedChanges.push({
        ruleId: "R02-nested-model-hoist",
        originalLine: h,
        rewrittenLine: `(hoisted above .SUBCKT)`,
        reason: `.model statement hoisted to top level: ${h.split(/\s+/).slice(0, 3).join(" ")}`,
        safe: true,
      });
    }
  }

  return {
    rewrittenText,
    appliedChanges,
    manualReviewItems,
    changed: appliedChanges.length > 0 || rewrittenText !== subcktText,
  };
}
