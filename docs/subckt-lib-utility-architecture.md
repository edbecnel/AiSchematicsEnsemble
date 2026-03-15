# AI Schematics Ensemble — SUBCKT Library Utility Architecture

## 1. Purpose

This document proposes a separate utility for AI Schematics Ensemble that generates an `ngspice`-friendly `.lib` file containing a `.SUBCKT` model for a named component.

Primary goal:

- take a component name or part number
- optionally take a PDF datasheet, a datasheet URL, or other notes
- produce a best-effort, traceable, reviewable `ngspice`-friendly `.SUBCKT` library file that can be used with KiCad symbols when no suitable simulation model is available

This utility should be offered as a separate feature alongside the main ensemble workflow, not as a replacement for it.

It should also be designed so it can be integrated back into the main AI Schematics Ensemble workflow in controlled ways.

---

## 2. Why this is useful

Today, this work is often done manually with an LLM. A dedicated utility would improve:

- repeatability
- traceability
- output formatting consistency
- compatibility with KiCad and `ngspice`
- review workflow for risky/generated simulation models

This is especially valuable for:

- comparators
- logic gates
- optocouplers
- LED drivers
- regulators
- op-amps used in simplified behavioral form
- vendor parts that have no public SPICE macromodel

---

## 3. Product positioning

This should be framed as a **model drafting and normalization utility**, not a guarantee of physical accuracy.

Recommended product language:

- produces a **simulation-oriented approximation** unless a vendor SPICE model is supplied
- may generate a **behavioral macro-model** rather than a transistor-level model
- should always preserve assumptions, simplifications, and validation notes
- should distinguish between:
  - syntax-valid model
  - plausible functional model
  - verified-against-datasheet model

That distinction is important to avoid false confidence.

---

## 4. Core user story

A user provides:

- component name, part number, or short description
- optional datasheet PDF or datasheet URL
- optional package/pinout notes
- optional target behavior notes
- optional preferred abstraction level

The system returns:

- an `ngspice`-friendly `.lib` file with one primary `.SUBCKT`
- pin list and pin mapping summary
- assumptions and simplifications
- warnings and unsupported behaviors
- optional example testbench
- optional KiCad usage notes for attaching the model to a symbol
- when run as part of Ensemble, generated `.lib` files and an updated `.cir` netlist included as report output deliverables, not just described in report text

---

## 5. Recommended scope

## 5.1 MVP scope

The first version should focus on **drafting and validation**, not full automatic trust.

Recommended MVP inputs:

- component identifier
- optional PDF datasheet
- optional datasheet URL
- optional free-text notes
- optional known pin map
- optional desired model style

Recommended MVP outputs:

- `partname.lib`
- `partname.model-report.md`
- `partname.model.json`
- optional `partname.smoke-test.cir`

Recommended integrated-Ensemble outputs:

- `subckt_libs/*.lib`
- updated `final.cir` or `final_with_subckts.cir`
- `subckt-manifest.json`
- report output deliverables that include the generated `.lib` artifacts and the updated emitted `.cir`
- report sections summarizing generated models, assumptions, and validation status

Recommended MVP model classes:

- simple analog behavioral blocks
- comparators
- op-amp macro-model approximations
- regulators
- optocoupler switch/phototransistor abstractions
- MOSFET/diode wrappers when data is sufficient
- digital-ish blocks modeled behaviorally where `ngspice` can support them adequately

## 5.2 Explicit non-goals for early versions

- guaranteed transistor-level fidelity
- arbitrary encrypted or image-only PDF reverse engineering without review
- automatic trust of hallucinated pinouts
- blind replacement of vendor SPICE models when an official model exists
- automatic publishing of generated libraries without human review

---

## 6. Recommended feature set

### 6.1 Input modes

Provide three input modes:

1. **Part-only mode**
   - user provides part number and notes
   - system drafts a model from known behavior plus user constraints

2. **Part + datasheet mode**

