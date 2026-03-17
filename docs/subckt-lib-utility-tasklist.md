# AI Schematics Ensemble — SUBCKT Library Utility Phased Tasklist

This checklist tracks implementation of the separate SUBCKT library utility.

## Source of truth

- This checklist is the implementation driver for the SUBCKT utility.
- The design reference is [docs/subckt-lib-utility-architecture.md](docs/subckt-lib-utility-architecture.md).

## Related documents

- Main provider migration checklist: [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md)
- Interactive refinement checklist: [docs/interactive-run-refinement-tasklist.md](docs/interactive-run-refinement-tasklist.md)
- Merged cross-tasklist priority queue: [docs/merged-cross-tasklist-priority-queue.md](docs/merged-cross-tasklist-priority-queue.md)

## Phase A — Scope, terminology, and output contract

- [x] Approve the utility architecture in [docs/subckt-lib-utility-architecture.md](docs/subckt-lib-utility-architecture.md)
- [x] Confirm MVP scope for create vs refine vs validate flows
- [x] Define the output contract for:
  - [x] `generated.lib`
  - [x] `generated.model.json`
  - [x] `validation.json`
  - [x] `kicad-notes.md`
  - [ ] integrated generated `.lib` report deliverables
  - [ ] integrated `subckt-manifest.json`
  - [ ] integrated updated `.cir` output
  - [ ] report packaging rules for generated `.lib` files plus updated emitted `.cir`
- [x] Define canonical entities and types:
  - [x] `SubcktLibRequest`
  - [x] `ExtractedComponentFact`
  - [x] `SubcktPinDefinition`
  - [x] `SubcktCandidate`
  - [x] `SubcktValidationResult`
  - [x] `SubcktLibResult`
- [x] Decide the MVP abstraction levels to support:
  - [x] `behavioral`
  - [x] `macro`
  - [x] `datasheet_constrained`
- [x] Define validation status vocabulary:
  - [x] syntax-valid
  - [x] syntax-valid with warnings
  - [x] needs manual review
  - [x] failed validation

### Phase A guardrails

- Do not imply physical accuracy where only a behavioral approximation is available.
- Keep validation status separate from generation success.

## Phase B — Local utility skeleton

- [x] Add a new utility module area under a path such as `src/subckt/`
- [x] Add entrypoints for:
  - [x] `subckt-lib create`
  - [x] `subckt-lib refine`
  - [x] `subckt-lib validate`
- [x] Add CLI argument parsing for component name, PDF path, datasheet URL, notes, existing model path, and output directory
- [x] Add run/output directory creation for SUBCKT utility runs
- [x] Add request/result persistence mirroring the main run traceability style

### Phase B guardrails

- Keep this utility separate from the main ensemble run command.
- Reuse shared infrastructure where possible instead of duplicating provider logic.

## Phase C — Artifact ingestion and datasheet preprocessing

- [x] Accept PDF datasheet input
- [x] Accept datasheet URL input
- [x] Accept free-text notes input
- [x] Accept optional existing `.lib` / `.cir` model input
- [x] Fetch remote datasheet artifacts from allowed URLs
- [x] Extract text from PDF artifacts
- [x] Store extracted text and artifact metadata
- [x] Persist original source URL in request/artifact metadata when applicable
- [x] Identify candidate datasheet sections for:
  - [x] pinout
  - [x] electrical characteristics
  - [x] absolute maximum ratings
  - [x] operating conditions
  - [x] timing/transfer behavior
- [x] Add fallback behavior for poor or partial extraction

### Phase C guardrails

- Keep artifact extraction separate from provider-specific prompting.
- Preserve raw extracted text for review.
- Treat datasheet URL support as controlled artifact ingestion, not arbitrary open-proxy behavior.

## Phase C.5 — Datasheet URL safety and fetch policy

- [x] Restrict datasheet URL fetching to allowed protocols, preferably `https:`
- [x] Reject localhost, loopback, RFC1918, link-local, and metadata-service targets
- [x] Add DNS/IP validation before remote fetch
- [x] Add remote fetch timeout and maximum size limits
- [x] Validate returned content type and fail safely on non-document responses
- [x] Store fetch failure reasons for review/debugging

### Phase C.5 guardrails

- Reuse the same SSRF-safety posture as other remote-fetch features where possible.

## Phase D — Structured component fact extraction

- [x] Add a canonical extracted-facts schema
- [x] Extract component identity facts
- [x] Extract pin facts
- [x] Extract supply and operating-range facts
- [x] Extract threshold/transfer/timing facts where available
- [x] Extract limitations and unknowns explicitly
- [x] Persist extracted facts as JSON and Markdown
- [x] Add confidence values and evidence references for extracted facts

### Phase D guardrails

- Do not go directly from datasheet text to final `.SUBCKT` output.
- Always retain an intermediate structured-facts stage.

## Phase E — Model synthesis

- [x] Add prompt/profile templates for SUBCKT generation
- [x] Generate a first candidate `.SUBCKT` from extracted facts
- [x] Normalize `.SUBCKT` naming and `.ENDS` naming
- [x] Normalize comments and assumptions section formatting
- [x] Preserve declared pin order in a canonical pin list
- [x] Support at least one behavioral-model template for common analog/digital blocks
- [x] Support at least one datasheet-constrained generation path
- [x] Persist raw generation output and normalized candidate output

### Phase E guardrails

- Prefer simpler behavioral models over fabricated precision.
- Do not present a generated transistor-level model unless the source data truly supports it.

## Phase F — ngspice compatibility and model validation

