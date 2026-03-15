# AI Schematics Ensemble — Phase 0 Provider Baseline

This document freezes the current provider behavior baseline before the open-provider refactor.

It serves two purposes:

- documents the current provider/model defaults
- defines the regression scenarios that should continue to behave equivalently until a later intentional change is approved

This is the current-state baseline for the existing local CLI/UI implementation.

---

## 1. Source files used for this baseline

Primary code references:

- [../src/index.ts](../src/index.ts)
- [../src/runBatch.ts](../src/runBatch.ts)
- [../src/util/runConfig.ts](../src/util/runConfig.ts)
- [../src/providers/openai.ts](../src/providers/openai.ts)
- [../src/providers/xai.ts](../src/providers/xai.ts)
- [../src/providers/gemini.ts](../src/providers/gemini.ts)
- [../src/providers/anthropic.ts](../src/providers/anthropic.ts)
- [../src/report/docx.ts](../src/report/docx.ts)
- [../src/ensemble.ts](../src/ensemble.ts)

---

## 2. Current provider and model defaults

### 2.1 CLI `run` command defaults

Current `run` command defaults from [../src/index.ts](../src/index.ts):

- OpenAI model: `gpt-5.2`
- xAI model: `grok-4`
- Gemini model: `gemini-2.5-flash`
- Anthropic model: `claude-sonnet-4-5-20250929`
- output root: `runs`
- interactive prompts for missing baseline inputs: enabled unless `--no-prompts` is passed
- schematic DPI: only set when explicitly provided; actual render fallback default is `600`

### 2.2 Config-supported model fields

Current config fields from [../src/util/runConfig.ts](../src/util/runConfig.ts):

- `openaiModel`
- `grokModel`
- `geminiModel`
- `claudeModel`
- `enabledProviders`

Current allowed provider IDs in config:

- `openai`
- `xai`
- `google`
- `anthropic`

### 2.3 Current provider credential environment variables

Current environment variables used by provider callers:

- OpenAI: `OPENAI_API_KEY`
- xAI: `XAI_API_KEY`
- Gemini: `GEMINI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`

### 2.4 Current provider protocol behavior

Current behavior by provider:

- `openai`
  - uses OpenAI Responses API
  - supports attached images
- `xai`
  - uses OpenAI-compatible client with `https://api.x.ai/v1`
  - currently ignores images in the provider wrapper
- `google`
  - uses Gemini `generateContent`
  - supports inline images
- `anthropic`
  - uses Anthropic Messages API
  - supports images
  - applies image downscaling/omission when payload size exceeds provider image limits

---

## 3. Current provider-selection behavior

### 3.1 Default enabled providers

When `enabledProviders` is not explicitly set, the run enables only providers that have matching API keys present in the environment.

Current detection order from [../src/runBatch.ts](../src/runBatch.ts):

1. `openai`
2. `xai`
3. `google`
4. `anthropic`

### 3.2 Explicit enabled providers

When `enabledProviders` is explicitly provided:

- only these four provider IDs are accepted: `openai`, `xai`, `google`, `anthropic`
- duplicates are removed
- insertion order is preserved
- the run errors if the resulting set is empty

### 3.3 Ensemble-provider selection

Current ensemble selection rule:

- if `anthropic` is enabled, Anthropic is preferred as the ensemble provider
- otherwise, the first enabled provider is used as the ensemble provider

### 3.4 Provider failure handling

Current fanout behavior is tolerant of per-provider call failures because provider wrappers return structured `ModelAnswer` objects with `error` populated instead of throwing for most request failures.

Current ensemble behavior is stricter:

- if the ensemble step fails or returns no text, the run throws and stops

---

## 4. Current output baseline

Current run outputs from [../src/runBatch.ts](../src/runBatch.ts):

