/**
 * Phase 4.5 — Hosted API skeleton
 *
 * Defines the stable route path constants and typed request/response
 * shapes for the hosted API surface.  No HTTP framework is wired here yet
 * (that happens in Phase 8.5) — this file is the source of truth for the
 * API contract that:
 *   - UI components consume (never invent their own payload shapes)
 *   - Backend handlers implement
 *   - SUBCKT utility endpoints follow the same pattern
 *
 * Groups:
 *   /providers   — provider catalog and BYOK management
 *   /runs        — run lifecycle
 *   /projects    — project and artifact management
 *   /billing     — billing summary (placeholder)
 */

import type {
  DispatchStatus,
  NormalizedFinding,
  ProviderName,
  ProviderProtocol,
  PromptProfileId,
  RunStatus,
} from "../../types.js";

// ---------------------------------------------------------------------------
// Route path constants
// ---------------------------------------------------------------------------

export const API_ROUTES = {
  // Provider catalog
  PROVIDERS_LIST:               "/api/v1/providers",
  PROVIDERS_GET:                "/api/v1/providers/:providerId",

  // BYOK credentials
  CREDENTIALS_CREATE:           "/api/v1/credentials",
  CREDENTIALS_DELETE:           "/api/v1/credentials/:credentialId",
  CREDENTIALS_VALIDATE:         "/api/v1/credentials/:credentialId/validate",

  // Custom endpoints
  CUSTOM_ENDPOINTS_CREATE:      "/api/v1/custom-endpoints",
  CUSTOM_ENDPOINTS_UPDATE:      "/api/v1/custom-endpoints/:endpointId",
  CUSTOM_ENDPOINTS_DELETE:      "/api/v1/custom-endpoints/:endpointId",
  CUSTOM_ENDPOINTS_PROBE:       "/api/v1/custom-endpoints/:endpointId/probe",

  // Runs
  RUNS_CREATE:                  "/api/v1/runs",
  RUNS_LIST:                    "/api/v1/runs",
  RUNS_GET:                     "/api/v1/runs/:runId",
  RUNS_RESULTS:                 "/api/v1/runs/:runId/results",
  RUNS_RETRY:                   "/api/v1/runs/:runId/retry",

  // Projects
  PROJECTS_CREATE:              "/api/v1/projects",
  PROJECTS_LIST:                "/api/v1/projects",
  PROJECTS_GET:                 "/api/v1/projects/:projectId",

  // Artifacts
  ARTIFACTS_CREATE:             "/api/v1/projects/:projectId/artifacts",
  ARTIFACTS_GET:                "/api/v1/projects/:projectId/artifacts/:artifactId",

  // Billing
  BILLING_SUMMARY:              "/api/v1/billing/summary",
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];

// ---------------------------------------------------------------------------
// Shared envelope
// ---------------------------------------------------------------------------

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ---------------------------------------------------------------------------
// Provider API types
// ---------------------------------------------------------------------------

export interface ProviderSummary {
  id: string;
  providerName: ProviderName;
  displayName: string;
  protocol: ProviderProtocol;
  billingMode: string;
  isEnabled: boolean;
  isFreeEligible: boolean;
  isPremiumOnly: boolean;
  supportsVision?: boolean;
  synthesisEligible?: boolean;
  judgeEligible?: boolean;
  /** Whether the current user has a valid BYOK credential for this provider. */
  hasByokCredential?: boolean;
}

export interface ListProvidersResponse {
  providers: ProviderSummary[];
}

export interface CreateCredentialRequest {
  providerRecordId: string;
  /** Plaintext API key — encrypted server-side immediately; never stored. */
  apiKey: string;
}

export interface CreateCredentialResponse {
  credentialId: string;
  status: "active" | "invalid";
}

export interface CreateCustomEndpointRequest {
  displayName: string;
  /** Must use https: in hosted/production mode. */
  baseUrl: string;
  protocol: "openai-compatible" | "anthropic-compatible";
  /** Plaintext API key for the custom endpoint. */
  apiKey: string;
}

export interface CustomEndpointResponse {
  id: string;
  displayName: string;
  baseUrl: string;
  protocol: string;
  activationStatus: "pending_validation" | "active" | "failed_validation" | "disabled";
  lastProbeAt?: string;
  lastProbeError?: string;
}

// ---------------------------------------------------------------------------
// Run API types
// ---------------------------------------------------------------------------

export interface CreateRunRequest {
  projectId?: string;
  promptProfileId?: PromptProfileId;
  providerDefinitionIds?: string[];
  /** Plain-text question/instructions. */
  questionText: string;
  /** Base64-encoded baseline netlist text (optional). */
  baselineNetlist?: string;
  /** Artifact IDs to include (already uploaded via artifact API). */
  artifactIds?: string[];
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  promptProfileId: PromptProfileId;
  providerCount: number;
  createdAt: string;
  completedAt?: string;
  /** Number of successful dispatches. */
  successCount?: number;
  /** Number of failed dispatches. */
  failureCount?: number;
}

export interface CreateRunResponse {
  runId: string;
  status: RunStatus;
}

export interface ListRunsResponse {
  runs: RunSummary[];
  total: number;
}

export interface GetRunResponse extends RunSummary {
  contextPackageId: string;
  reportStorageKey?: string;
}

export interface DispatchSummary {
  id: string;
  provider: ProviderName;
  model: string;
  status: DispatchStatus;
  latencyMs?: number;
  parseQuality?: number;
  errorCategory?: string;
  errorMessage?: string;
}

export interface RunResultSummary {
  dispatchId: string;
  provider: ProviderName;
  model: string;
  status: DispatchStatus;
  parseQuality: number;
  summary: string;
  findings: NormalizedFinding[];
  spiceNetlist?: string;
  confidenceHint?: string;
  errorCategory?: string;
  errorMessage?: string;
}

export interface GetRunResultsResponse {
  runId: string;
  status: RunStatus;
  dispatches: DispatchSummary[];
  results: RunResultSummary[];
  /** Present if synthesis completed. */
  synthesisResult?: {
    summary: string;
    findings: NormalizedFinding[];
    spiceNetlist?: string;
    confidenceNotes: string[];
  };
}

// ---------------------------------------------------------------------------
// Project & artifact API types
// ---------------------------------------------------------------------------

export interface CreateProjectRequest {
  name: string;
  description?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface CreateArtifactResponse {
  artifactId: string;
  storageKey: string;
  kind: string;
}

// ---------------------------------------------------------------------------
// Billing API types
// ---------------------------------------------------------------------------

export interface BillingSummaryResponse {
  /** Hosted-only — placeholders for local/dev mode. */
  creditsRemaining?: number;
  creditsUsedThisMonth?: number;
  estimatedRunCostUsd?: number;
  lastUpdatedAt?: string;
}
