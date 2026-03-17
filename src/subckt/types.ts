/**
 * Phase A — SUBCKT Library Utility: canonical types, output contract, and
 * integration configuration shapes.
 *
 * All SUBCKT utility modules import from here. Nothing in this file has
 * runtime dependencies — it is pure type declarations.
 */

import type { ProviderName } from "../types.js";

// ---------------------------------------------------------------------------
// Primary request type
// ---------------------------------------------------------------------------

/** Abstraction level requested by or inferred for the generated model. */
export type SubcktAbstractionLevel = "behavioral" | "macro" | "datasheet_constrained";

/**
 * Weak reference to an artifact that has already been ingested and stored.
 * Used to link request metadata to previously-prepared artifacts.
 */
export interface AnalysisArtifactRef {
  /** Stable artifact identifier (matches ArtifactMetadata.id). */
  artifactId: string;
  /** Human-readable description of how this artifact is being used. */
  role: "datasheet" | "existing_model" | "notes" | "reference";
}

/**
 * Primary input to the SUBCKT utility's create or refine workflow.
 * All fields other than `componentName` are optional.
 */
export interface SubcktLibRequest {
  /** Identifies the SUBCKT run for traceability (auto-generated if omitted). */
  runId?: string;
  /** Human-readable component name or part number. Required. */
  componentName: string;
  /** Optional manufacturer name for disambiguation. */
  manufacturer?: string;
  /** Full part number (may differ from componentName). */
  partNumber?: string;
  /** Free-text notes from the user (behavior, use case, constraints). */
  userNotes?: string;
  /** Datasheet URL; fetched server-side before extraction. */
  datasheetUrl?: string;
  /** Local path to a datasheet PDF. */
  datasheetPdfPath?: string;
  /** Known pin map supplied by the user. */
  knownPinMap?: SubcktPinDefinition[];
  /** Desired model style. Defaults to "behavioral" when no datasheet is given. */
  abstractionLevel?: SubcktAbstractionLevel;
  /** Pre-ingested artifact references. */
  datasheetArtifacts?: AnalysisArtifactRef[];
  /** Pre-ingested existing-model artifact references (for refine mode). */
  existingModelArtifacts?: AnalysisArtifactRef[];
}

// ---------------------------------------------------------------------------
// Extracted component facts (Phase D output)
// ---------------------------------------------------------------------------

export type FactCategory =
  | "identity"
  | "pin"
  | "supply"
  | "threshold"
  | "timing"
  | "transfer"
  | "absolute_max"
  | "recommended_operating"
  | "behavior"
  | "limitation"
  | "unknown";

/**
 * One structured fact extracted from a datasheet or user notes.
 * All SUBCKT model synthesis is driven from a list of these rather than
 * from raw datasheet text, keeping the intermediate stage reviewable.
 */