- `answers.json`
- `answers/*.md`
- `ensemble_raw.txt`
- `final.md`
- `final.cir`
- `final.json`
- `schematic.dot`
- optional `schematic.png`
- optional `schematic.svg`
- `report.docx`
- `report-auto.pdf`
- optional baseline/reference artifact copies
- optional include-bundling outputs:
  - `baseline_original.cir`
  - `baseline.cir`
  - `baseline_includes.json`

Current `report.docx` information baseline from [../src/report/docx.ts](../src/report/docx.ts):

- baseline schematic screenshot when present
- reference images when present
- question section
- ensembled output rendered from final markdown
- model answer sections when present
- SPICE netlist section
- connectivity schematic section with image or fallback message

This information baseline should be preserved during the migration even if the report grows.

---

## 5. Regression scenario matrix

These scenarios define the current behavior that refactors should preserve unless an explicit change is approved.

### Scenario A — full fanout with all providers enabled

Setup:

- all four API keys are present
- no explicit `enabledProviders`
- question input is valid

Expected baseline behavior:

- fanout runs against `openai`, `xai`, `google`, and `anthropic`
- `answers.json` contains four answer records
- `answers/` contains one markdown file per provider/model
- ensemble provider is `anthropic`
- `report.docx`, `final.md`, `final.cir`, and `final.json` are emitted

### Scenario B — explicit provider subset without Anthropic

Setup:

- `enabledProviders` is set to a subset such as `['openai', 'google']`
- question input is valid

Expected baseline behavior:

- only the selected providers are queried
- ensemble provider is the first enabled provider in the normalized list
- no Anthropic ensemble preference applies when Anthropic is not enabled

### Scenario C — no providers enabled

Setup:

- no API keys in environment
- `enabledProviders` omitted

Expected baseline behavior:

- run fails before fanout
- error message indicates no providers were enabled because no API keys were detected

### Scenario D — explicit provider selection but missing credentials

Setup:

- `enabledProviders` explicitly includes one or more providers without matching API keys

Expected baseline behavior:

- run emits provider-specific warning messages for missing keys
- provider wrappers return error-bearing answers where requests fail
- fanout still completes as long as the process does not fail before the ensemble step
- answer markdown for a failed provider is written as an `# ERROR` section

### Scenario E — Anthropic image limit handling

Setup:

- Anthropic is enabled
- one or more attached images exceed Anthropic payload limits

Expected baseline behavior:

- oversized images are downscaled/compressed when possible
- images that still cannot fit are omitted rather than crashing the provider call
- the effective prompt receives a note describing changed/omitted images

### Scenario F — fallback output packaging when ensemble tags are missing

Setup:

- ensemble text omits one or more required tagged output blocks

Expected baseline behavior:

- fallback extraction logic attempts to recover markdown, SPICE, and JSON
- if SPICE is still missing, `final.cir` is written with an error placeholder netlist
- if JSON is still missing, `final.json` is written with an error placeholder payload
- `final.md` includes a warning if the SPICE block is missing
- `ensemble_raw.txt` preserves the raw ensemble output

### Scenario G — connectivity diagram fallback behavior

Setup:

- final netlist is empty or unparseable
- baseline netlist is present and parseable

Expected baseline behavior:

- schematic generation falls back to the baseline netlist
- `schematic.dot` is still written
- diagram comments indicate baseline fallback when applicable
- PNG/SVG rendering remains best-effort depending on Graphviz availability

### Scenario H — current report content baseline

Setup:

- run completes with available baseline/reference artifacts and model answers

Expected baseline behavior:

- `report.docx` includes all current information categories listed in Section 4
- later refactors may add sections, but should not remove existing information categories

---

## 6. Phase 0 completion intent

For Phase 0 of the open-provider migration, this document is the source of truth for:

- current provider/model defaults
- current provider-selection and ensemble-selection behavior
- current output and report baseline
- current regression scenarios to preserve during refactoring

Later phases can replace this with automated regression coverage, but until then this document is the behavioral baseline.
