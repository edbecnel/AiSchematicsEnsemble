# AI Schematics Ensemble — Interactive Run Refinement Tasklist

This checklist tracks a future feature for post-run interactive chat, structured refinement, and rerun-driven deliverable updates.

## Source of truth

- This checklist is the implementation driver for the interactive run refinement feature.
- The design reference is [interactive-run-refinement-architecture.md](interactive-run-refinement-architecture.md).

## Related documents

- Main provider/orchestration design: [open-provider-architecture-plan.md](open-provider-architecture-plan.md)
- Main provider migration checklist: [open-provider-phased-tasklist.md](open-provider-phased-tasklist.md)
- SUBCKT utility architecture: [subckt-lib-utility-architecture.md](subckt-lib-utility-architecture.md)
- SUBCKT utility checklist: [subckt-lib-utility-tasklist.md](subckt-lib-utility-tasklist.md)

## Preconditions

Do not start this feature until these foundations are stable:

- shared provider registry and adapter flow
- canonical artifact and deliverable persistence
- top-level `executeRun()` orchestration path
- run/result APIs and run details UI basics

This feature is intentionally deferred until after the main MVP foundation.

## Phase A — Scope and vocabulary

- [ ] Approve the feature architecture in [interactive-run-refinement-architecture.md](interactive-run-refinement-architecture.md)
- [ ] Confirm this feature is post-MVP / deferred work
- [ ] Define whether refinement creates child runs, run revisions, or both
- [ ] Define the first supported refinement actions:
  - [ ] ask questions about findings
  - [ ] update instructions
  - [ ] add artifact
  - [ ] replace artifact
  - [ ] change provider selection
  - [ ] request rerun
- [ ] Confirm that original completed runs remain immutable
- [ ] Confirm that updated deliverables belong to the new revision output set

### Phase A guardrails

- Do not design this as in-place mutation of an existing completed run.
- Do not start with autonomous edits that bypass user approval.

## Phase B — Canonical entities and persistence

- [ ] Add canonical entities for:
  - [ ] `RunConversation`
  - [ ] `RunConversationTurn`
  - [ ] `RunRevision`
  - [ ] `RunChangeSet`
  - [ ] `RunChange`
  - [ ] `RunComparison`
- [ ] Define revision status vocabulary
- [ ] Define conversation status vocabulary
- [ ] Define change approval status vocabulary
- [ ] Add persistence interfaces for conversations, revisions, change sets, and comparisons
- [ ] Link revisions to parent runs without breaking existing run retrieval

### Phase B guardrails

- Keep revision objects separate from base run records.
- Preserve auditability of who approved which changes.

## Phase C — Run-scoped chat context

- [ ] Build a run-chat context assembler from:
  - [ ] original run request
  - [ ] artifacts and extracted text
  - [ ] normalized findings
  - [ ] synthesis result when present
  - [ ] deliverable references
  - [ ] SUBCKT artifacts/manifests when present
- [ ] Add read-only question-answering over completed runs
- [ ] Add citation/reference support back to run artifacts and findings where practical
- [ ] Persist chat transcripts and turn metadata

### Phase C guardrails

- Keep chat grounded in run data rather than generic free-form memory.
- Do not let the chat fabricate changes that are not represented in run state.

## Phase D — Structured change proposals

- [ ] Add machine-readable `RunChange` schema
- [ ] Add change categories for instructions, artifacts, provider selection, and SUBCKT integration
- [ ] Add assistant-side proposal generation from user messages
- [ ] Add reviewable change-set summaries
- [ ] Add explicit user approve/reject/edit flow
- [ ] Persist both proposed and approved versions of change sets

### Phase D guardrails

- Do not treat assistant prose as the source of truth for reruns.
- Require a structured approved change set before execution.

## Phase E — Revision creation and rerun orchestration

- [ ] Add `createRunRevision()`
- [ ] Add revision-to-run input materialization logic
- [ ] Map approved change sets into rerun-ready input state
- [ ] Add `executeRunRevision()`
- [ ] Route revision reruns through the same provider, artifact, dispatch, normalization, synthesis, and finalization path as normal runs
- [ ] Preserve partial-success behavior for refinement reruns
- [ ] Record linkage between parent run and revision run

### Phase E guardrails

- Do not create a separate rerun execution engine.
- Reuse `executeRun()` and related orchestration services.

## Phase F — Deliverable versioning and comparison

- [ ] Define revision deliverable layout
- [ ] Emit updated deliverables for each approved rerun revision
- [ ] Preserve original deliverables unchanged
- [ ] Add `comparison-to-parent.json` or equivalent comparison artifact
- [ ] Add finding diffs, deliverable diffs, and artifact diffs where practical
- [ ] Include explicit diff/reporting for updated `.cir` and generated `.lib` outputs when present
- [ ] Include explicit diff/reporting for SUBCKT manifest changes when present

### Phase F guardrails

- Do not overwrite original run deliverables.
- Keep comparison artifacts machine-readable and human-reviewable.

## Phase G — SUBCKT-aware refinement

- [ ] Allow chat-driven requests to:
  - [ ] replace generated `.lib` artifacts
  - [ ] disable SUBCKT integration for a rerun
  - [ ] add datasheet PDF or datasheet URL for a rerun
  - [ ] request SUBCKT regeneration for a specific component
- [ ] Ensure revised `.cir`, `.lib`, and manifest outputs flow into the new revision deliverables
- [ ] Ensure report output deliverables remain aligned with the revised SUBCKT state

### Phase G guardrails

- Keep SUBCKT refinement on the same provider/policy/artifact path as the base workflow.

## Phase H — Hosted API and UI

- [ ] Add run conversation APIs
- [ ] Add change-set approval APIs
- [ ] Add run revision creation/execution APIs
- [ ] Add comparison retrieval APIs
- [ ] Add run-details chat panel UI
- [ ] Add revision review/approve UI
- [ ] Add rerun action UI
- [ ] Add comparison view between parent and revised runs

### Phase H guardrails

- UI must consume stable backend contracts.
- Do not let UI invent change-set structure ad hoc.

## Phase I — Safety, audit, and operations

- [ ] Audit log proposed change creation
- [ ] Audit log change approval/rejection
- [ ] Audit log revision execution
- [ ] Add revision/conversation correlation IDs
- [ ] Add rate limits or budget controls for repeated reruns
- [ ] Ensure credential redaction in conversation context and logs

### Phase I guardrails

- Treat refinement chat as a privileged run-modification surface and log it accordingly.

## Phase J — Advanced enhancements

- [ ] Add richer explanation modes for why findings changed across revisions
- [ ] Add optional assistant-suggested minimal rerun scope if safe later
- [ ] Add branching revision trees if needed later
- [ ] Add collaboration/multi-review workflow only if product needs it later

### Phase J guardrails

- Keep advanced collaboration and optimization features out of the initial rollout.

## Completion gates

- [ ] Users can open a run-scoped chat after a run completes
- [ ] Users can ask grounded questions about findings, assumptions, artifacts, and deliverables
- [ ] The system can generate structured change sets for rerun candidates
- [ ] Users must approve material changes before rerun
- [ ] Reruns create revisioned output sets instead of mutating original runs
- [ ] Updated deliverables are generated and linked to the parent run
- [ ] Comparisons make changes across revisions visible
- [ ] SUBCKT-related revised outputs remain traceable in revised deliverables
- [ ] The feature reuses the same provider, artifact, policy, and orchestration architecture
- [ ] The feature can be added later without architectural reset
