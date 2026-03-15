/**
 * Phase C — Artifact ingestion and datasheet preprocessing.
 *
 * Accepts inputs for a SUBCKT utility run and produces a fully-extracted,
 * persisted artifact package. All AI provider calls are deferred to Phase D
 * (fact extraction). This module's job is purely:
 *   1. Fetch and persist raw artifacts.
 *   2. Extract text from PDFs.
 *   3. Identify candidate sections.
 *   4. Preserve raw extracted text separately from structured facts.
 *
 * PDF extraction strategy (in priority order):
 *   a) pdftotext (poppler-utils) subprocess — best fidelity.
 *   b) Minimal self-contained byte scan for readable ASCII — last resort
 *      without external tool dependencies.
 *
 * Vision-model extraction (Gemini / Anthropic) is reserved for Phase D's
 * AI-powered fact extraction, not this ingestion step.
 */

import path from "node:path";
import fs from "fs-extra";
import { execa } from "execa";

import { fetchDatasheetUrl, isAcceptableDatasheetContentType } from "./urlSafety.js";
import type { SubcktLibRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Ingestion result types
// ---------------------------------------------------------------------------

/** One candidate section identified in the raw extracted text. */
export interface IdentifiedSection {
  /** Semantic role of the section. */
  kind: "pinout" | "electrical_characteristics" | "absolute_maximum" | "operating_conditions" | "timing_transfer" | "description" | "other";
  /** Best-guess section heading from the text. */
  heading: string;
  /** Approximate character range in `rawText`. */
  startIndex: number;
  endIndex: number;
  /** Extracted text content of this section. */
  text: string;
}

/** Result of processing one input source (PDF, URL, or notes). */
export interface IngestedArtifact {
  /** "pdf" | "url" | "text" | "model" */
  sourceKind: "pdf" | "url" | "text" | "model";
  /** Original user-provided path or URL. */
  sourcePath: string;
  /** Path to the persisted raw artifact file (PDF, .lib, etc.). */
  persistedPath?: string;
  /** Extracted plain text. */
  rawText: string;
  /** Whether PDF extraction used pdftotext vs the fallback scan. */
  extractionMethod?: "pdftotext" | "ascii-scan" | "passthrough";
  /** Candidate sections identified in the text. */
  sections: IdentifiedSection[];
  /** Warning messages generated during ingestion. */
  warnings: string[];
}

export interface IngestArtifactsInput {
  request: SubcktLibRequest;
  /** Directory to persist raw artifacts into. */
  artifactDir: string;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface IngestArtifactsResult {
  artifacts: IngestedArtifact[];
  /** Combined text from all datasheet artifacts, for Phase D. */
  combinedDatasheetText: string;
  /** Combined text from any existing model .lib/.cir artifacts. */
  existingModelText: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

/**
 * Try to extract text from a PDF using `pdftotext` (poppler-utils).
 * Returns undefined if pdftotext is not available.
 */
async function tryPdftotext(pdfPath: string): Promise<string | undefined> {
  try {
    const result = await execa("pdftotext", ["-layout", pdfPath, "-"], {
      timeout: 30_000,
    });
    return result.stdout?.trim() || undefined;
  } catch (err) {
    // ENOENT → not installed; otherwise log
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // pdftotext exists but failed — return undefined so the fallback runs
    }
    return undefined;
  }
}

/**
 * Minimal ASCII scan fallback: extracts runs of printable ASCII from binary
 * PDF bytes. Far less structured than pdftotext but works without any tools.
 *
 * Only yields strings of printable Latin characters ≥ 4 chars long.
 */
function asciiScanPdf(buf: Buffer): string {
  const MIN_LENGTH = 4;
  const results: string[] = [];
  let current = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b >= 0x20 && b <= 0x7e) {
      current += String.fromCharCode(b);
    } else {
      if (current.length >= MIN_LENGTH) results.push(current);
      current = "";
    }
  }
  if (current.length >= MIN_LENGTH) results.push(current);
  return results.join(" ");
}

/**
 * Extract text from a PDF file. Uses pdftotext when available,
 * falls back to the ASCII scan.
 */
async function extractPdfText(
  pdfPath: string,
): Promise<{ text: string; method: "pdftotext" | "ascii-scan" }> {
  // Attempt pdftotext
  const ptText = await tryPdftotext(pdfPath);
  if (ptText) {
    return { text: ptText, method: "pdftotext" };
  }

  // Fallback
  const buf = await fs.readFile(pdfPath);
  return { text: asciiScanPdf(buf), method: "ascii-scan" };
}

// ---------------------------------------------------------------------------
// Section identification
// ---------------------------------------------------------------------------