export interface ExtractedComponentFact {
  /** Semantic category of this fact. */
  category: FactCategory;
  /** Short key identifying the specific property, e.g. "VCC_max". */
  key: string;
  /** The extracted value as a formatted string, e.g. "5.5 V". */
  value: string;
  /** Verbatim text excerpts that were used to extract this fact. */
  evidence: string[];
  /** 0.0–1.0 confidence score. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Pin definition
// ---------------------------------------------------------------------------

/** Direction from the perspective of the model's port. */
export type PinDirection = "in" | "out" | "inout" | "pwr" | "gnd" | "passive";

/**
 * Single pin entry in a .SUBCKT parameter list.
 * `pinOrder` is 1-based.
 */
export interface SubcktPinDefinition {
  pinOrder: number;
  pinName: string;
  direction?: PinDirection;
  description?: string;
}

// ---------------------------------------------------------------------------
// Candidate model (pre-validation Phase E output)
// ---------------------------------------------------------------------------

/**
 * A generated but not yet validated .SUBCKT model candidate.
 * Produced by the synthesis step; consumed by the validation step.
 */
export interface SubcktCandidate {
  /** The .SUBCKT model name (must match .ENDS). */
  modelName: string;
  /** Full raw .SUBCKT text including .ENDS. */
  subcktText: string;
  /** Ordered pin list as declared in the .SUBCKT header. */
  pins: SubcktPinDefinition[];
  /** Explicit assumptions the model makes (printed in report). */
  assumptions: string[];
  /** Known limitations of this approximation (printed in report). */
  limitations: string[];
  /** Pre-validation warnings the generator attached. */
  warnings: string[];
  /** Abstraction level used. */
  abstractionLevel: SubcktAbstractionLevel;
  /** Raw LLM output before normalization (kept for audit). */
  rawGeneratorOutput?: string;
}

// ---------------------------------------------------------------------------
// Validation result (Phase F output)
// ---------------------------------------------------------------------------

export type ValidationStatus =
  | "syntax-valid"
  | "syntax-valid-with-warnings"
  | "needs-manual-review"
  | "failed-validation";

export interface ValidationIssue {
  severity: "low" | "medium" | "high" | "critical";
  code: string;
  message: string;
}

/**
 * Static + optional dynamic (ngspice) validation result for one SubcktCandidate.
 */
export interface SubcktValidationResult {
  status: ValidationStatus;
  syntaxValid: boolean;
  /** Passes: .SUBCKT name == .ENDS name and both are present. */
  endsNameMatches: boolean;
  /** Passes: pin count in header matches SubcktCandidate.pins.length. */
  pinCountMatches: boolean;
  /** Whether ngspice was available and actually ran the smoke test. */
  ngspiceRan: boolean;
  /** True only when ngspice ran AND exited 0. */
  smokeTestPassed?: boolean;
  /** Raw ngspice stdout/stderr for reference. */
  smokeTestLog?: string;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Final library result (Phase F → output)
// ---------------------------------------------------------------------------

/**
 * The end-to-end result of a SUBCKT utility run.
 * All downstream report writing and integration outputs are derived from this.
 */
export interface SubcktLibResult {
  /** Run identifier (matches SubcktLibRequest.runId). */
  runId: string;
  /** Stable model name (normalized from componentName / partNumber). */
  modelName: string;
  /** Full .lib file text, ready to write to disk. */
  libText: string;
  /** Validated pin list in declaration order. */
  pins: SubcktPinDefinition[];
  /** Structured facts that were used to build the model. */
  extractedFacts: ExtractedComponentFact[];
  /** Explicit modelling assumptions. */
  assumptions: string[];
  /** Known limitations. */
  limitations: string[];
  /** Validation result. */
  validation: SubcktValidationResult;
  /** KiCad symbol attachment instructions (Phase G placeholder). */
  suggestedKicadInstructions?: string[];
  /** Optional smoke-test netlist used during ngspice validation. */
  smokeTestNetlist?: string;
  /** ISO-8601 timestamp. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Phase H — Provider role configuration
// ---------------------------------------------------------------------------

/**
 * The functional role a provider call plays within the SUBCKT utility pipeline.
 * Separated so callers can route different steps to different providers/models.
 */
export type SubcktProviderRole = "fact_extraction" | "model_synthesis" | "judge_repair";

export interface SubcktProviderTarget {
  /**
   * Shared provider identifier used by the main provider registry/adapter flow.
   * This can be a built-in provider name today and can later grow to include
   * provider-definition or custom-endpoint IDs without another SUBCKT type rewrite.
   */
  provider: ProviderName;
  /** Optional model override for the selected provider. */
  model?: string;
}

/**
 * Per-role provider/model overrides.
 * Any role that is not specified falls back to the run-level defaults.
 */
export interface SubcktProviderRoleConfig {
  /** Provider + optional model override for the fact-extraction (Phase D) call. */
  factExtraction?: SubcktProviderTarget;
  /** Provider + optional model override for the synthesis (Phase E) call. */
  modelSynthesis?: SubcktProviderTarget;
  /**
   * Provider + optional model override for the judge/repair call.
   * Populated automatically when the refinement workflow uses AI to repair a failed model.
   */
  judgeRepair?: SubcktProviderTarget;
}

// ---------------------------------------------------------------------------
// Integration types (Phase H.5)
// ---------------------------------------------------------------------------

/** How the SUBCKT utility participates in an Ensemble run. */
export type SubcktIntegrationMode = "disabled" | "manual" | "auto_detect";

/**
 * Per-component entry for manual integration mode.
 * The user specifies which components need generated models.
 */
export interface SubcktComponentSpec {
  /** Reference designator in the netlist, e.g. "U1". */
  refdes?: string;
  /** KiCad symbol name, e.g. "Comparator_LMV358". */
  symbolName?: string;
  /** Human-readable component name / part number. */
  componentName: string;
  /** Manufacturer, if known. */
  manufacturer?: string;
  /** Datasheet URL for this component. */
  datasheetUrl?: string;
  /** Local datasheet PDF path. */
  datasheetPdfPath?: string;
  /** Desired abstraction level. */
  abstractionLevel?: SubcktAbstractionLevel;
}

/**
 * Run-level SUBCKT integration configuration passed into executeRun()
 * or the UI run setup.
 */
export interface SubcktIntegrationConfig {
  mode: SubcktIntegrationMode;
  /** Components to process (required in manual mode). */
  components?: SubcktComponentSpec[];
  /** If true, the run fails when validation fails. Defaults to false. */
  requireValidationPass?: boolean;
  /** If true, generated .lib contents are embedded in the report. */
  includeLibsInReport?: boolean;
  /** If true, the emitted .cir is patched to reference generated .lib files. */
  patchFinalCir?: boolean;
  /**
   * Per-role provider configuration.
   * Overrides run-level defaults for each functional step.
   * Uses anthropic by default for all roles when not specified.
   */
  providerRoles?: SubcktProviderRoleConfig;
}

/**
 * Per-component artifact record written to subckt-manifest.json.
 */
export interface SubcktIntegrationArtifact {
  componentId: string;
  modelName: string;
  libArtifactPath: string;
  validationStatus: ValidationStatus;
}

/**
 * The overall result of the SUBCKT integration step within an Ensemble run.
 * Written to `subckt-manifest.json` and used by finalizeRun().
 */
export interface SubcktIntegrationResult {
  generatedModels: SubcktIntegrationArtifact[];
  /** Absolute paths to the generated .lib files (same as libArtifactPath in each artifact). */
  generatedLibPaths: string[];
  /** Final .cir text with .include directives prepended (when patchFinalCir is true). */
  updatedCirText?: string;
  /** Serialized JSON of the manifest (written to subckt-manifest.json). */
  manifestJson: string;
  /** Short summary lines for the report section. */
  reportSummary: string[];
}

// ---------------------------------------------------------------------------
// Utility run record (persisted per SUBCKT utility run)
// ---------------------------------------------------------------------------

export type SubcktRunStatus = "pending" | "running" | "succeeded" | "failed" | "failed-with-warnings";

/**
 * Persisted metadata record for one SUBCKT utility run directory.
 * Written to `request.json` and updated at completion.
 */
export interface SubcktRunRecord {
  runId: string;
  status: SubcktRunStatus;
  request: SubcktLibRequest;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  runDir: string;
  outputs?: {
    libPath?: string;
    modelJsonPath?: string;
    extractedFactsJsonPath?: string;
    extractedFactsMdPath?: string;
    validationJsonPath?: string;
    smokeTestCirPath?: string;
    smokeTestLogPath?: string;
    kicadNotesMdPath?: string;
  };
}
