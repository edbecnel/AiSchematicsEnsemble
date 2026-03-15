# AI Schematics Ensemble — Open Provider Architecture Plan

## 1. Purpose

This plan combines:

- the hosted, open-ended provider architecture spec you supplied
- recommended model/provider additions for quality, resilience, and future flexibility
- a migration path from the current single-package CLI/UI codebase to a hosted, protocol-driven provider platform

The goal is to evolve AI Schematics Ensemble from a locally run multi-provider CLI/UI into a hosted orchestration platform that:

- supports platform-managed providers
- supports BYOK for built-in providers
- supports safe user-defined custom endpoints
- routes runs through protocol adapters instead of vendor-specific hardcoding
- normalizes outputs into one canonical analysis format
- supports optional synthesis, judging, and later user-managed model definitions

This document is intentionally architecture-first and leaves room for your later full specification for user-managed model setup.

---

## 2. Current Codebase Baseline

The current repository is a single TypeScript package with:

- a CLI entrypoint in [src/index.ts](src/index.ts)
- hardcoded provider calls in [src/providers/openai.ts](src/providers/openai.ts), [src/providers/anthropic.ts](src/providers/anthropic.ts), plus Gemini/xAI siblings
- provider names currently modeled as a narrow union in [src/types.ts](src/types.ts)
- config-driven local runs via [src/util/runConfig.ts](src/util/runConfig.ts)
- a local HTTP UI server in [src/ui/server.ts](src/ui/server.ts)
- a batch-run orchestrator centered on local filesystem outputs

Today, the system is vendor-aware and file-system-centric. The next architecture should be protocol-aware, registry-driven, and able to operate in both:

1. local/dev mode for today’s workflow
2. hosted mode for the future product

That means the architecture should avoid a risky rewrite-first approach. Instead, we should extract portable layers from the current code and replace hardcoded provider logic incrementally.

---

## 3. Architecture Principles

### 3.1 Support protocols, not brands

Provider selection must resolve to protocol adapters rather than switch statements on vendor names.

Initial protocol set:

- `anthropic-native`
- `openai-compatible`
- `anthropic-compatible`
- `gemini-native` (optional if needed beyond OpenAI-compatible support)

Future-ready protocol set:

- `azure-openai-compatible`
- `bedrock-*` family wrappers or a generalized cloud-provider dispatch layer
- `openrouter-compatible`
- `ollama-compatible`
- `custom-plugin` only after a tightly constrained spec exists

### 3.2 Separate provider identity from model identity

The system should distinguish:

- provider definition: auth, protocol, base URL, billing mode, capability defaults
- model definition: concrete model ID, pricing metadata, context limits, feature flags
- model alias: stable application-facing name such as `openai.flagship`, `anthropic.fast`, `judge.default`

This prevents vendor renames from breaking configs and gives the app stable routing targets.

### 3.3 Local-first migration, hosted-first target

The same core abstractions should work in:

- current local CLI/UI runs
- later hosted API + worker architecture

The local app should become a thin client over shared orchestration primitives rather than a one-off execution path.

### 3.4 Capability-driven routing

Do not assume every model can do every task. Route based on explicit capability metadata.

At minimum, track:

- vision support
- file support
- streaming support
- structured output support
- strict JSON mode support
- tool use support
- max context tokens
- max output tokens
- input image/file size limits
- billing eligibility
- synthesis eligibility
- judge eligibility
- local vs hosted availability

### 3.5 Partial success over all-or-nothing

Runs must preserve successful provider results even when some providers fail. This rule should hold for:

- analysis fanout
- normalization
- synthesis
- judge/rerank passes

---

## 4. Recommended Provider and Model Expansion

Your current built-in set is a good start: OpenAI, Anthropic, Gemini, and xAI. The next architecture should support a broader matrix.

### 4.1 Keep current providers, but broaden each provider lane

For each built-in provider, define at least three model roles:

- `flagship`: highest quality general reasoning model
- `fast`: lower-cost / lower-latency model for fanout and drafts
- `reasoning`: strongest constraint-heavy model for difficult synthesis or adjudication

Suggested lanes:

