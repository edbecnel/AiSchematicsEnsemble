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
- SUBCKT utility design: [docs/subckt-lib-utility-architecture.md](docs/subckt-lib-utility-architecture.md)
- SUBCKT utility implementation checklist: [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md)

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

1. [ ] Finalize the Phase 0 architecture baseline and canonical entity vocabulary in [docs/open-provider-architecture-plan.md](docs/open-provider-architecture-plan.md)
2. [ ] Freeze current behavior with regression scenarios for OpenAI, Anthropic, Gemini, and xAI so refactors can be validated safely
3. [ ] Extract shared canonical types and schemas into reusable modules, including `DispatchRequest`, `RawProviderResponse`, `NormalizedPromptMessage`, `NormalizedAttachment`, `NormalizedFinding`, and `SynthesisOutput`
4. [ ] Create the shared provider adapter contract plus `getProviderAdapter(protocol)`
5. [ ] Settle the Gemini adapter strategy before broader provider refactors
6. [ ] Implement the first protocol adapters: `OpenAICompatibleAdapter`, `AnthropicNativeAdapter`, and `AnthropicCompatibleAdapter`
7. [ ] Create the provider registry, model catalog, stable model aliases, and canonical resolved-provider shape
8. [ ] Implement the dispatch and normalization foundation, including `DispatchStatus`, normalized provider errors, raw-result persistence, and structured/fallback parsing
9. [ ] Implement the prompt/artifact pipeline plus persistence foundations, including reusable analysis-context structure, storage abstractions, and hosted API skeletons
10. [ ] Implement the end-to-end orchestration path centered on `executeRun()` before starting major UI work or deeper SUBCKT utility coding

### What to start immediately after the first 10

- Begin [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md) Phase A through Phase F once the shared provider, artifact, persistence, and orchestration foundation is in place.
- Defer SUBCKT integration into Ensemble runs until the main orchestration and provider/policy path is stable.

## Phase 0 — Architecture alignment and baseline hardening

- [ ] Approve the target architecture in [docs/open-provider-architecture-plan.md](docs/open-provider-architecture-plan.md)
- [ ] Confirm MVP scope vs deferred items
- [ ] Freeze current provider behavior with regression test scenarios for OpenAI, Anthropic, Gemini, and xAI
- [ ] Document current provider/model defaults from [src/index.ts](src/index.ts) and [src/util/runConfig.ts](src/util/runConfig.ts)
- [ ] Identify which existing outputs must remain backward compatible (`final.md`, `final.cir`, `final.json`, `report.docx`)
- [ ] Define migration rules for existing config files and saved run folders
- [ ] Define the initial canonical internal entities:
  - [ ] `ProviderDefinition`
  - [ ] `UserProviderCredential`
  - [ ] `Run`
  - [ ] `RunDispatch`
  - [ ] `RunResult`
  - [ ] `NormalizedFinding`
  - [ ] `SynthesisResult`

### Phase 0 guardrails

- Do not begin major UI work or hosted API refactors before canonical entities and lifecycle terminology are agreed.

## Phase 1 — Core provider abstraction inside current repo

- [ ] Replace the narrow `ProviderName` pattern in [src/types.ts](src/types.ts) with extensible provider/protocol types
- [ ] Extract shared types and schemas into reusable packages/modules now, not later
- [ ] Introduce `ProviderProtocol`, `BillingMode`, `ProviderCapabilities`, and resolved-provider types
- [ ] Add `ModelDefinition` and `ModelAlias` types
- [ ] Create shared canonical types now:
  - [ ] `DispatchRequest`
  - [ ] `RawProviderResponse`
  - [ ] `NormalizedPromptMessage`
  - [ ] `NormalizedAttachment`
  - [ ] `NormalizedFinding`
  - [ ] `SynthesisOutput`
- [ ] Create a provider adapter contract in a shared core module
- [ ] Add a shared adapter interface file that all protocol adapters implement
- [ ] Add a provider adapter resolver: `getProviderAdapter(protocol)`
- [ ] Create `OpenAICompatibleAdapter`
- [ ] Create `AnthropicNativeAdapter`
- [ ] Create `AnthropicCompatibleAdapter`
- [ ] Settle the Gemini adapter strategy:
  - [ ] decide whether Gemini is routed through a Gemini-native adapter
  - [ ] or through the OpenAI-compatible adapter path
