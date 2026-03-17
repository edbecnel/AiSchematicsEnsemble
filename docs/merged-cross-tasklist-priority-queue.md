# AI Schematics Ensemble — Merged Cross-Tasklist Priority Queue

Created: 2026-03-17

This document merges the next-priority work across the three active planning documents:

- [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md)
- [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md)
- [docs/interactive-run-refinement-tasklist.md](docs/interactive-run-refinement-tasklist.md)

## Notes

- Items 1 through 10 are the recommended implementation order.
- Item 11 is the next item on the interactive refinement list, but that feature remains deferred until its stated preconditions are satisfied.
- This queue is intended as a practical execution order, not a replacement for the underlying source tasklists.
- As work is completed, update both this merged queue and the source tasklist item in the originating document.

## Queue status

- [x] 1. Open provider — replace narrow provider typing
- [x] 2. Open provider — finish model eligibility metadata
- [x] 3. Open provider — add legacy config resolution
- [x] 4. Open provider — complete partial-result preservation
- [x] 5. Open provider — finish storage abstraction cleanup
- [x] 6. SUBCKT utility — add testbench verification notes
- [x] 7. SUBCKT utility — reuse BYOK and custom-endpoint handling
- [ ] 8. SUBCKT utility — reuse server-side policy enforcement
- [ ] 9. Open provider — start BYOK and credential security phase
- [ ] 10. SUBCKT utility — start local UI phase
- [ ] 11. Interactive refinement — approve the architecture

## Priority queue

### [x] 1. Open provider — replace narrow provider typing

**Task**

- Replace the narrow `ProviderName` pattern with extensible provider/protocol types.

**Source**

- [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md#L89)

**Why this is first**

- This is a foundation item for the remaining provider, registry, policy, and endpoint work.

### [x] 2. Open provider — finish model eligibility metadata

**Task**

- Add synthesis-eligible and judge-eligible flags.

**Source**

- [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md#L122)

**Why this is next**

- It tightens provider selection and aligns the model catalog with the synthesis and judge pipeline.

### [x] 3. Open provider — add legacy config resolution

**Task**

- Add config migration support so existing `openaiModel`, `claudeModel`, and similar fields still resolve cleanly.

**Source**

- [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md#L124)

**Why this is next**

- It reduces migration risk before more hosted and policy-oriented work lands.

### [x] 4. Open provider — complete partial-result preservation

**Task**

- Preserve partial results when one or more providers fail.

**Source**

- [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md#L164)

**Why this is next**

- Core run reliability should be fully settled before deeper BYOK and hosted evolution.

### [x] 5. Open provider — finish storage abstraction cleanup

**Task**

- Migrate filesystem-only assumptions behind storage abstractions where needed to support later hosted rollout.

**Source**

- [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md#L212)

**Why this is next**

- It unlocks the later hosted split more cleanly and reduces future refactor churn.

### [x] 6. SUBCKT utility — add testbench verification notes

**Task**

- Include example testbench notes for bench or simulation verification.

**Source**

- [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md#L153)

**Why this is next**

- This is a small, contained usability improvement that can be completed quickly.

### [x] 7. SUBCKT utility — reuse BYOK and custom-endpoint handling

**Task**

- Reuse credential, BYOK, and custom-endpoint handling where practical.

**Source**

- [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md#L164)

**Why this is next**

- The SUBCKT utility should track the main provider architecture rather than drift from it.

### [ ] 8. SUBCKT utility — reuse server-side policy enforcement

**Task**

- Reuse server-side policy enforcement for hosted execution.

**Source**

- [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md#L165)

**Why this is next**

- Policy centralization is a shared architectural requirement across the platform.

### [ ] 9. Open provider — start BYOK and credential security phase

**Task**

- Begin secure credential storage, lifecycle helpers, and related audit/security work.

**Source**

- [docs/open-provider-phased-tasklist.md](docs/open-provider-phased-tasklist.md#L218-L231)

**Why this is next**

- This is the next major platform capability after the core provider abstraction is stable enough.

### [ ] 10. SUBCKT utility — start local UI phase

**Task**

- Add a separate SUBCKT utility page and the related create/refine/validate form flows.

**Source**

- [docs/subckt-lib-utility-tasklist.md](docs/subckt-lib-utility-tasklist.md#L206-L211)

**Why this is next**

- This is the next user-facing milestone once shared provider and policy reuse are aligned.

### [ ] 11. Interactive refinement — approve the architecture

**Task**

- Approve the feature architecture.

**Source**

- [docs/interactive-run-refinement-tasklist.md](docs/interactive-run-refinement-tasklist.md#L30)

**Why it is listed later**

- It is the next item on that tasklist, but the feature is still explicitly deferred until the MVP foundation and stated preconditions are stable.
- Preconditions are documented in [docs/interactive-run-refinement-tasklist.md](docs/interactive-run-refinement-tasklist.md#L11-L26).

## Suggested execution grouping

### Immediate implementation queue

1. Open provider typing foundation
2. Eligibility metadata
3. Legacy config resolution
4. Partial-result preservation
5. Storage abstraction cleanup

### Follow-on alignment work

6. SUBCKT testbench notes
7. SUBCKT BYOK/custom-endpoint reuse
8. SUBCKT server-side policy reuse

### Next major milestones

9. Open provider BYOK/security
10. SUBCKT local UI

### Deferred follow-up

11. Interactive refinement architecture approval
