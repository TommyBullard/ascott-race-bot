/**
 * DEBUG TEST SCENARIO: Royal Ascot simulation.
 *
 * Drives the full betting pipeline end-to-end on a single hand-crafted race and
 * prints exhaustive debug output. It exercises the REAL engine functions
 * (`calculateModelProbabilities`, `calculateEV`, `confidenceScore`,
 * `kellyStake`, `pickBestHorse`, `labelConfidence`) rather than re-implementing
 * them, so the numbers reflect actual production logic.
 *
 * The Supabase-backed `recommendBet` is intentionally bypassed — this harness
 * supplies the data directly so it runs with no database or env vars.
 *
 * Run with:  npm run simulate
 *
 * NOTE: a few intermediate diagnostics (per-tipster weight, weighted support,
 * crowd share) are recomputed here purely for display, mirroring the internal
 * logic of `modelProbabilities.ts`. The authoritative `model_prob` always comes
 * from the real `calculateModelProbabilities`.
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
  SCENARIO_1_RUNNERS,
  SCENARIO_1_TIPSTERS,
} from './scenarios';

// ---------------------------------------------------------------------------
// 1. Scenario definition (shared with the regression tests in scenarios.ts, so
//    the debug output and the assertions can never drift apart).
// ---------------------------------------------------------------------------

const BANKROLL = DEFAULT_BANKROLL;
const RUNNERS = SCENARIO_1_RUNNERS;
const TIPSTERS = SCENARIO_1_TIPSTERS;

// Derive the pipeline inputs from the scenario.
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
// 2-6. Run the full pipeline
// ---------------------------------------------------------------------------

console.log('');
console.log('============================================================');
console.log('  ROYAL ASCOT SIMULATION — BETTING ENGINE DEBUG TEST');
console.log('============================================================');
console.log(`  Runners: ${RUNNERS.length}   Tipsters: ${TIPSTERS.length}   Bankroll: ${BANKROLL}`);
console.log('');

// --- Inputs: tipsters & selections ----------------------------------------
console.log('TIPSTERS & SELECTIONS');
rule();
console.log(
  `${pad('Tipster', 9)}${pad('Tier', 10)}${pad('Picks', 8)}${rpad('ROI', 8)}${rpad('A/E', 8)}${rpad('Strike', 9)}`,
);
rule();
const diagWeights = diagnosticTipsterWeights(tipsterStats);
for (const t of TIPSTERS) {
  console.log(
    `${pad(t.id, 9)}${pad(t.tier, 10)}${pad(t.pick, 8)}${rpad(fix(t.roi, 2), 8)}${rpad(fix(t.ae, 2), 8)}${rpad(pct(t.strike_rate), 9)}`,
  );
}
rule();
console.log('');

// --- Diagnostic: computed tipster weights ----------------------------------
console.log('TIPSTER QUALITY WEIGHTS  (0.5*normROI + 0.3*normA/E + 0.2*strike)');
rule();
for (const t of TIPSTERS) {
  console.log(
    `${pad(t.id, 9)}${pad(`(${t.tier})`, 10)}weight = ${fix(diagWeights.get(t.id) ?? 0)}`,
  );
}
rule();
console.log('');

// --- Market probabilities (de-overrounded) ---------------------------------
const impliedRaw = RUNNERS.map((r) => 1 / r.odds);
const overround = impliedRaw.reduce((s, v) => s + v, 0);
const marketProb = new Map<string, number>(
  RUNNERS.map((r, i) => [r.id, impliedRaw[i] / overround]),
);

// --- Diagnostic: crowd share & weighted support per runner -----------------
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

// --- Step: build model probabilities (REAL pipeline) -----------------------
const probabilities = calculateModelProbabilities(
  probabilityRunners,
  tipsterSelections,
  tipsterStats,
);
const modelProb = new Map<string, number>(
  probabilities.map((p) => [String(p.runner_id), p.model_prob]),
);

// --- Step: EV per runner & ranking -----------------------------------------
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

// Assign ranks by EV (descending).
[...debugRows]
  .sort((a, b) => b.ev - a.ev)
  .forEach((row, i) => {
    row.rank = i + 1;
  });

// --- Step: pick best horse (REAL function) ---------------------------------
const engineRunners: Runner[] = RUNNERS.map((r) => ({
  name: r.name,
  odds: r.odds,
  model_prob: modelProb.get(r.id) ?? 0,
}));
const best = pickBestHorse(engineRunners);

// ---------------------------------------------------------------------------
// 5. FULL DEBUG TABLE
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
console.log(`Overround (sum of 1/odds): ${fix(overround, 4)}  (book margin ${pct(overround - 1)})`);
console.log(
  `Model probability sum check: ${fix(debugRows.reduce((s, r) => s + r.model, 0), 6)} (should be 1.0)`,
);
console.log('');

// ---------------------------------------------------------------------------
// 6. FINAL RESULT
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
console.log(`  Confidence     : ${confLabel.toUpperCase()}  (score ${fix(confidence, 4)})`);
console.log(`  Recommended stake : ${fix(stake, 2)}  (${pct(stake / BANKROLL)} of bankroll)`);
console.log('');

// ---------------------------------------------------------------------------
// 7. WHY did the model choose this horse?
// ---------------------------------------------------------------------------

const favourite = [...debugRows].sort((a, b) => b.crowd - a.crowd)[0];
const oddsBand =
  bestRow.odds < 2.0
    ? 'short (<2.0) → penalised x0.8'
    : bestRow.odds > 12.0
      ? 'high (>12.0) → penalised x0.85'
      : 'value zone (2.0–12.0) → neutral x1.0';

console.log('REASONING — why this horse?');
rule();
console.log(
  `1. VALUE vs CROWD: ${best.name} carries weighted support ${fix(bestRow.weighted, 3)} from ` +
    `${bestBackers.length} tipster(s) [${bestBackers.join(', ')}] while only attracting ` +
    `${pct(bestRow.crowd)} of the crowd. Quality-weighted backing outruns raw popularity, so the ` +
    `anti-crowd bias BOOSTS it.`,
);
console.log(
  `2. FAVOURITE FADED: ${favourite.name} is the crowd favourite at ${pct(favourite.crowd)} backing ` +
    `(model ${pct(favourite.model)}, EV ${sgnPct(favourite.ev)}). Crowd share > 40% triggers the ` +
    `overhyped-favourite penalty (x0.5), pulling its probability down despite the most tips.`,
);
console.log(
  `3. ODDS BAND: ${best.name} at ${fix(bestRow.odds, 2)} sits in the ${oddsBand}.`,
);
console.log(
  `4. EDGE: model ${pct(bestRow.model)} vs market ${pct(bestRow.market)} = ` +
    `+${pct(bestRow.model - bestRow.market)} edge → EV ${sgnPct(bestRow.ev)} (rank #${bestRow.rank} of ${RUNNERS.length}).`,
);
console.log(
  `5. CONFIDENCE: strong EV gate combined with ${bestBackers.length} backing tipster(s) yields ` +
    `${confLabel.toUpperCase()} confidence (${fix(confidence, 4)}); Kelly then sizes the stake at ${fix(stake, 2)}.`,
);
rule();
console.log('');
