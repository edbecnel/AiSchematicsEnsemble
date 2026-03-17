# AI Schematics Ensemble — Open Provider Phased Tasklist

This checklist is the active implementation driver for the open-provider migration.

## Source of truth

- This checklist is the implementation driver.
- The design reference is [docs/open-provider-architecture-plan.md](docs/open-provider-architecture-plan.md).

## How to use this plan

- Keep local/dev compatibility throughout the migration.
- Treat backend contracts as the source of truth for UI work.
- Keep provider access policy centralized and enforced server-side.
- Keep custom endpoint support tightly validated so the backend does not become an open proxy.
- Settle the Gemini adapter strategy early and avoid letting native and OpenAI-compatible paths drift in parallel without a deliberate reason.
- Keep the related SUBCKT utility aligned with the same provider, artifact, policy, and observability architecture.

## Related documents

- Main design reference: [docs/open-provider-architecture-plan.md](docs/open-provider-architecture-plan.md)
- Phase 0 regression/defaults baseline: [open-provider-phase0-baseline.md](open-provider-phase0-baseline.md)
- SUBCKT utility design: [docs/subckt-lib-utility-architecture.md](docs/subckt-lib-utility-architecture.md)
- SUBCKT utility implementation checklist: [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md)
- Merged cross-tasklist priority queue: [docs/merged-cross-tasklist-priority-queue.md](docs/merged-cross-tasklist-priority-queue.md)

## Revised execution order

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 4.5
7. Phase 5
8. Phase 6
9. Phase 7
10. Phase 7.5
11. Phase 8
12. Phase 8.5
13. Phase 9
14. Phase 10
15. Phase 11
16. Phase 12
17. Phase 13

## Recommended first 10 implementation steps

These are the recommended first implementation steps across the main open-provider plan and the related SUBCKT utility plan.

1. [x] Finalize the Phase 0 architecture baseline and canonical entity vocabulary in [docs/open-provider-architecture-plan.md](docs/open-provider-architecture-plan.md)
2. [x] Freeze current behavior with regression scenarios for OpenAI, Anthropic, Gemini, and xAI so refactors can be validated safely
3. [x] Extract shared canonical types and schemas into reusable modules, including `DispatchRequest`, `RawProviderResponse`, `NormalizedPromptMessage`, `NormalizedAttachment`, `NormalizedFinding`, and `SynthesisOutput`
4. [x] Create the shared provider adapter contract plus `getProviderAdapter(protocol)`
5. [x] Settle the Gemini adapter strategy before broader provider refactors
6. [x] Implement the first protocol adapters: `OpenAICompatibleAdapter`, `AnthropicNativeAdapter`, and `AnthropicCompatibleAdapter`
7. [x] Create the provider registry, model catalog, stable model aliases, and canonical resolved-provider shape
8. [x] Implement the dispatch and normalization foundation, including `DispatchStatus`, normalized provider errors, raw-result persistence, and structured/fallback parsing
9. [x] Implement the prompt/artifact pipeline plus persistence foundations, including reusable analysis-context structure, storage abstractions, and hosted API skeletons
10. [x] Implement the end-to-end orchestration path centered on `executeRun()` before starting major UI work or deeper SUBCKT utility coding

### What to start immediately after the first 10

- Begin [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md) Phase A through Phase F once the shared provider, artifact, persistence, and orchestration foundation is in place.
- Defer SUBCKT integration into Ensemble runs until the main orchestration and provider/policy path is stable.

## Phase 0 — Architecture alignment and baseline hardening

