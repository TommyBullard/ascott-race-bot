/**
 * DEBUG TEST SCENARIO 2: "No clear value".
 *
 * A deliberately flat race: every runner is fairly priced, tipsters are
 * maximally split (one each, no consensus), and there is no quality signal
 * (identical tipster stats). This is the control case for the engine — there is
 * nothing to find.
 *
 * It drives the REAL engine functions (`calculateModelProbabilities`,
 * `calculateEV`, `confidenceScore`, `kellyStake`, `pickBestHorse`,
 * `labelConfidence`), bypassing Supabase. Run with:  npm run simulate:novalue
 *
 * EXPECTATIONS (asserted against actual output at the end):
 *   1. System still returns a pick.
 *   2. EV is close to zero.
 *   3. Stake is VERY small — clamped to the 0.1% floor.
 *   4. Confidence is LOW.
 *   => Key question: does the system avoid overbetting? (Yes if 3 holds.)
 */

import {
  calculateModelProbabilities,
  type TipsterSelection,
  type TipsterStats,
  type ProbabilityRunner,
} from '../src/lib/modelProbabilities';
import {
  calculateEV,
  confidenceScore,
  kellyStake,
  labelConfidence,
  pickBestHorse,
  type Runner,
} from '../src/lib/bettingEngine';
import {
  diagnosticTipsterWeights,
  DEFAULT_BANKROLL,
  SCENARIO_2_RUNNERS,
  SCENARIO_2_TIPSTERS,
} from './scenarios';

// ---------------------------------------------------------------------------
// 1. Scenario definition (shared with the regression tests in scenarios.ts, so
//    the debug output and the assertions can never drift apart).
// ---------------------------------------------------------------------------

const BANKROLL = DEFAULT_BANKROLL;
const RUNNERS = SCENARIO_2_RUNNERS;
const TIPSTERS = SCENARIO_2_TIPSTERS;

/** 0.1% stake floor and the LOW/medium confidence boundary, for the checks. */
const STAKE_FLOOR = 0.001 * BANKROLL; // 1.0
const MEDIUM_CONFIDENCE_THRESHOLD = 0.55;

// Derive pipeline inputs.
const tipsterSelections: TipsterSelection[] = TIPSTERS.map((t) => ({
  runner_id: t.pick,
  tipster_id: t.id,
}));
const tipsterStats: TipsterStats[] = TIPSTERS.map((t) => ({
  tipster_id: t.id,
  roi: t.roi,
  ae: t.ae,
  strike_rate: t.strike_rate,
}));
const probabilityRunners: ProbabilityRunner[] = RUNNERS.map((r) => ({
  runner_id: r.id,
  odds: r.odds,
}));

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const pad = (s: unknown, w: number) => String(s).padEnd(w);
const rpad = (s: unknown, w: number) => String(s).padStart(w);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const sgnPct = (x: number) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const fix = (x: number, n = 4) => x.toFixed(n);
const rule = (n = 96) => console.log('-'.repeat(n));

// ---------------------------------------------------------------------------
// 2-5. Run the full pipeline
// ---------------------------------------------------------------------------

console.log('');
console.log('============================================================');
console.log('  SCENARIO 2: NO CLEAR VALUE — BETTING ENGINE DEBUG TEST');
console.log('============================================================');
console.log(
  `  Runners: ${RUNNERS.length}   Tipsters: ${TIPSTERS.length}   Bankroll: ${BANKROLL}`,
);
console.log('  Setup: fair book, tipsters maximally split, no quality signal.');
console.log('');

// Market probabilities (de-overrounded).
const impliedRaw = RUNNERS.map((r) => 1 / r.odds);
const overround = impliedRaw.reduce((s, v) => s + v, 0);
const marketProb = new Map<string, number>(
  RUNNERS.map((r, i) => [r.id, impliedRaw[i] / overround]),
);

