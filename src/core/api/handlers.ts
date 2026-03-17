/**
 * Phase 8.5 — Hosted API handler implementations
 *
 * ApiService provides all handler logic for the /api/v1/ route surface.
 * It is intentionally separated from the HTTP server so it can later be
 * tested independently and plugged into any server framework.
 *
 * Local/dev mode behaviour:
 *  - Provider catalog served from the built-in registry.
 *  - BYOK credentials are stored in-memory (no encryption — Phase 5 adds
 *    proper encrypted storage); they update process.env so executeRun can
 *    pick them up for the remainder of the process lifetime.
 *  - Custom endpoints are stored in-memory and are not persisted across
 *    server restarts. Persistent storage arrives in Phase 10.
 *  - Projects are stored in-memory.
 *  - Run results are read from the run directory on disk via the storage
 *    backend conventions established in Phases 4.5 and 7.5.
 *  - Billing summary is a stub (placeholder for Phase 10/hosted).
 *
 * Phase 8.5 guardrail: backend contracts must stabilize before broad UI
 * generation. This module is the single source of truth for what the UI
 * (Phase 9) consumes — UI must not invent its own payload shapes.
 */

import crypto from "node:crypto";
import path from "node:path";

import {
  getDefaultModelDefinitionForProvider,
  listProviderDefinitions,
} from "../../registry/providers.js";
import type {
  ProviderName,
  RunStatus,
} from "../../types.js";
import { executeRun } from "../orchestration/run.js";
import { createLocalStorage } from "../storage/store.js";
import { finalReportMdKey, runRecordKey } from "../storage/keys.js";

import type {
  ApiResponse,
  BillingSummaryResponse,
  CreateArtifactResponse,
  CreateCredentialRequest,
  CreateCredentialResponse,
  CreateCustomEndpointRequest,
  CreateProjectRequest,
  CreateRunRequest,
  CreateRunResponse,
  CustomEndpointResponse,
  DispatchSummary,
  GetRunResponse,
  GetRunResultsResponse,
  ListProvidersResponse,
  ListRunsResponse,
  ProjectSummary,
  ProviderSummary,
  RunResultSummary,
  RunSummary,
} from "./skeleton.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function fail(code: string, message: string, detail?: unknown): ApiResponse<never> {
  return { ok: false, error: { code, message, detail } };
}

// ---------------------------------------------------------------------------
// In-memory stores for local/dev mode
// ---------------------------------------------------------------------------

interface ByokRecord {
  id: string;
  providerDefinitionId: string;
  provider: ProviderName;
  /** Plaintext key kept in memory only; never returned to the client. */
  _apiKey: string;
  status: "active" | "invalid";
  createdAt: string;
}

interface CustomEndpointRecord extends CustomEndpointResponse {
  /** Kept in memory, never returned to the client. */
  _apiKey: string;
}

interface RunIndexEntry {
  runId: string;
  runDir: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  providerCount: number;
  successCount: number;
  failureCount: number;
  promptProfileId: string;
}

const BYOK_STORE = new Map<string, ByokRecord>();
const CUSTOM_ENDPOINT_STORE = new Map<string, CustomEndpointRecord>();
const PROJECT_STORE = new Map<string, ProjectSummary>();
const RUN_INDEX = new Map<string, RunIndexEntry>();

// ---------------------------------------------------------------------------
// ENV key names for built-in providers
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Record<string, string> = {
  "provider.openai":     "OPENAI_API_KEY",
  "provider.anthropic":  "ANTHROPIC_API_KEY",
  "provider.google":     "GEMINI_API_KEY",
  "provider.xai":        "XAI_API_KEY",
};

// ---------------------------------------------------------------------------
// ApiService
// ---------------------------------------------------------------------------

export interface ApiServiceOptions {
  /** Workspace CWD — used for resolving run artifact paths. */
  cwd: string;
  /** Default output directory for new runs. */
  defaultRunsDir: string;
}

/**
 * ApiService provides all Phase 8.5 handler implementations.
 * One instance should be created per server lifetime.
 */
export class ApiService {
  private readonly cwd: string;
  private readonly defaultRunsDir: string;

  constructor(opts: ApiServiceOptions) {
    this.cwd = opts.cwd;
    this.defaultRunsDir = opts.defaultRunsDir;
  }

