/**
 * Pure aggregation for the READ-ONLY nationwide dry-run TIMING harness —
 * Nationwide rebuild Phase 7A.2a.
 *
 * Given a fully-assembled, read-only projection of one meeting date's races
 * (all courses) — each already timed by the SELECT-only CLI
 * (scripts/nationwideTiming.ts) reading + scoring the race exactly as
 * `runModelForRace` would, but WITHOUT persisting anything — this module
 * aggregates the evidence: how many races were scored / skipped / failed, how
 * many runners were scored, and whether the total SEQUENTIAL read+score time
 * fits inside the 5-minute watcher cadence (`pipeline:watch`'s default
 * interval; Railway's `pipeline-refresh` schedule).
 *
 * PURPOSE: answer "can the existing system read + score every UK/IRE race
 * nationwide inside one watcher cycle, with failures isolated?" — NOT to
 * enable nationwide writes. The verdict here is informational only, exactly
 * like `nationwideAudit.ts`'s evidence-gate verdict: it never enables,
 * schedules, or invokes nationwide commit mode.
 *
 * No I/O, no DB, no clock (durations are pre-measured `number`s passed in by
 * the caller), no writes. Mirrors the pure-builder + pure-markdown-renderer
 * shape of `src/lib/nationwideAudit.ts` for consistency.
 */

/**
 * Why a race was skipped rather than scored. This harness deliberately does
 * NOT apply the production pre-off guard (POST_OFF/RESULTED): that guard
 * exists in `runModelForRace` to protect the WRITTEN decision record from a
 * stale post-off write, and this harness never writes anything, so the risk
 * the guard protects against cannot occur here. Skipping post-off/resulted
 * races here would also defeat the harness's purpose — retrospective
 * measurement against already-completed race days. The only legitimate skip
 * is a race with nothing to score.
 */
export type TimingSkipReason = 'NO_PRICED_FIELD';

/** One race's read-only timing measurement (assembled by the SELECT-only CLI). */
export interface NationwideTimingRaceInput {
  race_id: string;
  course_label: string | null;
  off_time: string | null;
  status: string | null;
  /** Priced runners scored (0 when skipped/failed). */
  runner_count: number;
  /** Sequential wall-clock time to read + score this race, or null when not scored. */
  duration_ms: number | null;
  /** True when the race was actually read + scored (not skipped, not failed). */
  scored: boolean;
  /** Set only when `scored` is false and the race was a guarded/no-data skip. */
  skip_reason: TimingSkipReason | null;
  /** Isolated per-race read/compute failure message, or null. */
  error: string | null;
}

/** The watcher cadence this evidence is measured against (5 minutes). */
export const WATCHER_CADENCE_MS = 300_000;

/** REVIEW threshold: 60% of the cadence — informational only. */
export const REVIEW_THRESHOLD_MS = 180_000;

export type TimingVerdict = 'PASS' | 'REVIEW' | 'FAIL';

export interface DurationStats {
  total_ms: number;
  min_ms: number;
  mean_ms: number;
  median_ms: number;
  p95_ms: number;
  max_ms: number;
  /** race_id of the single slowest scored race, for follow-up. */
  slowest_race_id: string;
}

export interface NationwideTimingReport {
  date: string;
  races_considered: number;
  races_scored: number;
  races_skipped_no_priced_field: number;
  races_failed: number;
  runners_scored: number;
  /** Null when zero races were scored (never a fabricated zero-duration). */
  duration: DurationStats | null;
  watcher_cadence_ms: number;
  /** `watcher_cadence_ms - duration.total_ms`; null when duration is null. */
  margin_ms: number | null;
  /** Per-race failures, verbatim (race_id + message) — never summarised away. */
  failures: Array<{ race_id: string; error: string }>;
  /** Every hard reconciliation violation found (empty when clean). */
  invariant_violations: string[];
  verdict: TimingVerdict;
  verdict_reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Percentile (0-100) of a SORTED ascending array using nearest-rank. Pure. */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return sortedAsc[idx];
}

