/**
 * Phase H.5 — .cir patching utility.
 *
 * Prepends `.include` directives into a SPICE netlist for each generated
 * .lib file, placing them after any leading comment block / `.title` line
 * but before the first component instantiation.
 *
 * Input .cir text is never modified destructively — the original and
 * patched versions are always kept separately.
 */

export interface IncludeDirective {
  /** Model name, used only as a comment label in the patched file. */
  modelName: string;
  /**
   * Path written into the `.include` line.
   * Callers should decide whether this is absolute or relative to the
   * run directory before calling this function.
   */
  libPath: string;
}

/**
 * Build the block of `.include` directives to insert.
 */
function buildIncludeBlock(directives: IncludeDirective[]): string {
  const lines = [
    "* ---- Generated SUBCKT library includes (ai-schematics-ensemble) ----",
  ];
  for (const d of directives) {
    lines.push(`* Model: ${d.modelName}`);
    lines.push(`.include "${d.libPath}"`);
  }
  lines.push("* ---- End generated includes ----");
  return lines.join("\n");
}

/**
 * Returns true for lines that are either blank, SPICE comments (*), or
 * the .title directive — so we can skip past them before inserting includes.
 */
function isPreambleLine(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("*") || t.toLowerCase().startsWith(".title");
}

/**
 * Prepend `.include` directives into `cirText` for each supplied directive.
 *
 * Insertion strategy:
 *   1. Walk past any leading preamble (blank lines, comments, .title).
 *   2. Insert the include block just before the first non-preamble line.
 *   3. If no non-preamble line is found, append the block at the end.
 *
 * Idempotency note: if `cirText` already contains a line beginning with
 * `* ---- Generated SUBCKT library includes`, this function returns the
 * original text unchanged to avoid double-patching.
 */
export function patchCirWithIncludes(cirText: string, directives: IncludeDirective[]): string {
  if (!directives.length) return cirText;

  // Guard against double-patching
  if (cirText.includes("* ---- Generated SUBCKT library includes")) {
    return cirText;
  }

  const lines = cirText.split("\n");
  let insertAt = lines.length; // default: append

  for (let i = 0; i < lines.length; i++) {
    if (!isPreambleLine(lines[i])) {
      insertAt = i;
      break;
    }
  }

  const includeBlock = buildIncludeBlock(directives);
  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(insertAt).join("\n");

  // Avoid extra blank lines at the join points
  const sep = before.trimEnd() ? "\n" : "";
  return `${before}${sep}\n${includeBlock}\n${after.trimStart() ? "\n" + after : ""}`;
}

/**
 * Convenience wrapper: returns the patched text plus the raw include block
 * for logging/report purposes.
 */
export function patchResult(cirText: string, directives: IncludeDirective[]): {
  patched: string;
  includeBlock: string;
  changed: boolean;
} {
  if (!directives.length || cirText.includes("* ---- Generated SUBCKT library includes")) {
    return { patched: cirText, includeBlock: "", changed: false };
  }
  const includeBlock = buildIncludeBlock(directives);
  const patched = patchCirWithIncludes(cirText, directives);
  return { patched, includeBlock, changed: patched !== cirText };
}
