/**
 * Pure aggregation for the READ-ONLY nationwide UK & Ireland audit —
 * Nationwide rebuild Phase 7A.1.
 *
 * Given a fully-assembled, read-only projection of one meeting date's stored
 * races (all courses), it groups by normalised course and builds per-course +
 * overall operational rollups: race/runner counts, odds & model coverage,
 * diagnostic pick/no-bet counts, official T-minus-5 lock coverage (time-aware),
 * official locked outcomes, result progress, course-identity warnings, and an
 * evidence-gate verdict.
 *
 * REUSES the proven pure helpers — `normalizeCourse` (course identity),
 * `buildLockedOutcomes` (Phase 5B/5C: time-aware not_locked_yet vs
 * lock_missing with recorded-winner evidence; official outcomes at STORED
 * locked odds/stake), `summarizeModelPerformance` (pending never a loss) — so
 * no official rule exists twice.
 *
 * HONESTY RULES (each enforced by nationwideAudit.test.ts):
 *   - Pending races are never losses; `locked_no_bet` is a valid decision
 *     (never a loss); `no_run_available` and `lock_missing` are separate
 *     buckets (never losses); lock_missing is NEVER backfilled.
 *   - A missing lock row is `not_locked_yet` while the window is open;
 *     `lock_missing` only once the off has passed OR a stored winner proves
 *     the race completed. Unknown off times are never accused.
 *   - Unknown optional data (odds/model/lock reads unavailable) is reported
 *     as UNKNOWN with a warning — never fabricated as zero-success or failure.
 *   - Questionable course labels are merged by `normalizeCourse` but every
 *     merge of distinct raw labels is REPORTED, never silent.
 *   - Diagnostic (pre-off) data is comparison/coverage only — the official
 *     record is `locked_race_decisions`.
 *   - HARD INVARIANTS (`checkRollupInvariants`): every coverage numerator is a
 *     count of DISTINCT RACE IDS and can never exceed its race/runner
 *     denominator; lock buckets must exactly reconcile to the race count;
 *     overall totals must equal the sum of per-course values. A violation
 *     always forces `verdict: 'FAIL'` and every violated invariant is listed
 *     verbatim — never clamped, summarised, or hidden. No coverage percentage
 *     is ever rendered above 100%.
 *
 * The verdict is INFORMATIONAL ONLY: nothing here (or in the CLI) enables,
 * schedules, or invokes nationwide commit mode. No I/O, no DB, no clock
 * (injected), no writes. Decision-support only — never betting advice.
 */

import { normalizeCourse } from './raceSync';
import {
  buildLockedOutcomes,
  type PerformanceLockCoverage,
} from './lockedEvaluation';
import {
  summarizeModelPerformance,
  type ModelPerformance,
} from './modelPerformance';
import type { LockedDecision } from './lockedDecisionRead';

/** Bucket label for races whose stored course is blank/unknown. */
export const UNKNOWN_COURSE_LABEL = '(unknown course)';

/** Country/region values considered expected for UK+IRE operation. */
export const EXPECTED_COUNTRIES: readonly string[] = ['gb', 'ire', 'ie', 'uk'];

/** The ingest-time fallback country value (raceSync writes 'GB' when absent). */
export const FALLBACK_COUNTRY_VALUE = 'GB';

/** One race's read-only audit input (assembled by the SELECT-only CLI). */
export interface NationwideAuditRaceInput {
  race_id: string;
  /** Raw stored `races.course` label (reported verbatim; merged by alias). */
  course_label: string | null;
  country: string | null;
  off_time: string | null;
  race_name: string | null;
  status: string | null;
  runner_count: number;
  /** Winner runner id (`finish_pos = 1`), or null while unresulted. */
  winner_runner_id: string | null;
  /** Latest odds snapshot exists; null = odds data UNKNOWN (probe failed). */
  has_odds: boolean | null;
  /** Priced runners in the latest snapshot; null when unknown. */
  priced_runner_count: number | null;
  /**
   * A valid PRE-OFF model run exists; false = none; null = UNKNOWN (read
   * failed, or off time unusable so pre-off cannot be evaluated).
   */
  has_pre_off_run: boolean | null;
  /**
   * The pre-off run's rank-1 recommendation exists (diagnostic pick); false =
   * diagnostic no-bet (run without a pick); null = unknown / no run.
   */
  has_diagnostic_pick: boolean | null;
  /** Official locked decision row, or null when none exists. */
  locked: LockedDecision | null;
  /** Isolated per-race read failure (other races still audit), or null. */
  read_error: string | null;
}

