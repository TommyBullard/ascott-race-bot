/**
 * Backtest harness: does needle-weighted tipster scoring beat a control on real
 * past races, measured by ROI at Betfair SP?
 *
 * For each race in scope this script (READ-ONLY):
 *   1. fetches the race's priced field + tipster data, then
 *   2. scores it with `scoreRaceRunners` — the SAME pure scoring core that
 *      `runModelForRace` uses, so backtest results match production exactly —
 *      once per mode, and
 *   3. compares each mode's rank-1 pick (highest EV) to the actual winner
 *      (`runners.finish_pos = 1`), settling P/L at level 1pt stakes.
 *
 * It prints a side-by-side comparison of two modes — NEEDLE (real tipster_priors
 * weights) vs a CONTROL — with races, strike rate, ROI% at BSP (falling back to
 * the quoted decimal odds, then SP), level-stakes P/L, max drawdown, and a
 * breakdown by the pick's odds band (<3.0, 3.0-8.0, >8.0). All three modes share
 * the identical scoring core and differ ONLY in tipster inputs, so any ROI gap
 * is attributable purely to tipster weighting (no parameters are tuned here).
 *
 * DRY RUN BY DESIGN: this harness only READS. It never writes to model_runs,
 * model_runner_scores, recommendations, or any other table, so it can never
 * pollute the live recommendations. Settlement data (finish_pos / BSP) must
 * already exist in the DB for a race to be evaluated.
 *
 * Usage:
 *   npm run backtest                                  # all races, needle vs flat
 *   npm run backtest -- --from 2026-06-01 --to 2026-06-12
 *   npm run backtest -- --date 2026-06-10
 *   npm run backtest -- --races <id1>,<id2>,<id3>
 *   npm run backtest -- --control market              # needle vs market-only
 *   (optional)            --bankroll 1000
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local`.
 */

import {
  fetchRaceIdsInRange,
  fetchRaceModelInputs,
  fetchTipsterSelections,
  getTipsterStats,
} from '../src/lib/raceData';
import {
  scoreRaceRunners,
  tipsterStatsFromPriors,
} from '../src/lib/runModelForRace';
import type { TipsterStats, TipsterSelection } from '../src/lib/modelProbabilities';
import {
  bandOf,
  summarize,
  type Evaluated,
  type ModeSummary,
} from '../src/lib/backtestStats';
import { supabaseAdmin } from '../src/lib/supabaseAdmin';

/** Bankroll for stake sizing (only affects the +EV flag, not the EV ranking). */
const DEFAULT_BANKROLL = 1000;

/**
 * Betting modes the harness can compare. All three run through the SAME scoring
 * core (`scoreRaceRunners`); they differ ONLY in the tipster inputs handed to
 * it, so any ROI difference is attributable purely to tipster weighting:
 * - `needle` : real `tipster_priors` quality weights (production behaviour).
 * - `flat`   : same selections, but every tipster weighted equally (empty stats
 *              => each backer gets the neutral 0.5 weight) — isolates the value
 *              of needle-weighting vs treating all tipsters the same.
 * - `market` : no tipster influence at all (empty selections) — market-implied
 *              probabilities shaped only by the engine's odds-band multipliers.
 */
type Mode = 'needle' | 'flat' | 'market';
type ControlKind = Exclude<Mode, 'needle'>;

const MODE_LABEL: Record<Mode, string> = {
  needle: 'NEEDLE (real priors)',
  flat: 'CONTROL flat/equal',
  market: 'CONTROL market-only',
};

/** Coerces a possibly null/string DB numeric to a finite number, else null. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface RunnerResultRow {
  id: string;
  finish_pos: number | null;
  bsp_decimal: number | string | null;
  sp_decimal: number | string | null;
}

/** Loads env from .env.local then .env (first found wins). */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Try the next; fall back to the shell environment.
    }
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Args {
  from?: string;
  to?: string;
  date?: string;
  races?: string;
  bankroll?: string;
  control?: string;
  mode?: string;
}

/** Minimal `--flag value` parser (no external deps). */
function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return args as Args;
}

