export const BUILTIN_PROVIDER_NAMES = ["openai", "xai", "google", "anthropic"] as const;

export type BuiltinProviderName = (typeof BUILTIN_PROVIDER_NAMES)[number];

/**
 * Extensible provider identifier.
 *
 * Built-in providers remain strongly typed, while custom/provider-registry
 * entries can introduce additional string IDs without forcing a type rewrite.
 */
export type ProviderName = BuiltinProviderName | (string & {});

export const BUILTIN_PROVIDER_PROTOCOLS = [
  "openai-compatible",
  "anthropic-native",
  "anthropic-compatible",
  "gemini-native",
] as const;

export type BuiltinProviderProtocol = (typeof BUILTIN_PROVIDER_PROTOCOLS)[number];

/**
 * Extensible protocol identifier.
 *
 * Initial adapters cover the built-in protocols, while later phases can add
 * protocol IDs for Azure, Bedrock, Ollama, custom gateways, and similar lanes.
 */
export type ProviderProtocol = BuiltinProviderProtocol | (string & {});

export function isBuiltinProviderName(provider: string): provider is BuiltinProviderName {
  return (BUILTIN_PROVIDER_NAMES as readonly string[]).includes(provider);
}

export function isBuiltinProviderProtocol(protocol: string): protocol is BuiltinProviderProtocol {
  return (BUILTIN_PROVIDER_PROTOCOLS as readonly string[]).includes(protocol);
}

export type BillingMode = "platform_free" | "platform_paid" | "user_byok" | "custom_endpoint";

export type ProviderScope = "builtin" | "custom_endpoint";

export interface ProviderCapabilities {
  supportsVision?: boolean;
  supportsFiles?: boolean;
  supportsStreaming?: boolean;
  supportsStructuredOutput?: boolean;
  supportsStrictJson?: boolean;
  supportsToolUse?: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  maxImageBytes?: number;
  synthesisEligible?: boolean;
  judgeEligible?: boolean;
  localDevAvailable?: boolean;
  hostedAvailable?: boolean;
}

export interface ProviderDefinition {
  id: string;
  provider: ProviderName;
  displayName: string;
  protocol: ProviderProtocol;
  billingMode: BillingMode;
  providerScope: ProviderScope;
  isEnabled: boolean;
  baseUrl?: string;
  authEnvVar?: string;
  authHeaderName?: string;
  authHeaderPrefix?: string;
  capabilities: ProviderCapabilities;
  isFreeEligible?: boolean;
  isPremiumOnly?: boolean;
}

export interface UserProviderCredential {
  id: string;
  providerDefinitionId: string;
  ownerId: string;
  status: "active" | "disabled" | "invalid";
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelDefinition {
  id: string;
  providerDefinitionId: string;
  modelId: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  synthesisEligible?: boolean;
  judgeEligible?: boolean;
  pricing?: {
    inputPerMillionUsd?: number;
    outputPerMillionUsd?: number;
  };
  isEnabled: boolean;
}

export interface ModelAlias {
  id: string;
  alias: string;
  targetModelDefinitionId: string;
  isDefault?: boolean;
}

export interface ResolvedProvider {
  provider: ProviderName;
  protocol: ProviderProtocol;
  model: string;
  baseUrl?: string;
  authEnvVar?: string;
  authHeaderName?: string;
  authHeaderPrefix?: string;
  capabilities: ProviderCapabilities;
  billingMode: BillingMode;
}

export interface InputImage {
  /** e.g. "image/png" or "image/jpeg" */
  mimeType: string;
  /** base64 (no data: prefix) */
  base64: string;
  /** original filename for traceability/logging */
  filename?: string;
}

export interface TaggedInputImage extends InputImage {
  /** Stable tag/id used to reference the image from the question text. */
  tag: string;
}

export interface TaggedImagePath {
  /** Stable tag/id used to reference the image from the question text. */
  tag: string;
  /** Path to the image file on disk. */
  path: string;
}

export interface NormalizedPromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
}

export interface NormalizedAttachment {
  id: string;
  kind: "image" | "pdf" | "text" | "netlist" | "other";
  filename?: string;
  mimeType?: string;
  path?: string;
  tag?: string;
}