- [ ] Refactor existing provider modules under a common dispatch contract
- [ ] Remove orchestration-time provider switch logic from [src/index.ts](src/index.ts) and related run paths

### Phase 1 guardrails

- Do not allow Gemini-native and OpenAI-compatible Gemini paths to evolve in parallel unless there is a deliberate reason.

## Phase 2 — Provider registry and model catalog

- [ ] Create a provider registry module for built-in provider definitions
- [ ] Create a model catalog for concrete model IDs
- [ ] Add stable model aliases such as `openai.flagship`, `anthropic.flagship`, `judge.default`
- [ ] Add capability metadata for each built-in model
- [ ] Add synthesis-eligible and judge-eligible flags
- [ ] Add pricing metadata placeholders even if billing is not yet active
- [ ] Add environment-key mapping rules for platform-owned local/dev credentials
- [ ] Add config migration support so existing `openaiModel`, `claudeModel`, etc. still resolve cleanly
- [ ] Add `billingMode` and `providerScope` explicitly to provider definitions:
  - [ ] `platform_free`
  - [ ] `platform_paid`
  - [ ] `user_byok`
  - [ ] `custom_endpoint`
- [ ] Add `isFreeEligible` and `isPremiumOnly` to provider definitions
- [ ] Add one canonical resolved-provider shape used by dispatch with:
  - [ ] protocol
  - [ ] base URL
  - [ ] model
  - [ ] auth header info
  - [ ] capabilities
  - [ ] billing mode

### Phase 2 guardrails

- Keep aliases simple at first.
- Do not overbuild alias routing before provider resolution rules are stable.

## Phase 3 — Dispatch pipeline and normalization

- [ ] Introduce a canonical `DispatchRequest`
- [ ] Introduce a canonical `RawProviderResponse`
- [ ] Introduce a canonical normalized result schema
- [ ] Add `DispatchStatus` enum:
  - [ ] `queued`
  - [ ] `running`
  - [ ] `succeeded`
  - [ ] `failed`
  - [ ] `timed_out`
  - [ ] `cancelled`
- [ ] Add a normalized error object for provider failures
- [ ] Persist raw provider outputs in a provider-agnostic structure
- [ ] Extract text from each provider response using the adapter contract
- [ ] Add a structured result parser and a fallback tagged-section parser
- [ ] Normalize every provider result into summary, findings, assumptions, missing info, and recommended actions
- [ ] Add parse-quality scoring for normalized outputs
- [ ] Add confidence-scoring hooks now, even if consensus boosting comes later
- [ ] Preserve partial results when one or more providers fail
- [ ] Add consistent error categories for auth, timeout, malformed output, unsupported attachments, and provider unavailability

### Phase 3 guardrails

- Do not let provider-specific parsing logic leak outside adapters and normalizers.

## Phase 4 — Prompt package and artifact pipeline

- [ ] Introduce a canonical normalized prompt/message format
- [ ] Introduce normalized attachment references
- [ ] Build a reusable analysis context package from uploaded/local artifacts
- [ ] Define a stable analysis context package structure containing:
  - [ ] user instructions
  - [ ] extracted artifact text
  - [ ] artifact metadata
  - [ ] storage references
  - [ ] system prompt profile ID
- [ ] Persist artifact metadata separately from provider request formatting
- [ ] Separate artifact preprocessing from provider dispatch
- [ ] Add one prompt-profile mechanism for:
  - [ ] analysis
  - [ ] synthesis
  - [ ] structured-output mode
- [ ] Add PDF/text extraction pipeline placeholders
- [ ] Add future-ready hooks for OCR/vision extraction models
- [ ] Record artifact provenance in run outputs for reproducibility
- [ ] Keep the artifact contract reusable for related workflows such as the SUBCKT utility and datasheet-ingestion flows

### Phase 4 guardrails

- Keep artifact storage and provenance independent from how any one provider wants files or messages formatted.

## Phase 4.5 — Persistence and hosted API foundations