- **Anthropic**
  - flagship Sonnet-class
  - cheaper/faster Sonnet-class or equivalent when available
  - premium synthesis/judge lane
- **OpenAI**
  - flagship general model
  - fast/cheap model
  - reasoning-oriented model for hard synthesis and consistency checks
- **Gemini**
  - Flash-class for throughput
  - Pro-class for higher quality
  - multimodal option for PDF/image-heavy runs
- **xAI**
  - flagship Grok-class
  - lower-cost mini/fast class when available

### 4.2 Add infrastructure-friendly providers

These improve enterprise deployability and resilience:

- **Azure OpenAI** for organizations that require Azure-hosted OpenAI access
- **AWS Bedrock** for multi-model procurement and enterprise governance
- **OpenRouter-compatible** support for broad model access behind one adapter
- **Groq / Together / Fireworks / DeepInfra** style OpenAI-compatible backends for burst capacity and open-weights access

### 4.3 Add local/open-weights support for dev, testing, and offline fallback

Even if the product is hosted, one local-compatible lane is strategically useful:

- **Ollama** or equivalent local endpoint support
- optionally `vLLM`-style OpenAI-compatible support for GPU environments

Benefits:

- offline dev and testing
- reproducible runs
- lower-cost regression testing
- easier future support for user-owned infrastructure

### 4.4 Add supporting model classes, not just chat models

The architecture should explicitly reserve space for:

- **vision/OCR extraction models** for PDFs and schematic images
- **embeddings models** for retrieval over prior runs, docs, part notes, and include libraries
- **reranker/judge models** for consensus and prioritization

These should be modeled as capabilities or roles, not bolted on later.

---

## 4.5 Related utility workflow: generated SUBCKT libraries

In addition to the main ensemble flow, the platform should support a related utility for generating `ngspice`-friendly `.SUBCKT` library files for components that lack usable simulation models.

That utility is documented in:

- [docs/subckt-lib-utility-architecture.md](docs/subckt-lib-utility-architecture.md)
- [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md)

This utility should remain a separate workflow, but the architecture should also allow controlled integration into ensemble runs.

Recommended integration modes:

1. `manual`

- user explicitly identifies components needing generated models
- user may attach a datasheet PDF or datasheet URL
- generated `.lib` files are packaged with run outputs
- emitted `.cir` output is updated to reference generated libraries

2. `auto_detect`

- opt-in only
- the run attempts to detect candidates missing usable SUBCKT/model information
- generated models must be validated and explicitly disclosed in the report

The main architecture constraint is that generated-model support must reuse the same:

- provider registry
- adapter contract
- policy enforcement
- artifact persistence
- observability and audit patterns

It must not create a second provider or dispatch architecture.

---

## 5. Recommended Product Surface

### 5.1 Provider categories

Retain the four categories from your supplied spec:

1. built-in platform-paid providers
2. built-in BYOK providers
3. custom OpenAI-compatible providers
4. custom Anthropic-compatible providers

Recommended additions:

5. built-in enterprise aliases
   - Azure OpenAI
   - Bedrock-backed provider definitions
6. local/dev providers
   - hidden by default in hosted mode
   - available in self-hosted/dev mode

### 5.2 Execution modes

Keep the three run modes from the supplied spec:

- `single`
- `ensemble`
- `ensemble_with_synthesis`

Recommended future extension:

- `ensemble_with_judge`
- `pipeline`

Where `pipeline` means staged execution such as:

1. extraction model
2. analysis fanout
3. judge/reranker
4. synthesis

---

## 6. Target Logical Architecture

## 6.1 High-level layers

### A. Client surfaces

- hosted web UI
- local web UI
- CLI
- possible future API clients

### B. API / gateway layer

Responsibilities:

- auth and session handling
- request validation
- plan enforcement
- rate limiting
- provider access checks
- run creation endpoints

### C. Orchestration layer

Responsibilities:

- create run records
- stage artifacts
- resolve providers
- build normalized prompt package
- dispatch analysis calls
- collect results
- invoke optional synthesis/judge steps
- finalize run status

### D. Provider registry and access engine

Responsibilities:

