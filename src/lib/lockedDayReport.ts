/**
 * Pure helpers for the read-only "locked-decision performance report"
 * (scripts/lockedReport.ts) — Newmarket rebuild Phase 5A.
 *
 * The report evaluates the OFFICIAL race-day decisions — `locked_race_decisions`
 * rows at the official T-minus horizon (`minutes_before = 5`) — against the
 * stored results (`runners.finish_pos`), and compares them with the FINAL
 * PRE-OFF diagnostic pick (the rule every legacy report still uses). It exists
 * because Newmarket 2026-07-09 exposed the gap: the official locked pick in the
 * final race lost while the final diagnostic pick won — a divergence the
 * pre-off-based reports cannot see.
 *
 * HONESTY RULES (each enforced by lockedDayReport.test.ts):
 *   - PENDING RACES ARE NEVER LOSSES (unsettled locked picks stay pending).
 *   - `locked_no_bet` is a VALID official decision — never a loss.
 *   - `no_run_available` is its own bucket — never a loss, never a no-bet.
 *   - `lock_missing` (no lock row) is its own bucket — never a loss, never a
 *     no-bet, and NEVER rewritten; the pre-off fallback pick is shown for those
 *     races in a clearly-labelled section OUTSIDE the official figures.
 *   - Official P/L uses ONLY the stored locked pick odds/stake (via the shared
 *     {@link summarizeModelPerformance}); nothing is fabricated — missing
 *     values render as an em dash.
 *   - Divergence is ANALYSIS ONLY: the locked decision remains the official
 *     record; this module has no way to change it (pure, no I/O, no mutation).
 *
 * Everything here is pure and deterministic: `generatedAt` is taken verbatim
 * from the input, so a given report object always renders to the same string.
 * Decision-support only — not betting advice.
 */

import {
  summarizeModelPerformance,
  type ModelPerformance,
  type RecommendationOutcome,
} from './modelPerformance';
import { parseTMinusCaptureArgs, type TMinusCaptureArgs } from './tMinusCapture';
import type { LockedDecision } from './lockedDecisionRead';

/** The em dash used for every missing/unknown value. */
const DASH = '—';

/** The evaluation rule behind every official figure in this report. */
export const LOCKED_REPORT_EVALUATION_MODE = 'locked_decision_first' as const;

/**
 * Highest finishing position counted as a "place" (same documented,
 * conservative approximation as the end-of-day report).
 */
export const LOCKED_PLACE_MAX_POSITION = 3;

/* -------------------------------------------------------------------------- */
/* Arguments + output path                                                    */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options: identical semantics to the capture/lock parsers. */
export type LockedReportArgs = TMinusCaptureArgs;

/**
 * Parses argv (sliced past `node script`). REUSES the T-minus capture parser
 * verbatim: `--date` strict YYYY-MM-DD, `--course` verbatim, `--minutes-before`
 * positive integer defaulting to 5 (the official horizon). There is no
 * `--commit` — this report is always read-only. Pure.
 */
export function parseLockedReportArgs(argv: readonly string[]): LockedReportArgs {
  return parseTMinusCaptureArgs(argv);
}

/**
 * Deterministic report path: `reports/locked-report-<date>[-<course-slug>].md`
 * (same slug rule as the other reports: lower-cased, non-alphanumerics
 * collapsed to `-`). Pure.
 */
export function buildLockedReportPath(date: string, course?: string | null): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `reports/locked-report-${date}`;
  return slug ? `${base}-${slug}.md` : `${base}.md`;
}

/* -------------------------------------------------------------------------- */
/* Input shapes (assembled by the read-only CLI)                              */
/* -------------------------------------------------------------------------- */

/** The final pre-off DIAGNOSTIC pick for a race (fallback rule), or absent. */
export interface DiagnosticPick {
  runner_id: string | null;
  horse_name: string | null;
  /** Stored recommendation odds, or null. */
  odds: number | null;
  /** The pick's recorded finishing position, or null. */
  finish_pos: number | null;
}

/** One race's fully-resolved evaluation input. */
export interface LockedReportRaceInput {
  race_id: string;
  race_name: string | null;
  course: string | null;
  off_time: string | null;
  /** Official locked decision, or null when NO lock row exists (lock_missing). */
  locked: LockedDecision | null;
  /** True when a finish_pos = 1 runner is recorded (the race is settled). */
  settled: boolean;
  /** The official winner's name, or null when pending/unknown. */
  winner_name: string | null;
  /** The locked pick runner's finish position, or null. */
  locked_pick_finish: number | null;
  /** Final pre-off diagnostic rank-1 pick, or null (diagnostic no-bet / no run). */
  diagnostic: DiagnosticPick | null;
  /** True when ANY pre-off model run exists (distinguishes no-bet from no-run). */
  diagnostic_run_exists: boolean;
}