- user provides part number and optional PDF or datasheet URL
- preferred mode for better accuracy

3. **Refinement mode**
   - user provides an existing `.lib`/`.cir`/draft model
   - system repairs or upgrades it for `ngspice` and KiCad friendliness

### 6.2 Output modes

Provide three output confidence levels:

1. **Draft behavioral model**
   - fastest
   - good for early experimentation

2. **Datasheet-constrained model**
   - uses extracted limits, pinout, threshold behavior, timing notes
   - preferred default when a datasheet is available

3. **Reviewed/validated model**
   - includes syntax validation and smoke tests
   - may include parameter sanity checks against the datasheet

### 6.3 Utility modes

Recommended separate commands or UI actions:

- `subckt-lib create`
- `subckt-lib refine`
- `subckt-lib validate`
- `subckt-lib explain`

---

## 7. Suggested user workflow

### 7.1 Create flow

1. User selects the SUBCKT utility.
2. User enters component name/part number.
3. User optionally uploads datasheet PDF.
4. User may instead paste a datasheet URL.
5. User optionally enters:
   - known pin order
   - desired abstraction level
   - operating voltage range
   - expected behavior or use case
6. System fetches and stores the referenced datasheet artifact when a URL is provided.
7. System extracts structured component facts.
8. System generates one or more candidate macro-models.
9. System normalizes to one `ngspice`-friendly `.SUBCKT` output.
10. System runs validation.
11. System returns the `.lib`, model report, and optional smoke test.

### 7.2 Refine flow

1. User uploads an existing model.
2. System checks `ngspice` compatibility.
3. System rewrites unsupported syntax if possible.
4. System reconciles pin order and naming.
5. System outputs a cleaned `.lib` plus a change report.

### 7.3 Integrated Ensemble flow

The utility should also support integration into the main AI Schematics Ensemble in two ways.

#### Mode 1: Fully automated integration

1. The Ensemble analyzes the input `.cir`, extracted netlist context, and optionally schematic images.
2. The system detects candidate components or subcircuit instances that appear to be missing usable `ngspice` model information.
3. For each eligible component, the system attempts to resolve identity, pin function, and available supporting artifacts.
4. The SUBCKT utility generates draft models for those candidates.
5. The system validates generated models.
6. Valid or warning-labeled models are written to external `.lib` files.
7. The generated `.lib` files are referenced from the emitted `.cir` output.
8. The report output deliverables include the generated `.lib` files and updated emitted `.cir`, and the report content explains what was auto-generated, what confidence level it had, and what still requires manual review.

#### Mode 2: Partial automation

1. The user selects an option in the UI or config to provide component identifiers that need model generation.
2. The user optionally attaches a PDF datasheet or datasheet URL for each component.
3. The SUBCKT utility generates and validates the models first.
4. The resulting `.lib` files are attached to the run outputs.
5. The Ensemble updates the emitted `.cir` output to reference the generated `.lib` files.
6. The report output deliverables include the generated `.lib` files and updated emitted `.cir`, and the report content includes the generated models and integration notes.

### 7.4 Recommended rollout

Both modes are possible.

Recommended rollout order:

1. ship **partial automation** first
2. add **fully automated detection** later as an opt-in feature

Reason:

- partial automation has a clearer review boundary
- it avoids accidental model generation for the wrong part or symbol
- it is easier to explain in the UI
- it reduces risk of silently patching a netlist with an incorrect model

Fully automated integration should remain gated by confidence thresholds and explicit reporting.

---

## 8. Architecture overview

This should be a separate utility surface that reuses the shared provider, prompt, artifact, and persistence infrastructure from the broader platform.

### 8.1 Logical pipeline

1. **Request intake**
   - component ID

- optional PDF
- optional datasheet URL
- optional notes
- optional pin map
- optional integration target metadata from the Ensemble

2. **Artifact preprocessing**