export interface NationwideAuditInput {
  date: string;
  /** Injected clock (epoch ms) for the time-aware lock split. */
  now: number;
  races: readonly NationwideAuditRaceInput[];
  /** False when locked_race_decisions was unreadable — lock stats UNKNOWN. */
  lockedTableAvailable: boolean;
  /** CLI-level warnings (optional-table probes etc.), reported verbatim. */
  globalWarnings: readonly string[];
}

/** Per-course rollup. Nullable numbers mean UNKNOWN, never zero-success. */
export interface CourseRollup {
  /** Normalised course key (or {@link UNKNOWN_COURSE_LABEL}). */
  course: string;
  /** Distinct raw labels merged into this course (sorted; >1 => warning). */
  labels: string[];
  /** Distinct stored country values (sorted). */
  countries: string[];
  races: number;
  runners: number;
  /**
   * Odds coverage is DEFINED EXACTLY AS: distinct stored races with at least
   * one qualifying odds snapshot. It counts RACES, never snapshots, markets,
   * quotes, provider events, or raw rows — so it can never exceed `races`.
   */
  races_with_odds: number | null;
  priced_runners: number | null;
  races_with_pre_off_run: number | null;
  diagnostic_picks: number | null;
  diagnostic_no_bets: number | null;
  /** Time-aware official lock coverage, or null when the table was unreadable. */
  lock: PerformanceLockCoverage | null;
  /** Official locked performance (stored odds/stake; pending never a loss). */
  official: ModelPerformance | null;
  settled: number;
  /** Post-off (or winner-proven) races without a recorded result. */
  pending: number;
  /** Races not yet off (or off unknown and unresulted). */
  upcoming: number;
  read_errors: number;
  warnings: string[];
  /** Hard rollup-invariant violations for THIS course (empty when clean). */
  invariant_violations: string[];
}

export type AuditVerdict = 'PASS' | 'REVIEW' | 'FAIL';