/* -------------------------------------------------------------------------- */
/* Classification (pure, deterministic)                                       */
/* -------------------------------------------------------------------------- */

/** The five mutually exclusive official-status buckets. */
export type OfficialStatus =
  | 'locked_pick'
  | 'locked_no_bet'
  | 'no_run_available'
  | 'lock_missing';

/** Classifies a race's official status; no lock row -> lock_missing. Pure. */
export function classifyOfficialStatus(input: LockedReportRaceInput): OfficialStatus {
  return input.locked?.decision_status ?? 'lock_missing';
}

/** The official locked pick's outcome (only meaningful for locked_pick). */
export type LockedPickOutcome = 'won' | 'lost' | 'pending' | 'unevaluable';

/**
 * Evaluates the official locked pick: pending until the race settles (NEVER a
 * loss), won iff the locked pick runner finished 1st, otherwise lost. A
 * `locked_pick` row without a pick runner id (impossible per the schema CHECK,
 * but never guessed at) is `unevaluable` — excluded from winners AND losers.
 * Returns null for every non-locked_pick status. Pure.
 */
export function evaluateLockedPick(
  input: LockedReportRaceInput,
): LockedPickOutcome | null {
  if (classifyOfficialStatus(input) !== 'locked_pick') return null;
  if (!input.locked?.pick_runner_id) return 'unevaluable';
  if (!input.settled) return 'pending';
  return input.locked_pick_finish === 1 ? 'won' : 'lost';
}

/** How the official decision and the final pre-off diagnostic pick relate. */
export type PickDivergence =
  | 'same_pick'
  | 'different_pick'
  | 'official_no_bet_diagnostic_pick'
  | 'official_pick_diagnostic_no_bet'
  | 'same_no_bet'
  | 'not_comparable';

/**
 * Classifies pick divergence. `lock_missing` and `no_run_available` races have
 * no official pick basis, so they are `not_comparable` (their fallback /
 * diagnostic picks still appear in the report, outside the official figures).
 * Pure.
 */
export function classifyPickDivergence(input: LockedReportRaceInput): PickDivergence {
  const status = classifyOfficialStatus(input);
  if (status === 'lock_missing' || status === 'no_run_available') {
    return 'not_comparable';
  }
  const officialPickId = input.locked?.pick_runner_id ?? null;
  const diagnosticPickId = input.diagnostic?.runner_id ?? null;

  if (status === 'locked_no_bet') {
    if (diagnosticPickId) return 'official_no_bet_diagnostic_pick';
    return input.diagnostic_run_exists ? 'same_no_bet' : 'not_comparable';
  }
  // status === 'locked_pick'
  if (!diagnosticPickId) {
    return input.diagnostic_run_exists
      ? 'official_pick_diagnostic_no_bet'
      : 'not_comparable';
  }
  return officialPickId === diagnosticPickId ? 'same_pick' : 'different_pick';
}

/** Settled-race outcome divergence between the two picks (else null). */
export type OutcomeDivergence =
  | 'diagnostic_won_official_lost'
  | 'official_won_diagnostic_lost'
  | null;

/**
 * Tags the outcome divergence for a SETTLED race where the official decision
 * and the diagnostic pick genuinely differ. The headline case — the diagnostic
 * pick won while the official locked decision lost (or was no-bet) — is why
 * this report exists (Newmarket 2026-07-09, final race). Pure.
 */