// Diagnostic: crowd share & weighted support per runner.
const diagWeights = diagnosticTipsterWeights(tipsterStats);
const totalTipsters = TIPSTERS.length;
const backersByRunner = new Map<string, string[]>();
for (const t of TIPSTERS) {
  const arr = backersByRunner.get(t.pick) ?? [];
  arr.push(t.id);
  backersByRunner.set(t.pick, arr);
}
const crowdShare = new Map<string, number>();
const weightedSupport = new Map<string, number>();
for (const r of RUNNERS) {
  const backers = backersByRunner.get(r.id) ?? [];
  crowdShare.set(r.id, backers.length / totalTipsters);
  weightedSupport.set(
    r.id,
    backers.reduce((s, id) => s + (diagWeights.get(id) ?? 0), 0),
  );
}

// Build model probabilities (REAL pipeline).
const probabilities = calculateModelProbabilities(
  probabilityRunners,
  tipsterSelections,
  tipsterStats,
);
const modelProb = new Map<string, number>(
  probabilities.map((p) => [String(p.runner_id), p.model_prob]),
);

// EV per runner & ranking.
interface RunnerDebug {
  id: string;
  name: string;
  odds: number;
  market: number;
  model: number;
  crowd: number;
  weighted: number;
  ev: number;
  rank: number;
}

