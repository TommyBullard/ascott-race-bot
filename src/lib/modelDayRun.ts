/**
 * Pure helpers for the "run the model for a whole race day" operator scripts
 * (scripts/runModelsForRaceDay.ts — Phase 3B; scripts/runRaceDayPipeline.ts —
 * Phase 3C).
 *
 * Argument parsing, race selection (filter + sort), the per-race run loop, and
 * outcome accumulation live here so they are unit-testable and shared by both
 * scripts. No model maths and no direct DB query of its own — the run loop takes
 * an injected `runOne` (the scripts pass the real `runModelForRace`; tests pass
 * a fake), and the only import is the pure `normalizeCourse`.
 */

import { normalizeCourse } from './raceSync';
import {
  evaluateModelRunGuard,
  type PreOffSkipReason,
} from './modelRunGuard';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parsed CLI options for the race-day model runner. */
export interface ModelDayArgs {
  /** Target meeting date (YYYY-MM-DD); undefined when missing/invalid. */
  date?: string;
  /** Optional course filter (verbatim; normalised by the caller for matching). */
  course?: string;
  /** Write mode: only writes when true. */
  commit: boolean;
  /** Dry-run flag (explicit; the default is also a dry run). */
  dryRun: boolean;
}

/**
 * Parses argv (already sliced past `node script`). `--date` requires a strict
 * YYYY-MM-DD value (anything else leaves `date` undefined so the caller can
 * error out). `--commit` enables writes; `--dry-run` is explicit but writes are
 * gated solely on `commit`, so without `--commit` nothing is ever written. Pure.
 */
export function parseModelDayArgs(argv: readonly string[]): ModelDayArgs {
  const args: ModelDayArgs = { commit: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.date = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    }
  }
  return args;
}

/** Whether a race was run, skipped (no priced field), or failed. */
export type RaceRunStatus = 'run' | 'skipped' | 'failed';

/** A race considered for a meeting-day model run (id + display/sort fields). */
export interface MeetingRace {
  id: string;
  course: string | null;
  off_time: string | null;
  race_name: string | null;
  /**
   * Race status (e.g. `result` once settled), when known. Used by the pre-off
   * guard to skip already-resulted races; optional so existing callers/tests
   * that don't supply it still compile (the guard treats it as unknown).
   */
  status?: string | null;
}

/** Sort key for off_time: known instants ascending, unknowns last. */
function offTimeSortKey(offTime: string | null): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Filters raw race rows to the optional course (normalised — "Ascot" matches
 * "Royal Ascot") and sorts by off time (unknowns last). Pure: returns a new
 * array and does not mutate `rows` or their elements.
 */
export function prepareMeetingRaces(
  rows: readonly MeetingRace[],
  course?: string,
): MeetingRace[] {
  let races = rows.map((r) => ({ ...r }));
  if (course && course.trim() !== '') {
    const want = normalizeCourse(course);
    races = races.filter((r) => normalizeCourse(r.course) === want);
  }
  races.sort((a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time));
  return races;
}

/** Minimal result of one model run (subset of RunModelResult). */
export interface RunOneRaceResult {
  scored: number;
  recommended: number;
}

/** Runs one race's model; returns null when there's nothing to model. Injected. */
export type RunOneRace = (raceId: string) => Promise<RunOneRaceResult | null>;

/** One race's outcome, fed into {@link summarizeModelDayOutcomes}. */
export interface RaceRunOutcome {
  raceId: string;
  status: RaceRunStatus;
  /** Recommendations written for this race (only meaningful when status='run'). */
  recommended?: number;
  /** Runners scored (only meaningful when status='run'); for logging. */
  scored?: number;
  /** Error message (only meaningful when status='failed'); for logging. */
  error?: string;
  /**
   * Why a `skipped` race was skipped by the pre-off guard (`POST_OFF` /
   * `RESULTED`). Absent for a no-priced-field skip (the model was attempted but
   * had nothing to score).
   */
  skipReason?: PreOffSkipReason;
}

