/**
 * Phase F — ngspice compatibility and model validation.
 *
 * Two-tier validation strategy:
 *
 * 1. STATIC (always runs, no tools required):
 *    - .SUBCKT / .ENDS consistency (names match, both present)
 *    - Pin count match vs declared pin list
 *    - Common unsupported or obviously invalid syntax patterns
 *    - Empty body, duplicate node names, etc.
 *
 * 2. DYNAMIC (optional, requires ngspice in PATH):
 *    - Generates a minimal smoke-test netlist.
 *    - Runs `ngspice -b <file>` and captures exit code + log.
 *    - Reports pass/fail without hiding failure details.
 *
 * The validation output is a SubcktValidationResult, which is always
 * written to `validation.json` in the run directory.
 *
 * Policy: never hide validation failures. A generated model may be
 * USEFUL even with warnings, but the user must see the status clearly.
 */

import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import { execa } from "execa";

import type {
  SubcktCandidate,
  SubcktValidationResult,
  ValidationIssue,
  ValidationStatus,
} from "../types.js";

// ---------------------------------------------------------------------------
// Static validation rules
// ---------------------------------------------------------------------------

interface StaticCheckContext {
  lines: string[];
  modelName: string;
  expectedPinCount: number;
  issues: ValidationIssue[];
}

// Elements / features that ngspice does not support or handles differently
const UNSUPPORTED_PATTERNS: Array<{ pattern: RegExp; code: string; message: string; severity: ValidationIssue["severity"] }> = [
  {
    pattern: /^\.lib\b/i,
    code: "subckt.lib-directive",
    message: ".lib directive inside a .SUBCKT block is not supported in all ngspice versions. Remove it.",
    severity: "high",
  },
  {
    pattern: /^\.include\b/i,
    code: "subckt.include-directive",
    message: ".include inside a .SUBCKT block may cause issues. Use .subckt nesting instead.",
    severity: "medium",
  },
  {
    pattern: /^\.model\b/i,
    code: "subckt.nested-model",
    message: ".model statement found inside .SUBCKT block. Move to top level or to .lib file.",
    severity: "medium",
  },
  {
    pattern: /\$\{[^}]+\}/,
    code: "subckt.brace-syntax",
    message: "${...} brace parameter syntax is not supported in standard ngspice .SUBCKT.",
    severity: "high",
  },
  {
    pattern: /^table\s*\(/i,
    code: "subckt.table-keyword",
    message: "Standalone 'table(...)' expression may not be supported outside a B-source. Wrap in a B source.",
    severity: "medium",
  },
];

function checkSubcktEnds(ctx: StaticCheckContext): {
  subcktName: string | null;
  endsName: string | null;
} {
  let subcktName: string | null = null;
  let endsName: string | null = null;
  let subcktCount = 0;
  let endsCount = 0;

  for (const line of ctx.lines) {
    const trimmed = line.trim();
    if (/^\.subckt\b/i.test(trimmed)) {
      subcktCount++;
      const parts = trimmed.split(/\s+/);
      subcktName = parts[1] ?? null;
    }
    if (/^\.ends\b/i.test(trimmed)) {
      endsCount++;
      const parts = trimmed.split(/\s+/);
      endsName = parts[1] ?? null;
    }
  }

  if (subcktCount === 0) {
    ctx.issues.push({
      severity: "critical",
      code: "subckt.missing-directive",
      message: "No .SUBCKT directive found in the generated text.",
    });
  }
  if (endsCount === 0) {
    ctx.issues.push({
      severity: "critical",
      code: "subckt.missing-ends",
      message: "No .ENDS directive found in the generated text.",
    });
  }
  if (subcktCount > 1) {
    ctx.issues.push({
      severity: "high",
      code: "subckt.multiple-directives",
      message: `Found ${subcktCount} .SUBCKT directives. Only one is expected.`,
    });
  }
  if (subcktName && endsName && subcktName.toLowerCase() !== endsName.toLowerCase()) {
    ctx.issues.push({
      severity: "critical",
      code: "subckt.name-mismatch",
      message: `.SUBCKT name "${subcktName}" does not match .ENDS name "${endsName}".`,
    });
  }
  if ((subcktName ?? ctx.modelName).toLowerCase() !== ctx.modelName.toLowerCase()) {
    ctx.issues.push({
      severity: "high",
      code: "subckt.unexpected-name",
      message: `Expected model name "${ctx.modelName}" but .SUBCKT declares "${subcktName}".`,
    });
  }

  return { subcktName, endsName };
}

