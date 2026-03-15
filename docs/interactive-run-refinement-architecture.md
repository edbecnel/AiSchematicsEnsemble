# AI Schematics Ensemble — Interactive Run Refinement Architecture

## 1. Purpose

This document proposes a future feature that allows a user to open an interactive chat after a run completes, ask follow-up questions, correct assumptions, refine inputs, and trigger a rerun that updates the resulting deliverables.

This is not required for the current MVP.

It should be documented now so the open-provider and orchestration architecture leaves a clean path for it later.

---

## 2. Why this is useful

A completed run often reveals issues that are easier to fix iteratively than by starting over manually.

Examples:

- a component was misidentified
- a datasheet or schematic image was missing
- a generated assumption was wrong
- a prompt or run note needs clarification
- a generated SUBCKT model should be replaced, revised, or disabled
- a user wants to ask why a recommendation was made before rerunning

A post-run refinement chat would allow the user to:

- inspect the run in context
- ask targeted questions about results
- propose corrections without rebuilding the run from scratch
- rerun from a modified input set
- receive updated deliverables with full traceability

---

## 3. Product positioning

This should be framed as a **run refinement and rerun workflow**, not as an untracked conversational overlay.

The system should:

- keep the original run immutable
- treat chat-driven changes as explicit proposed edits
- require clear user approval before applying material changes
- create a new revision or child run for each rerun
- preserve provenance between the original run and each revised run

That avoids silent mutation of historical results.

---

## 4. Core user story

A user completes a run and opens a refinement chat from the run details view.

The user can then:

- ask what assumptions were made
- ask why a specific finding appeared
- upload or reference a missing artifact
- correct a component identity or pinout
- change run notes or instructions
- disable or replace a generated SUBCKT model
- request a rerun with the new corrections applied

The system then:

- grounds the chat in the selected run and its artifacts
- proposes a structured change set
- lets the user approve or reject those changes
- executes a new run revision through the same orchestration path
- emits updated deliverables and a comparison to the prior run

---

## 5. Recommended scope

## 5.1 Early scope

The first version should support:

- post-run chat grounded in one completed run
- question-answering about findings, assumptions, missing information, and deliverables
- structured proposed edits to run instructions, attached artifacts, selected providers, or integration toggles
- explicit user approval before rerun
- child-run or revision creation
- updated deliverables plus revision metadata

## 5.2 Deferred scope

Defer these until later:

- free-form autonomous editing of run state without explicit approval
- branching conversation trees across many revisions
- collaborative multi-user editing in the same chat session
- automatic background reruns triggered by chat alone
- general-purpose agent tool use outside the bounded run context

---

## 6. Core design principles

### 6.1 Keep one orchestration path

Reruns triggered from chat should still flow through `executeRun()` or its future equivalent.

The chat feature should not introduce a second execution pipeline.

### 6.2 Keep original runs immutable

A completed run should remain a historical record.

Refinements should produce:

- a new `RunRevision`
- or a new child `Run` linked to the prior run

The updated deliverables should belong to the new revision, not overwrite the original run artifacts in place.

### 6.3 Use structured change sets, not only prose

The assistant should not merely say what to change.

It should produce machine-readable proposed changes such as:

- replace baseline netlist
- add artifact
- remove artifact
- update instructions
- change provider set
- disable generated SUBCKT integration
- replace generated SUBCKT artifact with user-supplied model

### 6.4 Preserve deliverable provenance

Every updated deliverable should record:

- which prior run it was derived from
- what chat-approved changes led to the rerun
- which revision produced it
- which artifacts were added, removed, or replaced

### 6.5 Ground the chat in run data

The chat should be grounded in:

- the original run request
- normalized findings
- synthesis output when present
- generated deliverables
- artifacts and extracted text
- SUBCKT manifests and generated `.lib` files when present
- revision history if the run has already been refined before

---

## 7. Recommended workflow

### 7.1 Read-only post-run Q&A

1. User opens a completed run.
2. User starts a refinement chat.
3. The system loads run context and deliverable references.
4. The user asks explanatory questions.
5. The system answers without changing run state.

### 7.2 Structured change proposal flow

1. User requests a correction or refinement.
2. The system converts that request into a structured proposed change set.
3. The UI shows a reviewable summary of intended changes.
4. The user approves, edits, or rejects the proposal.
5. Approved changes are persisted as a pending revision.

### 7.3 Rerun flow

1. The user requests rerun from the approved revision.
2. The system creates a child run or run revision record.
3. The system reuses the same orchestration path used for normal runs.
4. Updated deliverables are generated for the new revision.
5. The UI shows both the new deliverables and a comparison versus the prior run.

---

## 8. Repository fit and architectural alignment

This repo already has a CLI chat surface in [src/index.ts](src/index.ts), including an interactive transcript model and saved chat artifacts.

That existing chat support is useful precedent, but the future refinement chat should differ in important ways:

- it must be run-scoped rather than generic
- it must be grounded in persisted run artifacts and outputs
- it must produce structured change proposals rather than only free-form answers
- it must rerun via shared orchestration services rather than direct provider calls from a REPL path

The feature should integrate with the broader open-provider plan and the future hosted API/UI rather than remain CLI-only.

---

## 9. Proposed data model additions

Recommended new entities:

- **`RunConversation`**
  - a chat session attached to one run or run revision
  - owns session status, linked run ID, timestamps, and participant metadata

- **`RunConversationTurn`**
  - one user or assistant message in a `RunConversation`
  - may include references to findings, artifacts, deliverables, and proposed changes