function usageAndExit(): never {
  console.error(
    'Usage: npm run backtest -- ' +
      '[--from YYYY-MM-DD --to YYYY-MM-DD | --date YYYY-MM-DD | --races id1,id2,...] ' +
      '[--control flat|market] [--mode needle|flat|market] [--bankroll N]\n' +
      '(no scope flag => all races in the DB; --mode runs ONE mode only, e.g. ' +
      '--mode market for engine-on-market-prices with no tipster data)',
  );
  process.exit(1);
}

const pad = (s: unknown, w: number) => String(s).padEnd(w);
const padL = (s: unknown, w: number) => String(s).padStart(w);
const rule = (n = 64) => console.log('-'.repeat(n));
const signed = (n: number, suffix = '') =>
  `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)}${suffix}`;

async function resolveRaceIds(
  args: Args,
): Promise<{ raceIds: string[]; scope: string }> {
  if (args.races) {
    const raceIds = args.races
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { raceIds, scope: `${raceIds.length} race id(s)` };
  }
  if (args.date) {
    if (!DATE_RE.test(args.date)) usageAndExit();
    return {
      raceIds: await fetchRaceIdsInRange(args.date, args.date),
      scope: `date ${args.date}`,
    };
  }
  if (args.from && args.to) {
    if (!DATE_RE.test(args.from) || !DATE_RE.test(args.to)) usageAndExit();
    return {
      raceIds: await fetchRaceIdsInRange(args.from, args.to),
      scope: `${args.from}..${args.to}`,
    };
  }
  // No scope flag: evaluate every race in the DB (a wide date range stands in
  // for "all races", since meeting_date is the only span we index on).
  return {
    raceIds: await fetchRaceIdsInRange('1900-01-01', '2999-12-31'),
    scope: 'all races',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local.',
    );
    process.exit(1);
  }

  const bankroll = args.bankroll ? Number(args.bankroll) : DEFAULT_BANKROLL;
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    console.error(`Invalid --bankroll: ${args.bankroll}`);
    process.exit(1);
  }

  const { raceIds, scope } = await resolveRaceIds(args);

  console.log('');
  console.log('=== Model backtest ===');
  console.log('Mode: DRY RUN (read-only) — no production tables are written.');
  console.log(`Scope: ${scope}`);
  console.log(`Races found: ${raceIds.length}`);

  if (raceIds.length === 0) {
    console.log('Nothing to evaluate.');
    return;
  }

  // Tipster priors are global (not race-specific): fetch once and reuse, so the
  // scoring matches runModelForRace without a per-race round trip.
  const tipsterPriors = await getTipsterStats().catch(() => []);
  const realStats = tipsterStatsFromPriors(tipsterPriors);

  // Validate flags.
  if (args.control && args.control !== 'market' && args.control !== 'flat') {
    usageAndExit();
  }
  if (
    args.mode &&
    args.mode !== 'needle' &&
    args.mode !== 'flat' &&
    args.mode !== 'market'
  ) {
    usageAndExit();
  }

  // Mode selection:
  // - `--mode X` runs a SINGLE mode (clean one-column report). Use `--mode
  //   market` for engine-on-market-prices when there are no tipster picks.
  // - otherwise compare needle vs the requested control (default flat).
  const singleMode = args.mode as Mode | undefined;
  const control: ControlKind = args.control === 'market' ? 'market' : 'flat';
  const modes: Mode[] = singleMode ? [singleMode] : ['needle', control];

  if (singleMode) {
    console.log(
      `Single mode: ${MODE_LABEL[singleMode]}  ` +
        `(bankroll ${bankroll}; affects only the +EV flag, not picks)`,
    );
  } else {
    console.log(
      `Comparing: ${MODE_LABEL.needle}  vs  ${MODE_LABEL[control]}  ` +
        `(bankroll ${bankroll}; affects only the +EV flag, not picks)`,
    );
  }

  const evaluatedByMode: Record<Mode, Evaluated[]> = {
    needle: [],
    flat: [],
    market: [],
  };
  let skippedNoMarket = 0;
  let skippedNoResult = 0;

  for (const raceId of raceIds) {
    const inputs = await fetchRaceModelInputs(raceId);
    if (!inputs || inputs.runners.length === 0) {
      skippedNoMarket++;
      continue;
    }

    // Actual result, fetched ONCE per race (identical settlement for all modes).
    const { data: runnerData, error } = await supabaseAdmin
      .from('runners')
      .select('id, finish_pos, bsp_decimal, sp_decimal')
      .eq('race_id', raceId);
    if (error) {
      throw new Error(
        `Failed to fetch results for race ${raceId}: ${error.message}`,
      );
    }
    const rows = (runnerData ?? []) as RunnerResultRow[];
    const winner = rows.find((r) => Number(r.finish_pos) === 1);
    if (!winner) {
      skippedNoResult++;
      continue;
    }

    const selections = await fetchTipsterSelections(raceId).catch(() => []);
    const oddsByRunner = new Map(
      inputs.runners.map((r) => [r.runner_id, r.odds_decimal]),
    );

    // Score the SAME race under each mode; only the tipster inputs differ.
    for (const mode of modes) {
      const scored = scoreForMode(mode, inputs, selections, realStats, bankroll);
      if (scored.length === 0) continue;

      // The model's pick = highest-EV runner (rank 1). `scored` is EV-sorted.
      const pick = scored[0];
      const pickOdds = oddsByRunner.get(pick.runner_id) ?? null;
      if (pickOdds === null || pickOdds <= 1) continue;

      const won = String(winner.id) === pick.runner_id;
      let profit: number;
      if (won) {
        // Settle the pick at BSP, falling back to quoted odds, then SP.
        const pickRow = rows.find((r) => String(r.id) === pick.runner_id);
        const price =
          num(pickRow?.bsp_decimal) ?? pickOdds ?? num(pickRow?.sp_decimal);
        profit = price !== null && price > 1 ? price - 1 : 0;
      } else {
        profit = -1;
      }

      evaluatedByMode[mode].push({
        raceId,
        pickOdds,
        pickPositiveEV: pick.stake > 0,
        won,
        profit,
        band: bandOf(pickOdds),
      });
    }
  }

  // ---- Report ---------------------------------------------------------------
  console.log(`  skipped (no market data): ${skippedNoMarket}`);
  console.log(`  skipped (no result yet):  ${skippedNoResult}`);
  console.log('');

  const summaries = modes.map((m) => summarize(MODE_LABEL[m], evaluatedByMode[m]));

  // No-data guard (shared by both report paths).
  if (summaries[0].n === 0) {
    console.log(
      'No settled races with a model pick in scope — nothing to score.',
    );
    console.log(
      '(A race needs both a priced field AND a recorded winner (finish_pos=1) ' +
        'to be evaluated.)',
    );
    console.log('');
    console.log(
      'RESULT: the comparison could not be run — there is no real settled ' +
        'data to measure. See the summary printed by the caller.',
    );
    return;
  }

  if (singleMode) {
    printSingle(summaries[0]);
    return;
  }

  const [needleSum, controlSum] = summaries;
  printComparison(needleSum, controlSum);
}