function checkPinCount(ctx: StaticCheckContext, subcktName: string | null): boolean {
  // Find the .SUBCKT header line and count tokens after the name
  const headerLine = ctx.lines.find((l) => /^\.subckt\b/i.test(l.trim()));
  if (!headerLine) return false;

  const parts = headerLine.trim().split(/\s+/);
  // parts[0] = ".SUBCKT", parts[1] = name, parts[2..] = ports
  // Optional parameter section starts with "PARAMS:" — exclude it and everything after
  const portTokens: string[] = [];
  for (let i = 2; i < parts.length; i++) {
    const token = parts[i] ?? "";
    if (/^params:/i.test(token)) break;
    portTokens.push(token);
  }

  const headerPinCount = portTokens.length;
  const expectedCount   = ctx.expectedPinCount;

  if (expectedCount > 0 && headerPinCount !== expectedCount) {
    ctx.issues.push({
      severity: "medium",
      code: "subckt.pin-count-mismatch",
      message: `Header declares ${headerPinCount} ports but extracted pin list has ${expectedCount}. Verify pin order.`,
    });
    return false;
  }

  if (headerPinCount === 0) {
    ctx.issues.push({
      severity: "high",
      code: "subckt.no-ports",
      message: ".SUBCKT header declares zero ports. This is likely incomplete.",
    });
    return false;
  }

  return true;
}

function checkUnsupportedSyntax(ctx: StaticCheckContext): void {
  const inSubckt = { active: false };
  for (const line of ctx.lines) {
    const trimmed = line.trim();
    if (/^\.subckt\b/i.test(trimmed)) { inSubckt.active = true; continue; }
    if (/^\.ends\b/i.test(trimmed))   { inSubckt.active = false; continue; }
    if (!inSubckt.active) continue;

    for (const { pattern, code, message, severity } of UNSUPPORTED_PATTERNS) {
      if (pattern.test(trimmed)) {
        ctx.issues.push({ severity, code, message: `Line: "${trimmed.slice(0, 80)}" — ${message}` });
      }
    }
  }
}

function checkEmptyBody(ctx: StaticCheckContext): void {
  const inSubckt = { active: false };
  let elementCount = 0;

  for (const line of ctx.lines) {
    const trimmed = line.trim();
    if (/^\.subckt\b/i.test(trimmed)) { inSubckt.active = true; continue; }
    if (/^\.ends\b/i.test(trimmed))   { inSubckt.active = false; continue; }
    if (!inSubckt.active) continue;
    if (!trimmed || trimmed.startsWith("*")) continue;
    // Any non-comment, non-blank line inside .SUBCKT counts as an element
    if (/^[a-zA-Z]/.test(trimmed)) elementCount++;
  }

  if (elementCount === 0) {
    ctx.issues.push({
      severity: "high",
      code: "subckt.empty-body",
      message: ".SUBCKT body contains no element lines. The model has no simulation content.",
    });
  }
}

// ---------------------------------------------------------------------------
// Static rule aggregator
// ---------------------------------------------------------------------------

function runStaticValidation(
  subcktText: string,
  modelName: string,
  expectedPinCount: number,
): {
  issues: ValidationIssue[];
  subcktName: string | null;
  endsName: string | null;
  pinCountMatches: boolean;
} {
  const lines = subcktText.split(/\r?\n/);
  const ctx: StaticCheckContext = { lines, modelName, expectedPinCount, issues: [] };

  const { subcktName, endsName } = checkSubcktEnds(ctx);
  const pinCountMatches = checkPinCount(ctx, subcktName);
  checkUnsupportedSyntax(ctx);
  checkEmptyBody(ctx);

  return { issues: ctx.issues, subcktName, endsName, pinCountMatches };
}

// ---------------------------------------------------------------------------
// Smoke-test netlist builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal ngspice transient simulation netlist that exercises the
 * generated .SUBCKT. The test is intentionally simple: just instantiate the
 * subcircuit with ground on all ports, run a 1 ns tran, and check ngspice
 * parses without error.
 *
 * This catches structural parse errors but NOT functional correctness.
 */