- [ ] Add skeletal DB schema for users, providers, runs, dispatches, results, artifacts, billing, and audit records
- [ ] Add run/result/artifact persistence interfaces before full hosted rollout
- [ ] Introduce object storage layout for artifacts and raw dispatch payloads
- [ ] Add explicit storage key conventions:
  - [ ] `projects/{projectId}/artifacts/{artifactId}/{filename}`
  - [ ] `runs/{runId}/dispatches/{dispatchId}/request.json`
  - [ ] `runs/{runId}/dispatches/{dispatchId}/response.json`
  - [ ] `runs/{runId}/reports/final-report.json`
- [ ] Add authenticated hosted API foundations before major UI work:
  - [ ] provider APIs skeleton
  - [ ] run APIs skeleton
  - [ ] project/artifact APIs skeleton
  - [ ] billing summary API skeleton
- [ ] Migrate filesystem-only assumptions behind storage abstractions where needed to support later hosted rollout

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

- [ ] Add `createRun()`
- [ ] Add `resolveProvidersForRun()`
- [ ] Add `buildAnalysisContext()`
- [ ] Add `dispatchRun()`
- [ ] Add `normalizeDispatchResults()`
- [ ] Add optional `synthesizeRun()`
- [ ] Add `finalizeRun()`
- [ ] Add top-level `executeRun()` that coordinates the full run lifecycle
- [ ] Ensure partial-success behavior is preserved end-to-end
- [ ] Ensure synthesis failure does not mark a successful analysis run as failed
- [ ] Leave a clean integration point for related utility stages such as manual-first SUBCKT generation and packaging

### Phase 7.5 guardrails

- Keep orchestration logic out of entrypoints, handlers, and legacy modules where possible.
- `executeRun()` should become the primary lifecycle coordinator.

## Phase 8 — Synthesis, consensus, and judge pipeline

- [ ] Separate analysis providers from synthesis provider selection
- [ ] Add a dedicated synthesis output type
- [ ] Add a minimal consensus grouping strategy first:
  - [ ] title/category similarity
  - [ ] severity comparison
  - [ ] outlier detection
- [ ] Add consensus clustering across normalized findings
- [ ] Add agreement/disagreement summaries
- [ ] Add optional judge/reranker stage
- [ ] Add synthesis-provider eligibility rules
- [ ] Ensure synthesis failure does not invalidate otherwise successful runs
- [ ] Add formal invariant: raw ensemble still succeeds without synthesis
- [ ] Add confidence heuristics based on agreement, evidence, and parse quality
- [ ] Add outputs for prioritized fixes, open questions, and confidence notes

### Phase 8 guardrails

- Do not overcomplicate clustering or judging before the normalized result schema is stable.

## Phase 8.5 — Hosted API completion milestone

- [ ] Complete provider APIs:
  - [ ] list providers
  - [ ] add BYOK
  - [ ] add custom endpoint
  - [ ] update custom endpoint
  - [ ] delete custom endpoint
- [ ] Complete run APIs:
  - [ ] create run
  - [ ] list runs
  - [ ] get run
  - [ ] get run results
  - [ ] retry run
- [ ] Complete project and artifact APIs:
  - [ ] create project
  - [ ] list projects
  - [ ] create artifact
  - [ ] get artifact
- [ ] Complete billing summary APIs
- [ ] Add provider management API client layer separate from UI components
- [ ] Add run API client layer separate from UI components
- [ ] Ensure the API and service-contract style is reusable for later SUBCKT utility endpoints and integrated run outputs

### Phase 8.5 guardrails

- Backend contracts must stabilize before broad UI generation.
- UI should consume APIs, not invent payloads.

## Phase 9 — UI and local UX evolution

- [ ] Treat this phase as UI consumption of already-defined APIs, not API invention
- [ ] Add provider catalog UI grouped as Free / Premium / Your Keys / Custom Endpoints
- [ ] Add provider capability badges
- [ ] Add synthesis-eligible and judge-eligible indicators
- [ ] Add BYOK management UI
- [ ] Add custom endpoint add/edit/test/delete UI
- [ ] Add per-run provider status cards
- [ ] Add raw output, normalized findings, consensus, and synthesis views
- [ ] Add run rerun/retry UX
- [ ] Keep current local UI workflow working during migration

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
- [ ] The codebase is ready for your later full end-user model setup specification without another large architectural reset