export interface NationwideAuditReport {
  date: string;
  courses: CourseRollup[];
  totals: {
    courses: number;
    races: number;
    runners: number;
    races_with_odds: number | null;
    priced_runners: number | null;
    races_with_pre_off_run: number | null;
    diagnostic_picks: number | null;
    diagnostic_no_bets: number | null;
    locked_rows: number | null;
    locked_picks: number | null;
    locked_no_bets: number | null;
    no_run_available: number | null;
    not_locked_yet: number | null;
    lock_missing: number | null;
    settled: number;
    pending: number;
    upcoming: number;
    /** settled / (settled + pending), % to 1dp; null when nothing is post-off. */
    result_coverage_pct: number | null;
    /** races_with_pre_off_run / races, %; null when model data unknown. */
    model_coverage_pct: number | null;
    /** locked rows / races, %; null when the lock table was unreadable. */
    lock_coverage_pct: number | null;
  };
  /** Course-identity + data warnings (label merges, countries, unknowns). */
  warnings: string[];
  /**
   * Every hard rollup-invariant violation found (per-course + overall +
   * overall/per-course reconciliation), in full — never summarised away.
   * Non-empty here ALWAYS forces `verdict === 'FAIL'`.
   */
  invariant_violations: string[];
  verdict: AuditVerdict;
  verdict_reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A ratio as a percentage to 1dp. Returns `null` — NEVER a value above 100 —
 * when the numerator exceeds the denominator (an invalid ratio): the broken
 * raw counts stay visible elsewhere in the report; this function only refuses
 * to launder them into a nonsensical percentage. `checkInvariants` is what
 * surfaces the underlying defect (FAIL + a listed violation).
 */
function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) return 0;
  if (numerator > denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Sums nullable counters: any null contributor makes the total UNKNOWN. */
function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** Alnum-collapsed form used for near-duplicate label detection. */
function collapsed(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** True when the race is proven post-off (off passed, or a winner recorded). */
function isPostOff(race: NationwideAuditRaceInput, now: number): boolean {
  if (race.winner_runner_id !== null) return true;
  if ((race.status ?? '') === 'result') return true;
  const off = race.off_time ? Date.parse(race.off_time) : NaN;
  return Number.isFinite(off) && off < now;
}

/** True when the race has a recorded result. */
function isSettled(race: NationwideAuditRaceInput): boolean {
  return race.winner_runner_id !== null || (race.status ?? '') === 'result';
}

/* -------------------------------------------------------------------------- */
/* Rollup building                                                             */
/* -------------------------------------------------------------------------- */

function buildCourseRollup(
  course: string,
  races: readonly NationwideAuditRaceInput[],
  now: number,
  lockedTableAvailable: boolean,
): CourseRollup {
  const labels = [...new Set(races.map((r) => (r.course_label ?? '').trim() || UNKNOWN_COURSE_LABEL))].sort();
  const countries = [...new Set(races.map((r) => (r.country ?? '').trim()).filter((c) => c !== ''))].sort();

  const settled = races.filter(isSettled).length;
  const postOff = races.filter((r) => isPostOff(r, now)).length;
  const pending = postOff - settled;

  // Official lock coverage + outcomes via the shared Phase 5B/5C evaluator
  // (time-aware split incl. recorded-winner evidence; stored odds/stake only).
  let lock: PerformanceLockCoverage | null = null;
  let official: ModelPerformance | null = null;
  if (lockedTableAvailable) {
    const result = buildLockedOutcomes(
      races.map((r) => ({
        race_id: r.race_id,
        off_time: r.off_time,
        winner_runner_id: r.winner_runner_id,
        locked: r.locked,
      })),
      now,
    );
    lock = result.coverage;
    official = summarizeModelPerformance(result.outcomes, result.lockedNoBet);
  }

  const warnings: string[] = [];
  if (labels.length > 1) {
    warnings.push(`multiple raw course labels merged into "${course}": ${labels.join(' / ')}`);
  }
  if (course === UNKNOWN_COURSE_LABEL) {
    warnings.push(`${races.length} race(s) have a blank/unknown course label`);
  }
  const readErrors = races.filter((r) => r.read_error !== null);
  if (readErrors.length > 0) {
    warnings.push(
      `${readErrors.length} race(s) had isolated read failures (coverage shown as unknown for them)`,
    );
  }

  const races_with_odds = sumOrNull(races.map((r) => (r.has_odds === null ? null : r.has_odds ? 1 : 0)));
  const priced_runners = sumOrNull(races.map((r) => r.priced_runner_count));
  const races_with_pre_off_run = sumOrNull(
    races.map((r) => (r.has_pre_off_run === null ? null : r.has_pre_off_run ? 1 : 0)),
  );
  const diagnostic_picks = sumOrNull(
    races.map((r) => (r.has_pre_off_run === null ? null : r.has_diagnostic_pick === true ? 1 : 0)),
  );
  const diagnostic_no_bets = sumOrNull(
    races.map((r) =>
      r.has_pre_off_run === null ? null : r.has_pre_off_run && r.has_diagnostic_pick === false ? 1 : 0,
    ),
  );
  const runners = races.reduce((n, r) => n + r.runner_count, 0);

  const invariant_violations = checkRollupInvariants(
    course,
    toInvariantInputs({
      races: races.length,
      runners,
      races_with_odds,
      priced_runners,
      races_with_pre_off_run,
      diagnostic_picks,
      diagnostic_no_bets,
      settled,
      pending,
      lock,
    }),
  );

  return {
    course,
    labels,
    countries,
    races: races.length,
    runners,
    races_with_odds,
    priced_runners,
    races_with_pre_off_run,
    diagnostic_picks,
    diagnostic_no_bets,
    lock,
    official,
    settled,
    pending,
    upcoming: races.length - postOff,
    read_errors: readErrors.length,
    warnings,
    invariant_violations,
  };
}

/** Cross-course identity + country warnings. Pure. */
function buildGlobalWarnings(
  courses: readonly CourseRollup[],
  races: readonly NationwideAuditRaceInput[],
  lockedTableAvailable: boolean,
): string[] {
  const warnings: string[] = [];

  // Near-duplicate normalised course keys (one collapsed key prefixes another).
  const keys = courses.map((c) => c.course).filter((c) => c !== UNKNOWN_COURSE_LABEL);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = collapsed(keys[i]);
      const b = collapsed(keys[j]);
      if (a === b || a.startsWith(b) || b.startsWith(a)) {
        warnings.push(
          `suspicious near-duplicate course labels: "${keys[i]}" vs "${keys[j]}" — confirm these are genuinely different courses`,
        );
      }
    }
  }

  // Country values outside the expected UK+IRE set.
  const unexpected = [
    ...new Set(
      races
        .map((r) => (r.country ?? '').trim())
        .filter((c) => c !== '' && !EXPECTED_COUNTRIES.includes(c.toLowerCase())),
    ),
  ].sort();
  if (unexpected.length > 0) {
    warnings.push(`country value(s) outside expected GB/IE set: ${unexpected.join(', ')}`);
  }
  const missingCountry = races.filter((r) => (r.country ?? '').trim() === '').length;
  if (missingCountry > 0) {
    warnings.push(`${missingCountry} race(s) have no stored country value`);
  }
  // The ingest fallback writes exactly 'GB' when the provider region is absent;
  // provider-verbatim regions are lowercase — flag the identifiable fallback.
  const fallback = races.filter((r) => (r.country ?? '') === FALLBACK_COUNTRY_VALUE).length;
  if (fallback > 0) {
    warnings.push(
      `${fallback} race(s) carry country "${FALLBACK_COUNTRY_VALUE}" — the ingest fallback default (provider region was absent; likely GB but unverified)`,
    );
  }

  if (!lockedTableAvailable) {
    warnings.push(
      'locked_race_decisions was unreadable — lock coverage is UNKNOWN (not zero, not missing)',
    );
  }

  return warnings;
}

