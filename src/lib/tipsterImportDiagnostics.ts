/**
 * Pure formatting + diagnostic helpers for the tipster CSV importer's READ-ONLY
 * dry-run diagnostics (Batch K1b).
 *
 * These functions only FORMAT data the importer already fetched (races, runners)
 * into human-readable hints — they perform NO I/O, NO DB access, NO mutation,
 * and contain NO matching logic. They never decide that a row "matches"; they
 * only show the operator what exists so they can fix their CSV by hand. Matching
 * stays exactly as conservative as before (exact normalised, in
 * src/lib/runnerMatch.ts + the importer's race resolver). Nothing here fuzzy-
 * matches or auto-corrects a name.
 */

/** A race row as needed for listing / nearby-race diagnostics (display only). */
export interface DiagRaceRow {
  id: string;
  course: string;
  off_time: string | null;
  race_name?: string | null;
  runner_count?: number | null;
}

/** Counters the "Fix your CSV" section reads (a subset of the import audit). */
export interface ImportIssueCounts {
  skipped_missing_required: number;
  skipped_unmatched_race: number;
  skipped_ambiguous_race: number;
  skipped_unmatched_horse: number;
  skipped_ambiguous_horse: number;
  tipsters_unresolved: number;
  duplicate_rows_ignored_or_would_ignore: number;
}

const EN_DASH = '\u2014';

/** HH:MM (UTC) from an ISO timestamp, or an en-dash when missing/unparseable. */
export function hhmmFromIso(iso: string | null | undefined): string {
  if (!iso) return EN_DASH;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return EN_DASH;
  return new Date(ms).toISOString().slice(11, 16);
}

/** Sort key for off_time: known instants ascending, unknowns last. */
function offTimeSortKey(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** Right-pads a string to `width` (never truncates). */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * Builds aligned listing lines for `--list-races`, one per race, sorted by
 * off_time (ascending; unknowns last). Columns: off_time, course, runner_count,
 * race_id, race_name — so an operator can copy the exact course/off_time their
 * CSV needs. Pure; does not mutate `races`.
 */
export function formatRaceListingLines(races: readonly DiagRaceRow[]): string[] {
  if (races.length === 0) {
    return ['(no races found for the given filters)'];
  }
  const sorted = [...races].sort(
    (a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time),
  );
  const courseWidth = Math.min(
    24,
    Math.max(6, ...sorted.map((r) => (r.course ?? '').length)),
  );
  return sorted.map((r) => {
    const off = hhmmFromIso(r.off_time);
    const course = pad(r.course ?? EN_DASH, courseWidth);
    const count =
      r.runner_count === null || r.runner_count === undefined
        ? '?'
        : String(r.runner_count);
    const name = r.race_name ?? '';
    return `  ${off}  ${course}  ${pad(`${count} runners`, 12)}  ${r.id}  ${name}`.trimEnd();
  });
}

/**
 * Returns a race's runner names verbatim, de-duplicated and sorted, for showing
 * "available runners" when a horse name did not match. Display only — these are
 * the exact stored names, never normalised or altered. Pure.
 */
export function availableRunnerNames(
  runners: readonly { horse_name: string }[],
): string[] {
  const seen = new Set<string>();
  for (const r of runners) {
    const name = (r.horse_name ?? '').trim();
    if (name !== '') seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Summarises races NEAR an unmatched race row, for the operator to eyeball — it
 * does NOT auto-match. Using the injected `normalizeCourse` (the same pure
 * normaliser the importer matches with), it splits the day's races into:
 *   - sameCourseOffTimes: off-times (HH:MM) of races at the SAME normalised
 *     course (so a wrong off_time is obvious), and
 *   - otherCourses: the distinct, verbatim course names present that day (so a
 *     mis-spelt course is obvious).
 * Pure; never returns a chosen race and never feeds back into matching.
 */
export function summarizeNearbyRaces(
  dayRaces: readonly DiagRaceRow[],
  wantCourseRaw: string,
  normalizeCourse: (value: string | null | undefined) => string,
): { sameCourseOffTimes: string[]; otherCourses: string[] } {
  const want = normalizeCourse(wantCourseRaw);
  const sameCourseOffTimes = new Set<string>();
  const otherCourses = new Set<string>();
  for (const race of dayRaces) {
    if (normalizeCourse(race.course) === want) {
      sameCourseOffTimes.add(hhmmFromIso(race.off_time));
    } else {
      const name = (race.course ?? '').trim();
      if (name !== '') otherCourses.add(name);
    }
  }
  return {
    sameCourseOffTimes: [...sameCourseOffTimes].sort(),
    otherCourses: [...otherCourses].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Builds an actionable "Fix your CSV" section from the audit counters, listing
 * only the issue categories that actually occurred (deterministic order). When
 * nothing needs fixing, returns a single all-clear line. Pure.
 */
export function buildFixCsvSection(counts: ImportIssueCounts): string[] {
  const lines: string[] = [];
  if (counts.skipped_missing_required > 0) {
    lines.push(
      `${counts.skipped_missing_required} row(s) missing required fields — ` +
        'ensure meeting_date (YYYY-MM-DD), course, off_time (HH:MM), horse_name, ' +
        'tipster_name are all present.',
    );
  }
  if (counts.skipped_unmatched_race > 0) {
    lines.push(
      `${counts.skipped_unmatched_race} row(s) matched no race — check the ` +
        'course spelling and off_time against --list-races for that date.',
    );
  }
  if (counts.skipped_ambiguous_race > 0) {
    lines.push(
      `${counts.skipped_ambiguous_race} row(s) matched more than one race — ` +
        'the course + off_time is not unique; verify the intended race.',
    );
  }
  if (counts.skipped_unmatched_horse > 0) {
    lines.push(
      `${counts.skipped_unmatched_horse} row(s) matched no runner — compare the ` +
        'horse_name against the available runners listed above for that race.',
    );
  }
  if (counts.skipped_ambiguous_horse > 0) {
    lines.push(
      `${counts.skipped_ambiguous_horse} row(s) matched more than one runner — ` +
        'two runners share that name after normalisation; disambiguate manually.',
    );
  }
  if (counts.tipsters_unresolved > 0) {
    lines.push(
      `${counts.tipsters_unresolved} pick(s) have an unresolved tipster — they ` +
        'still import with tipster_id = null (raw name kept). Add a tipster/alias ' +
        'if you want them linked.',
    );
  }
  if (counts.duplicate_rows_ignored_or_would_ignore > 0) {
    lines.push(
      `${counts.duplicate_rows_ignored_or_would_ignore} duplicate row(s) would be ` +
        'ignored (same race + runner + tipster). This is expected on re-imports.',
    );
  }
  if (lines.length === 0) {
    lines.push('No issues detected — every row resolved to a race and runner.');
  }
  return lines;
}
