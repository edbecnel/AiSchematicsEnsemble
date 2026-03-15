/**
 * Phase 4 — Analysis context builder
 *
 * Assembles an AnalysisContextPackage from run inputs.  This step is
 * intentionally separated from provider dispatch so that:
 *   - Artifact preprocessing happens once, not once per provider.
 *   - The same context can be reused across retries and synthesis steps.
 *   - Provenance metadata is recorded independently of how any one provider
 *     expects files to be formatted.
 *   - The contract is reusable for the SUBCKT utility and datasheet-ingestion
 *     flows without pulling in runBatch dependencies.
 */

import crypto from "node:crypto";
import type {
  AnalysisContextPackage,
  ArtifactMetadata,
  ExtractedArtifactText,
  InputImage,
  NormalizedAttachment,
  PromptProfileId,
  TaggedImagePath,
  TaggedInputImage,
} from "../../types.js";
import { extractArtifactText } from "./extractor.js";

// ---------------------------------------------------------------------------
// Input shape (subset of RunBatchOptions — no run-infra fields)
// ---------------------------------------------------------------------------

export interface BuildContextInput {
  promptProfileId?: PromptProfileId;
  questionText?: string;
  questionFilename?: string;
  baselineNetlistText?: string;
  baselineNetlistFilename?: string;
  baselineImage?: InputImage;
  referenceImages?: TaggedInputImage[];
  referenceImagePaths?: TaggedImagePath[];
  /** ISO-8601 run ID or correlation ID (optional; a UUID is generated if omitted). */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

function inputImageToAttachment(
  image: InputImage,
  artifactId: string,
): NormalizedAttachment {
  return {
    id: artifactId,
    kind: "image",
    filename: image.filename,
    mimeType: image.mimeType,
    tag: undefined,
  };
}

function taggedImageToAttachment(
  image: TaggedInputImage,
  artifactId: string,
): NormalizedAttachment {
  return {
    id: artifactId,
    kind: "image",
    filename: image.filename,
    mimeType: image.mimeType,
    tag: image.tag,
  };
}

// ---------------------------------------------------------------------------
// buildAnalysisContext
// ---------------------------------------------------------------------------

/**
 * Assemble an AnalysisContextPackage from run inputs.
 *
 * Rules:
 *  - Each artifact gets a stable UUID.
 *  - Text artifacts (question, netlist) are extracted immediately.
 *  - Binary image artifacts are registered in metadata and attached as
 *    NormalizedAttachments for inline vision use; OCR extraction is deferred
 *    to the ocrImageHook placeholder in extractor.ts.
 *  - storageRefs records the provenance path for each artifact so run
 *    outputs can be reproduced.
 *  - Missing or blank inputs are silently skipped.
 */
export async function buildAnalysisContext(input: BuildContextInput): Promise<AnalysisContextPackage> {
  const contextId = input.runId ?? newId();
  const now = isoNow();
  const profileId: PromptProfileId = input.promptProfileId ?? "analysis";

  const artifacts: ArtifactMetadata[] = [];
  const extractedTexts: ExtractedArtifactText[] = [];
  const inlineAttachments: NormalizedAttachment[] = [];
  const storageRefs: Record<string, string> = {};

  // ── Question / user instructions ───────────────────────────────────────

  let userInstructions = "";
  if (input.questionText?.trim()) {
    const questionId = newId();
    const meta: ArtifactMetadata = {
      id: questionId,
      kind: "text",
      filename: input.questionFilename ?? "question.md",
      mimeType: "text/plain",
      provenanceSource: "config",
      extractedAt: now,
    };
    artifacts.push(meta);
    const extracted = await extractArtifactText(meta, input.questionText);
    extractedTexts.push(extracted);
    userInstructions = extracted.text;
    storageRefs[questionId] = input.questionFilename ?? "question.md";
  }

  // ── Baseline netlist ────────────────────────────────────────────────────

  if (input.baselineNetlistText?.trim()) {
    const netlistId = newId();
    const meta: ArtifactMetadata = {
      id: netlistId,
      kind: "netlist",
      filename: input.baselineNetlistFilename ?? "baseline.cir",
      mimeType: "text/plain",
      provenanceSource: "config",
      extractedAt: now,
    };
    artifacts.push(meta);
    const extracted = await extractArtifactText(meta, input.baselineNetlistText);
    extractedTexts.push(extracted);
    storageRefs[netlistId] = input.baselineNetlistFilename ?? "baseline.cir";
  }

  // ── Baseline schematic image ────────────────────────────────────────────

  if (input.baselineImage) {
    const imgId = newId();
    const meta: ArtifactMetadata = {
      id: imgId,
      kind: "image",
      filename: input.baselineImage.filename ?? "baseline-schematic.png",
      mimeType: input.baselineImage.mimeType,
      sizeBytes: Math.round((input.baselineImage.base64.length * 3) / 4),
      provenanceSource: "config",
      extractedAt: now,
    };
    artifacts.push(meta);
    // Images are not text-extracted here; they're attached inline for vision providers.
    // Future: route through ocrImageHook when a vision-extraction provider is configured.
    inlineAttachments.push(inputImageToAttachment(input.baselineImage, imgId));
    storageRefs[imgId] = input.baselineImage.filename ?? "baseline-schematic.png";
  }

  // ── Reference images (tagged inline) ───────────────────────────────────

  for (const ref of input.referenceImages ?? []) {
    const refId = newId();
    const meta: ArtifactMetadata = {
      id: refId,
      kind: "image",
      filename: ref.filename ?? `ref-${ref.tag}.png`,
      mimeType: ref.mimeType,
      sizeBytes: Math.round((ref.base64.length * 3) / 4),
      provenanceSource: "config",
      extractedAt: now,
    };
    artifacts.push(meta);
    const attachment = taggedImageToAttachment(ref, refId);
    inlineAttachments.push(attachment);
    storageRefs[refId] = ref.filename ?? `ref-${ref.tag}.png`;
  }

  // ── Reference image paths (local disk; metadata only — no inline data) ─

  for (const refPath of input.referenceImagePaths ?? []) {
    const refId = newId();
    const meta: ArtifactMetadata = {
      id: refId,
      kind: "image",
      filename: refPath.path.split(/[\\/]/).at(-1) ?? refPath.path,
      storageRef: refPath.path,
      provenanceSource: "run-input",
      extractedAt: now,
    };
    artifacts.push(meta);
    // Path-only references: the caller must load and inline them separately if needed.
    storageRefs[refId] = refPath.path;
  }

  return {
    id: contextId,
    promptProfileId: profileId,
    userInstructions,
    artifacts,
    extractedTexts,
    inlineAttachments: inlineAttachments.length > 0 ? inlineAttachments : undefined,
    storageRefs: Object.keys(storageRefs).length > 0 ? storageRefs : undefined,
    assembledAt: now,
  };
}