/* -------------------------------------------------------------------------- */
/* Hard rollup invariants (defense-in-depth; never silently clamped/hidden)   */
/* -------------------------------------------------------------------------- */

/** The shape both a `CourseRollup` and the overall `totals` block expose. */
interface InvariantInputs {
  races: number;
  runners: number;
  races_with_odds: number | null;
  priced_runners: number | null;
  races_with_pre_off_run: number | null;
  diagnostic_picks: number | null;
  diagnostic_no_bets: number | null;
  settled: number;
  pending: number;
  locked_rows: number | null;
  locked_picks: number | null;
  locked_no_bets: number | null;
  no_run_available: number | null;
  not_locked_yet: number | null;
  lock_missing: number | null;
}

/**
 * Checks every hard rollup invariant for one scope (a course, or the overall
 * totals). Returns the FULL list of violated invariants as plain-language
 * strings — every one is reported, none are summarised or dropped. A number
 * exceeding its bound is quoted VERBATIM (e.g. "7 exceeds races (6)") so the
 * incorrect value is never silently clamped or hidden. Pure.
 */
export function checkRollupInvariants(label: string, v: InvariantInputs): string[] {
  const violations: string[] = [];
  const at = (msg: string) => violations.push(`${label}: ${msg}`);

  // racesWithOdds <= races
  if (v.races_with_odds !== null && v.races_with_odds > v.races) {
    at(`racesWithOdds (${v.races_with_odds}) exceeds races (${v.races})`);
  }
  // racesWithModelRuns <= races
  if (v.races_with_pre_off_run !== null && v.races_with_pre_off_run > v.races) {
    at(`racesWithModelRuns (${v.races_with_pre_off_run}) exceeds races (${v.races})`);
  }
  // racesWithRecommendations (picks + diagnostic no-bets) <= races with a run <= races
  const recommendations = sumOrNull([v.diagnostic_picks, v.diagnostic_no_bets]);
  if (recommendations !== null) {
    const bound = v.races_with_pre_off_run ?? v.races;
    if (recommendations > bound) {
      at(`racesWithRecommendations (${recommendations}) exceeds racesWithModelRuns (${bound})`);
    }
  }
  // officialLockedRows <= races
  if (v.locked_rows !== null && v.locked_rows > v.races) {
    at(`officialLockedRows (${v.locked_rows}) exceeds races (${v.races})`);
  }
  // settledRaces <= races ; pendingRaces <= races ; settled + pending <= races
  if (v.settled > v.races) at(`settledRaces (${v.settled}) exceeds races (${v.races})`);
  if (v.pending > v.races) at(`pendingRaces (${v.pending}) exceeds races (${v.races})`);
  if (v.settled + v.pending > v.races) {
    at(`settledRaces + pendingRaces (${v.settled + v.pending}) exceeds races (${v.races})`);
  }
  // lockedPick + lockedNoBet + noRunAvailable <= races (and must equal officialLockedRows)
  const lockBucketSum = sumOrNull([v.locked_picks, v.locked_no_bets, v.no_run_available]);
  if (lockBucketSum !== null) {
    if (lockBucketSum > v.races) {
      at(`lockedPick + lockedNoBet + noRunAvailable (${lockBucketSum}) exceeds races (${v.races})`);
    }
    if (v.locked_rows !== null && lockBucketSum !== v.locked_rows) {
      at(
        `lockedPick + lockedNoBet + noRunAvailable (${lockBucketSum}) does not equal officialLockedRows (${v.locked_rows})`,
      );
    }
  }
  // locked + notLockedYet + lockMissing must reconcile to the applicable race count
  const partition = sumOrNull([v.locked_rows, v.not_locked_yet, v.lock_missing]);
  if (partition !== null && partition !== v.races) {
    at(
      `locked + notLockedYet + lockMissing (${partition}) does not reconcile to races (${v.races})`,
    );
  }
  // pricedRunners <= runners
  if (v.priced_runners !== null && v.priced_runners > v.runners) {
    at(`pricedRunners (${v.priced_runners}) exceeds runners (${v.runners})`);
  }

  return violations;
}

