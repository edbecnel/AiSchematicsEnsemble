/**
 * src/subckt/index.ts — public API for the SUBCKT utility.
 *
 * Internal consumers import from this barrel file rather than reaching into
 * sub-modules directly, so the public surface is easy to find and stable
 * across internal refactors.
 */

// --- Types ---
export type {
  SubcktLibRequest,
  ExtractedComponentFact,
  SubcktPinDefinition,
  SubcktCandidate,
  ValidationIssue,
  SubcktValidationResult,
  SubcktLibResult,
  SubcktRunRecord,
  SubcktRunStatus,
  SubcktComponentSpec,
  SubcktIntegrationConfig,
  SubcktIntegrationResult,
  SubcktIntegrationArtifact,
  ValidationStatus,
  // Phase H
  SubcktProviderRole,
  SubcktProviderAccessGuard,
  SubcktProviderAccessRequest,
  SubcktProviderRoleConfig,
} from "./types.js";

// --- Run directory ---
export { makeSubcktRunDir } from "./runDir.js";

// --- URL safety ---
export {
  checkDatasheetUrl,
  fetchDatasheetUrl,
  isAcceptableDatasheetContentType,
  UrlSafetyError,
} from "./urlSafety.js";
export type { UrlCheckOutcome, FetchDatasheetOutcome } from "./urlSafety.js";

// --- Artifact ingestion ---
export {
  ingestArtifacts,
  identifySections,
  persistIngestResults,
} from "./ingest.js";
export type {
  IngestArtifactsInput,
  IngestArtifactsResult,
  IngestedArtifact,
  IdentifiedSection,
} from "./ingest.js";

// --- Fact extraction ---
export { extractComponentFacts } from "./extract/factExtractor.js";
export type { ExtractFactsInput, ExtractFactsResult } from "./extract/factExtractor.js";

// --- Model synthesis ---
export { synthesizeSubcktModel } from "./synthesis/synthesize.js";
export type { SynthesizeModelInput, SynthesizeModelResult } from "./synthesis/synthesize.js";

// --- Validation ---
export {
  validateSubcktCandidate,
  validateLibText,
} from "./validate/validate.js";
export type { ValidateSubcktOptions } from "./validate/validate.js";

// --- Create flow ---
export { createSubckt } from "./create.js";
export type { CreateSubcktInput, CreateSubcktOutput } from "./create.js";

// --- Refine flow ---
export { refineSubckt } from "./refine.js";
export type { RefineSubcktInput, RefineSubcktOutput } from "./refine.js";

// --- Integration (Phase H.5) ---
export { runSubcktIntegration } from "./integration/integrate.js";
export type { RunSubcktIntegrationArgs, RunSubcktIntegrationOutput } from "./integration/integrate.js";
export { patchCirWithIncludes, patchResult } from "./integration/patchCir.js";
export type { IncludeDirective } from "./integration/patchCir.js";

// --- Repair modules (Phase I) ---
export { rewriteSubcktSyntax, hoistModelStatements } from "./repair/syntaxRewriter.js";
export type {
  SyntaxRewriteResult,
  RewriteChange,
} from "./repair/syntaxRewriter.js";

export {
  parsePinsFromSubcktHeader,
  reconcilePins,
  formatPinReconcileReport,
} from "./repair/pinReconciler.js";
export type {
  PinReconcileResult,
  PinMismatch,
} from "./repair/pinReconciler.js";

export { buildChangeReport } from "./repair/changeReport.js";
export type { ChangeReportInput } from "./repair/changeReport.js";

// --- Auto-detect (Phase J.5) ---
export { detectMissingSubckts, parseXElements, collectDeclaredSubckts } from "./autoDetect/detector.js";
export type {
  MissingSubcktCandidate,
  DetectMissingSubcktsResult,
  DetectionConfidence,
} from "./autoDetect/detector.js";

// --- Benchmark cases (Phase L) ---
export { BENCHMARK_CASES, findBenchmarkCase, casesByLevel } from "./benchmark/cases.js";
export type { BenchmarkCase } from "./benchmark/cases.js";