function median(sortedAsc: readonly number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

/** Builds duration stats from the scored races only. Null input -> null (never fabricated). Pure. */
function buildDurationStats(
  scored: ReadonlyArray<{ race_id: string; duration_ms: number }>,
): DurationStats | null {
  if (scored.length === 0) return null;
  const sorted = [...scored].sort((a, b) => a.duration_ms - b.duration_ms);
  const values = sorted.map((s) => s.duration_ms);
  const total = values.reduce((sum, v) => sum + v, 0);
  const slowest = sorted[sorted.length - 1];
  return {
    total_ms: total,
    min_ms: values[0],
    mean_ms: total / values.length,
    median_ms: median(values),
    p95_ms: percentile(values, 95),
    max_ms: values[values.length - 1],
    slowest_race_id: slowest.race_id,
  };
}

/* -------------------------------------------------------------------------- */
/* Report building                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Builds the full nationwide timing report from per-race timing inputs. The
 * verdict is INFORMATIONAL ONLY — it never enables/schedules/invokes
 * nationwide commit mode. Pure.
 */
export function buildNationwideTimingReport(
  date: string,
  races: readonly NationwideTimingRaceInput[],
): NationwideTimingReport {
  const scored = races.filter((r) => r.scored);
  const failed = races.filter((r) => r.error !== null);
  const skippedNoPricedField = races.filter((r) => r.skip_reason === 'NO_PRICED_FIELD');

  const durationInputs = scored
    .filter((r) => r.duration_ms !== null)
    .map((r) => ({ race_id: r.race_id, duration_ms: r.duration_ms as number }));
  const duration = buildDurationStats(durationInputs);

  const runnersScored = scored.reduce((n, r) => n + r.runner_count, 0);

  const invariant_violations: string[] = [];
  const reconciled = scored.length + skippedNoPricedField.length + failed.length;
  if (reconciled !== races.length) {
    invariant_violations.push(
      `scored + skipped(no_priced_field) + failed (${reconciled}) does not reconcile to races_considered (${races.length})`,
    );
  }
  if (scored.length !== durationInputs.length) {
    invariant_violations.push(
      `scored races (${scored.length}) does not match races with a recorded duration (${durationInputs.length})`,
    );
  }

  const marginMs = duration === null ? null : WATCHER_CADENCE_MS - duration.total_ms;

  const verdictReasons: string[] = [];
  let verdict: TimingVerdict;
  if (invariant_violations.length > 0) {
    verdict = 'FAIL';
    verdictReasons.push(...invariant_violations);
  } else if (duration !== null && duration.total_ms >= WATCHER_CADENCE_MS) {
    verdict = 'FAIL';
    verdictReasons.push(
      `total sequential read+score time (${duration.total_ms}ms) meets/exceeds the watcher cadence (${WATCHER_CADENCE_MS}ms)`,
    );
  } else if (
    (duration !== null && duration.total_ms >= REVIEW_THRESHOLD_MS) ||
    failed.length > 0 ||
    skippedNoPricedField.length > 0
  ) {
    verdict = 'REVIEW';
    if (duration !== null && duration.total_ms >= REVIEW_THRESHOLD_MS) {
      verdictReasons.push(
        `total sequential read+score time (${duration.total_ms}ms) exceeds ${REVIEW_THRESHOLD_MS}ms (60% of the ${WATCHER_CADENCE_MS}ms cadence) — margin is tight once racecards/odds cron steps in the same cycle are accounted for`,
      );
    }
    if (failed.length > 0) {
      verdictReasons.push(`${failed.length} race(s) had an isolated read/compute failure — needs operator review`);
    }
    if (skippedNoPricedField.length > 0) {
      verdictReasons.push(`${skippedNoPricedField.length} race(s) had no priced field to score (odds/racecard gap) — review coverage`);
    }
  } else {
    verdict = 'PASS';
    verdictReasons.push('total sequential read+score time is comfortably inside the watcher cadence with no failures or skips');
  }

  return {
    date,
    races_considered: races.length,
    races_scored: scored.length,
    races_skipped_no_priced_field: skippedNoPricedField.length,
    races_failed: failed.length,
    runners_scored: runnersScored,
    duration,
    watcher_cadence_ms: WATCHER_CADENCE_MS,
    margin_ms: marginMs,
    failures: failed.map((r) => ({ race_id: r.race_id, error: r.error as string })),
    invariant_violations,
    verdict,
    verdict_reasons: verdictReasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function ms(value: number): string {
  return `${value.toFixed(0)}ms`;
}

/** Renders the timing report as deterministic Markdown (same input -> same string). */
export function renderNationwideTimingMarkdown(
  report: NationwideTimingReport,
  generatedAt: string,
): string {
  const blocks: string[] = [];

  blocks.push(`# Nationwide dry-run timing evidence — ${report.date}`);
  blocks.push(
    [
      '**READ ONLY — SELECT-only timing harness.** No `--commit` flag exists anywhere in this',
      'procedure. Nothing was inserted, updated, upserted, or deleted; no model run, lock, or',
      'result was written; no bet was placed.',
      `Generated: ${generatedAt}`,
      '',
      '> This report measures whether the existing model-scoring step can read + score every',
      '> UK/IRE race nationwide inside one 5-minute watcher cycle, with failures isolated. It is',
      '> evidence for a future gated decision (Phase 7B) — it does NOT enable, schedule, or',
      '> invoke nationwide commit mode.',
    ].join('\n'),
  );

  if (report.invariant_violations.length > 0) {
    blocks.push(
      [
        '## ⚠️ INVARIANT VIOLATIONS — DO NOT TRUST THE FIGURES BELOW',
        '',
        ...report.invariant_violations.map((v) => `- ${v}`),
      ].join('\n'),
    );
  }

  const d = report.duration;
  blocks.push(
    [
      '## Coverage',
      '',
      `- Races considered: ${report.races_considered}`,
      `- Races scored (read + compute, no write): ${report.races_scored}`,
      `- Runners scored: ${report.runners_scored}`,
      `- Skipped — no priced field: ${report.races_skipped_no_priced_field}`,
      `- Failed (isolated): ${report.races_failed}`,
    ].join('\n'),
  );

  blocks.push(
    [
      '## Timing (sequential, matching the real watcher loop)',
      '',
      d === null
        ? '- No races were scored — no timing data.'
        : [
            `- Total: ${ms(d.total_ms)}`,
            `- Min: ${ms(d.min_ms)} · Mean: ${ms(d.mean_ms)} · Median: ${ms(d.median_ms)} · p95: ${ms(d.p95_ms)} · Max: ${ms(d.max_ms)}`,
            `- Slowest race: ${d.slowest_race_id}`,
            `- Watcher cadence: ${ms(report.watcher_cadence_ms)}`,
            `- Margin: ${report.margin_ms === null ? '—' : ms(report.margin_ms)}`,
          ].join('\n'),
    ].join('\n'),
  );

  if (report.failures.length > 0) {
    blocks.push(
      ['## Isolated failures', '', ...report.failures.map((f) => `- ${f.race_id}: ${f.error}`)].join('\n'),
    );
  }

  blocks.push(
    [
      `## Verdict: ${report.verdict}`,
      '',
      ...report.verdict_reasons.map((r) => `- ${r}`),
      '',
      'This report does not enable nationwide commit mode.',
    ].join('\n'),
  );

  return blocks.join('\n\n') + '\n';
}

/** Deterministic report path: `reports/nationwide-timing-<date>.md`. Pure. */
export function buildNationwideTimingPath(date: string): string {
  return `reports/nationwide-timing-${date}.md`;
}
