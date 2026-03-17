/**
 * Phase 8.5 — Typed API client for /api/v1/ routes
 *
 * Provides one function per route that wraps fetch and returns
 * Promise<ApiResponse<T>>.  All payload shapes come exclusively from
 * skeleton.ts — this module never invents its own types.
 *
 * Usage (in a browser/UI context):
 *   const res = await listProviders();
 *   if (res.ok) {
 *     console.log(res.data.providers);
 *   } else {
 *     console.error(res.error.message);
 *   }
 *
 * The optional `baseUrl` parameter defaults to an empty string (same-origin)
 * so the client works without configuration in a locally hosted UI.
 */

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
  GetRunResponse,
  GetRunResultsResponse,
  ListProvidersResponse,
  ListRunsResponse,
  ProjectSummary,
  ProviderSummary,
} from "../core/api/skeleton.js";

import { API_ROUTES } from "../core/api/skeleton.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  url: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json();
    return body as ApiResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: { code: "NETWORK_ERROR", message },
    };
  }
}

function resolveUrl(template: string, params: Record<string, string>, baseUrl = ""): string {
  let resolved = template;
  for (const [k, v] of Object.entries(params)) {
    resolved = resolved.replace(`:${k}`, encodeURIComponent(v));
  }
  return `${baseUrl}${resolved}`;
}

// ---------------------------------------------------------------------------
// Provider APIs
// ---------------------------------------------------------------------------

/** GET /api/v1/providers */
export function listProviders(
  baseUrl = "",
): Promise<ApiResponse<ListProvidersResponse>> {
  return apiFetch(`${baseUrl}${API_ROUTES.PROVIDERS_LIST}`);
}

/** GET /api/v1/providers/:providerId */
export function getProvider(
  providerId: string,
  baseUrl = "",
): Promise<ApiResponse<{ provider: ProviderSummary }>> {
  return apiFetch(resolveUrl(API_ROUTES.PROVIDERS_GET, { providerId }, baseUrl));
}

// ---------------------------------------------------------------------------
// BYOK credential APIs
// ---------------------------------------------------------------------------

