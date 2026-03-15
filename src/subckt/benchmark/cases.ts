/**
 * Phase L — SUBCKT utility: benchmark test vectors.
 *
 * A curated set of representative components for automated evaluation of the
 * SUBCKT generation pipeline.  Each case defines the expected model shape,
 * pin order, and evaluation criteria so that regression tests and human
 * reviewers can validate output quality consistently.
 *
 * Usage:
 *   import { BENCHMARK_CASES, findBenchmarkCase } from "./benchmark/cases.js";
 */

import type { SubcktAbstractionLevel } from "../types.js";

// ---------------------------------------------------------------------------
// BenchmarkCase type
// ---------------------------------------------------------------------------

export interface BenchmarkCase {
  /** Unique identifier used in test IDs and run directory names. */
  id: string;
  /** Human-readable component name / part number. */
  componentName: string;
  /** Canonical part number for datasheet lookup. */
  partNumber: string;
  /** Common manufacturer (optional — used for narrowing datasheet searches). */
  manufacturer?: string;
  /** Expected number of SUBCKT ports. */
  expectedPinCount: number;
  /** Expected top-level .SUBCKT model name stem (case-insensitive prefix match). */
  expectedModelNameStem: string;
  /** Expected abstraction level for the generated model. */
  expectedAbstractionLevel: SubcktAbstractionLevel;
  /**
   * Ordered list of expected pin names in .SUBCKT header order.
   * Ordering is the canonical published order from the datasheet.
   */
  pinNames: string[];
  /**
   * Phrases / constructs that MUST appear in a passing generated model.
   * Checked as case-insensitive substring matches against the raw .lib text.
   */
  mustContain: string[];
  /**
   * Phrases / constructs that MUST NOT appear in a passing generated model.
   * Checked as case-insensitive substring matches.
   */
  mustNotContain?: string[];
  /**
   * Human-readable criteria for a reviewer to assess model quality.
   * Printed in benchmark reports alongside pass/fail results.
   */
  evaluationCriteria: string[];
  /**
   * Minimal known-good .SUBCKT reference text.
   * Used as a lower-bound reference when evaluating similarity.
   * Should be a public-domain or vendor-published snippet.
   */
  referenceSnippet?: string;
  /** Optional notes for test authors. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Seed cases
// ---------------------------------------------------------------------------

export const BENCHMARK_CASES: BenchmarkCase[] = [
  // -------------------------------------------------------------------------
  // 1. 4N35 — 6-pin optocoupler (phototransistor output)
  // -------------------------------------------------------------------------
  {
    id: "opto-4n35",
    componentName: "4N35",
    partNumber: "4N35",
    manufacturer: "Vishay",
    expectedPinCount: 6,
    expectedModelNameStem: "4N35",
    expectedAbstractionLevel: "behavioral",
    pinNames: ["A", "K", "NC", "VCC", "GND", "OUT"],
    mustContain: [".subckt", "4N35"],
    mustNotContain: ["${"],
    evaluationCriteria: [
      "Model has 6 ports matching the standard 4N35 pinout (Anode/Cathode/NC/Base/Collector/Emitter or equivalent)",
      "LED side is modelled as a diode or current source with forward-voltage close to 1.2 V",
      "Phototransistor side is modelled as a BJT or controlled current source",
      "CTR (current-transfer-ratio) is approximately 100 % at recommended If",
      "No illegal SPICE constructs (${}, .lib inside .subckt, etc.)",
    ],
    notes: "6-pin DIP; pin 3 is NC.  Many published models use only 5 active pins.",
  },

  // -------------------------------------------------------------------------
  // 2. LM358 — dual op-amp (single supply)
  // -------------------------------------------------------------------------
  {
    id: "opamp-lm358",
    componentName: "LM358",
    partNumber: "LM358",
    manufacturer: "Texas Instruments",
    expectedPinCount: 5,
    expectedModelNameStem: "LM358",
    expectedAbstractionLevel: "behavioral",
    pinNames: ["IN+", "IN-", "VCC", "VEE", "OUT"],
    mustContain: [".subckt", "LM358", "e1"],
    mustNotContain: ["${"],
    evaluationCriteria: [
      "5-port single-op-amp sub-block (per-amplifier model, not the full 8-pin package)",
      "Input offset voltage modelled (≤ 2 mV typ.)",
      "Unity-gain bandwidth ≈ 1 MHz",
      "Output rail-saturation within ≈ 1.5 V of each supply rail",
      "Quiescent current ≈ 0.5 mA per amplifier",
    ],
  },

  // -------------------------------------------------------------------------
  // 3. 2N3904 — NPN BJT
  // -------------------------------------------------------------------------
  {
    id: "bjt-2n3904",
    componentName: "2N3904",
    partNumber: "2N3904",
    manufacturer: "Fairchild / onsemi",
    expectedPinCount: 3,
    expectedModelNameStem: "2N3904",
    expectedAbstractionLevel: "datasheet_constrained",
    pinNames: ["B", "C", "E"],
    mustContain: [".model", "2N3904", "NPN"],
    mustNotContain: ["${"],
    evaluationCriteria: [
      "Model is a .MODEL NPN definition (not a .SUBCKT wrapper)",
      "Ic(max) ≥ 100 mA, Vceo ≥ 40 V, hFE ≈ 100–300 typ.",
      "Transit frequency fT ≈ 300 MHz",
      "BF (forward beta) in range 100–400",
    ],
    notes: "Primitive-level model — expected to use .model NPN, not .subckt.",
  },

  // -------------------------------------------------------------------------
  // 4. 1N4148 — small-signal switching diode
  // -------------------------------------------------------------------------
  {
    id: "diode-1n4148",
    componentName: "1N4148",
    partNumber: "1N4148",
    manufacturer: "Vishay",
    expectedPinCount: 2,
    expectedModelNameStem: "1N4148",
    expectedAbstractionLevel: "datasheet_constrained",
    pinNames: ["A", "K"],
    mustContain: [".model", "1N4148", "D"],
    mustNotContain: ["${"],
    evaluationCriteria: [
      "Model is a .MODEL D definition",
      "Forward voltage drop ≈ 0.7 V at 1 mA",
      "Reverse-recovery time ≈ 4 ns",
      "Breakdown voltage ≥ 75 V",
    ],
    notes: "Primitive-level model — expected to use .model D, not .subckt.",
  },

  // -------------------------------------------------------------------------
  // 5. 2N7000 — N-channel MOSFET, TO-92
  // -------------------------------------------------------------------------
  {
    id: "nmos-2n7000",
    componentName: "2N7000",
    partNumber: "2N7000",
    manufacturer: "onsemi",
    expectedPinCount: 3,
    expectedModelNameStem: "2N7000",
    expectedAbstractionLevel: "datasheet_constrained",
    pinNames: ["G", "D", "S"],
    mustContain: [".model", "2N7000", "NMOS"],
    mustNotContain: ["${"],
    evaluationCriteria: [
      "Model is a .MODEL NMOS definition",
      "Vth ≈ 2–3 V, Id(on) ≥ 200 mA at Vgs = 10 V",
      "Rds(on) ≈ 5 Ω at Vgs = 10 V",
      "Gate-source capacitance Ciss ≈ 20–50 pF",
    ],
    notes: "Primitive-level MOSFET model.",
  },

  // -------------------------------------------------------------------------
  // 6. TL071 — general-purpose op-amp (FET input)
  // -------------------------------------------------------------------------
  {
    id: "opamp-tl071",
    componentName: "TL071",
    partNumber: "TL071",
    manufacturer: "Texas Instruments",
    expectedPinCount: 5,
    expectedModelNameStem: "TL071",
    expectedAbstractionLevel: "behavioral",
    pinNames: ["IN+", "IN-", "VCC", "VEE", "OUT"],
    mustContain: [".subckt", "TL071"],
    mustNotContain: ["${"],
    evaluationCriteria: [
      "5-port op-amp model",
      "Unity-gain bandwidth ≈ 3 MHz",
      "Slew rate ≈ 13 V/µs",
      "Input bias current ≤ 65 pA (FET input characteristic)",
      "Open-loop gain ≥ 200 V/mV (106 dB)",
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up a benchmark case by its ID. */
export function findBenchmarkCase(id: string): BenchmarkCase | undefined {
  return BENCHMARK_CASES.find((c) => c.id === id);
}

/** Filter cases by expected abstraction level. */
export function casesByLevel(level: SubcktAbstractionLevel): BenchmarkCase[] {
  return BENCHMARK_CASES.filter((c) => c.expectedAbstractionLevel === level);
}
