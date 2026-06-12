/**
 * Shared scenario harness for the betting-engine regression tests and the
 * human-readable debug simulations.
 *
 * Both the assertion tests (`scenarios.test.ts`) and the debug scripts
 * (`royalAscotSimulation.ts`, `noValueSimulation.ts`) drive the pipeline
 * through this single module, so they can never drift out of sync — the whole
 * point of pinning these scenarios as regression tests.
 *
 * Drives the REAL engine functions (`calculateModelProbabilities`,
 * `calculateEV`, `confidenceScore`, `kellyStake`, `pickBestHorse`,
 * `labelConfidence`); no Supabase or env vars required.
 */

import {
  calculateModelProbabilities,
  type ProbabilityRunner,
  type TipsterSelection,
  type TipsterStats,
} from '../src/lib/modelProbabilities';
import {
  calculateEV,
  confidenceScore,
  kellyStake,
  labelConfidence,
  pickBestHorse,
  type ConfidenceLabel,
  type Runner,
} from '../src/lib/bettingEngine';

/** Default bankroll used across scenarios. */
export const DEFAULT_BANKROLL = 1000;

/**
 * Minimum stake fraction (0.1% of bankroll). Mirrors `MIN_STAKE_FRACTION` in
 * bettingEngine.ts, which is module-private; kept here so tests can assert the
 * "stake clamped to floor" behavior without importing engine internals.
 */
export const STAKE_FLOOR_FRACTION = 0.001;

export interface ScenarioRunner {
  id: string;
  name: string;
  odds: number;
}

export interface ScenarioTipster {
  id: string;
  /** Optional human label for display in the debug scripts. */
  tier?: string;
  /** Optional display name. Aliases share one canonical `id` (see Scenario 4). */
  alias?: string;
  pick: string;
  roi: number;
  ae: number;
  strike_rate: number;
}

/** Per-runner diagnostics plus the authoritative model probability and EV. */
export interface RunnerDebug {
  id: string;
  name: string;
  odds: number;
  /** De-overrounded market-implied probability. */
  market: number;
  /** Authoritative model probability from calculateModelProbabilities. */
  model: number;
  /** Raw crowd share = distinct backers / total tipsters. */
  crowd: number;
  /** Summed tipster quality weight (diagnostic). */
  weighted: number;
  ev: number;
  /** 1-based rank by EV, descending. */
  rank: number;
}

export interface ScenarioResult {
  bankroll: number;
  rows: RunnerDebug[];
  /** Sum of 1/odds across the field (1 + book margin). */
  overround: number;
  totalTipsters: number;
  backersByRunner: Map<string, string[]>;
  tipsterWeights: Map<string, number>;
  /** The selected runner (highest EV), or null for an empty field. */
  pick: RunnerDebug | null;
  pickBackers: string[];
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  stake: number;
}

/**
 * Quality weight per tipster, mirroring modelProbabilities.ts internals for
 * diagnostic display only. The authoritative `model_prob` always comes from
 * `calculateModelProbabilities`; this just surfaces weighted support.
 */
export function diagnosticTipsterWeights(
  stats: TipsterStats[],
): Map<string, number> {
  if (stats.length === 0) {
    return new Map();
  }
  const rois = stats.map((s) => s.roi);
  const aes = stats.map((s) => s.ae);
  const roiMin = Math.min(...rois);
  const roiMax = Math.max(...rois);
  const aeMin = Math.min(...aes);
  const aeMax = Math.max(...aes);
  const norm = (v: number, mn: number, mx: number) =>
    mx > mn ? (v - mn) / (mx - mn) : 0.5;
  const clamp = (v: number, a: number, b: number) =>
    Math.min(Math.max(v, a), b);

  const weights = new Map<string, number>();
  for (const s of stats) {
    weights.set(
      String(s.tipster_id),
      0.5 * norm(s.roi, roiMin, roiMax) +
        0.3 * norm(s.ae, aeMin, aeMax) +
        0.2 * clamp(s.strike_rate, 0, 1),
    );
  }
  return weights;
}