/** Projects a `CourseRollup` (or the overall totals block) to {@link InvariantInputs}. Pure. */
function toInvariantInputs(v: {
  races: number;
  runners: number;
  races_with_odds: number | null;
  priced_runners: number | null;
  races_with_pre_off_run: number | null;
  diagnostic_picks: number | null;
  diagnostic_no_bets: number | null;
  settled: number;
  pending: number;
  lock?: PerformanceLockCoverage | null;
  locked_rows?: number | null;
  locked_picks?: number | null;
  locked_no_bets?: number | null;
  no_run_available?: number | null;
  not_locked_yet?: number | null;
  lock_missing?: number | null;
}): InvariantInputs {
  return {
    races: v.races,
    runners: v.runners,
    races_with_odds: v.races_with_odds,
    priced_runners: v.priced_runners,
    races_with_pre_off_run: v.races_with_pre_off_run,
    diagnostic_picks: v.diagnostic_picks,
    diagnostic_no_bets: v.diagnostic_no_bets,
    settled: v.settled,
    pending: v.pending,
    locked_rows: v.lock ? v.lock.locked : (v.locked_rows ?? null),
    locked_picks: v.lock ? v.lock.locked_pick : (v.locked_picks ?? null),
    locked_no_bets: v.lock ? v.lock.locked_no_bet : (v.locked_no_bets ?? null),
    no_run_available: v.lock ? v.lock.no_run_available : (v.no_run_available ?? null),
    not_locked_yet: v.lock ? v.lock.not_locked_yet : (v.not_locked_yet ?? null),
    lock_missing: v.lock ? v.lock.lock_missing : (v.lock_missing ?? null),
  };
}

/**
 * Reconciles the OVERALL totals against the sum of the per-course rollups for
 * every additive dimension (requirement: overall must equal the sum of
 * per-course where the dimension is additive). By construction the totals ARE
 * built by summing the courses, so this is a regression guard, not a
 * tautology-free check — it exists so a future refactor can never silently
 * desynchronise the two. Pure.
 */