- load provider definitions
- load model definitions and aliases
- resolve built-in vs BYOK vs custom credentials
- compute access decisions
- return adapter-ready resolved providers

### E. Dispatch/adapters layer

Responsibilities:

- map canonical requests into provider-specific payloads
- apply retries/timeouts
- capture usage and latency
- normalize errors
- preserve raw response payloads

### F. Artifact preprocessing layer

Responsibilities:

- ingest uploads
- extract text from text-based artifacts
- preserve binaries in object storage
- derive normalized attachment references
- later: OCR/PDF parsing/image preprocessing

### G. Normalization and agreement layer

Responsibilities:

- parse raw outputs into canonical findings
- score parse quality
- cluster similar findings
- detect agreements, conflicts, outliers
- prepare synthesis/judge inputs

### H. Reporting layer

Responsibilities:

- raw provider views
- normalized findings
- consensus/disagreement summaries
- final markdown/JSON/netlist/report outputs

### I. Persistence layer

Responsibilities:

- SQL metadata store
- object storage for artifacts and raw results
- audit logs
- usage/billing records

---

## 7. Repository Evolution Plan

The supplied spec uses a future monorepo under `/apps` and `/packages`. That is a good target, but the current repo should move there in stages.

### 7.1 Near-term structure inside the current repo

A practical transitional structure:

```text
/src
  /core
    /providers
    /dispatch
    /normalization
    /prompts
    /artifacts
    /runs
    /billing
    /security
  /adapters
    /anthropic-native
    /openai-compatible
    /anthropic-compatible
  /registry
  /schemas
  /ui
  /cli
```

This lets you refactor without a monorepo jump on day one.

### 7.2 Target monorepo structure

Adopt the supplied `/apps` + `/packages` shape once the abstractions stabilize:

```text
/apps
  /web
  /worker
/packages
  /shared
  /provider-sdk
  /prompting
  /normalization
/docs
```

Recommended refinement:

- add `/packages/provider-sdk` for adapter contracts, request/response mappers, capability schemas, and reusable probes
- add `/packages/prompting` if prompts become versioned/shared

---

## 8. Core Data and Type Model

The supplied domain model is strong and should be adopted with a few additions.

### 8.1 Keep these main entities

- User
- Project
- Artifact
- ProviderDefinition
- UserProviderCredential
- Run
- RunArtifact
- RunDispatch
- RunResult
- NormalizedFinding
- SynthesisResult
- CreditLedger
- PlanSubscription
- AuditEvent

### 8.2 Add these entities or subtypes

- **ModelDefinition**
  - concrete provider model ID and capability/pricing metadata
- **ModelAlias**
  - stable app-facing alias mapped to a concrete `ModelDefinition`
- **ProviderProbeResult**
  - stores endpoint validation and capability-probe outcomes
- **PromptProfile**
  - named prompt/system profile for different analysis styles
- **UsageRecord**
  - normalized token/cost record even if some providers report different usage fields
- **NormalizationVersion**
  - records which parser/schema version interpreted a result

### 8.3 Key type additions

Extend your supplied types with the concepts below:

```ts
export type ModelRole =
  | "analysis"
  | "synthesis"
  | "judge"
  | "vision_extract"
  | "embedding"
  | "rerank";

export interface ModelPricing {
  inputPerMillionUsd?: number;
  outputPerMillionUsd?: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
}

export interface ModelDefinition {
  id: string;
  providerDefinitionId: string;
  modelId: string;
  displayName: string;
  roles: ModelRole[];
  capabilities: ProviderCapabilities;
  pricing?: ModelPricing;
  isEnabled: boolean;
}

export interface ModelAlias {
  id: string;
  alias: string;
  targetModelDefinitionId: string;
  intendedRole?: ModelRole;
  isDefault: boolean;
}
```

---

## 9. Provider Registry and Resolution

The provider resolution service in your supplied spec should become the heart of the new design.

### 9.1 Resolution output should include both provider and model information

Instead of only resolving a provider, resolve a provider-model pair with:

- provider definition
- selected model definition or alias target
- final auth strategy
- final billing mode
- effective capability set
- limits, timeout policy, and retry policy

### 9.2 Resolution precedence