  // -------------------------------------------------------------------------
  // Provider APIs
  // -------------------------------------------------------------------------

  /** GET /api/v1/providers */
  listProviders(): ApiResponse<ListProvidersResponse> {
    const defs = listProviderDefinitions();
    const providers: ProviderSummary[] = defs.map((d) => {
      const hasByok = [...BYOK_STORE.values()].some(
        (b) => b.providerDefinitionId === d.id && b.status === "active",
      );
      const defaultModel = getDefaultModelDefinitionForProvider(d.provider);
      return {
        id: d.id,
        providerName: d.provider,
        displayName: d.displayName,
        protocol: d.protocol,
        billingMode: d.billingMode,
        isEnabled: d.isEnabled,
        isFreeEligible: d.isFreeEligible ?? false,
        isPremiumOnly: d.isPremiumOnly ?? false,
        supportsVision: d.capabilities.supportsVision,
        synthesisEligible: defaultModel?.synthesisEligible ?? d.capabilities.synthesisEligible,
        judgeEligible: defaultModel?.judgeEligible ?? d.capabilities.judgeEligible,
        hasByokCredential: hasByok,
      };
    });
    return ok({ providers });
  }

  /** GET /api/v1/providers/:providerId */
  getProvider(providerId: string): ApiResponse<{ provider: ProviderSummary }> {
    const defs = listProviderDefinitions();
    const d = defs.find((def) => def.id === providerId);
    if (!d) return fail("NOT_FOUND", `Provider not found: ${providerId}`);
    const hasByok = [...BYOK_STORE.values()].some(
      (b) => b.providerDefinitionId === d.id && b.status === "active",
    );
    const defaultModel = getDefaultModelDefinitionForProvider(d.provider);
    return ok({
      provider: {
        id: d.id,
        providerName: d.provider,
        displayName: d.displayName,
        protocol: d.protocol,
        billingMode: d.billingMode,
        isEnabled: d.isEnabled,
        isFreeEligible: d.isFreeEligible ?? false,
        isPremiumOnly: d.isPremiumOnly ?? false,
        supportsVision: d.capabilities.supportsVision,
        synthesisEligible: defaultModel?.synthesisEligible ?? d.capabilities.synthesisEligible,
        judgeEligible: defaultModel?.judgeEligible ?? d.capabilities.judgeEligible,
        hasByokCredential: hasByok,
      },
    });
  }

  // -------------------------------------------------------------------------
  // BYOK credential APIs
  // -------------------------------------------------------------------------

  /** POST /api/v1/credentials */
  addByok(body: CreateCredentialRequest): ApiResponse<CreateCredentialResponse> {
    const { providerRecordId, apiKey } = body;
    if (!providerRecordId?.trim()) return fail("INVALID_INPUT", "providerRecordId is required");
    if (!apiKey?.trim()) return fail("INVALID_INPUT", "apiKey is required");

    // Look up the provider definition
    const defs = listProviderDefinitions();
    const def = defs.find((d) => d.id === providerRecordId);
    if (!def) return fail("NOT_FOUND", `Provider definition not found: ${providerRecordId}`);

    // Upsert: remove any existing credential for the same provider
    for (const [id, existing] of BYOK_STORE.entries()) {
      if (existing.providerDefinitionId === providerRecordId) {
        BYOK_STORE.delete(id);
        break;
      }
    }

    const id = newId();
    const record: ByokRecord = {
      id,
      providerDefinitionId: providerRecordId,
      provider: def.provider,
      _apiKey: apiKey.trim(),
      status: "active",
      createdAt: isoNow(),
    };
    BYOK_STORE.set(id, record);

    // Apply to process.env so subsequent executeRun calls use it
    const envKey = PROVIDER_ENV_KEYS[providerRecordId] ?? def.authEnvVar;
    if (envKey) process.env[envKey] = apiKey.trim();

    return ok({ credentialId: id, status: "active" });
  }

