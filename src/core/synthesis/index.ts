/**
 * Phase 8 — Synthesis/consensus/judge module public API
 *
 * Re-export the public surface of the synthesis sub-modules so callers
 * import from one stable path rather than individual files.
 */

export { computeConsensus } from "./consensus.js";
export {
  filterSynthesisEligible,
  filterJudgeEligible,
  selectSynthesisProvider,
  selectJudgeProvider,
  areSynthesisAndJudgeSameProvider,
} from "./eligibility.js";
export { runJudge } from "./judge.js";
export {
  runSynthesisPipeline,
  SILENT_LOGGER,
} from "./pipeline.js";
export type { PipelineLogger, RunSynthesisPipelineArgs } from "./pipeline.js";