/**
 * Runs the full betting pipeline for a scenario and returns structured results
 * (used by both the tests and the debug scripts).
 */
export function runScenario(
  runners: ScenarioRunner[],
  tipsters: ScenarioTipster[],
  bankroll: number = DEFAULT_BANKROLL,
): ScenarioResult {
  const tipsterSelections: TipsterSelection[] = tipsters.map((t) => ({
    runner_id: t.pick,
    tipster_id: t.id,
  }));
  const tipsterStats: TipsterStats[] = tipsters.map((t) => ({
    tipster_id: t.id,
    roi: t.roi,
    ae: t.ae,
    strike_rate: t.strike_rate,
  }));
  const probabilityRunners: ProbabilityRunner[] = runners.map((r) => ({
    runner_id: r.id,
    odds: r.odds,
  }));

  // Market probabilities (de-overrounded so they sum to 1).
  const impliedRaw = runners.map((r) => 1 / r.odds);
  const overround = impliedRaw.reduce((s, v) => s + v, 0);
  const marketProb = new Map<string, number>(
    runners.map((r, i) => [r.id, impliedRaw[i] / overround]),
  );

  // Diagnostic crowd share & weighted support.
  // Dedupe by tipster_id to mirror the engine, which keys support on
  // tipster_id (so the same tipster listed multiple times on a runner — e.g.
  // resolved aliases — counts once). Counting raw rows here would let the
  // harness diagnostics drift from the engine's deduped probabilities.
  const tipsterWeights = diagnosticTipsterWeights(tipsterStats);
  const totalTipsters = new Set(tipsters.map((t) => t.id)).size;
  const backersByRunner = new Map<string, string[]>();
  for (const t of tipsters) {
    const backers = backersByRunner.get(t.pick) ?? [];
    if (!backers.includes(t.id)) {
      backers.push(t.id);
    }
    backersByRunner.set(t.pick, backers);
  }
  const crowdShare = new Map<string, number>();
  const weightedSupport = new Map<string, number>();
  for (const r of runners) {
    const backers = backersByRunner.get(r.id) ?? [];
    crowdShare.set(r.id, totalTipsters > 0 ? backers.length / totalTipsters : 0);
    weightedSupport.set(
      r.id,
      backers.reduce((s, id) => s + (tipsterWeights.get(id) ?? 0), 0),
    );
  }

  // REAL model probabilities.
  const probabilities = calculateModelProbabilities(
    probabilityRunners,
    tipsterSelections,
    tipsterStats,
  );
  const modelProb = new Map<string, number>(
    probabilities.map((p) => [String(p.runner_id), p.model_prob]),
  );

  // EV per runner + ranking by EV (descending).
  const rows: RunnerDebug[] = runners.map((r) => {
    const model = modelProb.get(r.id) ?? 0;
    return {
      id: r.id,
      name: r.name,
      odds: r.odds,
      market: marketProb.get(r.id) ?? 0,
      model,
      crowd: crowdShare.get(r.id) ?? 0,
      weighted: weightedSupport.get(r.id) ?? 0,
      ev: calculateEV(model, r.odds),
      rank: 0,
    };
  });
  [...rows]
    .sort((a, b) => b.ev - a.ev)
    .forEach((row, i) => {
      row.rank = i + 1;
    });

  // REAL best-horse pick.
  const engineRunners: Runner[] = runners.map((r) => ({
    name: r.name,
    odds: r.odds,
    model_prob: modelProb.get(r.id) ?? 0,
  }));
  const best = pickBestHorse(engineRunners);

  let pick: RunnerDebug | null = null;
  let pickBackers: string[] = [];
  let confidence = 0;
  let confidenceLabel: ConfidenceLabel = 'low';
  let stake = 0;

  if (best) {
    const bestId = runners.find((r) => r.name === best.name)!.id;
    pick = rows.find((r) => r.id === bestId)!;
    pickBackers = backersByRunner.get(bestId) ?? [];
    confidence = confidenceScore({
      ev: pick.ev,
      modelProb: pick.model,
      marketProb: pick.market,
      tipsterCount: pickBackers.length,
    });
    confidenceLabel = labelConfidence(confidence);
    stake = kellyStake(pick.model, pick.odds, bankroll, confidence);
  }

  return {
    bankroll,
    rows,
    overround,
    totalTipsters,
    backersByRunner,
    tipsterWeights,
    pick,
    pickBackers,
    confidence,
    confidenceLabel,
    stake,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: "strong tipsters beat the crowded favourite" (Royal Ascot).
// ---------------------------------------------------------------------------

export const SCENARIO_1_RUNNERS: ScenarioRunner[] = [
  { id: 'A', name: 'Horse A', odds: 2.5 },
  { id: 'B', name: 'Horse B', odds: 3.5 },
  { id: 'C', name: 'Horse C', odds: 5.0 },
  { id: 'D', name: 'Horse D', odds: 6.0 },
  { id: 'E', name: 'Horse E', odds: 8.0 },
  { id: 'F', name: 'Horse F', odds: 12.0 },
  { id: 'G', name: 'Horse G', odds: 16.0 },
  { id: 'H', name: 'Horse H', odds: 25.0 },
];

// 5 average tipsters on the favourite (A), 2 strong on D, 1 strong on E,
// 2 weak on G and C (fixed for reproducibility).
export const SCENARIO_1_TIPSTERS: ScenarioTipster[] = [
  { id: 'T1', tier: 'average', pick: 'A', roi: 0.02, ae: 1.0, strike_rate: 0.14 },
  { id: 'T2', tier: 'average', pick: 'A', roi: 0.0, ae: 0.98, strike_rate: 0.13 },
  { id: 'T3', tier: 'average', pick: 'A', roi: 0.05, ae: 1.03, strike_rate: 0.16 },
  { id: 'T4', tier: 'average', pick: 'A', roi: -0.02, ae: 0.97, strike_rate: 0.12 },
  { id: 'T5', tier: 'average', pick: 'A', roi: 0.03, ae: 1.01, strike_rate: 0.15 },
  { id: 'T6', tier: 'strong', pick: 'D', roi: 0.2, ae: 1.2, strike_rate: 0.24 },
  { id: 'T7', tier: 'strong', pick: 'D', roi: 0.22, ae: 1.25, strike_rate: 0.26 },
  { id: 'T8', tier: 'strong', pick: 'E', roi: 0.18, ae: 1.15, strike_rate: 0.22 },
  { id: 'T9', tier: 'weak', pick: 'G', roi: -0.1, ae: 0.85, strike_rate: 0.1 },
  { id: 'T10', tier: 'weak', pick: 'C', roi: -0.15, ae: 0.8, strike_rate: 0.08 },
];

// ---------------------------------------------------------------------------
// Scenario 2: "no clear value" — fair book, split tipsters, no quality signal.
// ---------------------------------------------------------------------------

export const SCENARIO_2_RUNNERS: ScenarioRunner[] = [
  { id: 'A', name: 'Horse A', odds: 5.89 },
  { id: 'B', name: 'Horse B', odds: 6.26 },
  { id: 'C', name: 'Horse C', odds: 7.16 },
  { id: 'D', name: 'Horse D', odds: 7.71 },
  { id: 'E', name: 'Horse E', odds: 8.71 },
  { id: 'F', name: 'Horse F', odds: 9.54 },
  { id: 'G', name: 'Horse G', odds: 10.55 },
  { id: 'H', name: 'Horse H', odds: 11.79 },
];

// 8 tipsters, each backing a different horse, all with identical mediocre
// stats => no consensus and no quality differentiation.
export const SCENARIO_2_TIPSTERS: ScenarioTipster[] = SCENARIO_2_RUNNERS.map(
  (r, i) => ({
    id: `T${i + 1}`,
    tier: 'average',
    pick: r.id,
    roi: 0.0,
    ae: 1.0,
    strike_rate: 0.12,
  }),
);

// ---------------------------------------------------------------------------
// Scenario 3: "favourite justified" — a genuine short-priced favourite backed
// by several strong tipsters, where the anti-crowd bias should NOT suppress it.
// ---------------------------------------------------------------------------

export const SCENARIO_3_RUNNERS: ScenarioRunner[] = [
  { id: 'A', name: 'Horse A', odds: 3.0 },
  { id: 'B', name: 'Horse B', odds: 4.5 },
  { id: 'C', name: 'Horse C', odds: 6.0 },
  { id: 'D', name: 'Horse D', odds: 8.0 },
  { id: 'E', name: 'Horse E', odds: 10.0 },
  { id: 'F', name: 'Horse F', odds: 13.0 },
  { id: 'G', name: 'Horse G', odds: 17.0 },
  { id: 'H', name: 'Horse H', odds: 26.0 },
];

// 8 tipsters. 3 strong, sharp tipsters back the favourite (A) — that is only
// 37.5% of the crowd, just under the 40% over-hyped-favourite penalty line, so
// the favourite is justified rather than over-bet. The rest give weaker, noisy
// support spread across other runners.
export const SCENARIO_3_TIPSTERS: ScenarioTipster[] = [
  { id: 'T1', tier: 'strong', pick: 'A', roi: 0.2, ae: 1.15, strike_rate: 0.22 },
  { id: 'T2', tier: 'strong', pick: 'A', roi: 0.23, ae: 1.22, strike_rate: 0.24 },
  { id: 'T3', tier: 'strong', pick: 'A', roi: 0.25, ae: 1.3, strike_rate: 0.26 },
  { id: 'T4', tier: 'average', pick: 'B', roi: 0.04, ae: 1.01, strike_rate: 0.15 },
  { id: 'T5', tier: 'weak', pick: 'C', roi: -0.05, ae: 0.9, strike_rate: 0.1 },
  { id: 'T6', tier: 'weak', pick: 'D', roi: -0.1, ae: 0.85, strike_rate: 0.09 },
  { id: 'T7', tier: 'weak', pick: 'E', roi: -0.08, ae: 0.88, strike_rate: 0.1 },
  { id: 'T8', tier: 'average', pick: 'B', roi: 0.02, ae: 1.0, strike_rate: 0.14 },
];

// ---------------------------------------------------------------------------
// Scenario 4: "duplicate alias protection" — the same tipster appears under
// several display names. The engine keys support on the canonical `id`, so the
// aliased variant must produce identical results to a single-entry (deduped)
// variant. A third "distinct" variant (genuinely different ids) proves the
// dedup is load-bearing.
// ---------------------------------------------------------------------------

export const SCENARIO_4_RUNNERS: ScenarioRunner[] = [
  { id: 'A', name: 'Horse A', odds: 3.5 },
  { id: 'B', name: 'Horse B', odds: 4.0 },
  { id: 'C', name: 'Horse C', odds: 6.0 },
  { id: 'D', name: 'Horse D', odds: 9.0 },
  { id: 'E', name: 'Horse E', odds: 12.0 },
];

// Stats for one sharp tipster — the canonical identity behind the aliases.
const SHARP_SAM = { roi: 0.22, ae: 1.25, strike_rate: 0.25 } as const;

// Backers shared by every Scenario 4 variant.
const SCENARIO_4_OTHERS: ScenarioTipster[] = [
  { id: 'T_b', tier: 'average', pick: 'B', roi: 0.05, ae: 1.02, strike_rate: 0.15 },
  { id: 'T_c', tier: 'weak', pick: 'C', roi: -0.05, ae: 0.92, strike_rate: 0.11 },
  { id: 'T_d', tier: 'weak', pick: 'D', roi: -0.08, ae: 0.88, strike_rate: 0.1 },
];

// ALIASED: one tipster (canonical id 'sharp_sam') appears 3x under different
// display names, all backing Horse D.
export const SCENARIO_4_ALIASED_TIPSTERS: ScenarioTipster[] = [
  { id: 'sharp_sam', alias: 'SamTips', pick: 'D', ...SHARP_SAM },
  { id: 'sharp_sam', alias: 'SammyT', pick: 'D', ...SHARP_SAM },
  { id: 'sharp_sam', alias: 'S_Smith', pick: 'D', ...SHARP_SAM },
  ...SCENARIO_4_OTHERS,
];

// DEDUPED: the same tipster, listed once.
export const SCENARIO_4_DEDUPED_TIPSTERS: ScenarioTipster[] = [
  { id: 'sharp_sam', alias: 'SamTips', pick: 'D', ...SHARP_SAM },
  ...SCENARIO_4_OTHERS,
];

// DISTINCT (contrast): three GENUINELY different tipsters backing Horse D.
// Distinct ids must legitimately add more support than a single deduped
// backer — proving the dedup above is doing real work, not vacuously passing.
export const SCENARIO_4_DISTINCT_TIPSTERS: ScenarioTipster[] = [
  { id: 'sam_1', alias: 'Sam One', pick: 'D', ...SHARP_SAM },
  { id: 'sam_2', alias: 'Sam Two', pick: 'D', ...SHARP_SAM },
  { id: 'sam_3', alias: 'Sam Three', pick: 'D', ...SHARP_SAM },
  ...SCENARIO_4_OTHERS,
];

// ---------------------------------------------------------------------------
// Scenario 5: "non-runner handling" — a clear top pick is withdrawn before the
// off. Re-running with that runner removed must exclude it, renormalise market
// probabilities over the survivors, and produce a fresh recommendation, without
// penalising the tipsters whose selection was voided.
//
// Void modelling (faithful to the current engine, which has no settlement /
// non-runner concept): the withdrawn runner is removed from the FIELD, while
// the tipster pool (their global priors) is left intact. A voided selection
// therefore points at a runner no longer in the field and contributes no
// support — exactly what the engine does today when fed such selections.
//
// All odds sit in the 2.0–12.0 value band so the odds-band filter is neutral.
// ---------------------------------------------------------------------------

export const SCENARIO_5_RUNNERS: ScenarioRunner[] = [
  { id: 'A', name: 'Horse A', odds: 3.0 },
  { id: 'B', name: 'Horse B', odds: 4.0 },
  { id: 'C', name: 'Horse C', odds: 5.0 },
  { id: 'D', name: 'Horse D', odds: 6.0 },
  { id: 'E', name: 'Horse E', odds: 8.0 },
  { id: 'F', name: 'Horse F', odds: 10.0 },
];

// 9 tipsters with varied quality. Horse D draws the strongest combined backing
// (3 sharp tipsters, 33% crowd — under the 40% over-hyped line) and is the top
// pick. Horse B is the clear second (2 backers incl. the sharpest). The roi/ae
// extremes are deliberately held by survivor-backers (T4 on B, T8 on F), not by
// D's backers.
export const SCENARIO_5_TIPSTERS: ScenarioTipster[] = [
  { id: 'T1', tier: 'strong', pick: 'D', roi: 0.18, ae: 1.15, strike_rate: 0.22 },
  { id: 'T2', tier: 'strong', pick: 'D', roi: 0.19, ae: 1.16, strike_rate: 0.225 },
  { id: 'T3', tier: 'strong', pick: 'D', roi: 0.2, ae: 1.18, strike_rate: 0.23 },
  { id: 'T4', tier: 'strong', pick: 'B', roi: 0.22, ae: 1.2, strike_rate: 0.24 },
  { id: 'T5', tier: 'average', pick: 'B', roi: 0.1, ae: 1.05, strike_rate: 0.16 },
  { id: 'T6', tier: 'average', pick: 'C', roi: 0.05, ae: 1.0, strike_rate: 0.14 },
  { id: 'T7', tier: 'weak', pick: 'E', roi: -0.05, ae: 0.9, strike_rate: 0.11 },
  { id: 'T8', tier: 'weak', pick: 'F', roi: -0.1, ae: 0.85, strike_rate: 0.1 },
  { id: 'T9', tier: 'average', pick: 'A', roi: 0.0, ae: 0.95, strike_rate: 0.12 },
];