- validate and fetch remote datasheet when a URL is provided
- extract datasheet text
- identify likely pinout sections
- identify electrical characteristics
- identify absolute maximums / typical operating values

3. **Component fact extraction**
   - normalize into canonical structured facts
   - pin names
   - pin functions
   - supply range
   - thresholds
   - timing or transfer behavior
   - known limitations

4. **Model synthesis**
   - generate candidate `.SUBCKT` model
   - optionally generate more than one abstraction level

5. **Model normalization**
   - normalize node ordering
   - normalize parameter names
   - normalize comments and section headers
   - ensure `ngspice`-friendly syntax

6. **Validation**
   - syntax checks
   - `.SUBCKT`/`.ENDS` consistency
   - pin-count consistency
   - unsupported-element checks
   - optional smoke-test execution in `ngspice`

7. **Packaging**
   - write `.lib`
   - write model report
   - write machine-readable JSON

- write optional KiCad attachment notes
- when integrated, write updated `.cir` references and a model manifest

---

## 9. Core design principle

### Generate structured component facts before generating the model

Do not go straight from PDF text to `.SUBCKT` text.

Use a two-stage approach:

1. extract and normalize component facts
2. synthesize the model from those facts

This is safer because it:

- makes review easier
- reduces prompt drift
- allows fallback if model generation fails
- gives a machine-readable audit trail

---

## 9.5 Integration into the main Ensemble

Yes, this utility can be integrated into the main AI Schematics Ensemble.

The right architectural model is:

- keep SUBCKT generation as a separate internal service/pipeline
- allow the Ensemble orchestrator to call it when configured
- keep the generated model artifacts externalized as `.lib` files
- update the emitted `.cir` output to include or reference those `.lib` files
- always surface generated-model provenance, assumptions, and validation in the final report

### Recommended integration settings

Suggested run setting shape:

```ts
export type SubcktIntegrationMode = "disabled" | "manual" | "auto_detect";

export interface SubcktIntegrationConfig {
  mode: SubcktIntegrationMode;
  components?: Array<{
    refdes?: string;
    symbolName?: string;
    componentName?: string;
    datasheetUrl?: string;
  }>;
  requireValidationPass?: boolean;
  includeLibsInReport?: boolean;
  patchFinalCir?: boolean;
}
```

### Integration policy

- `manual` should be the recommended default for first release
- `auto_detect` should be opt-in
- auto-generated models should never be hidden from the user
- low-confidence generation should be reported, not silently patched in
- generated `.lib` files should remain separate artifacts even if the netlist is patched
- the final report should explicitly list each generated model and its validation status

---

## 10. Canonical internal data model

```ts
export interface SubcktLibRequest {
  componentName: string;
  manufacturer?: string;
  partNumber?: string;
  userNotes?: string;
  datasheetUrl?: string;
  knownPinMap?: Array<{
    pinNumber?: string;
    pinName: string;
    function?: string;
  }>;
  abstractionLevel?: "behavioral" | "macro" | "datasheet_constrained";
  datasheetArtifacts?: AnalysisArtifactRef[];
  existingModelArtifacts?: AnalysisArtifactRef[];
}

export interface ExtractedComponentFact {
  category:
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
  key: string;
  value: string;
  evidence: string[];
  confidence: number;
}

export interface SubcktPinDefinition {
  pinOrder: number;
  pinName: string;
  direction?: "in" | "out" | "inout" | "pwr" | "gnd" | "passive";
  description?: string;
}

export interface SubcktCandidate {
  modelName: string;
  subcktText: string;
  pins: SubcktPinDefinition[];
  assumptions: string[];
  limitations: string[];
  warnings: string[];
  abstractionLevel: "behavioral" | "macro" | "datasheet_constrained";
}

export interface SubcktValidationResult {
  syntaxValid: boolean;
  ngspiceCompatible: boolean;
  pinCountMatches: boolean;
  smokeTestPassed?: boolean;
  issues: Array<{
    severity: "low" | "medium" | "high" | "critical";
    code: string;
    message: string;
  }>;
}

export interface SubcktLibResult {
  modelName: string;
  libText: string;
  pins: SubcktPinDefinition[];
  extractedFacts: ExtractedComponentFact[];
  assumptions: string[];
  limitations: string[];
  validation: SubcktValidationResult;
  suggestedKicadInstructions?: string[];
  smokeTestNetlist?: string;
}

export interface SubcktIntegrationArtifact {
  componentId: string;
  modelName: string;
  libArtifactPath: string;
  validationStatus:
    | "syntax-valid"
    | "syntax-valid-with-warnings"
    | "needs-manual-review"
    | "failed-validation";
}

export interface SubcktIntegrationResult {
  generatedModels: SubcktIntegrationArtifact[];
  updatedCirText?: string;
  manifestJson: string;
  reportSummary: string[];
}
```

