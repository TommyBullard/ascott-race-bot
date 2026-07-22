/**
 * Nationwide dry-run — pure evaluation, reconciliation, and rendering —
 * Nationwide rebuild Phase 7A.2b Step 5.
 *
 * Backs the `nationwide:dry-run` CLI (scripts/nationwideDryRun.ts). This
 * module performs NO provider calls, NO model persistence, and NO Supabase
 * WRITES of its own — its only I/O is {@link fetchNationwideWorkloadRows}, a
 * single injectable SELECT-only reader (mirrors the injectable-factory
 * pattern already used by `raceDayPipelineRunner.ts`'s `createFetchRaceRows`).
 * Everything else here is pure functions over already-gathered inputs.
 *
 * REUSES, NEVER REINVENTS:
 *   - `normalizeCourse` (course identity — the ONE normalisation rule);
 *   - `checkRollupInvariants`, `UNKNOWN_COURSE_LABEL`, `EXPECTED_COUNTRIES`,
 *     `FALLBACK_COUNTRY_VALUE` from `nationwideAudit.ts` — the SAME hard
 *     invariants and course-warning vocabulary the nationwide audit uses.
 *     Lock/settlement/model-run fields are irrelevant to a dry-run (it
 *     creates none of those), so they are passed as `null`/`0` — which
 *     `checkRollupInvariants` already treats as "not applicable, skip this
 *     check" by design (its null-guards exist exactly for this).
 *   - `buildNationwideTimingReport` / `NationwideTimingRaceInput` /
 *     `DurationStats` / `WATCHER_CADENCE_MS` from `nationwideTiming.ts` — the
 *     SAME scoring/timing aggregation (races scored/skipped/failed, duration
 *     percentiles, cadence margin) the Phase 7A.2a timing harness produces.
 *
 * The ONE genuinely new piece of logic is {@link reconcileNationwideWorkload}:
 * it computes the nationwide totals TWICE, independently (once ungrouped over
 * every row, once by grouping via `normalizeCourse` and summing the groups),
 * and cross-checks the two answers agree. This is not a second rollup rule —
 * it is the same arithmetic definition evaluated two ways as a defense-in-
 * depth check that the one grouping rule was applied consistently.
 *
 * Decision-support only — creates no model_runs, model_runner_scores,
 * recommendations, locked_race_decisions, results, training rows, or GenAI
 * artifacts, and never places a bet.
 */

import { normalizeCourse } from './raceSync';
import {
  UNKNOWN_COURSE_LABEL,
  EXPECTED_COUNTRIES,
  FALLBACK_COUNTRY_VALUE,
  checkRollupInvariants,
} from './nationwideAudit';
import {
  buildNationwideTimingReport,
  WATCHER_CADENCE_MS,
  type NationwideTimingRaceInput,
  type NationwideTimingReport,
} from './nationwideTiming';
import type { NationwideMode } from './nationwideOwnership';

/** The two operator-facing CLI mode values (Correction 1 — no default). */
export type NationwideCliMode = 'stored-only' | 'live-provider';

/** Maps the CLI's mode flag to the claim metadata mode recorded in the DB. */
export function toOwnershipMode(mode: NationwideCliMode): NationwideMode {
  return mode === 'stored-only' ? 'nationwide-stored-dry-run' : 'nationwide-live-provider-dry-run';
}