function reconcileTotalsWithCourses(
  totals: NationwideAuditReport['totals'],
  courses: readonly CourseRollup[],
): string[] {
  const violations: string[] = [];
  const check = (name: string, total: number | null, sum: number | null) => {
    if (total !== sum) {
      violations.push(
        `OVERALL: ${name} total (${total === null ? 'unknown' : total}) does not equal the sum of per-course values (${sum === null ? 'unknown' : sum})`,
      );
    }
  };
  const sumField = (pick: (c: CourseRollup) => number | null): number | null =>
    sumOrNull(courses.map(pick));

  check('races', totals.races, courses.reduce((n, c) => n + c.races, 0));
  check('runners', totals.runners, courses.reduce((n, c) => n + c.runners, 0));
  check('settled', totals.settled, courses.reduce((n, c) => n + c.settled, 0));
  check('pending', totals.pending, courses.reduce((n, c) => n + c.pending, 0));
  check('races_with_odds', totals.races_with_odds, sumField((c) => c.races_with_odds));
  check('priced_runners', totals.priced_runners, sumField((c) => c.priced_runners));
  check(
    'races_with_pre_off_run',
    totals.races_with_pre_off_run,
    sumField((c) => c.races_with_pre_off_run),
  );
  check('diagnostic_picks', totals.diagnostic_picks, sumField((c) => c.diagnostic_picks));
  check('diagnostic_no_bets', totals.diagnostic_no_bets, sumField((c) => c.diagnostic_no_bets));
  check('locked_rows', totals.locked_rows, sumField((c) => (c.lock ? c.lock.locked : null)));
  check('locked_picks', totals.locked_picks, sumField((c) => (c.lock ? c.lock.locked_pick : null)));
  check(
    'locked_no_bets',
    totals.locked_no_bets,
    sumField((c) => (c.lock ? c.lock.locked_no_bet : null)),
  );
  check(
    'no_run_available',
    totals.no_run_available,
    sumField((c) => (c.lock ? c.lock.no_run_available : null)),
  );
  check(
    'not_locked_yet',
    totals.not_locked_yet,
    sumField((c) => (c.lock ? c.lock.not_locked_yet : null)),
  );
  check('lock_missing', totals.lock_missing, sumField((c) => (c.lock ? c.lock.lock_missing : null)));

  return violations;
}

/**
 * Builds the full nationwide audit report: per-course rollups (sorted by
 * course), totals, warnings, and the evidence-gate verdict. The verdict is
 * informational only — it never enables/schedules anything. Pure.
 */