export function classifyOutcomeDivergence(
  input: LockedReportRaceInput,
): OutcomeDivergence {
  if (!input.settled) return null;
  const divergence = classifyPickDivergence(input);
  const diagnosticWon = input.diagnostic?.finish_pos === 1;
  const officialOutcome = evaluateLockedPick(input);

  if (divergence === 'different_pick' || divergence === 'official_no_bet_diagnostic_pick') {
    if (diagnosticWon && officialOutcome !== 'won') return 'diagnostic_won_official_lost';
  }
  if (divergence === 'different_pick' || divergence === 'official_pick_diagnostic_no_bet') {
    if (officialOutcome === 'won' && !diagnosticWon) return 'official_won_diagnostic_lost';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Report assembly                                                            */
/* -------------------------------------------------------------------------- */

/** One race with its derived classifications attached. */
export interface LockedReportRace extends LockedReportRaceInput {
  official_status: OfficialStatus;
  locked_outcome: LockedPickOutcome | null;
  pick_divergence: PickDivergence;
  outcome_divergence: OutcomeDivergence;
}

/** Lock coverage across the day. */
export interface LockCoverage {
  races: number;
  locked: number;
  missing: number;
  /** locked / races * 100, one decimal; 0 when no races. */
  coverage_pct: number;
  missing_races: { off_time: string | null; race_name: string | null }[];
}

/** The full report payload passed to the renderer. */
export interface LockedDayReport {
  date: string;
  course: string | null;
  minutes_before: number;
  /** Shown verbatim; never invented. */
  generatedAt: string;
  /** False when locked_race_decisions was unreadable (all races lock_missing). */
  locked_table_available: boolean;
  races: LockedReportRace[];
  coverage: LockCoverage;
  /** Official performance over locked_pick races ONLY (shared maths). */
  official: ModelPerformance;
  locked_no_bet_count: number;
  no_run_available_count: number;
  unevaluable_count: number;
}

/** Derives one race's classifications. Pure. */
export function buildLockedReportRace(input: LockedReportRaceInput): LockedReportRace {
  return {
    ...input,
    official_status: classifyOfficialStatus(input),
    locked_outcome: evaluateLockedPick(input),
    pick_divergence: classifyPickDivergence(input),
    outcome_divergence: classifyOutcomeDivergence(input),
  };
}

/**
 * Assembles the full report: per-race classifications, lock coverage, and the
 * OFFICIAL performance summary — locked_pick races only, at the STORED locked
 * odds/stake, via the shared {@link summarizeModelPerformance} (pending never
 * counted; a win with no usable odds returns 0, never an invented price).
 * `locked_no_bet` feeds only the summary's no-bet count; `no_run_available`,
 * `lock_missing`, and `unevaluable` rows are excluded entirely. Pure.
 */
export function buildLockedDayReport(params: {
  date: string;
  course: string | null;
  minutesBefore: number;
  generatedAt: string;
  lockedTableAvailable: boolean;
  inputs: readonly LockedReportRaceInput[];
}): LockedDayReport {
  const races = params.inputs.map(buildLockedReportRace);

  const missingRaces = races.filter((r) => r.official_status === 'lock_missing');
  const lockedCount = races.length - missingRaces.length;
  const coverage: LockCoverage = {
    races: races.length,
    locked: lockedCount,
    missing: missingRaces.length,
    coverage_pct:
      races.length === 0 ? 0 : Math.round((lockedCount / races.length) * 1000) / 10,
    missing_races: missingRaces.map((r) => ({
      off_time: r.off_time,
      race_name: r.race_name,
    })),
  };

  const outcomes: RecommendationOutcome[] = races
    .filter((r) => r.official_status === 'locked_pick' && r.locked_outcome !== 'unevaluable')
    .map((r) => ({
      settled: r.settled,
      won: r.locked_outcome === 'won',
      odds: r.locked?.pick_odds ?? null,
      stake: r.locked?.pick_stake ?? null,
      ev: r.locked?.pick_ev ?? null,
    }));
  const lockedNoBetCount = races.filter((r) => r.official_status === 'locked_no_bet').length;
  const noRunCount = races.filter((r) => r.official_status === 'no_run_available').length;
  const unevaluableCount = races.filter((r) => r.locked_outcome === 'unevaluable').length;

  return {
    date: params.date,
    course: params.course,
    minutes_before: params.minutesBefore,
    generatedAt: params.generatedAt,
    locked_table_available: params.lockedTableAvailable,
    races,
    coverage,
    official: summarizeModelPerformance(outcomes, lockedNoBetCount),
    locked_no_bet_count: lockedNoBetCount,
    no_run_available_count: noRunCount,
    unevaluable_count: unevaluableCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value);
}

function fmtOdds(odds: number | null | undefined): string {
  return odds === null || odds === undefined || !Number.isFinite(odds)
    ? DASH
    : odds.toFixed(2);
}

function fmtStake(stake: number | null | undefined): string {
  return stake === null || stake === undefined || !Number.isFinite(stake)
    ? DASH
    : stake.toFixed(2);
}

function fmtEv(ev: number | null | undefined): string {
  if (ev === null || ev === undefined || !Number.isFinite(ev)) return DASH;
  const pct = ev * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Off time as HH:MM (UTC), or em dash. */
function fmtOffTimeHm(offTime: string | null): string {
  if (!offTime) return DASH;
  const ms = new Date(offTime).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : DASH;
}

function fmtOutcome(outcome: LockedPickOutcome | null): string {
  if (outcome === null) return DASH;
  return outcome.toUpperCase();
}

/** Renders one race section deterministically. Pure. */
function renderRaceSection(race: LockedReportRace): string {
  const lines: string[] = [];
  lines.push(`### ${fmtOffTimeHm(race.off_time)} — ${race.race_name ?? '(unknown race)'}`);
  lines.push('');
  lines.push(`- Official status: ${race.official_status}`);
  if (race.official_status === 'locked_pick' && race.locked) {
    lines.push(
      `- Official locked pick: ${orDash(race.locked.pick_horse_name)} — odds ${fmtOdds(race.locked.pick_odds)} · EV ${fmtEv(race.locked.pick_ev)} · stake ${fmtStake(race.locked.pick_stake)} · confidence ${orDash(race.locked.pick_confidence_label)}`,
    );
  }
  if (race.official_status === 'locked_no_bet') {
    lines.push(`- Official no-bet reason: ${orDash(race.locked?.no_bet_reason)}`);
  }
  lines.push(`- Result: ${race.settled ? `winner ${orDash(race.winner_name)}` : 'pending (not counted)'}`);
  lines.push(`- Official outcome: ${fmtOutcome(race.locked_outcome)}`);
  lines.push(
    `- Final pre-off diagnostic pick: ${
      race.diagnostic
        ? `${orDash(race.diagnostic.horse_name)} — odds ${fmtOdds(race.diagnostic.odds)}${
            race.settled ? ` — ${race.diagnostic.finish_pos === 1 ? 'WON' : 'lost'}` : ''
          }`
        : race.diagnostic_run_exists
          ? 'no bet (diagnostic run made no rank-1 recommendation)'
          : DASH
    }`,
  );
  lines.push(`- Divergence: ${race.pick_divergence}`);
  if (race.outcome_divergence) {
    lines.push(`- ⚠️ Outcome divergence: ${race.outcome_divergence}`);
  }
  return lines.join('\n');
}

/**
 * Renders the full report as deterministic Markdown: coverage, the official
 * locked performance, per-race detail, the divergence analysis (diagnostic-won
 * cases first), and the fallback view for lock_missing races. Pure.
 */
export function renderLockedDayReportMarkdown(report: LockedDayReport): string {
  const blocks: string[] = [];

  blocks.push(`# Locked-decision performance — ${report.date}`);
  blocks.push(
    [
      `Course: ${report.course ?? 'All'}`,
      `Official horizon: T-minus-${report.minutes_before}`,
      `Generated: ${report.generatedAt}`,
      `Races: ${report.races.length}`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> OFFICIAL decision = `locked_race_decisions` at T-minus-5. The final',
      '> pre-off model run is fallback/diagnostic only. Locked decisions are',
      '> immutable — divergence below is analysis, never a reason to rewrite a',
      '> lock. Pending races are never losses; `locked_no_bet`,',
      '> `no_run_available`, and `lock_missing` are separate buckets, never',
      '> losses. One day is research signal only. Decision-support only — not',
      '> betting advice.',
    ].join('\n'),
  );

  if (!report.locked_table_available) {
    blocks.push(
      '> ⚠️ **locked_race_decisions was unreadable** (missing table or read error).' +
        ' Every race below is reported as `lock_missing`; official figures are empty,' +
        ' not zero-performance.',
    );
  }

  // Lock coverage.
  const cov = report.coverage;
  const covLines: string[] = ['## Lock coverage', ''];
  covLines.push(`- Races considered: ${cov.races}`);
  covLines.push(`- Locked (any official row): ${cov.locked}`);
  covLines.push(`- Lock missing: ${cov.missing}`);
  covLines.push(`- Coverage: ${cov.coverage_pct.toFixed(1)}% (target ≥ 95%)`);
  if (cov.missing_races.length > 0) {
    covLines.push('- Missing races (remain lock_missing; NEVER backfilled):');
    for (const m of cov.missing_races) {
      covLines.push(`  - ${fmtOffTimeHm(m.off_time)} ${m.race_name ?? '(unknown race)'}`);
    }
  }
  blocks.push(covLines.join('\n'));

  // Official performance (locked_pick only).
  const o = report.official;
  blocks.push(
    [
      '## Official locked performance (locked_pick only, stored odds/stake)',
      '',
      `- Locked picks: ${o.recommendations_total} (settled ${o.settled_count}, pending ${o.pending_count})`,
      `- Winners / losers: ${o.winners} / ${o.losers}`,
      `- Strike rate: ${o.strike_rate.toFixed(1)}%`,
      `- P/L (stored locked odds/stake): ${o.profit_loss.toFixed(2)} over ${o.total_staked.toFixed(2)} staked`,
      `- ROI: ${o.roi.toFixed(1)}%`,
      `- Average locked EV: ${o.average_ev === null ? DASH : fmtEv(o.average_ev)}`,
      `- Official no-bet decisions (locked_no_bet): ${report.locked_no_bet_count}`,
      `- No run available at lock (no_run_available): ${report.no_run_available_count}`,
      `- Unevaluable locked picks: ${report.unevaluable_count}`,
    ].join('\n'),
  );

  // Per-race detail.
  blocks.push('## Per-race detail');
  for (const race of report.races) {
    blocks.push(renderRaceSection(race));
  }

  // Divergence analysis — diagnostic-won-official-lost first.
  const headline = report.races.filter(
    (r) => r.outcome_divergence === 'diagnostic_won_official_lost',
  );
  const reverse = report.races.filter(
    (r) => r.outcome_divergence === 'official_won_diagnostic_lost',
  );
  const otherDiverging = report.races.filter(
    (r) =>
      r.outcome_divergence === null &&
      (r.pick_divergence === 'different_pick' ||
        r.pick_divergence === 'official_no_bet_diagnostic_pick' ||
        r.pick_divergence === 'official_pick_diagnostic_no_bet'),
  );
  const divLines: string[] = ['## Divergence analysis (official vs final pre-off diagnostic)', ''];
  if (headline.length === 0 && reverse.length === 0 && otherDiverging.length === 0) {
    divLines.push('- No divergence between official locked decisions and diagnostic picks.');
  } else {
    if (headline.length > 0) {
      divLines.push('### ⚠️ Diagnostic won but official lock lost / did not bet');
      for (const r of headline) {
        divLines.push(
          `- ${fmtOffTimeHm(r.off_time)} ${r.race_name ?? '(unknown race)'}: official ${
            r.official_status === 'locked_pick'
              ? `${orDash(r.locked?.pick_horse_name)} LOST`
              : 'no-bet'
          } vs diagnostic ${orDash(r.diagnostic?.horse_name)} WON`,
        );
      }
      divLines.push('');
    }
    if (reverse.length > 0) {
      divLines.push('### Official won where diagnostic lost / did not bet');
      for (const r of reverse) {
        divLines.push(
          `- ${fmtOffTimeHm(r.off_time)} ${r.race_name ?? '(unknown race)'}: official ${orDash(r.locked?.pick_horse_name)} WON vs diagnostic ${
            r.diagnostic ? `${orDash(r.diagnostic.horse_name)} lost` : 'no-bet'
          }`,
        );
      }
      divLines.push('');
    }
    if (otherDiverging.length > 0) {
      divLines.push('### Other pick divergence (no settled outcome split)');
      for (const r of otherDiverging) {
        divLines.push(
          `- ${fmtOffTimeHm(r.off_time)} ${r.race_name ?? '(unknown race)'}: ${r.pick_divergence}`,
        );
      }
    }
  }
  blocks.push(divLines.join('\n').replace(/\n+$/, ''));

  // Fallback view: lock_missing races only, outside official figures.
  const missing = report.races.filter((r) => r.official_status === 'lock_missing');
  if (missing.length > 0) {
    const fbLines: string[] = [
      '## Fallback view — lock_missing races (pre-off rule; NOT official figures)',
      '',
    ];
    for (const r of missing) {
      fbLines.push(
        `- ${fmtOffTimeHm(r.off_time)} ${r.race_name ?? '(unknown race)'}: fallback pick ${
          r.diagnostic
            ? `${orDash(r.diagnostic.horse_name)} — odds ${fmtOdds(r.diagnostic.odds)}${
                r.settled ? ` — ${r.diagnostic.finish_pos === 1 ? 'WON' : 'lost'}` : ' — pending'
              }`
            : r.diagnostic_run_exists
              ? 'no bet (pre-off run made no rank-1 recommendation)'
              : DASH
        }`,
      );
    }
    blocks.push(fbLines.join('\n'));
  }

  return blocks.join('\n\n') + '\n';
}