/**
 * Scores a race under one mode. All modes share `scoreRaceRunners`; they differ
 * ONLY in the tipster inputs, so any ROI difference is purely the tipster effect:
 * - needle: real priors (production weights),
 * - flat:   real selections but empty stats => every backer gets the neutral
 *           0.5 weight (equal weighting; backer COUNT still matters, quality
 *           does not),
 * - market: no selections => market-implied probs shaped only by odds bands.
 */
function scoreForMode(
  mode: Mode,
  inputs: Parameters<typeof scoreRaceRunners>[0],
  selections: TipsterSelection[],
  realStats: TipsterStats[],
  bankroll: number,
) {
  if (mode === 'needle') {
    return scoreRaceRunners(inputs, selections, realStats, bankroll);
  }
  if (mode === 'flat') {
    return scoreRaceRunners(inputs, selections, [], bankroll);
  }
  return scoreRaceRunners(inputs, [], [], bankroll); // market-only
}

/** Formats a percentage or em-dash for a null (no-bet) value. */
function fPct(n: number | null): string {
  return n === null ? '—' : `${n.toFixed(1)}%`;
}

/** Formats a signed number (or em-dash) with an optional unit suffix. */
function fSigned(n: number | null, suffix = ''): string {
  return n === null ? '—' : signed(n, suffix);
}