export function buildNationwideAudit(input: NationwideAuditInput): NationwideAuditReport {
  const byCourse = new Map<string, NationwideAuditRaceInput[]>();
  for (const race of input.races) {
    const raw = (race.course_label ?? '').trim();
    const key = raw === '' ? UNKNOWN_COURSE_LABEL : normalizeCourse(raw) || UNKNOWN_COURSE_LABEL;
    const bucket = byCourse.get(key);
    if (bucket) bucket.push(race);
    else byCourse.set(key, [race]);
  }

  const courses = [...byCourse.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([course, races]) => buildCourseRollup(course, races, input.now, input.lockedTableAvailable));

  const warnings = [
    ...input.globalWarnings,
    ...buildGlobalWarnings(courses, input.races, input.lockedTableAvailable),
  ];

  const settled = courses.reduce((n, c) => n + c.settled, 0);
  const pending = courses.reduce((n, c) => n + c.pending, 0);
  const lockKnown = input.lockedTableAvailable;
  const lockSum = (pick: (l: PerformanceLockCoverage) => number): number | null =>
    lockKnown ? courses.reduce((n, c) => n + (c.lock ? pick(c.lock) : 0), 0) : null;

  const racesTotal = input.races.length;
  const withRun = sumOrNull(courses.map((c) => c.races_with_pre_off_run));
  const lockedRows = lockSum((l) => l.locked);

  const totals: NationwideAuditReport['totals'] = {
    courses: courses.length,
    races: racesTotal,
    runners: courses.reduce((n, c) => n + c.runners, 0),
    races_with_odds: sumOrNull(courses.map((c) => c.races_with_odds)),
    priced_runners: sumOrNull(courses.map((c) => c.priced_runners)),
    races_with_pre_off_run: withRun,
    diagnostic_picks: sumOrNull(courses.map((c) => c.diagnostic_picks)),
    diagnostic_no_bets: sumOrNull(courses.map((c) => c.diagnostic_no_bets)),
    locked_rows: lockedRows,
    locked_picks: lockSum((l) => l.locked_pick),
    locked_no_bets: lockSum((l) => l.locked_no_bet),
    no_run_available: lockSum((l) => l.no_run_available),
    not_locked_yet: lockSum((l) => l.not_locked_yet),
    lock_missing: lockSum((l) => l.lock_missing),
    settled,
    pending,
    upcoming: courses.reduce((n, c) => n + c.upcoming, 0),
    result_coverage_pct: settled + pending === 0 ? null : pct(settled, settled + pending),
    model_coverage_pct: withRun === null || racesTotal === 0 ? null : pct(withRun, racesTotal),
    lock_coverage_pct: lockedRows === null || racesTotal === 0 ? null : pct(lockedRows, racesTotal),
  };

  // --- Hard invariants (defense-in-depth): a violation ALWAYS forces FAIL,
  //     and every violation is listed in full — never summarised or hidden.
  const overallInvariants = checkRollupInvariants('OVERALL', toInvariantInputs(totals));
  const reconciliation = reconcileTotalsWithCourses(totals, courses);
  const invariant_violations = [
    ...courses.flatMap((c) => c.invariant_violations),
    ...overallInvariants,
    ...reconciliation,
  ];

  // --- Evidence-gate verdict (informational only; never enables anything). --
  const verdictReasons: string[] = [];
  let verdict: AuditVerdict;

  if (invariant_violations.length > 0) {
    verdict = 'FAIL';
    verdictReasons.push(...invariant_violations);
  } else {
    verdict = 'PASS';
    const courseWarnings = courses.flatMap((c) => c.warnings);
    if (warnings.length > 0 || courseWarnings.length > 0) {
      verdict = 'REVIEW';
      verdictReasons.push(
        `${warnings.length + courseWarnings.length} warning(s) require operator review`,
      );
    }
    if (
      totals.races_with_odds === null ||
      totals.races_with_pre_off_run === null ||
      !lockKnown
    ) {
      verdict = 'REVIEW';
      verdictReasons.push('optional data was unavailable/unknown for part of the audit');
    }
    if (verdict === 'PASS') {
      verdictReasons.push('nationwide read coverage is internally consistent with no warnings');
    }
  }

  return {
    date: input.date,
    courses,
    totals,
    warnings,
    invariant_violations,
    verdict,
    verdict_reasons: verdictReasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                    */
/* -------------------------------------------------------------------------- */

const DASH = '—';

function n(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function pctLabel(value: number | null): string {
  return value === null ? DASH : `${value.toFixed(1)}%`;
}

/** Renders the audit as deterministic Markdown (same input -> same string). */
export function renderNationwideAuditMarkdown(
  report: NationwideAuditReport,
  generatedAt: string,
): string {
  const t = report.totals;
  const blocks: string[] = [];

  blocks.push(`# Nationwide UK & Ireland audit — ${report.date}`);
  blocks.push(
    [
      '**READ ONLY** — SELECT-only inspection of stored data.',
      `Generated: ${generatedAt}`,
      '',
      '> Official decision = `locked_race_decisions` at T-minus-5. Diagnostic',
      '> (pre-off) output is comparison only. Pending races are never losses;',
      '> `locked_no_bet` is a valid decision (never a loss); `no_run_available`',
      '> and `lock_missing` are separate buckets (never losses, never',
      '> backfilled). Decision-support only — not betting advice.',
      '>',
      '> **This report does not enable nationwide commit mode.**',
    ].join('\n'),
  );

  if (report.invariant_violations.length > 0) {
    blocks.push(
      [
        '## ⚠️ INVARIANT VIOLATIONS — DO NOT TRUST THE FIGURES BELOW',
        '',
        'One or more hard rollup invariants failed. Every violated invariant is',
        'listed verbatim below; nothing is clamped, summarised, or hidden.',
        '',
        ...report.invariant_violations.map((v) => `- ${v}`),
      ].join('\n'),
    );
  }

  blocks.push(
    [
      '## Overall summary',
      '',
      `- Courses/meetings: ${t.courses}`,
      `- Races: ${t.races}`,
      `- Runners: ${t.runners}`,
      `- Races with odds: ${n(t.races_with_odds)}`,
      `- Priced runners / total runners: ${n(t.priced_runners)} / ${t.runners}`,
      `- Races with pre-off model runs: ${n(t.races_with_pre_off_run)}`,
      `- Diagnostic picks: ${n(t.diagnostic_picks)}`,
      `- Diagnostic no-bets: ${n(t.diagnostic_no_bets)}`,
      `- Official locked rows: ${n(t.locked_rows)}`,
      `- Locked picks: ${n(t.locked_picks)}`,
      `- Locked no-bets: ${n(t.locked_no_bets)}`,
      `- No run available at lock: ${n(t.no_run_available)}`,
      `- Not locked yet: ${n(t.not_locked_yet)}`,
      `- LOCK MISSING: ${n(t.lock_missing)}`,
      `- Settled races: ${t.settled}`,
      `- Pending races: ${t.pending} (never counted as losses)`,
      `- Result coverage: ${pctLabel(t.result_coverage_pct)}`,
      `- Model coverage: ${pctLabel(t.model_coverage_pct)}`,
      `- Lock coverage: ${pctLabel(t.lock_coverage_pct)}`,
    ].join('\n'),
  );

  blocks.push('## Per-course rollup');
  for (const c of report.courses) {
    const lines: string[] = [];
    lines.push(`### ${c.course}`);
    lines.push('');
    lines.push(`- Source labels: ${c.labels.join(' / ')}`);
    lines.push(`- Countries: ${c.countries.length > 0 ? c.countries.join(', ') : DASH}`);
    lines.push(`- Races: ${c.races} · Runners: ${c.runners}`);
    lines.push(
      `- Odds coverage: ${n(c.races_with_odds)}/${c.races} races · priced runners ${n(c.priced_runners)}/${c.runners}`,
    );
    lines.push(
      `- Model coverage: ${n(c.races_with_pre_off_run)}/${c.races} pre-off runs · diagnostic picks ${n(c.diagnostic_picks)} · diagnostic no-bets ${n(c.diagnostic_no_bets)}`,
    );
    if (c.lock) {
      lines.push(
        `- Official locks: ${c.lock.locked}/${c.races} · picks ${c.lock.locked_pick} · no-bets ${c.lock.locked_no_bet} · no-run ${c.lock.no_run_available} · not yet ${c.lock.not_locked_yet} · MISSING ${c.lock.lock_missing}`,
      );
    } else {
      lines.push('- Official locks: unknown (locked_race_decisions unreadable)');
    }
    if (c.official && c.official.settled_count > 0) {
      lines.push(
        `- Official outcomes (stored locked odds/stake): W${c.official.winners}/L${c.official.losers} · pending ${c.official.pending_count} · no-bet ${c.official.no_bet_races}`,
      );
    }
    lines.push(`- Results: settled ${c.settled} · pending ${c.pending} · upcoming ${c.upcoming}`);
    for (const w of c.warnings) lines.push(`- ⚠️ ${w}`);
    for (const v of c.invariant_violations) lines.push(`- 🛑 INVARIANT VIOLATION: ${v}`);
    blocks.push(lines.join('\n'));
  }

  blocks.push(
    [
      '## Provider / course-label warnings',
      '',
      ...(report.warnings.length > 0
        ? report.warnings.map((w) => `- ⚠️ ${w}`)
        : ['- none']),
    ].join('\n'),
  );

  // Coverage gaps: courses where any known coverage falls short.
  const gaps = report.courses.filter(
    (c) =>
      (c.races_with_odds !== null && c.races_with_odds < c.races) ||
      (c.races_with_pre_off_run !== null && c.races_with_pre_off_run < c.races) ||
      (c.lock !== null && c.lock.lock_missing > 0) ||
      c.pending > 0 ||
      c.read_errors > 0,
  );
  blocks.push(
    [
      '## Coverage gaps',
      '',
      ...(gaps.length > 0
        ? gaps.map(
            (c) =>
              `- ${c.course}: odds ${n(c.races_with_odds)}/${c.races}, model ${n(c.races_with_pre_off_run)}/${c.races}, lock missing ${c.lock ? c.lock.lock_missing : 'unknown'}, pending ${c.pending}, read errors ${c.read_errors}`,
          )
        : ['- none']),
    ].join('\n'),
  );

  blocks.push(
    [
      `## Evidence-gate verdict: ${report.verdict}`,
      '',
      ...report.verdict_reasons.map((r) => `- ${r}`),
      '',
      'This report does not enable nationwide commit mode.',
    ].join('\n'),
  );

  return blocks.join('\n\n') + '\n';
}

/** Deterministic report path: `reports/nationwide-audit-<date>.md`. Pure. */
export function buildNationwideAuditPath(date: string): string {
  return `reports/nationwide-audit-${date}.md`;
}