function buildSmokeTestNetlist(candidate: SubcktCandidate): string {
  const { modelName, subcktText, pins } = candidate;
  const portList = pins.length
    ? pins.sort((a, b) => a.pinOrder - b.pinOrder).map((p) => `0`).join(" ")
    : "0 0";

  return [
    `* ngspice smoke test — auto-generated by ai-schematics-ensemble`,
    `* Component: ${modelName}`,
    `*`,
    subcktText.trim(),
    "",
    `.title Smoke Test: ${modelName}`,
    `* Instantiate with all ports tied to GND`,
    `XDUT ${portList} ${modelName}`,
    `* Minimal simulation`,
    `.tran 1n 1n`,
    `.end`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// ngspice runner
// ---------------------------------------------------------------------------

async function tryRunNgspice(
  netlistPath: string,
  logPath: string,
  timeoutMs = 30_000,
): Promise<{ ran: boolean; passed: boolean; log: string }> {
  try {
    const result = await execa("ngspice", ["-b", "-o", logPath, netlistPath], {
      timeout: timeoutMs,
      reject: false,
    });

    const log = await fs.readFile(logPath, "utf-8").catch(() => result.stderr ?? "");

    // ngspice exit 0 = success; any other = failure
    const passed = result.exitCode === 0 && !log.toLowerCase().includes("error:");
    return { ran: true, passed, log };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // ngspice not installed
      return { ran: false, passed: false, log: "ngspice not found in PATH." };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ran: true, passed: false, log: `ngspice run error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Status classifier
// ---------------------------------------------------------------------------

function classifyStatus(
  syntaxValid: boolean,
  issues: ValidationIssue[],
  smokeTestPassed: boolean | undefined,
): ValidationStatus {
  const hasCritical = issues.some((i) => i.severity === "critical");
  const hasHigh     = issues.some((i) => i.severity === "high");

  if (!syntaxValid || hasCritical) return "failed-validation";
  if (smokeTestPassed === false) return "needs-manual-review";
  if (hasHigh) return "needs-manual-review";
  if (issues.length > 0) return "syntax-valid-with-warnings";
  return "syntax-valid";
}

// ---------------------------------------------------------------------------
// Top-level validator
// ---------------------------------------------------------------------------

export interface ValidateSubcktOptions {
  /** Run the ngspice smoke test if ngspice is available. Default: true. */
  runSmokeTest?: boolean;
  /** Optional logger. */
  log?: (msg: string) => void;
}

/**
 * Validate a SubcktCandidate using static rules and optionally ngspice.
 * Writes `validation.json` and optionally `smoke-test.cir` / `smoke-test.log`
 * to `runDir` when provided.
 */
export async function validateSubcktCandidate(
  candidate: SubcktCandidate,
  runDir?: string,
  opts?: ValidateSubcktOptions,
): Promise<SubcktValidationResult> {
  const log = opts?.log ?? ((m: string) => console.log(m));
  const runSmokeTest = opts?.runSmokeTest !== false;

  log("Running static validation...");

  // Static pass
  const { issues, subcktName, endsName, pinCountMatches } = runStaticValidation(
    candidate.subcktText,
    candidate.modelName,
    candidate.pins.length,
  );

  const endsNameMatches =
    Boolean(subcktName) &&
    Boolean(endsName) &&
    subcktName!.toLowerCase() === endsName!.toLowerCase();

  const syntaxValid = !issues.some((i) => i.severity === "critical");

  log(`  → static: ${syntaxValid ? "pass" : "fail"}, ${issues.length} issue(s)`);

  // Dynamic pass
  let ngspiceRan = false;
  let smokeTestPassed: boolean | undefined;
  let smokeTestLog: string | undefined;
  let smokeTestNetlist: string | undefined;

  if (runSmokeTest && syntaxValid) {
    const netlist = buildSmokeTestNetlist(candidate);
    smokeTestNetlist = netlist;

    // Write to a temp dir (or runDir)
    const tmpDir = runDir ?? path.join(os.tmpdir(), `subckt-smoke-${Date.now()}`);
    await fs.mkdirp(tmpDir);
    const netlistPath = path.join(tmpDir, "smoke-test.cir");
    const logPath     = path.join(tmpDir, "smoke-test.log");

    await fs.outputFile(netlistPath, netlist, "utf-8");

    log("Running ngspice smoke test...");
    const smokeResult = await tryRunNgspice(netlistPath, logPath);
    ngspiceRan      = smokeResult.ran;
    smokeTestPassed = smokeResult.passed;
    smokeTestLog    = smokeResult.log;

    if (!smokeResult.ran) {
      log("  → ngspice not available; smoke test skipped.");
    } else {
      log(`  → ngspice: ${smokeResult.passed ? "PASS" : "FAIL"}`);
      if (!smokeResult.passed && smokeResult.log) {
        issues.push({
          severity: "high",
          code: "subckt.ngspice-smoke-fail",
          message: `ngspice smoke test failed. See smoke-test.log for details.`,
        });
      }
    }

    // Persist smoke-test files in runDir
    if (runDir) {
      await fs.outputFile(path.join(runDir, "smoke-test.cir"), netlist, "utf-8");
      if (smokeTestLog) {
        await fs.outputFile(path.join(runDir, "smoke-test.log"), smokeTestLog, "utf-8");
      }
    }
  }

  const status = classifyStatus(syntaxValid, issues, smokeTestPassed);
  log(`  → status: ${status}`);

  const result: SubcktValidationResult = {
    status,
    syntaxValid,
    endsNameMatches,
    pinCountMatches,
    ngspiceRan,
    smokeTestPassed,
    smokeTestLog,
    issues,
  };

  // Persist validation.json
  if (runDir) {
    await fs.outputJson(path.join(runDir, "validation.json"), result, { spaces: 2 });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Quick helper for callers that already have a .lib text (not a candidate)
// ---------------------------------------------------------------------------

/**
 * Validate raw .lib text without a pre-built candidate object.
 * Creates a minimal candidate wrapper for validation purposes.
 */
export async function validateLibText(
  libText: string,
  modelName: string,
  runDir?: string,
  opts?: ValidateSubcktOptions,
): Promise<SubcktValidationResult> {
  const candidate: SubcktCandidate = {
    modelName,
    subcktText: libText,
    pins: [],
    assumptions: [],
    limitations: [],
    warnings: [],
    abstractionLevel: "behavioral",
  };
  return validateSubcktCandidate(candidate, runDir, opts);
}