---

## 11. Provider strategy

This utility should reuse the same provider architecture being introduced for the broader platform.

### 11.1 Recommended provider roles

Use provider roles rather than one hardcoded vendor:

- **fact extraction model**
  - good with PDFs and structured extraction
- **model synthesis model**
  - strong at code/text generation and following format constraints
- **judge/repair model**
  - checks whether the generated `.SUBCKT` is internally coherent

### 11.2 Suggested routing

- Datasheet extraction: multimodal or strong structured-output model
- Model generation: reasoning-capable text model
- Repair pass: cheaper structured-output or code-oriented model

### 11.3 Constraint

All provider calls should go through the same registry + adapter + policy path as the main ensemble product.

---

## 12. Validation strategy

This utility will be much more useful if it validates generated models before handing them to the user.

### 12.1 Minimum validation

- `.SUBCKT` and `.ENDS` names match
- pin count matches declared pin list
- unsupported or obviously invalid syntax is flagged
- generated model is saved even if warnings exist

### 12.2 Recommended `ngspice` validation

If `ngspice` is available:

- run parse-only or operating-point smoke test
- fail softly with warnings if simulation fails
- preserve generated artifacts for inspection

### 12.3 Validation output policy

Classify output as:

- **syntax-valid**
- **syntax-valid with warnings**
- **needs manual review**
- **failed validation**

Do not silently label a generated model as trustworthy.

---

## 12.5 Datasheet URL handling and safety

Supporting a datasheet URL is useful, but it should be treated as controlled artifact ingestion rather than arbitrary URL fetching.

Recommended rules:

- fetch the remote file server-side and store it as an artifact before extraction
- prefer `https:` URLs
- reject localhost, loopback, RFC1918, link-local, and metadata-service targets
- cap file size and fetch timeouts
- record the source URL in request metadata for traceability
- detect content type and fail safely if the URL does not return a usable PDF or document
- keep the fetched artifact separate from extracted text so review remains possible

If hosted support already has SSRF protections for custom endpoints, the same safety posture should be reused here.

---

## 13. KiCad integration suggestions

This should stay lightweight at first.

### 13.1 MVP integration

Output:

- `.lib` file
- recommended `Spice_Model` value
- recommended `Spice_Netlist_Enabled` notes
- pin-order notes for symbol mapping
- when integrated with Ensemble, a list of `.include` or equivalent netlist attachment notes

### 13.2 Later integration

- helper output for KiCad symbol fields
- simple per-pin mapping assistant
- optional symbol pin order reconciliation against a user-supplied symbol export

### 13.3 Constraint

Do not assume KiCad symbol pin order matches datasheet order. The report should call this out explicitly.

---

## 14. Proposed repository fit

Recommended future structure:

```text
/src
  /subckt
    /index.ts
    /types.ts
    /extract
    /synthesis
    /normalize
    /validate
    /templates
    /kicad
```

Possible commands:

- `node dist/index.js subckt-lib create --component "LMV358" --pdf datasheet.pdf`
- `node dist/index.js subckt-lib create --component "LMV358" --datasheet-url https://example.com/lmv358.pdf`
- `node dist/index.js subckt-lib refine --model existing.lib --pdf datasheet.pdf`
- `node dist/index.js subckt-lib validate --model generated.lib`

Possible UI surface later:

- separate “Generate SUBCKT Lib” page in the local/hosted UI
- upload inputs
- generated `.lib` preview
- validation report
- copyable KiCad setup instructions
- optional integration panel inside Ensemble run setup for manual component entry and datasheet attachment

---

## 15. Suggested output file set

For a run directory or utility output folder:

```text
subckt_runs/{timestamp}_{part}/
  request.json
  datasheet.pdf
  extracted-facts.json
  extracted-facts.md
  candidate-raw.md
  generated.lib
  generated.model.json
  validation.json
  smoke-test.cir
  smoke-test.log
  kicad-notes.md
```

For integrated Ensemble runs:

```text
runs/{runId}/
  final.cir
  subckt_libs/
    part_a.lib
    part_b.lib
  subckt-manifest.json
  report.docx
  report.pdf
```

This mirrors the project’s existing traceability style.

For integrated runs, the generated `.lib` files under `subckt_libs/` and the updated emitted `final.cir` should be treated as report output deliverables/artifacts, not merely intermediate run files.

---

## 16. Safety and quality rules

- Always preserve assumptions and limitations.
- Prefer simpler behavioral models over fake precision.
- Prefer emitting a usable warning-labeled draft over an overconfident fabricated transistor model.
- Flag missing pinout certainty explicitly.
- Flag when the model was derived from partial or low-quality datasheet extraction.
- If an official vendor SPICE model is provided, prefer adapting or validating it instead of regenerating it.
- If integrated into Ensemble, never silently hide that the netlist was patched with generated models.

---

## 17. Recommended phased delivery

### Phase A — local CLI utility MVP

- create from part name + optional PDF
- generate `.lib` + report + JSON
- syntax validation
- optional smoke test

### Phase B — refinement and repair

- improve existing models
- fix unsupported syntax
- reconcile pin order and naming

### Phase C — UI workflow

- separate utility page
- file upload flow
- validation display
- KiCad instructions

### Phase C.5 — integrated Ensemble assistance

- manual component-entry workflow in the run UI
- optional datasheet upload or datasheet URL per component
- generated `.lib` files added to run deliverables and report output deliverables
- updated `.cir` emitted as part of the run outputs and report output deliverables

### Phase D — hosted integration

- store runs/results/artifacts
- expose APIs
- use central provider policy and credentials

### Phase E — full automatic integration

- detect missing or unresolved model candidates from netlist/schematic context
- generate and validate candidate models automatically when enabled
- patch final emitted `.cir` and package external `.lib` files as report output deliverables
- clearly disclose all generated-model interventions in the report

---

## 18. Acceptance criteria

The utility is successful when:

1. a user can enter a component name and optionally a datasheet PDF
2. a user can enter a component name and optionally a datasheet URL instead of a local PDF
3. the utility outputs an `ngspice`-friendly `.lib` with a `.SUBCKT`
4. the output includes explicit assumptions and warnings
5. validation results are shown separately from generation output
6. the utility can run as a separate workflow alongside the main ensemble
7. the utility can optionally integrate into Ensemble runs in manual mode
8. integrated runs can emit generated `.lib` files plus an updated `.cir` as deliverables
9. provider access, BYOK, and custom endpoint support reuse the same shared architecture
10. the output is traceable enough for manual engineering review before use

---

## 19. Summary recommendation

The best version of this feature is not “ask an LLM for a SPICE model.”

It is:

- a structured component-fact extraction pipeline
- followed by constrained model synthesis
- followed by `ngspice` compatibility validation
- with traceable outputs and explicit warnings

That makes it much more credible and useful inside AI Schematics Ensemble.