/**
 * Runs the model for each race in order, returning one outcome per race.
 * `runOne` is injected (scripts pass the real `runModelForRace`; tests pass a
 * fake), so this loop — the bug-prone part — is unit-testable without a DB. A
 * `null` result is a `skipped` race (no priced field / snapshot); a thrown error
 * is `failed` (message captured for logging, NEVER rethrown, so one bad race
 * can't sink the batch). `onOutcome` lets the caller log each result in its own
 * style. Does not mutate `races`.
 *
 * Pre-off guard: a race that has already gone off or is resulted is SKIPPED
 * before `runOne` is called (so a post-off rerun can never supersede the race's
 * valid pre-off run), recording the reason (`POST_OFF` / `RESULTED`) on the
 * outcome. `now` is injectable for deterministic tests.
 */
export async function runModelForMeetingRaces(
  races: readonly MeetingRace[],
  runOne: RunOneRace,
  onOutcome?: (race: MeetingRace, outcome: RaceRunOutcome) => void,
  now: Date = new Date(),
): Promise<RaceRunOutcome[]> {
  const outcomes: RaceRunOutcome[] = [];
  for (const race of races) {
    // Pre-off guard FIRST: never even attempt a run for a post-off / resulted
    // race — that protects the final pre-off run from being superseded.
    const guard = evaluateModelRunGuard(
      { off_time: race.off_time, status: race.status },
      now,
    );
    if (guard.skip && guard.reason) {
      const skippedOutcome: RaceRunOutcome = {
        raceId: race.id,
        status: 'skipped',
        skipReason: guard.reason,
      };
      outcomes.push(skippedOutcome);
      onOutcome?.(race, skippedOutcome);
      continue;
    }

    let outcome: RaceRunOutcome;
    try {
      const result = await runOne(race.id);
      outcome = result
        ? {
            raceId: race.id,
            status: 'run',
            recommended: result.recommended,
            scored: result.scored,
          }
        : { raceId: race.id, status: 'skipped' };
    } catch (err) {
      outcome = {
        raceId: race.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    outcomes.push(outcome);
    onOutcome?.(race, outcome);
  }
  return outcomes;
}

/** Aggregate counts for the operator summary. */
export interface ModelDaySummary {
  races_found: number;
  races_run: number;
  model_runs_created: number;
  recommendations_created: number;
  no_bet_races: number;
  /** Races skipped for no priced field / market snapshot (model had nothing to score). */
  skipped_races: number;
  /** Races skipped because they had already gone off (pre-off run protected). */
  skipped_post_off: number;
  /** Races skipped because they were already resulted (pre-off run protected). */
  skipped_resulted: number;
  failures: number;
}

/**
 * Accumulates per-race outcomes into the summary counts. `races_found` is the
 * total selected; a `run` outcome creates a model run (and contributes its
 * `recommended` count, with `recommended === 0` counted as a no-bet race); a
 * `skipped` race had no priced field (`skipped_races`) OR was skipped by the
 * pre-off guard (`skipped_post_off` / `skipped_resulted`); a `failed` race threw.
 * Pure — does not mutate `outcomes`.
 */
export function summarizeModelDayOutcomes(
  outcomes: readonly RaceRunOutcome[],
): ModelDaySummary {
  const summary: ModelDaySummary = {
    races_found: outcomes.length,
    races_run: 0,
    model_runs_created: 0,
    recommendations_created: 0,
    no_bet_races: 0,
    skipped_races: 0,
    skipped_post_off: 0,
    skipped_resulted: 0,
    failures: 0,
  };
  for (const o of outcomes) {
    if (o.status === 'run') {
      summary.races_run += 1;
      summary.model_runs_created += 1;
      const rec = typeof o.recommended === 'number' ? o.recommended : 0;
      summary.recommendations_created += rec;
      if (rec === 0) summary.no_bet_races += 1;
    } else if (o.status === 'skipped') {
      // Route pre-off-guard skips to their own counters; a reasonless skip is the
      // existing "no priced field" case.
      if (o.skipReason === 'POST_OFF') summary.skipped_post_off += 1;
      else if (o.skipReason === 'RESULTED') summary.skipped_resulted += 1;
      else summary.skipped_races += 1;
    } else {
      summary.failures += 1;
    }
  }
  return summary;
}

/** Formats the summary as aligned `key: value` lines (no secrets). Pure. */
export function formatModelDaySummary(summary: ModelDaySummary): string[] {
  return Object.entries(summary).map(([k, v]) => `  ${k}: ${v}`);
}