Recommended precedence:

1. admin-disabled check
2. plan eligibility check
3. synthesis/judge eligibility check
4. credential source resolution
5. model alias to concrete model resolution
6. endpoint safety check for custom endpoints
7. capability requirement check
8. budget/credit estimate check

### 9.3 Built-in alias examples

Examples of stable aliases:

- `anthropic.flagship`
- `anthropic.fast`
- `anthropic.synthesis`
- `openai.flagship`
- `openai.fast`
- `openai.reasoning`
- `gemini.fast`
- `gemini.multimodal`
- `judge.default`
- `vision.default`

This should be the public-facing configuration surface rather than raw vendor model names.

---

## 10. Adapter and Dispatch Design

### 10.1 Adapter contract

The supplied adapter contract is correct and should be retained.

Recommended additions:

- a `probeCapabilities()` method for endpoint validation
- a `mapAttachments()` helper for provider-specific attachment handling
- a `supports()` helper for fast protocol/capability checks

Example extension:

```ts
export interface ProviderAdapter {
  protocol: ProviderProtocol;
  buildRequest(input: DispatchRequest): RequestInit & { url: string };
  parseResponse(
    response: Response,
    bodyText: string,
  ): Promise<RawProviderResponse>;
  normalizeError(error: unknown): RawProviderResponse;
  extractText(result: RawProviderResponse): string;
  extractUsage(result: RawProviderResponse): {
    inputTokens?: number;
    outputTokens?: number;
  };
  probeCapabilities?(input: {
    baseUrl: string;
    headers: Record<string, string>;
    model: string;
  }): Promise<ProviderCapabilities>;
}
```

### 10.2 First adapters to implement

1. `OpenAICompatibleAdapter`
2. `AnthropicNativeAdapter`
3. `AnthropicCompatibleAdapter`
4. optional `GeminiNativeAdapter` only if OpenAI-compatible behavior is insufficient

### 10.3 Keep native adapters when they provide material advantages

Even if protocol-compatibility exists, native adapters are still valuable when they unlock:

- better file upload semantics
- better multimodal support
- richer usage reporting
- provider-specific retries and error normalization
- structured output features not faithfully exposed through compatible endpoints

---

## 11. Prompting and Artifact Strategy

The supplied canonical prompt/message structure is good and should be adopted.

Recommended additions:

### 11.1 Explicit analysis package object

Build a reusable context package per run containing:

- normalized user instructions
- artifact manifest
- extracted text snippets
- baseline circuit context
- prior run references if retrieval is enabled
- schema instructions for structured output

This package should be persisted for reproducibility.

### 11.2 Split extraction from reasoning when inputs are messy

For PDFs and schematic images, prefer a two-step pipeline when needed:

1. extraction/OCR/vision summary
2. reasoning prompt over cleaned extracted context

This usually yields more reliable synthesis than sending raw artifacts directly to every model.

### 11.3 Structured output policy

Use three levels:

1. strict JSON mode when supported
2. JSON schema-like prompting when supported but not strict
3. tagged-sections fallback with heuristic parsing

Persist parse quality so downstream confidence scoring knows how much to trust each result.

---

## 12. Normalization, Consensus, and Synthesis

This layer is where AI Schematics Ensemble can become differentiated.

### 12.1 Canonical normalization output

For every provider result, normalize into:

- summary
- findings
- assumptions
- recommended actions
- missing information
- confidence notes
- parse quality score
- evidence references

### 12.2 Consensus engine

Implement semantic clustering across findings to derive:

- consensus findings
- partial overlaps
- conflicts
- outliers

### 12.3 Judge model support

In addition to synthesis, support an optional judge/reranker pass that:

- ranks likely-correct findings
- prioritizes fixes
- flags unsupported claims
- explains why one recommendation should outrank another

This should be modeled as a first-class run stage, not a hack inside synthesis.

### 12.4 Confidence policy

Confidence should be based on:

- parse quality
- provider agreement
- evidence specificity
- internal consistency
- explicit uncertainty language
- model role suitability

Do not trust provider self-reported confidence alone.

---

## 13. Security and Safety

