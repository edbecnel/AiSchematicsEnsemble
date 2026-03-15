/**
 * Phase 4 — Artifact extraction pipeline
 *
 * Responsibilities:
 *  - Extract usable text from each artifact kind (netlist, plain text, etc.)
 *  - Provide PDF extraction placeholder (not yet implemented — stub returns notice)
 *  - Provide OCR/vision extraction hook (future — stub returns undefined)
 *  - Keep all extraction logic out of the dispatch path
 *
 * When full PDF and OCR support is added, replace the placeholder functions
 * below with real implementations without changing the calling code in
 * context.ts.
 */

import type { ArtifactMetadata, ExtractedArtifactText } from "../../types.js";

// ---------------------------------------------------------------------------
// Netlist / plain-text extraction
// ---------------------------------------------------------------------------

const FENCE_OPEN_RE = /^```[^\n]*\n/gm;
const FENCE_CLOSE_RE = /\n?```\s*$/gm;

/**
 * Extract text from a SPICE netlist string.
 * Strips Markdown code fences if present (e.g. when the netlist was pasted
 * as a fenced block inside a question file).
 */
export function extractNetlistText(raw: string): { text: string; method: "direct" | "fence-strip" } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const stripped = trimmed.replace(FENCE_OPEN_RE, "").replace(FENCE_CLOSE_RE, "").trim();
    return { text: stripped, method: "fence-strip" };
  }
  return { text: trimmed, method: "direct" };
}

/**
 * Extract text from a plain-text artifact (question file, datasheet snippet, etc.).
 * Currently returns the content unchanged.
 */
export function extractPlainText(raw: string): { text: string; method: "direct" } {
  return { text: raw.trim(), method: "direct" };
}

// ---------------------------------------------------------------------------
// PDF extraction — placeholder
// ---------------------------------------------------------------------------

/**
 * PDF text extraction placeholder.
 *
 * When a real PDF library (e.g. pdf-parse, pdfjs-dist, or a hosted extraction
 * service) is integrated, replace this function body.  The return type and
 * calling convention must remain stable.
 *
 * @returns A stub notice string so the downstream prompt can still render
 *          something meaningful.
 */
export async function extractPdfText(
  _artifactId: string,
  _storageRef: string | undefined,
): Promise<{ text: string; method: "pdf-placeholder" }> {
  return {
    text: "[PDF text extraction not yet implemented — attach PDF text manually or use OCR]",
    method: "pdf-placeholder",
  };
}

// ---------------------------------------------------------------------------
// OCR / vision extraction hook — placeholder
// ---------------------------------------------------------------------------

/**
 * OCR / vision model extraction hook.
 *
 * Intended use: pass an image artifact to a vision-capable model to extract
 * a text description or structured data before embedding in the prompt.
 *
 * Returns `undefined` while not yet implemented, so callers can decide
 * whether to skip or use the inline image directly.
 */
export async function ocrImageHook(
  _artifactId: string,
  _base64: string,
  _mimeType: string,
): Promise<string | undefined> {
  // TODO: route through a vision provider when hostedAvailable + supportsVision
  return undefined;
}

// ---------------------------------------------------------------------------
// Unified dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch to the appropriate extractor based on artifact kind and content.
 * Always returns a resolved `ExtractedArtifactText` — never throws.
 */
export async function extractArtifactText(
  artifact: ArtifactMetadata,
  content: string | undefined,
): Promise<ExtractedArtifactText> {
  const now = new Date().toISOString();

  // No content available
  if (!content) {
    return {
      artifactId: artifact.id,
      text: "",
      extractionMethod: "direct",
      extractedAt: now,
    };
  }

  if (artifact.kind === "netlist") {
    const { text, method } = extractNetlistText(content);
    return { artifactId: artifact.id, text, extractionMethod: method, extractedAt: now };
  }

  if (artifact.kind === "pdf") {
    const { text, method } = await extractPdfText(artifact.id, artifact.storageRef);
    return { artifactId: artifact.id, text, extractionMethod: method, extractedAt: now };
  }

  // text / other — direct
  const { text } = extractPlainText(content);
  return { artifactId: artifact.id, text, extractionMethod: "direct", extractedAt: now };
}
