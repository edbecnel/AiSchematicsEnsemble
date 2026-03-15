/**
 * Phase 4.5 — Canonical storage key conventions
 *
 * These functions produce the canonical object-storage key (or local-fs
 * relative path) for every artifact and run-scoped payload.  Both the local
 * filesystem backend and any future object-storage backend (S3-compatible,
 * GCS, etc.) use exactly these keys — the backend is responsible for
 * resolving them to actual paths or URLs.
 *
 * Convention:
 *   projects/{projectId}/artifacts/{artifactId}/{filename}
 *   runs/{runId}/context.json
 *   runs/{runId}/dispatches/{dispatchId}/request.json
 *   runs/{runId}/dispatches/{dispatchId}/response.json
 *   runs/{runId}/dispatches/{dispatchId}/result.json
 *   runs/{runId}/reports/final-report.json
 *   runs/{runId}/reports/report.docx
 *   runs/{runId}/reports/report.pdf
 */

// ---------------------------------------------------------------------------
// Artifact keys
// ---------------------------------------------------------------------------

/** Object-storage key for a project-scoped artifact file. */
export function artifactKey(projectId: string, artifactId: string, filename: string): string {
  return `projects/${projectId}/artifacts/${artifactId}/${filename}`;
}

// ---------------------------------------------------------------------------
// Run-scoped keys
// ---------------------------------------------------------------------------

/** Storage key for the assembled AnalysisContextPackage JSON. */
export function runContextKey(runId: string): string {
  return `runs/${runId}/context.json`;
}

/** Storage key for the Run entity record itself. */
export function runRecordKey(runId: string): string {
  return `runs/${runId}/run.json`;
}

// ---------------------------------------------------------------------------
// Dispatch-scoped keys
// ---------------------------------------------------------------------------

/** Storage key for the serialized NormalizedPromptMessage[] sent to a provider. */
export function dispatchRequestKey(runId: string, dispatchId: string): string {
  return `runs/${runId}/dispatches/${dispatchId}/request.json`;
}

/** Storage key for the raw RawProviderResponse JSON returned by a provider. */
export function dispatchResponseKey(runId: string, dispatchId: string): string {
  return `runs/${runId}/dispatches/${dispatchId}/response.json`;
}

/** Storage key for the NormalizedProviderResult JSON derived from a dispatch. */
export function dispatchResultKey(runId: string, dispatchId: string): string {
  return `runs/${runId}/dispatches/${dispatchId}/result.json`;
}

// ---------------------------------------------------------------------------
// Report keys
// ---------------------------------------------------------------------------

/** Storage key for the final structured report JSON. */
export function finalReportJsonKey(runId: string): string {
  return `runs/${runId}/reports/final-report.json`;
}

/** Storage key for the final Markdown report. */
export function finalReportMdKey(runId: string): string {
  return `runs/${runId}/reports/final-report.md`;
}

/** Storage key for the report.docx deliverable. */
export function reportDocxKey(runId: string): string {
  return `runs/${runId}/reports/report.docx`;
}

/** Storage key for the report.pdf deliverable. */
export function reportPdfKey(runId: string): string {
  return `runs/${runId}/reports/report.pdf`;
}

/** Storage key for the SPICE netlist output. */
export function finalCirKey(runId: string): string {
  return `runs/${runId}/reports/final.cir`;
}

/** Storage key for the schematic DOT graph. */
export function schematicDotKey(runId: string): string {
  return `runs/${runId}/reports/schematic.dot`;
}