export interface DispatchRequest {
  runId?: string;
  provider: ProviderName;
  protocol: ProviderProtocol;
  model: string;
  messages: NormalizedPromptMessage[];
  attachments?: NormalizedAttachment[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Phase 3 — Dispatch pipeline & normalization
// ---------------------------------------------------------------------------

/** Lifecycle state for a single provider dispatch. */
export type DispatchStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

/** Broad error taxonomy used by the normalizer to classify raw error strings. */
export type ProviderErrorCategory =
  | "auth"
  | "timeout"
  | "malformed_output"
  | "unsupported_attachment"
  | "provider_unavailable"
  | "unknown";

/** Structured description of a provider-side failure. */
export interface NormalizedProviderError {
  category: ProviderErrorCategory;
  message: string;
  /** Whether the operation is safe to retry without a config change. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------

export interface RawProviderResponse {
  provider: ProviderName;
  model: string;
  text: string;
  status?: DispatchStatus;
  error?: string;
  raw?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  latencyMs?: number;
}

/**
 * RawProviderResponse enriched with a canonical DispatchStatus and a
 * structured error object.  This is the type that flows through the
 * dispatch pipeline after each adapter returns.
 */
export interface NormalizedDispatchResult {
  provider: ProviderName;
  model: string;
  status: DispatchStatus;
  text: string;
  error?: NormalizedProviderError;
  raw?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  latencyMs?: number;
}

/**
 * Fully parsed and normalized result produced from a single provider response.
 * Downstream synthesis and report stages consume this instead of raw text.
 */
export interface NormalizedProviderResult {
  provider: ProviderName;
  model: string;
  status: DispatchStatus;
  /** Short prose summary extracted or inferred from the response. */
  summary: string;
  findings: NormalizedFinding[];
  assumptions: string[];
  missingInfo: string[];
  recommendedActions: string[];
  /** SPICE netlist extracted from the response, if present. */
  spiceNetlist?: string;
  /** Circuit JSON extracted from the response, if present. */
  circuitJson?: string;
  /**
   * Parse-quality score from 0.0 (nothing parseable) to 1.0 (all required
   * structured sections found and non-empty).
   */
  parseQuality: number;
  /** Human-readable confidence note surfaced to the UI and synthesis stage. */
  confidenceHint?: string;
  /** Present when the dispatch failed or the output could not be parsed. */
  error?: NormalizedProviderError;
}

export interface NormalizedFinding {
  title: string;
  category?: string;
  severity?: "info" | "low" | "medium" | "high" | "critical";
  summary: string;
  evidence?: string[];
  assumptions?: string[];
  confidenceNote?: string;
  sourceProviders?: ProviderName[];
}

export interface SynthesisOutput {
  summary: string;
  findings: NormalizedFinding[];
  openQuestions: string[];
  prioritizedActions: string[];
  confidenceNotes: string[];
}

// ---------------------------------------------------------------------------
// Phase 8 — Synthesis, consensus, and judge pipeline
// ---------------------------------------------------------------------------

/** A NormalizedFinding attributed to a specific provider dispatch result. */
export interface FindingWithSource extends NormalizedFinding {
  /** Provider name from which this finding originated. */
  sourceProvider: ProviderName;
  /** Model ID from which this finding originated. */
  sourceModel: string;
  /** Parse quality of the source result (0–1). */
  sourceParseQuality: number;
}

/** A cluster of findings from multiple providers that agree on a topic. */
export interface ConsensusCluster {
  /** Representative title derived from the cluster's highest-weight member. */
  title: string;
  /** Shared category when all members agree on one, otherwise undefined. */
  category?: string;
  /** Highest severity seen across all cluster members. */
  maxSeverity?: NormalizedFinding["severity"];
  /** All findings contributing to this cluster. */
  members: FindingWithSource[];
  /** Number of distinct providers that contributed findings to this cluster. */
  providerCount: number;
  /** Fraction of successful providers that contributed to this cluster (0–1). */
  agreementScore: number;
  /** True when only one provider contributed (i.e. this is an outlier finding). */
  isOutlier: boolean;
}

/** Output of the consensus-clustering stage. */
export interface ConsensusResult {
  /** Clusters ordered by agreementScore descending, then maxSeverity descending. */
  clusters: ConsensusCluster[];
  /** Providers excluded from clustering because their parse quality was too low. */
  excludedProviders: ProviderName[];
  /** Human-readable summary of agreement across providers. */
  agreementSummary: string;
  /** Human-readable summary of disagreements and outliers between providers. */
  disagreementSummary: string;
  /**
   * Overall ensemble confidence heuristic (0–1), derived from:
   *  - average cluster agreement score (weight 0.6)
   *  - average provider parse quality    (weight 0.4)
   */
  ensembleConfidence: number;
}

/** Output of the optional judge/reranker stage. */
export interface JudgeOutput {
  /** Reranked findings, highest priority first. */
  prioritizedFindings: NormalizedFinding[];
  /** Open questions no provider answered adequately. */
  openQuestions: string[];
  /** Confidence notes from the judge about overall analysis quality. */
  confidenceNotes: string[];
  /** Raw judge response text preserved for provenance. */
  rawText: string;
  /** Provider that acted as judge. */
  judgeProvider: ProviderName;
  /** Model that acted as judge. */
  judgeModel: string;
}

/** Full output of the Phase 8 synthesis/consensus/judge pipeline. */
export interface SynthesisPipelineResult {
  /** Whether the pipeline was attempted (at least one successful result available). */
  attempted: boolean;
  /** Whether the pipeline produced at least a consensus result. */
  succeeded: boolean;
  /** Human-readable error if the pipeline failed entirely before producing consensus. */
  error?: string;
  /** Consensus clustering output. Present when attempted=true and no fatal error. */
  consensus?: ConsensusResult;
  /** Judge output. Present only when the judge step ran and succeeded. */
  judge?: JudgeOutput;
  /** Raw NormalizedProviderResult from the synthesis LLM call. */
  synthesis?: NormalizedProviderResult;
  /** Structured synthesis output when the synthesis text was parseable. */
  synthesisOutput?: SynthesisOutput;
}

export interface ModelAnswer {
  provider: ProviderName;
  model: string;
  text: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface EnsembleOutputs {
  finalMarkdown: string;
  spiceNetlist: string;
  circuitJson: string;
}

// ---------------------------------------------------------------------------
// Phase 4 — Prompt package and artifact pipeline
// ---------------------------------------------------------------------------

/** The prompt-construction strategy used for a given dispatch. */
export type PromptProfileId = "analysis" | "synthesis" | "structured-output" | "judge";

/**
 * Provider-agnostic metadata record for one artifact.
 * Intentionally decoupled from how any provider expects files to be formatted.
 */
export interface ArtifactMetadata {
  id: string;
  kind: "image" | "pdf" | "text" | "netlist" | "other";
  filename?: string;
  mimeType?: string;
  /**
   * Filesystem path (local/dev mode) or object-storage key (hosted mode).
   * Format: plain path OR `s3://<bucket>/<key>` OR `runs/<runId>/artifacts/<id>/<filename>`.
   */
  storageRef?: string;
  sizeBytes?: number;
  /** Where the artifact originated — e.g. "upload", "config", "run-input", "inline". */
  provenanceSource: string;
  extractedAt?: string;
}

/**
 * Text content extracted from one artifact, along with provenance metadata
 * describing how the extraction was performed.
 */
export interface ExtractedArtifactText {
  artifactId: string;
  text: string;
  /**
   * How the text was obtained:
   * - "direct"           — plain-text read, no transformation
   * - "fence-strip"      — code fences removed before use
   * - "pdf-placeholder"  — PDF extraction not yet implemented; stub only
   * - "ocr-placeholder"  — future OCR/vision extraction hook; stub only
   */
  extractionMethod: "direct" | "fence-strip" | "pdf-placeholder" | "ocr-placeholder";
  extractedAt: string;
}

/**
 * Stable, self-contained package that describes everything needed to send a
 * prompt to one or more providers, assembled once and reused across all
 * dispatches in a run.  Artifact preprocessing is done here, not inside the
 * dispatch path.
 */
export interface AnalysisContextPackage {
  /** Stable ID for this context package (correlates with a run or turn). */
  id: string;
  promptProfileId: PromptProfileId;
  /** Plain-text user instructions / question text. */
  userInstructions: string;
  /** All artifacts registered for this context. */
  artifacts: ArtifactMetadata[];
  /** Extracted text from each artifact, keyed by artifactId. */
  extractedTexts: ExtractedArtifactText[];
  /**
   * Inline binary attachments (base64) for vision/image providers.
   * Only populated in local/dev mode or when the provider requires inline data.
   */
  inlineAttachments?: NormalizedAttachment[];
  /**
   * Object-storage prefixes or run-dir paths for each artifact, used to
   * record artifact provenance in run outputs for reproducibility.
   * Keys match ArtifactMetadata.id values.
   */
  storageRefs?: Record<string, string>;
  /** ISO-8601 timestamp when the context was assembled. */
  assembledAt: string;
}

// ---------------------------------------------------------------------------
// Phase 4.5 — Persistence and hosted API foundations: entity records
// ---------------------------------------------------------------------------

export type RunStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

/**
 * Top-level run record: one user request → one Run, which fans out to N
 * RunDispatches (one per provider).
 */
export interface Run {
  id: string;
  /** Owner user ID (undefined in local/dev mode). */
  ownerId?: string;
  /** Optional project grouper. */
  projectId?: string;
  status: RunStatus;
  promptProfileId: PromptProfileId;
  /** IDs of provider definitions included in this run. */
  providerDefinitionIds: string[];
  contextPackageId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Storage key for the assembled AnalysisContextPackage JSON. */
  contextStorageKey?: string;
  /** Storage key for the final report JSON. */
  reportStorageKey?: string;
}

/**
 * One per-provider dispatch within a Run.
 */
export interface RunDispatch {
  id: string;
  runId: string;
  providerDefinitionId: string;
  provider: ProviderName;
  model: string;
  status: DispatchStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Storage key for the raw request payload (NormalizedPromptMessage[]). */
  requestStorageKey?: string;
  /** Storage key for the raw provider response JSON. */
  responseStorageKey?: string;
  error?: NormalizedProviderError;
}

/**
 * Normalized result derived from one RunDispatch after the normalization step.
 */
export interface RunResult {
  id: string;
  runId: string;
  dispatchId: string;
  provider: ProviderName;
  model: string;
  parseQuality: number;
  summary: string;
  findings: NormalizedFinding[];
  assumptions: string[];
  missingInfo: string[];
  recommendedActions: string[];
  spiceNetlist?: string;
  circuitJson?: string;
  confidenceHint?: string;
  createdAt: string;
  /** Storage key for the full NormalizedProviderResult JSON. */
  resultStorageKey?: string;
}