const debugRows: RunnerDebug[] = RUNNERS.map((r) => {
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
[...debugRows]
  .sort((a, b) => b.ev - a.ev)
  .forEach((row, i) => {
    row.rank = i + 1;
  });

// Pick best horse (REAL function).
const engineRunners: Runner[] = RUNNERS.map((r) => ({
  name: r.name,
  odds: r.odds,
  model_prob: modelProb.get(r.id) ?? 0,
}));
const best = pickBestHorse(engineRunners);

// ---------------------------------------------------------------------------
// FULL DEBUG TABLE
// ---------------------------------------------------------------------------

console.log('PER-RUNNER DEBUG  (sorted by rank / EV)');
rule();
console.log(
  `${rpad('Rank', 5)}  ${pad('Horse', 9)}${rpad('Odds', 7)}${rpad('Market%', 10)}${rpad('Model%', 10)}${rpad('Crowd%', 9)}${rpad('WtSupport', 11)}${rpad('EV', 11)}`,
);
rule();
for (const row of [...debugRows].sort((a, b) => a.rank - b.rank)) {
  console.log(
    `${rpad(row.rank, 5)}  ${pad(row.name, 9)}${rpad(fix(row.odds, 2), 7)}${rpad(pct(row.market), 10)}${rpad(pct(row.model), 10)}${rpad(pct(row.crowd), 9)}${rpad(fix(row.weighted, 3), 11)}${rpad(sgnPct(row.ev), 11)}`,
  );
}
rule();
console.log(
  `Overround (sum of 1/odds): ${fix(overround, 4)}  (book margin ${sgnPct(overround - 1)})`,
);
console.log(
  `Model probability sum check: ${fix(debugRows.reduce((s, r) => s + r.model, 0), 6)} (should be 1.0)`,
);
const evSpread =
  Math.max(...debugRows.map((r) => r.ev)) -
  Math.min(...debugRows.map((r) => r.ev));
console.log(`EV spread across field: ${fix(evSpread * 100, 4)} pts`);
console.log('');

// ---------------------------------------------------------------------------
// FINAL RESULT
// ---------------------------------------------------------------------------

if (!best) {
  console.log('No runners — no recommendation.');
  process.exit(0);
}

const bestId = RUNNERS.find((r) => r.name === best.name)!.id;
const bestRow = debugRows.find((r) => r.id === bestId)!;
const bestBackers = backersByRunner.get(bestId) ?? [];

const confidence = confidenceScore({
  ev: bestRow.ev,
  modelProb: bestRow.model,
  marketProb: bestRow.market,
  tipsterCount: bestBackers.length,
});
const confLabel = labelConfidence(confidence);
const stake = kellyStake(bestRow.model, bestRow.odds, BANKROLL, confidence);

console.log('============================================================');
console.log('  FINAL RESULT');
console.log('============================================================');
console.log(`  Selected horse : ${best.name}  @ ${fix(bestRow.odds, 2)}`);
console.log(`  Expected value : ${sgnPct(bestRow.ev)}`);
console.log(
  `  Confidence     : ${confLabel.toUpperCase()}  (score ${fix(confidence, 4)})`,
);
console.log(
  `  Recommended stake : ${fix(stake, 2)}  (${pct(stake / BANKROLL)} of bankroll)`,
);
console.log('');

// ---------------------------------------------------------------------------
// REASONING
// ---------------------------------------------------------------------------

console.log('REASONING — why no real bet here?');
rule();
console.log(
  `1. FAIR BOOK: overround is ${fix(overround, 4)} (${sgnPct(overround - 1)} margin), so market ` +
    `prices are ~fair. De-overrounded market probabilities are the baseline.`,
);
console.log(
  `2. SPLIT TIPSTERS: all ${totalTipsters} tipsters back different horses (crowd share ` +
    `${pct(1 / totalTipsters)} each) — nobody clears the 40% favourite-penalty line and there is ` +
    `no consensus to amplify.`,
);
console.log(
  `3. NO QUALITY SIGNAL: identical tipster stats => identical weights => weighted share equals ` +
    `crowd share for every runner => anti-crowd value_signal = 0 throughout.`,
);
console.log(
  `4. NEUTRAL BANDS: every price is inside the 2.0–12.0 value zone (x1.0), so nothing is ` +
    `reshaped by the odds-band filter.`,
);
console.log(
  `5. MODEL == MARKET: with a uniform support multiplier, the model never diverges from the ` +
    `market. EV is therefore flat at ${sgnPct(bestRow.ev)} across the whole field (spread ` +
    `${fix(evSpread * 100, 4)} pts) — purely the small book generosity, not genuine value.`,
);
console.log(
  `6. PICK IS A FORMALITY: EVs are tied, so the engine returns the first runner (${best.name}) ` +
    `as a tie-break. There is no standout.`,
);
console.log(
  `7. STAKING DISCIPLINE: edge over market is ${sgnPct(bestRow.model - bestRow.market)}, so the ` +
    `value gate (and confidence) collapse to ${fix(confidence, 4)} = LOW. Fractional Kelly on a ` +
    `sub-1% edge falls below the 0.1% floor and is clamped UP to ${fix(STAKE_FLOOR, 2)}.`,
);
rule();
console.log('');

// ---------------------------------------------------------------------------
// EXPECTATION CHECKS
// ---------------------------------------------------------------------------

const checks: { label: string; pass: boolean; detail: string }[] = [
  {
    label: 'Returns a pick',
    pass: Boolean(best),
    detail: `selected ${best.name}`,
  },
  {
    label: 'EV close to zero',
    pass: Math.abs(bestRow.ev) < 0.01,
    detail: `EV = ${sgnPct(bestRow.ev)} (|EV| < 1%)`,
  },
  {
    label: 'Stake at floor (very small)',
    pass: stake > 0 && stake <= STAKE_FLOOR + 1e-9,
    detail: `stake = ${fix(stake, 2)} (floor = ${fix(STAKE_FLOOR, 2)})`,
  },
  {
    label: 'Confidence LOW',
    pass: confidence < MEDIUM_CONFIDENCE_THRESHOLD,
    detail: `confidence = ${fix(confidence, 4)} (< ${MEDIUM_CONFIDENCE_THRESHOLD})`,
  },
  {
    label: 'Avoids overbetting',
    pass: stake <= STAKE_FLOOR + 1e-9,
    detail: `exposure capped at the ${pct(STAKE_FLOOR / BANKROLL)} floor despite +EV`,
  },
];

console.log('EXPECTATION CHECKS');
rule();
for (const c of checks) {
  console.log(`  [${c.pass ? 'PASS' : 'FAIL'}]  ${pad(c.label, 30)} ${c.detail}`);
}
rule();
const allPass = checks.every((c) => c.pass);
console.log(
  `  ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} — the system ${allPass ? 'avoids overbetting when there is no edge.' : 'did not behave as expected.'}`,
);
console.log('');

process.exit(allPass ? 0 : 1);