  /** DELETE /api/v1/credentials/:credentialId */
  deleteByok(credentialId: string): ApiResponse<{ deleted: boolean }> {
    const record = BYOK_STORE.get(credentialId);
    if (!record) return fail("NOT_FOUND", `Credential not found: ${credentialId}`);

    BYOK_STORE.delete(credentialId);

    // Unset from process.env only if no other BYOK for same provider remains
    const hasAnother = [...BYOK_STORE.values()].some(
      (b) => b.providerDefinitionId === record.providerDefinitionId,
    );
    if (!hasAnother) {
      const envKey = PROVIDER_ENV_KEYS[record.providerDefinitionId];
      if (envKey) delete process.env[envKey];
    }

    return ok({ deleted: true });
  }

  // -------------------------------------------------------------------------
  // Custom endpoint APIs
  // -------------------------------------------------------------------------

  /** POST /api/v1/custom-endpoints */
  addCustomEndpoint(body: CreateCustomEndpointRequest): ApiResponse<CustomEndpointResponse> {
    if (!body.baseUrl?.trim()) return fail("INVALID_INPUT", "baseUrl is required");
    if (!body.protocol?.trim()) return fail("INVALID_INPUT", "protocol is required");
    if (!body.displayName?.trim()) return fail("INVALID_INPUT", "displayName is required");

    const urlStr = body.baseUrl.trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      return fail("INVALID_URL", "baseUrl is not a valid URL");
    }

    // Basic SSRF block (full implementation in Phase 6)
    const blocked = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
    if (blocked.includes(parsedUrl.hostname)) {
      return fail("SSRF_BLOCKED", "localhost/loopback endpoints are not allowed");
    }

    const id = newId();
    const record: CustomEndpointRecord = {
      id,
      displayName: body.displayName.trim(),
      baseUrl: urlStr,
      protocol: body.protocol,
      activationStatus: "pending_validation",
      _apiKey: body.apiKey?.trim() ?? "",
    };
    CUSTOM_ENDPOINT_STORE.set(id, record);

