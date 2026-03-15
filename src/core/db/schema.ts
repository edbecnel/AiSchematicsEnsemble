/**
 * Phase 4.5 — Skeletal DB schema
 *
 * Defines the TypeScript record types for every table in the future hosted
 * database.  These are NOT ORM entities yet — they are plain TypeScript
 * interfaces that document the intended schema so that:
 *   - The persistence interfaces in Phase 4.5 can be typed correctly.
 *   - A future migration to Drizzle / Prisma / Kysely just adds decorators
 *     or helper wrappers around these same shapes.
 *   - Local/dev mode serializes and deserializes these records as JSON.
 *
 * Field conventions:
 *   - All IDs are UUIDs (string).
 *   - All timestamps are ISO-8601 strings.
 *   - Optional hosted-only fields are marked with a comment.
 *   - All tables include createdAt; mutable tables also include updatedAt.
 */

import type {
  BillingMode,
  DispatchStatus,
  NormalizedFinding,
  NormalizedProviderError,
  ProviderName,
  ProviderProtocol,
  ProviderScope,
  PromptProfileId,
  RunStatus,
} from "../../types.js";

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  displayName?: string;
  /** "free" | "premium" | "admin" */
  planTier: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// providers  (mirrors ProviderDefinition at the DB level)
// ---------------------------------------------------------------------------

export interface ProviderRecord {
  id: string;
  providerName: ProviderName;
  displayName: string;
  protocol: ProviderProtocol;
  billingMode: BillingMode;
  providerScope: ProviderScope;
  isEnabled: boolean;
  baseUrl?: string;
  authEnvVar?: string;
  isFreeEligible: boolean;
  isPremiumOnly: boolean;
  /** Hosted-only: admin who last modified this record. */
  lastModifiedBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// user_provider_credentials  (BYOK)
// ---------------------------------------------------------------------------

export interface CredentialRecord {
  id: string;
  ownerId: string;
  providerRecordId: string;
  /** Encrypted ciphertext — never stored plaintext. */
  encryptedKey: string;
  /** KMS key ID or encryption scheme identifier used to produce encryptedKey. */
  encryptionKeyRef: string;
  status: "active" | "disabled" | "invalid";
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export interface ArtifactRecord {
  id: string;
  projectId?: string;
  ownerId?: string;
  kind: "image" | "pdf" | "text" | "netlist" | "other";
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Canonical storage key (see src/core/storage/keys.ts). */
  storageKey: string;
  provenanceSource: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  ownerId?: string;
  projectId?: string;
  status: RunStatus;
  promptProfileId: PromptProfileId;
  providerRecordIds: string[];
  contextPackageId: string;
  contextStorageKey?: string;
  reportStorageKey?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Hosted-only: estimated cost in USD at dispatch time. */
  estimatedCostUsd?: number;
  /** Hosted-only: actual billed cost in USD after run completion. */
  actualCostUsd?: number;
}

// ---------------------------------------------------------------------------
// run_dispatches
// ---------------------------------------------------------------------------

export interface RunDispatchRecord {
  id: string;
  runId: string;
  providerRecordId: string;
  provider: ProviderName;
  model: string;
  status: DispatchStatus;
  requestStorageKey?: string;
  responseStorageKey?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCategory?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// run_results
// ---------------------------------------------------------------------------

export interface RunResultRecord {
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
  resultStorageKey?: string;
  error?: NormalizedProviderError;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// billing_events  (placeholder — ledger entries)
// ---------------------------------------------------------------------------

export interface BillingEventRecord {
  id: string;
  ownerId: string;
  runId?: string;
  dispatchId?: string;
  providerRecordId?: string;
  billingMode: BillingMode;
  /** Credits consumed (platform billing) or USD cost for audit. */
  creditsConsumed?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// audit_events
// ---------------------------------------------------------------------------

export type AuditEventKind =
  | "provider_access_denied"
  | "custom_endpoint_probe_failed"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "credential_created"
  | "credential_updated"
  | "credential_deleted"
  | "credential_validation_failed";

export interface AuditEventRecord {
  id: string;
  kind: AuditEventKind;
  actorId?: string;
  targetId?: string;
  targetType?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}