- **`RunRevision`**
  - a persisted refinement layer derived from a prior run
  - owns parent run ID, revision number, status, approved change set, and rerun linkage

- **`RunChangeSet`**
  - the structured list of changes proposed or approved for a rerun
  - should be machine-readable and audit-friendly

- **`RunChange`**
  - one atomic edit such as add artifact, update instruction, replace model, or disable integration mode

- **`RunComparison`**
  - a comparison object between two runs or revisions
  - includes deliverable diffs, finding diffs, provider differences, and artifact differences

Suggested change categories:

- `update_instructions`
- `add_artifact`
- `remove_artifact`
- `replace_artifact`
- `replace_baseline_netlist`
- `change_provider_selection`
- `change_model_alias`
- `toggle_synthesis`
- `toggle_subckt_integration`
- `replace_generated_subckt`
- `add_datasheet_url`
- `add_datasheet_pdf`

---

## 10. Orchestration design

Recommended service boundaries:

- `startRunConversation(runId)`
- `appendConversationTurn(conversationId, userMessage)`
- `answerRunQuestion(conversationId)`
- `proposeRunChanges(conversationId)`
- `approveRunChangeSet(changeSetId)`
- `createRunRevision(runId, changeSetId)`
- `executeRunRevision(revisionId)`
- `compareRunOutputs(previousRunId, nextRunId)`

The key rule is:

- `executeRunRevision()` should map into the same lifecycle coordinator as normal runs
- the rerun should still use canonical provider resolution, artifact preprocessing, dispatch, normalization, synthesis, and finalization

---

## 11. Deliverables and revision outputs

Each rerun should emit a new deliverable set rather than mutating the original set.

Recommended deliverables for a refinement-enabled rerun:

```text
runs/{runId}/
  revisions/
    rev-001/
      revision.json
      changeset.json
      conversation.json
      comparison-to-parent.json
      final.md
      final.json
      final.cir
      report.docx
      report.pdf
      subckt_libs/
      subckt-manifest.json
```

Recommended rules:

- the original deliverables remain preserved
- revised deliverables are linked to the parent run
- comparison artifacts should identify what changed
- if SUBCKT artifacts were added, removed, or replaced, the comparison should disclose that explicitly
- updated `.cir` and generated `.lib` artifacts should remain part of deliverable outputs when applicable

---

## 12. UI and API recommendations

### 12.1 Run details UI

Add a future refinement entry point from the run details page:

- “Ask about this run”
- “Propose correction”
- “Rerun with changes”
- “Compare to previous run”

### 12.2 Revision review UI

Before rerunning, show:

- proposed instruction changes
- artifact additions/removals
- provider/model changes
- SUBCKT integration changes
- expected deliverable impact

### 12.3 Hosted API surface

Potential future endpoints:

- `POST /runs/:id/conversations`
- `POST /run-conversations/:id/messages`
- `POST /run-conversations/:id/propose-changes`
- `POST /run-change-sets/:id/approve`
- `POST /runs/:id/revisions`
- `POST /run-revisions/:id/execute`
- `GET /runs/:id/comparisons/:otherRunId`

---

## 13. Security and safety

This workflow should preserve the same safety posture as the main platform.

Requirements:

- user approval before material rerun changes are applied
- audit log of proposed and approved changes
- no raw credential exposure in chat context
- artifact access should respect project and tenant boundaries
- remote artifact fetching should reuse existing SSRF protections
- deliverable replacement should be traceable and reversible

---

## 14. Relationship to SUBCKT generation

This feature is especially valuable for generated SUBCKT workflows.

A refinement chat could let a user:

- ask why a SUBCKT model was generated
- ask which datasheet facts were used
- upload a better datasheet
- replace a generated `.lib` with a user-provided model
- disable auto-generated SUBCKT integration for the rerun
- rerun and regenerate deliverables with the revised model state

This should reuse the same provider, artifact, policy, and deliverable architecture already planned for SUBCKT integration.

---

## 15. Recommended phased delivery

### Phase A — read-only run chat

- run-scoped Q&A
- grounded in findings, deliverables, and artifacts
- no mutation yet

### Phase B — structured change proposals

- chat can propose machine-readable changes
- user reviews and approves changes
- revision records are created

### Phase C — rerun from approved revision

- create child run or revision
- execute via the shared orchestration path
- generate updated deliverables and comparison artifacts

### Phase D — UI and API integration

- run-details chat panel
- revision review UI
- comparison views
- hosted API endpoints

### Phase E — advanced refinement capabilities

- richer comparison summaries
- partial rerun optimization if safe later
- deeper SUBCKT-specific repair and replacement flows

---

## 16. Acceptance criteria

This architecture is successful when:

1. users can ask questions about a completed run in context
2. the system can propose structured refinements rather than only conversational advice
3. users must explicitly approve material changes before rerun
4. reruns use the same orchestration path as normal runs
5. original runs remain immutable
6. updated deliverables are emitted as a new revisioned output set
7. comparison artifacts make deliverable changes visible
8. SUBCKT-related changes and deliverables remain traceable across revisions
9. the design does not require a parallel provider or orchestration architecture
10. the feature can remain deferred until after the current MVP without causing architectural rework

---

## 17. Summary recommendation

Yes, this feature is feasible and is a strong future addition.

The right design is:

- run-scoped instead of generic chat-scoped
- revision-based instead of in-place mutation
- structured-change-driven instead of prose-only
- orchestration-reusing instead of orchestration-bypassing
- comparison- and provenance-friendly instead of overwrite-based

It should be documented now and implemented later, after the main provider/orchestration foundations are stable.