    const { _apiKey: _, ...publicRecord } = record;
    return ok(publicRecord);
  }

  /** PUT /api/v1/custom-endpoints/:endpointId */
  updateCustomEndpoint(
    endpointId: string,
    body: Partial<CreateCustomEndpointRequest>,
  ): ApiResponse<CustomEndpointResponse> {
    const existing = CUSTOM_ENDPOINT_STORE.get(endpointId);
    if (!existing) return fail("NOT_FOUND", `Custom endpoint not found: ${endpointId}`);

    if (body.baseUrl !== undefined) existing.baseUrl = body.baseUrl.trim();
    if (body.displayName !== undefined) existing.displayName = body.displayName.trim();
    if (body.apiKey !== undefined) existing._apiKey = body.apiKey.trim();

    // Reset activation status on significant changes
    if (body.baseUrl !== undefined || body.protocol !== undefined) {
      existing.activationStatus = "pending_validation";
      existing.lastProbeAt = undefined;
      existing.lastProbeError = undefined;
    }

    const { _apiKey: _, ...publicRecord } = existing;
    return ok(publicRecord);
  }

  /** DELETE /api/v1/custom-endpoints/:endpointId */
  deleteCustomEndpoint(endpointId: string): ApiResponse<{ deleted: boolean }> {
    if (!CUSTOM_ENDPOINT_STORE.has(endpointId)) {
      return fail("NOT_FOUND", `Custom endpoint not found: ${endpointId}`);
    }
    CUSTOM_ENDPOINT_STORE.delete(endpointId);
    return ok({ deleted: true });
  }

  /** POST /api/v1/custom-endpoints/:endpointId/probe — stub for Phase 6 */
  probeCustomEndpoint(endpointId: string): ApiResponse<CustomEndpointResponse> {
    const existing = CUSTOM_ENDPOINT_STORE.get(endpointId);
    if (!existing) return fail("NOT_FOUND", `Custom endpoint not found: ${endpointId}`);

    // Full probe logic in Phase 6; for now mark as active so the contract is exercisable
    existing.activationStatus = "active";
    existing.lastProbeAt = isoNow();
    existing.lastProbeError = undefined;

    const { _apiKey: _, ...publicRecord } = existing;
    return ok(publicRecord);
  }

  // -------------------------------------------------------------------------
  // Run APIs
  // -------------------------------------------------------------------------

  /** POST /api/v1/runs — create and execute a run */
  async createRun(
    body: CreateRunRequest,
    opts: { outdir?: string } = {},
  ): Promise<ApiResponse<CreateRunResponse>> {
    if (!body.questionText?.trim()) {
      return fail("INVALID_INPUT", "questionText is required");
    }

    const runDir = opts.outdir ?? this.defaultRunsDir;

    try {
      const result = await executeRun({
        questionText: body.questionText.trim(),
        baselineNetlistText: body.baselineNetlist
          ? Buffer.from(body.baselineNetlist, "base64").toString("utf-8")
          : undefined,
        outdir: runDir,
        synthesize: true,
      });

      const entry: RunIndexEntry = {
        runId: result.runId,
        runDir: result.runDir,
        status: result.status,
        createdAt: result.run.createdAt,
        completedAt: result.run.completedAt,
        providerCount: result.dispatches.length,
        successCount: result.results.filter((r) => r.status === "succeeded").length,
        failureCount: result.results.filter((r) => r.status !== "succeeded").length,
        promptProfileId: result.run.promptProfileId,
      };
      RUN_INDEX.set(result.runId, entry);

      return ok({ runId: result.runId, status: result.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail("RUN_FAILED", `Run execution failed: ${msg}`);
    }
  }

  /** GET /api/v1/runs */
  async listRuns(): Promise<ApiResponse<ListRunsResponse>> {
    // Merge in-memory index and on-disk run directories
    await this._scanRunDirs();

    const runs: RunSummary[] = [...RUN_INDEX.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((e) => ({
        id: e.runId,
        status: e.status,
        promptProfileId: (e.promptProfileId as RunSummary["promptProfileId"]) ?? "analysis",
        providerCount: e.providerCount,
        createdAt: e.createdAt,
        completedAt: e.completedAt,
        successCount: e.successCount,
        failureCount: e.failureCount,
      }));

    return ok({ runs, total: runs.length });
  }

  /** GET /api/v1/runs/:runId */
  async getRun(runId: string): Promise<ApiResponse<GetRunResponse>> {
    await this._loadRunIfNeeded(runId);
    const entry = RUN_INDEX.get(runId);
    if (!entry) return fail("NOT_FOUND", `Run not found: ${runId}`);

    const runRecord = await this._readRunRecord(entry.runDir, runId);

    return ok({
      id: runId,
      status: entry.status,
      promptProfileId: (entry.promptProfileId as GetRunResponse["promptProfileId"]) ?? "analysis",
      providerCount: entry.providerCount,
      createdAt: entry.createdAt,
      completedAt: entry.completedAt,
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      contextPackageId: runRecord?.contextPackageId ?? "",
      reportStorageKey: runRecord?.reportStorageKey,
    });
  }

  /** GET /api/v1/runs/:runId/results */
  async getRunResults(runId: string): Promise<ApiResponse<GetRunResultsResponse>> {
    await this._loadRunIfNeeded(runId);
    const entry = RUN_INDEX.get(runId);
    if (!entry) return fail("NOT_FOUND", `Run not found: ${runId}`);

    const storage = createLocalStorage(entry.runDir);
    const resultKeys = await storage.list(`runs/${runId}/dispatches`, { recursive: true }).catch(() => []);
    const normalizedResultKeys = resultKeys.filter((key) => key.endsWith("/result.json"));

    const materialized = (
      await Promise.all(normalizedResultKeys.map(async (key) => {
        const data = await storage.readJson<any>(key).catch(() => undefined);
        if (!data) return undefined;

        const match = key.match(/dispatches\/([^/]+)\/result\.json$/);
        const dispatchId = match?.[1] ?? key;

        const result: RunResultSummary = {
          dispatchId,
          provider: (data.provider ?? "unknown-provider") as ProviderName,
          model: data.model ?? "",
          status: data.status ?? "failed",
          parseQuality: data.parseQuality ?? 0,
          summary: data.summary ?? "",
          findings: Array.isArray(data.findings) ? data.findings : [],
          spiceNetlist: typeof data.spiceNetlist === "string" ? data.spiceNetlist : undefined,
          confidenceHint: typeof data.confidenceHint === "string" ? data.confidenceHint : undefined,
          errorCategory: data.error?.category,
          errorMessage: data.error?.message,
        };

        const dispatch: DispatchSummary = {
          id: dispatchId,
          provider: result.provider,
          model: result.model,
          status: result.status,
          parseQuality: result.parseQuality,
          errorCategory: result.errorCategory,
          errorMessage: result.errorMessage,
        };

        return { dispatch, result };
      }))
    ).filter((item): item is { dispatch: DispatchSummary; result: RunResultSummary } => Boolean(item));

    let dispatches: DispatchSummary[] = materialized.map((item) => item.dispatch);
    let results: RunResultSummary[] = materialized.map((item) => item.result);

    if (!results.length) {
      const answersRaw = await storage.readJson("answers.json").catch(() => null);
      const answers = Array.isArray(answersRaw) ? (answersRaw as any[]) : [];

      dispatches = answers.map((a: any, i: number) => ({
        id: `dispatch-${i}`,
        provider: a.provider as ProviderName,
        model: a.model ?? "",
        status: a.status ?? "succeeded",
        parseQuality: a.parseQuality,
        errorCategory: a.errorCategory,
        errorMessage: a.error,
      }));

      results = answers.map((a: any, i: number) => ({
        dispatchId: `dispatch-${i}`,
        provider: a.provider as ProviderName,
        model: a.model ?? "",
        status: a.status ?? "succeeded",
        parseQuality: a.parseQuality ?? 0,
        summary: (typeof a.text === "string" ? a.text : "") || "",
        findings: Array.isArray(a.findings) ? a.findings : [],
        confidenceHint: typeof a.confidenceHint === "string" ? a.confidenceHint : undefined,
        errorCategory: a.errorCategory,
        errorMessage: a.error,
      }));
    }

    // Read synthesis result from storage key (new layout: runs/{runId}/reports/final-report.md)
    let synthesisResult: GetRunResultsResponse["synthesisResult"] | undefined;
    try {
      const finalMd = await storage.readText(finalReportMdKey(entry.runId));
      if (finalMd?.trim()) {
        synthesisResult = {
          summary: finalMd.slice(0, 2000),
          findings: [],
          confidenceNotes: [],
        };
      }
    } catch { /* non-fatal */ }

    return ok({
      runId,
      status: entry.status,
      dispatches,
      results,
      synthesisResult,
    });
  }

  /** POST /api/v1/runs/:runId/retry */
  async retryRun(runId: string): Promise<ApiResponse<CreateRunResponse>> {
    await this._loadRunIfNeeded(runId);
    const entry = RUN_INDEX.get(runId);
    if (!entry) return fail("NOT_FOUND", `Run not found: ${runId}`);

    // Read original question from the run storage
    const storage = createLocalStorage(entry.runDir);
    let questionText: string | undefined;
    try {
      // New layout: context is written to runs/{runId}/context.json
      const runRecord = await this._readRunRecord(entry.runDir, runId);
      if (runRecord?.contextStorageKey) {
        const ctx = await createLocalStorage(entry.runDir).readJson(runRecord.contextStorageKey);
        questionText = (ctx as any)?.userInstructions;
      }
    } catch { /* fall through */ }

    if (!questionText) {
      // Try reading from answers.json as a fallback (not ideal but better than nothing)
      return fail("RETRY_UNAVAILABLE", "Original run question could not be recovered; re-submit via create run.");
    }

    return this.createRun({ questionText }, { outdir: path.dirname(entry.runDir) });
  }

  // -------------------------------------------------------------------------
  // Project APIs
  // -------------------------------------------------------------------------

  /** POST /api/v1/projects */
  createProject(body: CreateProjectRequest): ApiResponse<ProjectSummary> {
    if (!body.name?.trim()) return fail("INVALID_INPUT", "name is required");
    const id = newId();
    const project: ProjectSummary = {
      id,
      name: body.name.trim(),
      description: body.description?.trim(),
      createdAt: isoNow(),
    };
    PROJECT_STORE.set(id, project);
    return ok(project);
  }

  /** GET /api/v1/projects */
  listProjects(): ApiResponse<{ projects: ProjectSummary[]; total: number }> {
    const projects = [...PROJECT_STORE.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return ok({ projects, total: projects.length });
  }

  /** GET /api/v1/projects/:projectId */
  getProject(projectId: string): ApiResponse<{ project: ProjectSummary }> {
    const p = PROJECT_STORE.get(projectId);
    if (!p) return fail("NOT_FOUND", `Project not found: ${projectId}`);
    return ok({ project: p });
  }

  // -------------------------------------------------------------------------
  // Artifact APIs
  // -------------------------------------------------------------------------

  /**
   * POST /api/v1/projects/:projectId/artifacts
   * In local/dev mode: records artifact metadata; the actual file byte upload
   * is handled by the existing /api/upload route and the artifactPath field
   * points to the uploaded path on disk.
   */
  createArtifact(
    projectId: string,
    body: { filename: string; kind: string; artifactPath: string },
  ): ApiResponse<CreateArtifactResponse> {
    if (!PROJECT_STORE.has(projectId)) {
      return fail("NOT_FOUND", `Project not found: ${projectId}`);
    }
    if (!body.filename?.trim()) return fail("INVALID_INPUT", "filename is required");
    const artifactId = newId();
    const storageKey = `projects/${projectId}/artifacts/${artifactId}/${body.filename.trim()}`;
    return ok({ artifactId, storageKey, kind: body.kind ?? "other" });
  }

  /** GET /api/v1/projects/:projectId/artifacts/:artifactId */
  getArtifact(
    projectId: string,
    artifactId: string,
  ): ApiResponse<{ artifactId: string; projectId: string }> {
    if (!PROJECT_STORE.has(projectId)) {
      return fail("NOT_FOUND", `Project not found: ${projectId}`);
    }
    // In local/dev mode there is no artifact index; return minimal metadata
    return ok({ artifactId, projectId });
  }

  // -------------------------------------------------------------------------
  // Billing APIs
  // -------------------------------------------------------------------------

  /** GET /api/v1/billing/summary */
  getBillingSummary(): ApiResponse<BillingSummaryResponse> {
    // Local/dev mode: billing is always a stub
    return ok({
      creditsRemaining: undefined,
      creditsUsedThisMonth: undefined,
      estimatedRunCostUsd: undefined,
      lastUpdatedAt: isoNow(),
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _readRunRecord(runDir: string, runId: string): Promise<any> {
    try {
      const storage = createLocalStorage(runDir);
      // New layout: {runDir}/runs/{runId}/run.json
      return await storage.readJson(runRecordKey(runId));
    } catch {
      return null;
    }
  }

  /**
   * Scan run directories under defaultRunsDir and populate RUN_INDEX.
   *
   * On-disk layout produced by executeRun/makeRunDir:
   *   {defaultRunsDir}/
   *     {timestamp}/           ← runDir
   *       answers.json
   *       runs/
   *         {runId}/
   *           run.json         ← run record (storage key: runs/{runId}/run.json)
   *           reports/
   *             final-report.md
   *             ...
   */
  private async _scanRunDirs(): Promise<void> {
    try {
      const root = path.resolve(this.cwd, this.defaultRunsDir);
      const rootStorage = createLocalStorage(root);
      const keys = await rootStorage.list("", { recursive: true }).catch(() => []);
      const runRecordKeys = keys.filter((key) => /(^|\/)runs\/[^/]+\/run\.json$/.test(key));

      for (const key of runRecordKeys) {
        const match = key.match(/^([^/]+)\/runs\/([^/]+)\/run\.json$/);
        if (!match) continue;

        const [, runDirKey, runId] = match;
        if (RUN_INDEX.has(runId)) continue;

        try {
          const data = await rootStorage.readJson<any>(key);
          if (!data) continue;

          RUN_INDEX.set(runId, {
            runId,
            runDir: rootStorage.resolveLocation(runDirKey),
            status: data.status ?? "succeeded",
            createdAt: data.createdAt ?? isoNow(),
            completedAt: data.completedAt,
            providerCount: (data.providerDefinitionIds?.length as number) ?? 0,
            successCount: 0,
            failureCount: 0,
            promptProfileId: data.promptProfileId ?? "analysis",
          });
        } catch { /* skip unreadable run records */ }
      }
    } catch { /* non-fatal */ }
  }

  private async _loadRunIfNeeded(runId: string): Promise<void> {
    if (RUN_INDEX.has(runId)) return;
    await this._scanRunDirs();
  }
}