/** Parses `--mode` input; anything else is invalid (no default — Correction 1). Pure. */
export function parseNationwideCliMode(raw: string | null | undefined): NationwideCliMode | null {
  if (raw === 'stored-only' || raw === 'live-provider') return raw;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Workload reconciliation (read-only inputs; pure evaluation)                */
/* -------------------------------------------------------------------------- */

/** One race's read-only workload row (assembled by {@link fetchNationwideWorkloadRows}). */
export interface NationwideWorkloadRow {
  race_id: string;
  course_label: string | null;
  country: string | null;
  runner_count: number;
  /** A qualifying odds snapshot exists; null = unknown (read failed — never assumed false). */
  has_odds: boolean | null;
  /** Priced runners in the latest snapshot; null = unknown. */
  priced_runner_count: number | null;
}

export interface CourseWorkloadTotals {
  course: string;
  labels: string[];
  countries: string[];
  races: number;
  runners: number;
  races_with_odds: number;
  priced_runners: number;
}

export interface NationwideWorkloadTotals {
  courses: number;
  races: number;
  runners: number;
  races_with_odds: number;
  priced_runners: number;
}

export interface NationwideReconciliation {
  totals: NationwideWorkloadTotals;
  perCourse: CourseWorkloadTotals[];
  /** GB-fallback / non-expected-country / merged-label warnings — WARNINGS only, never proven country labels. */
  warnings: string[];
  /** Every hard invariant violation, verbatim (never clamped/hidden/summarised). */
  violations: string[];
  /** True only when races > 0, courses > 0, and zero violations. */
  ok: boolean;
  /** Human reason scoring must not proceed, or null when `ok`. */
  blockReason: string | null;
}

/**
 * Reconciles a nationwide workload snapshot: groups by `normalizeCourse`,
 * computes totals TWICE independently and cross-checks them, and runs the
 * SAME hard invariants the nationwide audit uses (races_with_odds <= races,
 * priced_runners <= runners). Zero races or zero courses is an explicit block
 * (never a fabricated pass). Pure.
 */
export function reconcileNationwideWorkload(rows: readonly NationwideWorkloadRow[]): NationwideReconciliation {
  // Pass 1: ungrouped totals, computed directly over every row.
  let races = 0;
  let runners = 0;
  let racesWithOdds = 0;
  let pricedRunners = 0;
  const courseKeys = new Set<string>();
  for (const r of rows) {
    races += 1;
    runners += r.runner_count;
    if (r.has_odds === true) racesWithOdds += 1;
    if (r.priced_runner_count !== null) pricedRunners += r.priced_runner_count;
    courseKeys.add(r.course_label && r.course_label.trim() !== '' ? normalizeCourse(r.course_label) : UNKNOWN_COURSE_LABEL);
  }
  const totals: NationwideWorkloadTotals = {
    courses: courseKeys.size,
    races,
    runners,
    races_with_odds: racesWithOdds,
    priced_runners: pricedRunners,
  };

  // Pass 2: grouped by course (the ONE normalisation rule), summed independently.
  interface Bucket {
    labels: Set<string>;
    countries: Set<string>;
    races: number;
    runners: number;
    races_with_odds: number;
    priced_runners: number;
  }
  const byCourse = new Map<string, Bucket>();
  for (const r of rows) {
    const key = r.course_label && r.course_label.trim() !== '' ? normalizeCourse(r.course_label) : UNKNOWN_COURSE_LABEL;
    let bucket = byCourse.get(key);
    if (!bucket) {
      bucket = { labels: new Set(), countries: new Set(), races: 0, runners: 0, races_with_odds: 0, priced_runners: 0 };
      byCourse.set(key, bucket);
    }
    if (r.course_label) bucket.labels.add(r.course_label);
    bucket.countries.add(r.country ?? FALLBACK_COUNTRY_VALUE);
    bucket.races += 1;
    bucket.runners += r.runner_count;
    if (r.has_odds === true) bucket.races_with_odds += 1;
    if (r.priced_runner_count !== null) bucket.priced_runners += r.priced_runner_count;
  }
  const perCourse: CourseWorkloadTotals[] = [...byCourse.entries()]
    .map(([course, b]) => ({
      course,
      labels: [...b.labels].sort(),
      countries: [...b.countries].sort(),
      races: b.races,
      runners: b.runners,
      races_with_odds: b.races_with_odds,
      priced_runners: b.priced_runners,
    }))
    .sort((a, b) => a.course.localeCompare(b.course));

  const violations: string[] = [];

  // Cross-check: the two independent computations of the SAME totals must agree.
  const sumRaces = perCourse.reduce((s, c) => s + c.races, 0);
  const sumRunners = perCourse.reduce((s, c) => s + c.runners, 0);
  const sumOdds = perCourse.reduce((s, c) => s + c.races_with_odds, 0);
  const sumPriced = perCourse.reduce((s, c) => s + c.priced_runners, 0);
  if (sumRaces !== totals.races) {
    violations.push(`per-course race sum (${sumRaces}) does not equal the nationwide total (${totals.races})`);
  }
  if (sumRunners !== totals.runners) {
    violations.push(`per-course runner sum (${sumRunners}) does not equal the nationwide total (${totals.runners})`);
  }
  if (sumOdds !== totals.races_with_odds) {
    violations.push(`per-course races-with-odds sum (${sumOdds}) does not equal the nationwide total (${totals.races_with_odds})`);
  }
  if (sumPriced !== totals.priced_runners) {
    violations.push(`per-course priced-runner sum (${sumPriced}) does not equal the nationwide total (${totals.priced_runners})`);
  }

  // Reuse the SAME hard invariants the nationwide audit enforces (lock/model/
  // settlement fields null/0 — not applicable to a dry-run that persists none
  // of those; checkRollupInvariants already skips null fields by design).
  violations.push(
    ...checkRollupInvariants('overall', {
      races: totals.races,
      runners: totals.runners,
      races_with_odds: totals.races_with_odds,
      priced_runners: totals.priced_runners,
      races_with_pre_off_run: null,
      diagnostic_picks: null,
      diagnostic_no_bets: null,
      settled: 0,
      pending: 0,
      locked_rows: null,
      locked_picks: null,
      locked_no_bets: null,
      no_run_available: null,
      not_locked_yet: null,
      lock_missing: null,
    }),
  );
  for (const c of perCourse) {
    violations.push(
      ...checkRollupInvariants(c.course, {
        races: c.races,
        runners: c.runners,
        races_with_odds: c.races_with_odds,
        priced_runners: c.priced_runners,
        races_with_pre_off_run: null,
        diagnostic_picks: null,
        diagnostic_no_bets: null,
        settled: 0,
        pending: 0,
        locked_rows: null,
        locked_picks: null,
        locked_no_bets: null,
        no_run_available: null,
        not_locked_yet: null,
        lock_missing: null,
      }),
    );
  }

  // Country / label warnings — WARNINGS only, never proven country labels.
  const warnings: string[] = [];
  for (const c of perCourse) {
    if (c.labels.length > 1) {
      warnings.push(`course "${c.course}" merges ${c.labels.length} distinct stored labels: ${c.labels.join(', ')}`);
    }
    for (const country of c.countries) {
      if (!EXPECTED_COUNTRIES.includes(country.toLowerCase())) {
        warnings.push(
          `course "${c.course}" has an unexpected country value "${country}"` +
            (country === FALLBACK_COUNTRY_VALUE ? ' (this is the ingest-time fallback — not a proven label)' : ''),
        );
      }
    }
  }

  const blockReason =
    totals.races === 0
      ? 'zero stored races for this date — scoring cannot proceed'
      : totals.courses === 0
        ? 'zero courses reconciled from the stored races — scoring cannot proceed'
        : violations.length > 0
          ? `${violations.length} reconciliation invariant violation(s) — scoring cannot proceed`
          : null;

  return { totals, perCourse, warnings, violations, ok: blockReason === null, blockReason };
}

/* -------------------------------------------------------------------------- */
/* Shared read-only workload gatherer (the ONLY I/O in this module)           */
/* -------------------------------------------------------------------------- */

/** The minimal Supabase surface the gatherer needs (injectable for tests). */
export interface NationwideWorkloadClient {
  selectRaces(date: string): Promise<{ data: unknown; error: { message: string } | null }>;
  selectRunners(raceIds: readonly string[]): Promise<{ data: unknown; error: { message: string } | null }>;
  selectLatestSnapshots(raceIds: readonly string[]): Promise<{ data: unknown; error: { message: string } | null }>;
  selectQuotes(snapshotIds: readonly string[]): Promise<{ data: unknown; error: { message: string } | null }>;
}

/**
 * SELECT-only: races for the date, runner counts, the latest odds snapshot
 * per race, and its priced-runner count — the exact same read pattern
 * `scripts/nationwideAudit.ts` uses per-race, done here as four bulk queries.
 * Never writes. Isolated: a read failure at any stage degrades that race's
 * `has_odds`/`priced_runner_count` to `null` (unknown) rather than throwing
 * the whole gather away — matching the audit's fail-open-to-UNKNOWN posture
 * for optional coverage data (never a fabricated zero-success).
 */
export async function fetchNationwideWorkloadRows(
  client: NationwideWorkloadClient,
  date: string,
): Promise<{ rows: NationwideWorkloadRow[] | null; error: string | null }> {
  const racesRes = await client.selectRaces(date);
  if (racesRes.error) return { rows: null, error: `races read failed: ${racesRes.error.message}` };
  const races = (racesRes.data ?? []) as Array<{
    id: string | number;
    course: string | null;
    country: string | null;
  }>;
  if (races.length === 0) return { rows: [], error: null };

  const raceIds = races.map((r) => String(r.id));

  const [runnersRes, snapshotsRes] = await Promise.all([
    client.selectRunners(raceIds),
    client.selectLatestSnapshots(raceIds),
  ]);

  const runnerCountByRace = new Map<string, number>();
  let runnersOk = !runnersRes.error;
  if (runnersOk) {
    for (const row of (runnersRes.data ?? []) as Array<{ race_id: string | number }>) {
      const key = String(row.race_id);
      runnerCountByRace.set(key, (runnerCountByRace.get(key) ?? 0) + 1);
    }
  }

  const latestSnapshotByRace = new Map<string, string>(); // race_id -> snapshot_id
  let snapshotsOk = !snapshotsRes.error;
  if (snapshotsOk) {
    // Rows are expected pre-sorted (snapshot_time desc); keep the FIRST seen per race.
    for (const row of (snapshotsRes.data ?? []) as Array<{ id: string | number; race_id: string | number }>) {
      const raceKey = String(row.race_id);
      if (!latestSnapshotByRace.has(raceKey)) latestSnapshotByRace.set(raceKey, String(row.id));
    }
  }

  const snapshotIds = [...new Set(latestSnapshotByRace.values())];
  const pricedByRace = new Map<string, number>();
  let quotesOk = true;
  if (snapshotsOk && snapshotIds.length > 0) {
    const quotesRes = await client.selectQuotes(snapshotIds);
    quotesOk = !quotesRes.error;
    if (quotesOk) {
      const runnersBySnapshot = new Map<string, Set<string>>();
      for (const row of (quotesRes.data ?? []) as Array<{ snapshot_id: string | number; runner_id: string | number }>) {
        const snapKey = String(row.snapshot_id);
        if (!runnersBySnapshot.has(snapKey)) runnersBySnapshot.set(snapKey, new Set());
        runnersBySnapshot.get(snapKey)!.add(String(row.runner_id));
      }
      for (const [raceId, snapId] of latestSnapshotByRace) {
        pricedByRace.set(raceId, runnersBySnapshot.get(snapId)?.size ?? 0);
      }
    }
  }

  const rows: NationwideWorkloadRow[] = races.map((r) => {
    const raceId = String(r.id);
    return {
      race_id: raceId,
      course_label: r.course,
      country: r.country,
      runner_count: runnersOk ? (runnerCountByRace.get(raceId) ?? 0) : 0,
      has_odds: snapshotsOk ? latestSnapshotByRace.has(raceId) : null,
      priced_runner_count: snapshotsOk && quotesOk ? (pricedByRace.get(raceId) ?? (latestSnapshotByRace.has(raceId) ? 0 : 0)) : null,
    };
  });
  return { rows, error: null };
}

/* -------------------------------------------------------------------------- */
/* Provider stage summaries                                                   */
/* -------------------------------------------------------------------------- */

export type ProviderStageStatus = 'ok' | 'failed' | 'skipped' | 'not_applicable';

export interface ProviderStageSummary {
  stage: 'racecards' | 'odds';
  status: ProviderStageStatus;
  detail: string;
}

/* -------------------------------------------------------------------------- */
/* Claim lifecycle + full report                                             */
/* -------------------------------------------------------------------------- */

export type ClaimLifecycleStart = 'acquired' | 'stole_expired';
export type ClaimLifecycleEnd = 'released' | 'release_failed' | 'lost' | 'uncertain' | 'unavailable' | 'not_reached';

export interface NationwideDryRunReport {
  date: string;
  mode: NationwideCliMode;
  scope: string;
  ownerPrefix: string;
  generation: number;
  claimStart: ClaimLifecycleStart;
  claimEnd: ClaimLifecycleEnd;
  providerStages: ProviderStageSummary[];
  reconciliation: NationwideReconciliation | null;
  timing: NationwideTimingReport | null;
  commandDurationMs: number;
  /** True only when the run reached the end of its stage contract without being stopped. */
  completed: boolean;
  /** The stage name at which the run stopped, or null when `completed`. */
  blockedAtStage: string | null;
  /** Human reason the run stopped, or null when `completed`. */
  blockedReason: string | null;
}

/** Fixed, honest note — this command performs no external checks itself. */
export const EXTERNAL_CHECKS_SOURCE_NOTE =
  'not_applicable — this command performs no external checks; run nationwide:preflight separately for an operator-attested verdict';

/** Deterministic report path: `reports/nationwide-dry-run-<date>-<mode>.md`. Pure. */
export function buildNationwideDryRunPath(date: string, mode: NationwideCliMode): string {
  return `reports/nationwide-dry-run-${date}-${mode}.md`;
}

/** Renders the dry-run report as deterministic Markdown (same input -> same string). Pure. */
export function renderNationwideDryRunMarkdown(report: NationwideDryRunReport, generatedAtIso: string): string {
  const blocks: string[] = [];

  blocks.push(`# Nationwide dry-run — ${report.date} — ${report.mode}`);
  blocks.push(
    [
      '**READ/INGESTION BOUNDARY.** No model runs, recommendations, official locks, or',
      'results were persisted by this command. No bet was placed; no bet was ever possible.',
      `Generated: ${generatedAtIso}`,
      '',
      `- Mode: \`${report.mode}\``,
      `- Ownership scope: \`${report.scope}\``,
      `- Owner: ${report.ownerPrefix}… (generation ${report.generation})`,
      `- Claim lifecycle: ${report.claimStart} → ${report.claimEnd}`,
      `- External checks source: ${EXTERNAL_CHECKS_SOURCE_NOTE}`,
    ].join('\n'),
  );

  blocks.push(
    [
      '## Provider stages attempted',
      '',
      report.providerStages.length === 0
        ? '- None (stored-only mode makes no provider calls).'
        : report.providerStages.map((s) => `- ${s.stage}: ${s.status} — ${s.detail}`).join('\n'),
    ].join('\n'),
  );

  if (report.reconciliation) {
    const r = report.reconciliation;
    blocks.push(
      [
        '## Rollup reconciliation',
        '',
        `- Courses: ${r.totals.courses}`,
        `- Total races: ${r.totals.races}`,
        `- Total runners: ${r.totals.runners}`,
        `- Races with odds: ${r.totals.races_with_odds}`,
        `- Priced runners: ${r.totals.priced_runners}`,
        r.violations.length > 0
          ? ['', '**INVARIANT VIOLATIONS — scoring was blocked:**', ...r.violations.map((v) => `- ${v}`)].join('\n')
          : '- No invariant violations.',
        '',
        '### Per-course counts',
        '',
        '| Course | Races | Runners | Odds | Priced runners |',
        '| --- | --- | --- | --- | --- |',
        ...r.perCourse.map((c) => `| ${c.course} | ${c.races} | ${c.runners} | ${c.races_with_odds} | ${c.priced_runners} |`),
      ].join('\n'),
    );
    if (r.warnings.length > 0) {
      blocks.push(['## Warnings', '', ...r.warnings.map((w) => `- ${w}`)].join('\n'));
    }
  } else {
    blocks.push('## Rollup reconciliation\n\n- Not reached (the run stopped before reconciliation).');
  }

  if (report.timing) {
    const t = report.timing;
    const d = t.duration;
    blocks.push(
      [
        '## Scoring',
        '',
        `- Eligible races: ${t.races_considered}`,
        `- Scored races: ${t.races_scored}`,
        `- Zero-priced skips: ${t.races_skipped_no_priced_field}`,
        `- Failures (isolated): ${t.races_failed}`,
        d === null
          ? '- No races were scored — no timing data.'
          : [
              `- Total: ${d.total_ms.toFixed(0)}ms · Mean: ${d.mean_ms.toFixed(0)}ms · Median: ${d.median_ms.toFixed(0)}ms · p95: ${d.p95_ms.toFixed(0)}ms · Max: ${d.max_ms.toFixed(0)}ms`,
              `- Five-minute-cadence margin: ${t.margin_ms === null ? '—' : `${t.margin_ms.toFixed(0)}ms`}`,
            ].join('\n'),
        t.failures.length > 0 ? ['', ...t.failures.map((f) => `- FAILED ${f.race_id}: ${f.error}`)].join('\n') : '',
      ]
        .filter((s) => s !== '')
        .join('\n'),
    );
  } else {
    blocks.push('## Scoring\n\n- Not reached (the run stopped before scoring).');
  }

  blocks.push(`## Command duration\n\n- ${report.commandDurationMs.toFixed(0)}ms total`);

  blocks.push(
    [
      `## Outcome: ${report.completed ? 'COMPLETED' : 'STOPPED'}`,
      '',
      report.completed
        ? '- The run completed its full stage contract.'
        : `- Stopped at stage "${report.blockedAtStage}": ${report.blockedReason}`,
      '',
      'No model runs, recommendations, locks, or results were persisted by this command.',
      'No betting and no bet placement — this system never places a bet.',
    ].join('\n'),
  );

  return blocks.join('\n\n') + '\n';
}

export { buildNationwideTimingReport, WATCHER_CADENCE_MS, type NationwideTimingRaceInput, type NationwideTimingReport };