/** Prints a single mode's headline metrics + odds-band table (no comparison). */
function printSingle(summary: ModeSummary): void {
  console.log(`=== ${summary.label} ===`);
  rule();
  console.log(
    `races ${summary.n} · wins ${summary.wins} · ` +
      `strike ${fPct(summary.strikeRatePct)} · ` +
      `P/L ${fSigned(summary.profit, 'pt')} · ` +
      `ROI ${fSigned(summary.roiPct)}% · ` +
      `max DD ${summary.maxDrawdown.toFixed(2)}pt · ` +
      `+EV ${summary.positiveEv}`,
  );
  rule();
  console.log('');

  console.log(`By odds band — ${summary.label} (pick price):`);
  rule();
  console.log(
    `${pad('band', 10)}${padL('races', 7)}${padL('wins', 6)}` +
      `${padL('SR%', 8)}${padL('P/L', 10)}${padL('ROI%', 9)}`,
  );
  rule();
  for (const b of summary.bands) {
    console.log(
      `${pad(b.band, 10)}${padL(b.races, 7)}${padL(b.wins, 6)}` +
        `${padL(fPct(b.strikeRatePct), 8)}${padL(fSigned(b.profit, 'pt'), 10)}` +
        `${padL(b.roiPct === null ? '—' : fSigned(b.roiPct) + '%', 9)}`,
    );
  }
  rule();
  console.log('');

  if (summary.n < 200) {
    console.log(
      `CAUTION: ${summary.n} race(s) is a small sample — treat strike/ROI as ` +
        `indicative (a sanity check), not a verdict. Wider samples needed to conclude.`,
    );
    console.log('');
  }
}

/** Prints the headline two-mode comparison plus each mode's odds-band table. */
function printComparison(needleSum: ModeSummary, controlSum: ModeSummary): void {
  const L = 20;
  const C = 24;
  const r2 = (label: string, a: string, b: string) =>
    console.log(pad(label, L) + padL(a, C) + padL(b, C));

  console.log('=== Comparison: needle vs control ===');
  rule(L + C * 2);
  r2('metric', needleSum.label, controlSum.label);
  rule(L + C * 2);
  r2('races', String(needleSum.n), String(controlSum.n));
  r2('wins', String(needleSum.wins), String(controlSum.wins));
  r2('strike rate', fPct(needleSum.strikeRatePct), fPct(controlSum.strikeRatePct));
  r2('P/L (level 1pt)', fSigned(needleSum.profit, 'pt'), fSigned(controlSum.profit, 'pt'));
  r2('ROI', fSigned(needleSum.roiPct) + '%', fSigned(controlSum.roiPct) + '%');
  r2('max drawdown', `${needleSum.maxDrawdown.toFixed(2)}pt`, `${controlSum.maxDrawdown.toFixed(2)}pt`);
  r2('+EV (would bet)', String(needleSum.positiveEv), String(controlSum.positiveEv));
  rule(L + C * 2);
  console.log('');

  for (const summary of [needleSum, controlSum]) {
    console.log(`By odds band — ${summary.label} (pick price):`);
    rule();
    console.log(
      `${pad('band', 10)}${padL('races', 7)}${padL('wins', 6)}` +
        `${padL('SR%', 8)}${padL('P/L', 10)}${padL('ROI%', 9)}`,
    );
    rule();
    for (const b of summary.bands) {
      console.log(
        `${pad(b.band, 10)}${padL(b.races, 7)}${padL(b.wins, 6)}` +
          `${padL(fPct(b.strikeRatePct), 8)}${padL(fSigned(b.profit, 'pt'), 10)}` +
          `${padL(b.roiPct === null ? '—' : fSigned(b.roiPct) + '%', 9)}`,
      );
    }
    rule();
    console.log('');
  }

  // Honest headline read on the ROI question.
  const nRoi = needleSum.roiPct ?? 0;
  const cRoi = controlSum.roiPct ?? 0;
  const diff = nRoi - cRoi;
  const verdict =
    diff > 0
      ? `needle beat the control by ${diff.toFixed(2)} ROI points`
      : diff < 0
        ? `needle TRAILED the control by ${Math.abs(diff).toFixed(2)} ROI points`
        : 'needle and the control tied on ROI';
  console.log(`Headline: ${verdict} over ${needleSum.n} settled race(s).`);
  if (needleSum.n < 200) {
    console.log(
      `CAUTION: ${needleSum.n} race(s) is far too small to conclude anything — ` +
        `single-race noise dwarfs any real edge. Not significant.`,
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