const SECTION_PATTERNS: Array<{
  kind: IdentifiedSection["kind"];
  patterns: RegExp[];
}> = [
  {
    kind: "pinout",
    patterns: [/\bpin\s*(out|configuration|description|assignment)/i, /\bpinout\b/i],
  },
  {
    kind: "electrical_characteristics",
    patterns: [/\belectrical\s*(characteristics?|specifications?|parameters?)\b/i],
  },
  {
    kind: "absolute_maximum",
    patterns: [/\babsolute\s+max/i, /\bmaximum\s+rating/i],
  },
  {
    kind: "operating_conditions",
    patterns: [/\brecommended\s+operating/i, /\boperating\s+condition/i, /\boperating\s+range\b/i],
  },
  {
    kind: "timing_transfer",
    patterns: [/\btiming\s+(diagram|characteristic|parameter)/i, /\btransfer\s+(function|characteristic)/i, /\bswitch(ing)?\s+characteristic/i],
  },
  {
    kind: "description",
    patterns: [/\b(general\s+)?(product\s+)?description\b/i, /\bfeature/i],
  },
];

/**
 * Identify candidate sections in extracted PDF text using heuristic heading
 * pattern matching. Lines that match a known section pattern are treated as
 * section headings; the text following until the next heading is the section
 * body.
 */
