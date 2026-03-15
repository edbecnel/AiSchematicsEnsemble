# AI Schematics Ensemble — SUBCKT Library Utility Phased Tasklist

This checklist tracks implementation of the separate SUBCKT library utility.

## Source of truth

- This checklist is the implementation driver for the SUBCKT utility.
- The design reference is [docs/subckt-lib-utility-architecture.md](docs/subckt-lib-utility-architecture.md).

## Phase A — Scope, terminology, and output contract

- [ ] Approve the utility architecture in [docs/subckt-lib-utility-architecture.md](docs/subckt-lib-utility-architecture.md)
- [ ] Confirm MVP scope for create vs refine vs validate flows
- [ ] Define the output contract for:
  - [ ] `generated.lib`
  - [ ] `generated.model.json`
  - [ ] `validation.json`
  - [ ] `kicad-notes.md`
  - [ ] integrated `subckt-manifest.json`
  - [ ] integrated updated `.cir` output
- [ ] Define canonical entities and types:
  - [ ] `SubcktLibRequest`
  - [ ] `ExtractedComponentFact`
  - [ ] `SubcktPinDefinition`
  - [ ] `SubcktCandidate`
  - [ ] `SubcktValidationResult`
  - [ ] `SubcktLibResult`
- [ ] Decide the MVP abstraction levels to support:
  - [ ] `behavioral`
  - [ ] `macro`
  - [ ] `datasheet_constrained`
- [ ] Define validation status vocabulary:
  - [ ] syntax-valid
  - [ ] syntax-valid with warnings
  - [ ] needs manual review
  - [ ] failed validation

### Phase A guardrails

- Do not imply physical accuracy where only a behavioral approximation is available.
- Keep validation status separate from generation success.

## Phase B — Local utility skeleton

- [ ] Add a new utility module area under a path such as `src/subckt/`
- [ ] Add entrypoints for:
  - [ ] `subckt-lib create`
  - [ ] `subckt-lib refine`
  - [ ] `subckt-lib validate`
- [ ] Add CLI argument parsing for component name, PDF path, datasheet URL, notes, existing model path, and output directory
- [ ] Add run/output directory creation for SUBCKT utility runs
- [ ] Add request/result persistence mirroring the main run traceability style

### Phase B guardrails

- Keep this utility separate from the main ensemble run command.
- Reuse shared infrastructure where possible instead of duplicating provider logic.

## Phase C — Artifact ingestion and datasheet preprocessing

- [ ] Accept PDF datasheet input
- [ ] Accept datasheet URL input
- [ ] Accept free-text notes input
- [ ] Accept optional existing `.lib` / `.cir` model input
- [ ] Fetch remote datasheet artifacts from allowed URLs
- [ ] Extract text from PDF artifacts
- [ ] Store extracted text and artifact metadata
- [ ] Persist original source URL in request/artifact metadata when applicable
- [ ] Identify candidate datasheet sections for:
  - [ ] pinout
  - [ ] electrical characteristics
  - [ ] absolute maximum ratings
  - [ ] operating conditions
  - [ ] timing/transfer behavior
- [ ] Add fallback behavior for poor or partial extraction

### Phase C guardrails

- Keep artifact extraction separate from provider-specific prompting.
- Preserve raw extracted text for review.
- Treat datasheet URL support as controlled artifact ingestion, not arbitrary open-proxy behavior.

## Phase C.5 — Datasheet URL safety and fetch policy

- [ ] Restrict datasheet URL fetching to allowed protocols, preferably `https:`
- [ ] Reject localhost, loopback, RFC1918, link-local, and metadata-service targets
- [ ] Add DNS/IP validation before remote fetch
- [ ] Add remote fetch timeout and maximum size limits
- [ ] Validate returned content type and fail safely on non-document responses
- [ ] Store fetch failure reasons for review/debugging

### Phase C.5 guardrails

- Reuse the same SSRF-safety posture as other remote-fetch features where possible.

## Phase D — Structured component fact extraction

- [ ] Add a canonical extracted-facts schema
- [ ] Extract component identity facts
- [ ] Extract pin facts
- [ ] Extract supply and operating-range facts
- [ ] Extract threshold/transfer/timing facts where available
- [ ] Extract limitations and unknowns explicitly
- [ ] Persist extracted facts as JSON and Markdown
- [ ] Add confidence values and evidence references for extracted facts

### Phase D guardrails

- Do not go directly from datasheet text to final `.SUBCKT` output.
- Always retain an intermediate structured-facts stage.

## Phase E — Model synthesis

- [ ] Add prompt/profile templates for SUBCKT generation
- [ ] Generate a first candidate `.SUBCKT` from extracted facts
- [ ] Normalize `.SUBCKT` naming and `.ENDS` naming
- [ ] Normalize comments and assumptions section formatting
- [ ] Preserve declared pin order in a canonical pin list
- [ ] Support at least one behavioral-model template for common analog/digital blocks
- [ ] Support at least one datasheet-constrained generation path
- [ ] Persist raw generation output and normalized candidate output