- [x] Approve the target architecture in [docs/open-provider-architecture-plan.md](docs/open-provider-architecture-plan.md)
- [x] Confirm MVP scope vs deferred items
- [x] Freeze current provider behavior with regression test scenarios for OpenAI, Anthropic, Gemini, and xAI in [open-provider-phase0-baseline.md](open-provider-phase0-baseline.md)
- [x] Document current provider/model defaults from [src/index.ts](src/index.ts) and [src/util/runConfig.ts](src/util/runConfig.ts) in [open-provider-phase0-baseline.md](open-provider-phase0-baseline.md)
- [x] Accept breaking changes to legacy outputs for this migration for `final.md`, `final.cir`, and `final.json`, while preserving all information currently emitted in `report.docx`
- [x] Defer automated migration rules/support for existing config files and saved run folders unless a later requirement makes them necessary
- [x] Approve the initial canonical internal entity definitions (Phase 0 vocabulary only; not code implementation) in [open-provider-architecture-plan.md](open-provider-architecture-plan.md#phase0-canonical-entities):
  - [x] `ProviderDefinition`
  - [x] `UserProviderCredential`
  - [x] `Run`
  - [x] `RunDispatch`
  - [x] `RunResult`
  - [x] `NormalizedFinding`
  - [x] `SynthesisResult`

### Phase 0 guardrails

- Do not begin major UI work or hosted API refactors before canonical entities and lifecycle terminology are agreed.

## Phase 1 — Core provider abstraction inside current repo

- [x] Replace the narrow `ProviderName` pattern in [src/types.ts](src/types.ts) with extensible provider/protocol types
- [x] Extract shared types and schemas into reusable packages/modules now, not later
- [x] Introduce `ProviderProtocol`, `BillingMode`, `ProviderCapabilities`, and resolved-provider types
- [x] Add `ModelDefinition` and `ModelAlias` types
- [ ] Create shared canonical types now:
  - [x] `DispatchRequest`
  - [x] `RawProviderResponse`
  - [x] `NormalizedPromptMessage`
  - [x] `NormalizedAttachment`
  - [x] `NormalizedFinding`
  - [x] `SynthesisOutput`
- [x] Create a provider adapter contract in a shared core module
- [x] Add a shared adapter interface file that all protocol adapters implement
- [x] Add a provider adapter resolver: `getProviderAdapter(protocol)`
- [x] Create `OpenAICompatibleAdapter`
- [x] Create `AnthropicNativeAdapter`
- [x] Create `AnthropicCompatibleAdapter`
- [x] Settle the Gemini adapter strategy:
  - [x] decide whether Gemini is routed through a Gemini-native adapter (`gemini-native` protocol using `@google/genai` SDK; not the OpenAI-compatible path)
  - [x] or through the OpenAI-compatible adapter path (not chosen; native SDK is preferred for full feature access)
- [x] Refactor existing provider modules under a common dispatch contract
- [x] Remove orchestration-time provider switch logic from [src/index.ts](src/index.ts) and related run paths

### Phase 1 guardrails

- Do not allow Gemini-native and OpenAI-compatible Gemini paths to evolve in parallel unless there is a deliberate reason.

## Phase 2 — Provider registry and model catalog

- [x] Create a provider registry module for built-in provider definitions
- [x] Create a model catalog for concrete model IDs
- [x] Add stable model aliases such as `openai.flagship`, `anthropic.flagship`, `judge.default`
- [x] Add capability metadata for each built-in model
- [x] Add synthesis-eligible and judge-eligible flags
- [x] Add pricing metadata placeholders even if billing is not yet active
- [x] Add environment-key mapping rules for platform-owned local/dev credentials
- [x] Add config migration support so existing `openaiModel`, `claudeModel`, etc. still resolve cleanly
- [x] Add `billingMode` and `providerScope` explicitly to provider definitions:
  - [ ] `platform_free`
  - [x] `platform_paid`
  - [ ] `user_byok`
  - [ ] `custom_endpoint`
- [x] Add `isFreeEligible` and `isPremiumOnly` to provider definitions
- [x] Add one canonical resolved-provider shape used by dispatch with:
  - [x] protocol
  - [x] base URL
  - [x] model
  - [x] auth header info
  - [x] capabilities
  - [x] billing mode

### Phase 2 guardrails

- Keep aliases simple at first.
- Do not overbuild alias routing before provider resolution rules are stable.

## Phase 3 — Dispatch pipeline and normalization

- [x] Introduce a canonical `DispatchRequest`
- [x] Introduce a canonical `RawProviderResponse`
- [x] Introduce a canonical normalized result schema
- [x] Add `DispatchStatus` enum:
  - [x] `queued`
  - [x] `running`
  - [x] `succeeded`
  - [x] `failed`
  - [x] `timed_out`
  - [x] `cancelled`
- [x] Add a normalized error object for provider failures
- [x] Persist raw provider outputs in a provider-agnostic structure
- [x] Extract text from each provider response using the adapter contract
- [x] Add a structured result parser and a fallback tagged-section parser
- [x] Normalize every provider result into summary, findings, assumptions, missing info, and recommended actions
- [x] Add parse-quality scoring for normalized outputs
- [x] Add confidence-scoring hooks now, even if consensus boosting comes later
- [x] Preserve partial results when one or more providers fail
- [x] Add consistent error categories for auth, timeout, malformed output, unsupported attachments, and provider unavailability

### Phase 3 guardrails

- Do not let provider-specific parsing logic leak outside adapters and normalizers.

## Phase 4 — Prompt package and artifact pipeline

- [x] Introduce a canonical normalized prompt/message format
- [x] Introduce normalized attachment references
- [x] Build a reusable analysis context package from uploaded/local artifacts
- [x] Define a stable analysis context package structure containing:
  - [x] user instructions
  - [x] extracted artifact text
  - [x] artifact metadata
  - [x] storage references
  - [x] system prompt profile ID
- [x] Persist artifact metadata separately from provider request formatting
- [x] Separate artifact preprocessing from provider dispatch
- [x] Add one prompt-profile mechanism for:
  - [x] analysis
  - [x] synthesis
  - [x] structured-output mode
- [x] Add PDF/text extraction pipeline placeholders
- [x] Add future-ready hooks for OCR/vision extraction models
- [x] Record artifact provenance in run outputs for reproducibility
- [x] Keep the artifact contract reusable for related workflows such as the SUBCKT utility and datasheet-ingestion flows

### Phase 4 guardrails

- Keep artifact storage and provenance independent from how any one provider wants files or messages formatted.

## Phase 4.5 — Persistence and hosted API foundations

- [x] Add skeletal DB schema for users, providers, runs, dispatches, results, artifacts, billing, and audit records
- [x] Add run/result/artifact persistence interfaces before full hosted rollout
- [x] Introduce object storage layout for artifacts and raw dispatch payloads
- [x] Add explicit storage key conventions:
  - [x] `projects/{projectId}/artifacts/{artifactId}/{filename}`
  - [x] `runs/{runId}/dispatches/{dispatchId}/request.json`
  - [x] `runs/{runId}/dispatches/{dispatchId}/response.json`
  - [x] `runs/{runId}/reports/final-report.json`
- [x] Add authenticated hosted API foundations before major UI work:
  - [x] provider APIs skeleton
  - [x] run APIs skeleton
  - [x] project/artifact APIs skeleton
  - [x] billing summary API skeleton
- [x] Migrate filesystem-only assumptions behind storage abstractions where needed to support later hosted rollout

### Phase 4.5 guardrails

- Persistence and API foundations must exist before too much higher-level orchestration and UI logic depends on them.

## Phase 5 — BYOK for built-in providers

- [ ] Define a secure credential storage abstraction
- [ ] Make credential security explicit:
  - [ ] credentials are encrypted at rest
  - [ ] credentials are only decrypted server-side
  - [ ] raw API keys are never returned to the client or UI
- [ ] Add credential lifecycle helpers:
  - [ ] create
  - [ ] rotate/update
  - [ ] disable
  - [ ] delete
- [ ] Add built-in BYOK records for Anthropic
- [ ] Add built-in BYOK records for OpenAI
- [ ] Optionally add built-in BYOK for Gemini and xAI
- [ ] Add provider resolution logic for platform key vs BYOK key
- [ ] Enforce Sonnet access rules server-side in the orchestration layer
- [ ] Add invalid-key handling that does not collapse the entire run
- [ ] Add audit logging for credential create/update/delete actions
- [ ] Add audit logging for failed credential validation

### Phase 5 guardrails

- Do not accept temporary plaintext credential storage, even for MVP.

## Phase 6 — Custom endpoint support (safe, restricted)

- [ ] Add custom OpenAI-compatible provider definitions
- [ ] Add custom Anthropic-compatible provider definitions
- [ ] Add endpoint validation flow
- [ ] Add URL syntax validation
- [ ] Add explicit endpoint activation states:
  - [ ] `pending_validation`
  - [ ] `active`
  - [ ] `failed_validation`
  - [ ] `disabled`
- [ ] Add SSRF protection for localhost, loopback, RFC1918, link-local, and metadata targets
- [ ] Require `https:` in hosted/production mode
- [ ] Add DNS/IP resolution checks before endpoint activation
- [ ] Add capability probing for auth, model existence, text completion, and structured output
- [ ] Add probe-result persistence for:
  - [ ] supported protocol
  - [ ] supported features
  - [ ] last successful probe
  - [ ] last failure reason
- [ ] Store verification results and last-verified timestamp
- [ ] Keep custom endpoints disabled until validation succeeds
- [ ] Add optional admin approval hooks for advanced or enterprise self-hosted endpoints later

### Phase 6 guardrails

- Custom endpoint support must not turn the backend into a generic open proxy.

## Phase 7 — Access policy, billing hooks, and plan controls

- [ ] Add `evaluateProviderAccess()` policy layer
- [ ] Add `assertProviderAccess()` policy enforcement entry point
- [ ] Add one consistent policy response shape with:
  - [ ] allowed
  - [ ] reason
  - [ ] billing mode
  - [ ] requires credits
  - [ ] estimated cost
- [ ] Enforce free/premium/BYOK/custom rules in one place
- [ ] Add explicit rule: Sonnet is allowed only if premium or valid Anthropic BYOK is present
- [ ] Add plan/account flag for allowing custom endpoints
- [ ] Add per-provider free eligibility and premium-only flags
- [ ] Add estimated run-cost calculation hooks
- [ ] Add usage capture normalization across providers
- [ ] Add credit-ledger schema placeholders
- [ ] Add budget/cost guardrails for synthesis and judge stages

### Phase 7 guardrails

- Do not split provider access checks across UI, handlers, and dispatch services.
- Server-side policy remains the single source of truth.

## Phase 7.5 — End-to-end run orchestration service

- [x] Add `createRun()`
- [x] Add `resolveProvidersForRun()`
- [x] Add `buildAnalysisContext()`
- [x] Add `dispatchRun()`
- [x] Add `normalizeDispatchResults()`
- [x] Add optional `synthesizeRun()`
- [x] Add `finalizeRun()`
- [x] Add top-level `executeRun()` that coordinates the full run lifecycle
- [x] Ensure partial-success behavior is preserved end-to-end
- [x] Ensure synthesis failure does not mark a successful analysis run as failed
- [x] Leave a clean integration point for related utility stages such as manual-first SUBCKT generation and packaging
- [x] Preserve a packaging/report-deliverable contract so integrated SUBCKT outputs can include generated `.lib` files and updated emitted `.cir`

### Phase 7.5 guardrails

- Keep orchestration logic out of entrypoints, handlers, and legacy modules where possible.
- `executeRun()` should become the primary lifecycle coordinator.

## Phase 8 — Synthesis, consensus, and judge pipeline

- [x] Separate analysis providers from synthesis provider selection
- [x] Add a dedicated synthesis output type
- [x] Add a minimal consensus grouping strategy first:
  - [x] title/category similarity
  - [x] severity comparison
  - [x] outlier detection
- [x] Add consensus clustering across normalized findings
- [x] Add agreement/disagreement summaries
- [x] Add optional judge/reranker stage
- [x] Add synthesis-provider eligibility rules
- [x] Ensure synthesis failure does not invalidate otherwise successful runs
- [x] Add formal invariant: raw ensemble still succeeds without synthesis
- [x] Add confidence heuristics based on agreement, evidence, and parse quality
- [x] Add outputs for prioritized fixes, open questions, and confidence notes

### Phase 8 guardrails

- Do not overcomplicate clustering or judging before the normalized result schema is stable.

## Phase 8.5 — Hosted API completion milestone

- [x] Complete provider APIs:
  - [x] list providers
  - [x] add BYOK
  - [x] add custom endpoint
  - [x] update custom endpoint
  - [x] delete custom endpoint
- [x] Complete run APIs:
  - [x] create run
  - [x] list runs
  - [x] get run
  - [x] get run results
  - [x] retry run
- [x] Complete project and artifact APIs:
  - [x] create project
  - [x] list projects
  - [x] create artifact
  - [x] get artifact
- [x] Complete billing summary APIs
- [x] Add provider management API client layer separate from UI components
- [x] Add run API client layer separate from UI components
- [x] Ensure the API and service-contract style is reusable for later SUBCKT utility endpoints and integrated run outputs

### Phase 8.5 guardrails

- Backend contracts must stabilize before broad UI generation.
- UI should consume APIs, not invent payloads.

## Phase 9 — UI and local UX evolution

- [x] Treat this phase as UI consumption of already-defined APIs, not API invention
- [x] Add provider catalog UI grouped as Free / Premium / Your Keys / Custom Endpoints
- [x] Add provider capability badges
- [x] Add synthesis-eligible and judge-eligible indicators
- [x] Add BYOK management UI
- [x] Add custom endpoint add/edit/test/delete UI
- [x] Add per-run provider status cards
- [x] Add raw output, normalized findings, consensus, and synthesis views
- [x] Add run rerun/retry UX
- [x] Keep current local UI workflow working during migration

### Phase 9 guardrails

- Do not let UI components define payload shapes ad hoc.

## Phase 10 — Persistence and hosted service split completion

- [ ] Introduce SQL-backed metadata for users, providers, runs, dispatches, and results
- [ ] Split API/gateway responsibilities from background worker responsibilities
- [ ] Complete migration of filesystem-only assumptions behind storage abstractions
- [ ] Preserve local/dev mode as a supported execution path
- [ ] Finish extraction of shared packages/modules as needed for hosted and local runtimes

### Phase 10 guardrails

- Finish the hosted split only after the shared contracts, persistence skeleton, and orchestration path are already stable.

## Phase 11 — Observability, operations, and benchmarking

- [ ] Add request/run/dispatch correlation IDs
- [ ] Add one structured log format shared across dispatch, normalization, and synthesis
- [ ] Record per-provider latency and usage metrics
- [ ] Record normalization failures separately from provider failures
- [ ] Add provider health dashboards or summaries
- [ ] Add endpoint validation failure reporting
- [ ] Add audit events for:
  - [ ] provider access denied
  - [ ] custom endpoint probe failed
  - [ ] run started
  - [ ] run completed
  - [ ] run failed
- [ ] Add admin metrics for provider failure rate and latency percentiles
- [ ] Add model benchmarking runs against representative schematic-analysis prompts
- [ ] Add alias retargeting process when vendors rename or deprecate models

### Phase 11 guardrails

- Keep observability fields stable early so dashboards and logs do not churn.

## Phase 12 — Recommended provider/model additions

- [ ] Keep this phase strictly as expansion after the registry, dispatch, and policy path is proven stable
- [ ] Require that new providers enter through the same registry + adapter + policy flow
- [ ] Add stable alias lanes for each built-in provider: `flagship`, `fast`, and `reasoning`
- [ ] Add Azure OpenAI-compatible provider definitions
- [ ] Add OpenRouter-compatible provider definitions if desired
- [ ] Evaluate Bedrock-backed provider support
- [ ] Evaluate Groq/Together/Fireworks/DeepInfra style OpenAI-compatible backends
- [ ] Add local/dev provider support such as Ollama-compatible endpoints
- [ ] Add vision/OCR model role support
- [ ] Add embeddings model role support
- [ ] Add judge/reranker model role support
- [ ] Keep related AI utilities, including SUBCKT generation, on the same provider registry + adapter + policy path when expanding model coverage

### Phase 12 guardrails

- Do not add new providers before the first built-in, BYOK, and custom endpoint paths are stable.

## Phase 13 — Deferred until your later full spec

- [ ] Leave this phase deferred on purpose
- [ ] Design the end-user model-definition UX and schema
- [ ] Design guardrails for user-managed provider/model presets
- [ ] Decide how much endpoint/protocol customization end users may control
- [ ] Define approval and validation rules for advanced enterprise/self-hosted endpoints
- [ ] Define whether user-managed model aliases are tenant-local, project-local, or account-global
- [ ] Finalize migration from admin-curated custom endpoints to broader user-managed model setup

### Phase 13 guardrails

- Do not expand full end-user model-definition complexity into MVP unless the provider registry and policy model proves too restrictive.

## Completion gates

- [ ] Built-in, BYOK, and custom providers all resolve through one registry and dispatch path
- [ ] Unsafe custom endpoints are blocked before use
- [ ] Partial-success runs are preserved and visible in UI/API
- [ ] Synthesis and judge stages are optional and fault-tolerant
- [ ] Model aliases shield user-facing configs from vendor model churn
- [ ] Local/dev workflows still work while hosted capabilities are added
- [ ] All provider access decisions are enforced server-side
- [ ] Credentials are encrypted at rest and only decrypted server-side
- [ ] A single `executeRun()` service drives the end-to-end run lifecycle
- [ ] UI uses stable backend/API contracts rather than defining its own payload shapes
- [ ] Shared canonical types exist before major hosted/UI expansion
- [ ] Related AI utilities, including SUBCKT generation, do not create a parallel provider/policy architecture
- [ ] The future `report.docx` preserves all information currently generated today, even if new report sections are added
- [ ] When SUBCKT integration is used, generated `.lib` files and updated emitted `.cir` are included in report output deliverables
- [ ] The codebase is ready for your later full end-user model setup specification without another large architectural reset