export function identifySections(text: string): IdentifiedSection[] {
  const lines = text.split(/\r?\n/);
  const sections: IdentifiedSection[] = [];

  let currentKind: IdentifiedSection["kind"] | null = null;
  let currentHeading = "";
  let currentLines: string[] = [];
  let currentStart = 0;
  let charPos = 0;

  const flushSection = (endPos: number) => {
    if (currentKind && currentLines.length) {
      sections.push({
        kind: currentKind,
        heading: currentHeading,
        startIndex: currentStart,
        endIndex: endPos,
        text: currentLines.join("\n").trim(),
      });
    }
    currentKind = null;
    currentHeading = "";
    currentLines = [];
  };

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for the stripped newline

    let matched: IdentifiedSection["kind"] | null = null;
    for (const { kind, patterns } of SECTION_PATTERNS) {
      if (patterns.some((p) => p.test(line))) {
        matched = kind;
        break;
      }
    }

    if (matched) {
      // New section heading found
      flushSection(charPos);
      currentKind = matched;
      currentHeading = line.trim();
      currentStart = charPos;
      currentLines = [];
    } else if (currentKind) {
      currentLines.push(line);
    }

    charPos += lineLen;
  }

  // Close any open section
  if (currentKind && currentLines.length) {
    sections.push({
      kind: currentKind,
      heading: currentHeading,
      startIndex: currentStart,
      endIndex: charPos,
      text: currentLines.join("\n").trim(),
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Individual source handlers
// ---------------------------------------------------------------------------

async function ingestPdfPath(
  pdfPath: string,
  artifactDir: string,
  log: (m: string) => void,
): Promise<IngestedArtifact> {
  const warnings: string[] = [];
  const resolvedPath = path.resolve(pdfPath);

  if (!(await fs.pathExists(resolvedPath))) {
    warnings.push(`PDF not found: ${resolvedPath}`);
    return {
      sourceKind: "pdf",
      sourcePath: pdfPath,
      rawText: "",
      extractionMethod: "passthrough",
      sections: [],
      warnings,
    };
  }

  // Copy to artifact dir
  const savedName = `datasheet_${path.basename(resolvedPath)}`;
  const persistedPath = path.join(artifactDir, savedName);
  await fs.copy(resolvedPath, persistedPath, { overwrite: true });

  log(`Extracting text from ${path.basename(resolvedPath)}...`);
  const { text, method } = await extractPdfText(resolvedPath);

  if (!text.trim()) {
    warnings.push(`PDF text extraction yielded empty content (method=${method}). The PDF may be image-only.`);
  } else if (method === "ascii-scan") {
    warnings.push("pdftotext not found; used ASCII scan fallback. Install poppler-utils for better extraction.");
  }

  const sections = identifySections(text);
  log(`  → ${text.length} chars, ${sections.length} candidate sections (method=${method})`);

  return {
    sourceKind: "pdf",
    sourcePath: pdfPath,
    persistedPath,
    rawText: text,
    extractionMethod: method,
    sections,
    warnings,
  };
}

async function ingestUrl(
  rawUrl: string,
  artifactDir: string,
  log: (m: string) => void,
): Promise<IngestedArtifact> {
  const warnings: string[] = [];
  log(`Fetching datasheet from: ${rawUrl}`);

  const fetchResult = await fetchDatasheetUrl(rawUrl);
  if (!fetchResult.ok) {
    warnings.push(`Datasheet URL fetch failed: ${fetchResult.reason}`);
    return { sourceKind: "url", sourcePath: rawUrl, rawText: "", sections: [], warnings };
  }

  // Content-type check
  if (!isAcceptableDatasheetContentType(fetchResult.contentType)) {
    warnings.push(
      `Unexpected Content-Type "${fetchResult.contentType}" — expected PDF. Will attempt extraction anyway.`,
    );
  }

  // Persist the downloaded artifact
  const urlSlug = new URL(rawUrl).pathname.split("/").filter(Boolean).pop() ?? "datasheet.pdf";
  const persistedPath = path.join(artifactDir, `datasheet_url_${urlSlug}`);
  await fs.outputFile(persistedPath, fetchResult.buffer);
  log(`  → downloaded ${fetchResult.contentLength ?? "?"} bytes to ${path.basename(persistedPath)}`);

  // Extract text from the persisted file
  const { text, method } = await extractPdfText(persistedPath);
  if (!text.trim()) {
    warnings.push("Downloaded artifact text extraction yielded empty content. The document may be image-only.");
  } else if (method === "ascii-scan") {
    warnings.push("pdftotext not found; used ASCII scan fallback. Install poppler-utils for better extraction.");
  }

  const sections = identifySections(text);
  log(`  → ${text.length} chars, ${sections.length} candidate sections (method=${method})`);

  return {
    sourceKind: "url",
    sourcePath: rawUrl,
    persistedPath,
    rawText: text,
    extractionMethod: method,
    sections,
    warnings,
  };
}

async function ingestTextNotes(notes: string): Promise<IngestedArtifact> {
  const sections = identifySections(notes);
  return {
    sourceKind: "text",
    sourcePath: "(user notes)",
    rawText: notes,
    extractionMethod: "passthrough",
    sections,
    warnings: [],
  };
}

async function ingestExistingModel(
  modelPath: string,
  artifactDir: string,
  log: (m: string) => void,
): Promise<IngestedArtifact> {
  const warnings: string[] = [];
  const resolvedPath = path.resolve(modelPath);

  if (!(await fs.pathExists(resolvedPath))) {
    warnings.push(`Existing model file not found: ${resolvedPath}`);
    return { sourceKind: "model", sourcePath: modelPath, rawText: "", sections: [], warnings };
  }

  const savedName = `existing_model_${path.basename(resolvedPath)}`;
  const persistedPath = path.join(artifactDir, savedName);
  await fs.copy(resolvedPath, persistedPath, { overwrite: true });

  const text = await fs.readFile(resolvedPath, "utf-8");
  log(`  → loaded existing model: ${path.basename(resolvedPath)} (${text.length} chars)`);

  return {
    sourceKind: "model",
    sourcePath: modelPath,
    persistedPath,
    rawText: text,
    extractionMethod: "passthrough",
    sections: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

/**
 * Ingest all artifacts for a SUBCKT utility run.
 * Writes artifacts to `artifactDir` for traceability.
 * Returns extracted text and identified sections.
 */
export async function ingestArtifacts(args: IngestArtifactsInput): Promise<IngestArtifactsResult> {
  const { request, artifactDir } = args;
  const log = args.log ?? ((m: string) => console.log(m));
  const allWarnings: string[] = [];
  const artifacts: IngestedArtifact[] = [];

  await fs.mkdirp(artifactDir);

  // PDF datasheet
  if (request.datasheetPdfPath?.trim()) {
    const a = await ingestPdfPath(request.datasheetPdfPath, artifactDir, log);
    artifacts.push(a);
    allWarnings.push(...a.warnings);
  }

  // URL datasheet
  if (request.datasheetUrl?.trim()) {
    const a = await ingestUrl(request.datasheetUrl, artifactDir, log);
    artifacts.push(a);
    allWarnings.push(...a.warnings);
  }

  // Free-text notes
  if (request.userNotes?.trim()) {
    const a = await ingestTextNotes(request.userNotes);
    artifacts.push(a);
    allWarnings.push(...a.warnings);
  }

  // Combined datasheet text (PDF + URL + notes)
  const combinedDatasheetText = artifacts
    .filter((a) => a.sourceKind !== "model")
    .map((a) => a.rawText)
    .filter(Boolean)
    .join("\n\n---\n\n");

  // Existing model .lib/.cir (refine mode)
  let existingModelText = "";
  if (request.datasheetPdfPath === undefined && request.datasheetUrl === undefined) {
    // no-op if there's nothing, existingModelArtifacts is resolved from refs separately
  }
  // For direct path support in create/refine commands, handle existing model as parameter
  // This hook is reserved; callers can push a model artifact separately.

  return {
    artifacts,
    combinedDatasheetText,
    existingModelText,
    warnings: allWarnings,
  };
}

// ---------------------------------------------------------------------------
// Persist extracted text
// ---------------------------------------------------------------------------

/**
 * Write extracted text content to `{runDir}/extracted-text.md` and a raw
 * artifact list to `{runDir}/artifacts.json` for traceability.
 */
export async function persistIngestResults(
  result: IngestArtifactsResult,
  runDir: string,
): Promise<void> {
  await fs.outputFile(
    path.join(runDir, "extracted-text.md"),
    [
      "# Extracted Datasheet Text",
      "",
      result.combinedDatasheetText || "(No text extracted)",
    ].join("\n"),
    "utf-8",
  );

  const artifactMeta = result.artifacts.map((a) => ({
    sourceKind: a.sourceKind,
    sourcePath: a.sourcePath,
    persistedPath: a.persistedPath,
    extractionMethod: a.extractionMethod,
    charCount: a.rawText.length,
    sectionCount: a.sections.length,
    sections: a.sections.map((s) => ({ kind: s.kind, heading: s.heading })),
    warnings: a.warnings,
  }));

  await fs.outputJson(path.join(runDir, "artifacts.json"), artifactMeta, { spaces: 2 });
}