### Phase E guardrails

- Prefer simpler behavioral models over fabricated precision.
- Do not present a generated transistor-level model unless the source data truly supports it.

## Phase F — ngspice compatibility and model validation

- [ ] Add static validation rules for `.SUBCKT` structure
- [ ] Check `.SUBCKT` / `.ENDS` consistency
- [ ] Check pin-count consistency
- [ ] Check for obviously unsupported or invalid syntax
- [ ] Add warning classification by severity
- [ ] Add optional `ngspice` smoke-test generation
- [ ] If `ngspice` is available, run validation/smoke tests and capture logs
- [ ] Persist `validation.json` and optional smoke-test outputs

### Phase F guardrails

- Do not hide validation failures.
- A model may be generated successfully but still require manual review.

## Phase G — KiCad-oriented output and usability

- [ ] Generate `kicad-notes.md`
- [ ] Include suggested `Spice_Model` value
- [ ] Include symbol pin mapping guidance
- [ ] Include warnings when symbol pin order may differ from datasheet pin order
- [ ] Include example subcircuit invocation syntax where helpful
- [ ] Include example testbench notes for bench or sim verification
- [ ] Include notes for how generated `.lib` files should be referenced from emitted netlists when used in Ensemble integration

### Phase G guardrails

- Do not assume KiCad symbol pin order automatically matches generated SUBCKT pin order.

## Phase H — Shared provider architecture integration

- [ ] Route SUBCKT utility provider calls through the same registry + adapter + policy path as the main platform
- [ ] Reuse canonical artifact and prompt message structures where practical
- [ ] Reuse credential/BYOK/custom-endpoint handling where practical
- [ ] Reuse server-side policy enforcement for hosted execution
- [ ] Define provider roles for:
  - [ ] fact extraction
  - [ ] model synthesis
  - [ ] judge/repair
- [ ] Define integration config shared with Ensemble runs for `disabled`, `manual`, and `auto_detect` modes

### Phase H guardrails

- Do not create a second provider architecture just for the SUBCKT utility.

## Phase H.5 — Ensemble integration, manual-first

- [ ] Add a manual integration mode where the user specifies components that need generated SUBCKT models
- [ ] Allow per-component datasheet PDF or datasheet URL in the Ensemble UI/config
- [ ] Generate required `.lib` files before final run packaging
- [ ] Update the emitted `.cir` output to reference the generated `.lib` files
- [ ] Add integrated report content describing generated models, assumptions, and validation status
- [ ] Emit a `subckt-manifest.json` in run outputs

### Phase H.5 guardrails

- Make manual integration the recommended first integrated mode.
- Keep generated `.lib` artifacts external and reviewable.

## Phase I — Refine and repair workflow

- [ ] Accept an existing `.lib` or `.cir` as input
- [ ] Detect likely compatibility issues
- [ ] Rewrite obvious syntax incompatibilities where safe
- [ ] Reconcile model pin names/order against extracted facts
- [ ] Output a repaired `.lib` plus a change report
- [ ] Add a “why changed” summary to the model report

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

- [ ] Detect candidate symbols/components that appear to be missing usable SUBCKT/model information
- [ ] Define eligibility thresholds for when auto-generation is allowed
- [ ] Generate and validate models automatically when `auto_detect` mode is enabled
- [ ] Skip or warn on low-confidence candidates instead of silently patching them
- [ ] Patch the final emitted `.cir` output and package generated `.lib` files
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

- [ ] Add benchmark cases for representative components
- [ ] Add evaluation cases for pinout correctness and syntax validity
- [ ] Add evaluation cases for datasheet-constrained behavior plausibility
- [ ] Add support for additional component classes as confidence grows
- [ ] Add optional official-model adaptation flow when a vendor model is supplied

### Phase L guardrails

- Expand component-class coverage only after the core create/validate path is stable.

## Completion gates

- [ ] A user can generate a `.SUBCKT` library from a component name and optional PDF or datasheet URL
- [ ] The utility outputs a usable `ngspice`-friendly `.lib`
- [ ] The output includes assumptions, limitations, and warnings
- [ ] Validation results are produced separately from generation output
- [ ] The utility can optionally run smoke tests when `ngspice` is available
- [ ] KiCad-oriented notes are generated for symbol/model hookup
- [ ] The utility reuses the shared provider, policy, and credential architecture
- [ ] The utility can integrate into Ensemble runs in manual mode and emit `.lib` files plus an updated `.cir`
- [ ] Fully automated integration, if enabled, remains opt-in and explicitly disclosed in the report
- [ ] Outputs remain traceable enough for manual engineering review