The supplied security section is strong and should remain mandatory.

### 13.1 Keep these requirements

- encrypted BYOK and custom credentials at rest
- server-side decryption only during dispatch
- strict tenant isolation
- audit logging
- server-side access enforcement

### 13.2 Custom endpoint safety must be a hard gate

Before custom endpoints are usable, enforce:

- deny localhost, loopback, RFC1918, link-local, and metadata endpoints
- validate DNS resolution and resolved IPs
- require `https:` in production
- restrict redirects
- cap payload size and timeout budgets
- log and surface validation failures clearly

### 13.3 Add provider egress policy abstraction

Represent endpoint policies centrally so custom providers, future plugins, and enterprise allowlists all use the same enforcement layer.

---

## 14. Billing and Access Policy

Retain the supplied billing modes:

- `platform_free`
- `platform_paid`
- `user_byok`
- `custom_endpoint`

Recommended additions:

- `enterprise_included`
- `local_dev`

These do not need to ship in MVP, but the type model should be extensible enough to add them without refactoring.

### 14.1 Core policy rules

Keep the supplied rules, especially:

- Sonnet never free by default
- premium providers enforced server-side
- BYOK can unlock a restricted provider when policy allows it
- custom endpoints gated by plan/account

### 14.2 Cost controls to add early

- per-run estimated token budget
- per-user monthly budget caps
- per-provider concurrency caps
- synthesis provider cost visibility before run start

---

## 15. Hosted UI and Workflow Recommendations

The supplied UI requirements are good. Recommended additions:

### 15.1 Provider catalog page

Add a dedicated catalog with:

- provider badges
- model aliases
- capability filters
- premium/free/BYOK/custom grouping
- synthesis/judge eligibility flags

### 15.2 Run setup UX

Let the user choose:

- analysis providers
- optional synthesis provider
- optional judge provider
- strict structured-output requirement
- cost-vs-quality preference
- fast vs thorough run template

### 15.3 Endpoint management UX

For custom providers, show:

- protocol
- base URL
- resolved model
- probe status
- capability badges
- last verification time
- disabled reason if validation fails

---

## 16. Migration Plan for This Repo

### 16.1 Stage 1: extract core abstractions inside current app

Refactor the current provider-specific functions in `src/providers/*` behind a shared provider contract while keeping the CLI/UI behavior intact.

### 16.2 Stage 2: replace hardcoded provider selection with a registry

Replace `ProviderName` unions and switch statements with provider definitions + model aliases + resolved dispatch objects.

### 16.3 Stage 3: add BYOK and custom endpoint management to local UI

Use the existing local UI server as a proving ground for:

- credential storage approach
- endpoint validation flow
- provider selection UX
- normalized run details

### 16.4 Stage 4: split hosted worker/API from local client surfaces

Once the shared orchestration code is stable, split toward:

- web app
- worker/API app
- shared packages

This is the right point to introduce SQL metadata and object storage.

---

## 17. Recommended MVP Scope

A strong MVP for this repo’s next major phase would be:

### Required

- protocol-based adapter layer
- provider definitions + model aliases
- built-in OpenAI, Anthropic, Gemini, xAI mapped through registry
- BYOK for built-in Anthropic and OpenAI first
- custom OpenAI-compatible endpoints
- canonical normalized findings model
- partial-failure-tolerant ensemble runs
- local UI/provider management proof of concept
- separate SUBCKT utility MVP for component-name + optional PDF/URL to `.lib` generation

### Strongly recommended in MVP or MVP+1

- custom Anthropic-compatible endpoints
- capability probing
- synthesis provider selection
- provider access engine
- secure credential storage abstraction
- Azure OpenAI-compatible provider definitions
- manual-first SUBCKT integration into Ensemble runs with generated `.lib` files and updated emitted `.cir`

### Defer until after your future full end-user model-spec design

- arbitrary user-authored plugin code
- unrestricted custom protocol definitions
- direct weight uploads
- user-defined prompt-to-adapter code execution

---

## 18. Acceptance Criteria

This combined architecture is successful when:

1. the code no longer hardcodes provider logic into orchestration paths
2. built-in providers, BYOK providers, and custom endpoints all resolve through one registry
3. model aliases shield configs from vendor ID churn
4. unsafe custom endpoints are blocked before dispatch
5. multi-provider runs persist raw results and normalized findings even on partial failure
6. synthesis and judge stages are optional, independent, and non-catastrophic on failure
7. local mode and hosted mode share the same dispatch and normalization contracts
8. generated SUBCKT utility runs reuse the same provider, policy, and artifact architecture
9. manual-first SUBCKT integration can emit generated `.lib` files plus an updated `.cir` in run deliverables
10. the design leaves room for your later full spec for user-managed model definitions without another major rewrite

---

## 19. Recommended Implementation Order

1. shared provider/model schemas and capability metadata
2. adapter interface and dispatch layer
3. provider registry and resolution service
4. migrate current providers into registry-backed adapters
5. canonical normalized findings schema
6. BYOK for built-in providers
7. custom OpenAI-compatible endpoints with SSRF protections
8. separate SUBCKT utility foundation with shared provider and artifact contracts
9. manual-first SUBCKT integration into run outputs and reports
10. synthesis and judge role support
11. local UI provider management and run details
12. persistence and hosted service split
13. custom Anthropic-compatible endpoints
14. advanced billing, observability, and benchmarking
15. later: user-managed provider/model specifications per your future full spec

---

## 20. Summary Recommendation

The best long-term direction is:

- **protocol-driven** instead of vendor-driven
- **registry- and alias-based** instead of hardcoded model names
- **capability-aware** instead of assuming model equivalence
- **shared-core across local and hosted** instead of separate code paths
- **strictly validated custom endpoints** instead of open proxy behavior

That gives you a safe path from the current local tool to a hosted product while preserving room for future user-defined model setup.

---

## Appendix A. Implementation notes

These notes are intended to keep implementation sequencing aligned with the active checklist in [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md).

### A.1 Keep one orchestration path

Prefer one high-level orchestration entry such as `executeRun()` for the ensemble lifecycle.

When the SUBCKT utility is integrated into Ensemble runs, it should plug into that lifecycle as a distinct stage or helper service rather than introducing parallel orchestration logic.

### A.2 Keep one provider architecture

Provider calls for:

- ensemble analysis
- synthesis/judge stages
- SUBCKT fact extraction
- SUBCKT model generation
- SUBCKT repair/review

should all flow through the same provider registry, adapter resolver, and policy enforcement path.

### A.3 Prefer manual-first integration for generated models

The recommended rollout for generated SUBCKT integration is:

1. standalone utility
2. manual-first integration into Ensemble runs
3. opt-in `auto_detect` integration later

This keeps the review boundary clear and reduces the risk of silently patching generated models into emitted netlists.

### A.4 Keep generated artifacts externalized

When integrated into an Ensemble run:

- generated models should remain as separate `.lib` artifacts
- the emitted `.cir` should reference those artifacts
- the report should disclose what was generated, how it was validated, and what requires manual review

### A.5 Reuse the same security posture for remote fetches

Datasheet URLs for the SUBCKT utility should follow the same remote-fetch safety posture used elsewhere:

- controlled server-side fetch
- SSRF protection
- artifact persistence before extraction
- explicit auditability of source URL and fetch outcome

### A.6 Let the UI consume backend contracts

The UI should consume stable APIs and service contracts for both:

- provider management and runs
- SUBCKT utility and SUBCKT-integrated runs

Avoid letting UI components invent payloads or integration semantics ad hoc.

### A.7 Recommended first 10 implementation steps

The recommended starting sequence is:

1. finalize the architecture baseline and canonical entities
2. freeze current behavior with regression scenarios
3. extract shared canonical types and schemas
4. create the shared provider adapter contract and resolver
5. settle the Gemini adapter strategy
6. implement the first protocol adapters
7. create the provider registry, model catalog, and resolved-provider shape
8. implement dispatch and normalization foundations
9. implement artifact, persistence, and hosted API foundations
10. implement end-to-end orchestration centered on `executeRun()`

After those steps, begin the standalone SUBCKT utility implementation before integrating SUBCKT generation into Ensemble runs.