- [x] Add static validation rules for `.SUBCKT` structure
- [x] Check `.SUBCKT` / `.ENDS` consistency
- [x] Check pin-count consistency
- [x] Check for obviously unsupported or invalid syntax
- [x] Add warning classification by severity
- [x] Add optional `ngspice` smoke-test generation
- [x] If `ngspice` is available, run validation/smoke tests and capture logs
- [x] Persist `validation.json` and optional smoke-test outputs

### Phase F guardrails

- Do not hide validation failures.
- A model may be generated successfully but still require manual review.

## Phase G — KiCad-oriented output and usability

- [x] Generate `kicad-notes.md`
- [x] Include suggested `Spice_Model` value
- [x] Include symbol pin mapping guidance
- [x] Include warnings when symbol pin order may differ from datasheet pin order
- [x] Include example subcircuit invocation syntax where helpful
- [x] Include example testbench notes for bench or sim verification
- [x] Include notes for how generated `.lib` files should be referenced from emitted netlists when used in Ensemble integration

### Phase G guardrails

- Do not assume KiCad symbol pin order automatically matches generated SUBCKT pin order.

## Phase H — Shared provider architecture integration

- [x] Route SUBCKT utility provider calls through the same registry + adapter + policy path as the main platform
- [x] Reuse canonical artifact and prompt message structures where practical
- [x] Reuse credential/BYOK/custom-endpoint handling where practical
- [ ] Reuse server-side policy enforcement for hosted execution
- [x] Define provider roles for:
  - [x] fact extraction
  - [x] model synthesis
  - [x] judge/repair
- [x] Define integration config shared with Ensemble runs for `disabled`, `manual`, and `auto_detect` modes

### Phase H guardrails

- Do not create a second provider architecture just for the SUBCKT utility.

## Phase H.5 — Ensemble integration, manual-first

- [x] Add a manual integration mode where the user specifies components that need generated SUBCKT models
- [x] Allow per-component datasheet PDF or datasheet URL in the Ensemble UI/config
- [x] Generate required `.lib` files before final run packaging
- [x] Update the emitted `.cir` output to reference the generated `.lib` files
- [x] Include the generated `.lib` files and updated emitted `.cir` as report output deliverables, not only as side artifacts
- [x] Add integrated report content describing generated models, assumptions, and validation status
- [x] Emit a `subckt-manifest.json` in run outputs

### Phase H.5 guardrails

- Make manual integration the recommended first integrated mode.
- Keep generated `.lib` artifacts external and reviewable.

## Phase I — Refine and repair workflow

- [x] Accept an existing `.lib` or `.cir` as input
- [x] Detect likely compatibility issues
- [x] Rewrite obvious syntax incompatibilities where safe
- [x] Reconcile model pin names/order against extracted facts
- [x] Output a repaired `.lib` plus a change report
- [x] Add a "why changed" summary to the model report

### Phase I guardrails

- Preserve the original uploaded model alongside the repaired version.

## Phase J — UI workflow

- [ ] Add a separate SUBCKT utility page in the local UI
- [ ] Add create/refine/validate form flows
- [ ] Add upload UI for datasheets and existing models
- [ ] Add preview for generated `.lib`
- [ ] Add validation status display
- [ ] Add downloadable artifacts and KiCad notes

### Phase J guardrails

- Build UI on top of stable utility APIs or service contracts, not ad hoc component-defined shapes.

## Phase J.5 — Fully automated Ensemble integration

- [x] Detect candidate symbols/components that appear to be missing usable SUBCKT/model information
- [x] Define eligibility thresholds for when auto-generation is allowed
- [x] Generate and validate models automatically when `auto_detect` mode is enabled
- [x] Skip or warn on low-confidence candidates instead of silently patching them
- [ ] Patch the final emitted `.cir` output and package generated `.lib` files
- [ ] Include the patched emitted `.cir` and generated `.lib` files in report output deliverables for auto-generated interventions
- [ ] Include explicit report disclosure for every auto-generated model intervention

### Phase J.5 guardrails

- Keep fully automated integration opt-in.
- Never silently modify the final netlist without reporting the change.

## Phase K — Hosted/API integration

- [ ] Add utility run APIs for create/refine/validate actions
- [ ] Add artifact persistence for datasheets, extracted facts, generated models, and validation results
- [ ] Add run history and detail APIs for utility runs
- [ ] Reuse provider access policy and credential controls
- [ ] Reuse audit logging and observability patterns

### Phase K guardrails

- Keep hosted utility runs aligned with the same persistence and policy standards as the main product.

## Phase L — Quality, benchmarks, and expansion

- [x] Add benchmark cases for representative components
- [ ] Add evaluation cases for pinout correctness and syntax validity
- [ ] Add evaluation cases for datasheet-constrained behavior plausibility
- [ ] Add support for additional component classes as confidence grows
- [ ] Add optional official-model adaptation flow when a vendor model is supplied

### Phase L guardrails

- Expand component-class coverage only after the core create/validate path is stable.

## Completion gates

- [x] A user can generate a `.SUBCKT` library from a component name and optional PDF or datasheet URL
- [x] The utility outputs a usable `ngspice`-friendly `.lib`
- [x] The output includes assumptions, limitations, and warnings
- [x] Validation results are produced separately from generation output
- [x] The utility can optionally run smoke tests when `ngspice` is available
- [x] KiCad-oriented notes are generated for symbol/model hookup
- [x] The utility reuses the shared provider, policy, and credential architecture
- [x] The utility can integrate into Ensemble runs in manual mode and emit `.lib` files plus an updated `.cir`
- [x] When integrated into Ensemble runs, the generated `.lib` files and updated emitted `.cir` are part of report output deliverables
- [ ] Fully automated integration, if enabled, remains opt-in and explicitly disclosed in the report
- [x] Outputs remain traceable enough for manual engineering review