/** POST /api/v1/credentials */
export function createCredential(
  body: CreateCredentialRequest,
  baseUrl = "",
): Promise<ApiResponse<CreateCredentialResponse>> {
  return apiFetch(`${baseUrl}${API_ROUTES.CREDENTIALS_CREATE}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** DELETE /api/v1/credentials/:credentialId */
export function deleteCredential(
  credentialId: string,
  baseUrl = "",
): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiFetch(resolveUrl(API_ROUTES.CREDENTIALS_DELETE, { credentialId }, baseUrl), {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Custom endpoint APIs
// ---------------------------------------------------------------------------

/** POST /api/v1/custom-endpoints */
export function createCustomEndpoint(
  body: CreateCustomEndpointRequest,
  baseUrl = "",
): Promise<ApiResponse<CustomEndpointResponse>> {
  return apiFetch(`${baseUrl}${API_ROUTES.CUSTOM_ENDPOINTS_CREATE}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** PUT /api/v1/custom-endpoints/:endpointId */
export function updateCustomEndpoint(
  endpointId: string,
  body: Partial<CreateCustomEndpointRequest>,
  baseUrl = "",
): Promise<ApiResponse<CustomEndpointResponse>> {
  return apiFetch(
    resolveUrl(API_ROUTES.CUSTOM_ENDPOINTS_UPDATE, { endpointId }, baseUrl),
    { method: "PUT", body: JSON.stringify(body) },
  );
}

/** DELETE /api/v1/custom-endpoints/:endpointId */
export function deleteCustomEndpoint(
  endpointId: string,
  baseUrl = "",
): Promise<ApiResponse<{ deleted: boolean }>> {
  return apiFetch(
    resolveUrl(API_ROUTES.CUSTOM_ENDPOINTS_DELETE, { endpointId }, baseUrl),
    { method: "DELETE" },
  );
}

/** POST /api/v1/custom-endpoints/:endpointId/probe */
export function probeCustomEndpoint(
  endpointId: string,
  baseUrl = "",
): Promise<ApiResponse<CustomEndpointResponse>> {
  return apiFetch(
    resolveUrl(API_ROUTES.CUSTOM_ENDPOINTS_PROBE, { endpointId }, baseUrl),
    { method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Run APIs
// ---------------------------------------------------------------------------

/** POST /api/v1/runs */
export function createRun(
  body: CreateRunRequest,
  baseUrl = "",
): Promise<ApiResponse<CreateRunResponse>> {
  return apiFetch(`${baseUrl}${API_ROUTES.RUNS_CREATE}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** GET /api/v1/runs */
export function listRuns(
  baseUrl = "",
): Promise<ApiResponse<ListRunsResponse>> {
  return apiFetch(`${baseUrl}${API_ROUTES.RUNS_LIST}`);
}

/** GET /api/v1/runs/:runId */
export function getRun(
  runId: string,
  baseUrl = "",
): Promise<ApiResponse<GetRunResponse>> {
  return apiFetch(resolveUrl(API_ROUTES.RUNS_GET, { runId }, baseUrl));
}

/** GET /api/v1/runs/:runId/results */
export function getRunResults(
  runId: string,
  baseUrl = "",
): Promise<ApiResponse<GetRunResultsResponse>> {
  return apiFetch(resolveUrl(API_ROUTES.RUNS_RESULTS, { runId }, baseUrl));
}

/** POST /api/v1/runs/:runId/retry */
export function retryRun(
  runId: string,
  baseUrl = "",
): Promise<ApiResponse<CreateRunResponse>> {
  return apiFetch(resolveUrl(API_ROUTES.RUNS_RETRY, { runId }, baseUrl), {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Project APIs
// ---------------------------------------------------------------------------

/** POST /api/v1/projects */
export function createProject(
  body: CreateProjectRequest,
  baseUrl = "",
): Promise<ApiResponse<ProjectSummary>> {
  return apiFetch(`${baseUrl}${API_ROUTES.PROJECTS_CREATE}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** GET /api/v1/projects */
export function listProjects(
  baseUrl = "",
): Promise<ApiResponse<{ projects: ProjectSummary[]; total: number }>> {
  return apiFetch(`${baseUrl}${API_ROUTES.PROJECTS_LIST}`);
}

/** GET /api/v1/projects/:projectId */
export function getProject(
  projectId: string,
  baseUrl = "",
): Promise<ApiResponse<{ project: ProjectSummary }>> {
  return apiFetch(resolveUrl(API_ROUTES.PROJECTS_GET, { projectId }, baseUrl));
}

// ---------------------------------------------------------------------------
// Artifact APIs
// ---------------------------------------------------------------------------

/** POST /api/v1/projects/:projectId/artifacts */
export function createArtifact(
  projectId: string,
  body: { filename: string; kind: string; artifactPath?: string },
  baseUrl = "",
): Promise<ApiResponse<CreateArtifactResponse>> {
  return apiFetch(
    resolveUrl(API_ROUTES.ARTIFACTS_CREATE, { projectId }, baseUrl),
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** GET /api/v1/projects/:projectId/artifacts/:artifactId */
export function getArtifact(
  projectId: string,
  artifactId: string,
  baseUrl = "",
): Promise<ApiResponse<{ artifactId: string; projectId: string }>> {
  return apiFetch(
    resolveUrl(API_ROUTES.ARTIFACTS_GET, { projectId, artifactId }, baseUrl),
  );
}

// ---------------------------------------------------------------------------
// Billing APIs
// ---------------------------------------------------------------------------

/** GET /api/v1/billing/summary */
export function getBillingSummary(
  baseUrl = "",
): Promise<ApiResponse<BillingSummaryResponse>> {
  return apiFetch(`${baseUrl}${API_ROUTES.BILLING_SUMMARY}`);
}
