/**
 * Pure helpers for the CONTROLLED race-day operator MVP
 * (scripts/raceDayOperate.ts).
 *
 * This produces a SAFE, deterministic operating PLAN + next-action for a race
 * day, and a runner SEAM that — in a future phase — could drive only the
 * read-only steps. In THIS phase it is strictly DECISION-SUPPORT and
 * PLAN-ONLY:
 *   - it executes NOTHING, writes NO database, spawns NO child process;
 *   - it prints the per-race timing windows (T-15 refresh, T-7 pipeline
 *     refresh, T-5 capture, off-time lock, post-off no-rerun warning, result
 *     check), the preflight checks, the result-settlement steps, the end-of-day
 *     reporting commands, the dashboard reminder, and the safety notes;
 *   - the only DB-writing commands it documents (the pipeline refresh and the
 *     results-settlement commit step) are flagged MANUAL-APPROVAL and are never
 *     run by this phase;
 *   - the future flags (--allow-pipeline-writes / --allow-result-commit /
 *     --run-once-readonly / --watch / --minutes-before / --stop-after-race) are
 *     DOCUMENTED but NOT implemented here.
 *
 * Everything is pure and deterministic: argument parsing, schedule arithmetic,
 * the command plan, the next-action derivation (reusing {@link deriveNextAction})
 * and the rendering. There is NO database access, NO network, NO child-process
 * spawning, and NO environment read here (the CLI does the optional SELECT-only
 * race lookup and passes the rows in). Missing values render as an em dash;
 * nothing is fabricated. All times are rendered in UTC (the storage convention).
 *
 * The runner seam ({@link simulateReadOnlyRun}) is injected with a runner
 * function so it can be unit-tested with a FAKE runner and never touches a real
 * child process. It refuses to run any approval/write command (e.g. anything
 * carrying the commit flag) — those are always reported as skipped.
 */

import { deriveNextAction, type NextAction } from './operatorNextAction';
import type { NextRaceLike } from './raceDayStatus';

const DASH = '\u2014';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Schedule offsets (minutes) relative to each race's off time. */
export const REFRESH_OFFSET_MIN = 15;
export const PIPELINE_REFRESH_OFFSET_MIN = 7;
export const CAPTURE_OFFSET_MIN = 5;
export const RESULT_CHECK_OFFSET_MIN = 30;

/** Default T-minus capture target (minutes before off). */
export const DEFAULT_MINUTES_BEFORE = 5;

/** The post-off reminder shown for every race (no model re-run after the off). */
export const POST_OFF_NO_RERUN_NOTE =
  'After the off, do NOT re-run the model — the pre-off run is the decision of record.';

/** The exact warning shown when no stored races are found for the date/course. */
export const NO_RACES_WARNING =
  'No stored races found; the schedule is empty (run racecards ingest manually when appropriate).';

/** The fixed safety disclaimers (always shown). */
export const SAFETY_NOTES: readonly string[] = [
  'No auto-betting and no bet placement under any flag in this phase.',
  'No orders are ever placed; this is decision-support only.',
  'No guaranteed outcomes and no betting edge are claimed.',
  'No GenAI winner prediction; GenAI / race-intelligence stays shadow-only and is never model-active.',
  'No no-bet gates are activated; gate research stays read-only.',
  'The website is read-only — it has no commit or write controls in the UI.',
];

/**
 * Future flags — DOCUMENTED here but NOT implemented in this phase. Passing any
 * of them leaves the tool in plan-only mode and only adds an inert warning.
 */
export const FUTURE_FLAGS: ReadonlyArray<{ flag: string; description: string }> = [
  { flag: '--allow-pipeline-writes', description: 'would permit the pipeline refresh to write the database. NOT implemented in this phase.' },
  { flag: '--allow-result-commit', description: 'would permit the results-settlement commit step to write the database. NOT implemented in this phase.' },
  { flag: '--run-once-readonly', description: 'would run the read-only steps once via the injected runner. NOT implemented in this phase.' },
  { flag: '--watch', description: 'would loop the read-only plan on an interval. NOT implemented in this phase.' },
  { flag: '--minutes-before', description: 'would override the T-minus capture target (default 5). NOT implemented in this phase.' },
  { flag: '--stop-after-race', description: 'would stop a watch loop after the given off time (HH:MM). NOT implemented in this phase.' },
];

/** Future-flag names recognised (and captured as inert) by the arg parser. */
const FUTURE_FLAG_NAMES = new Set(FUTURE_FLAGS.map((f) => f.flag));
/** Future flags that take a value argument (consumed so it is not misparsed). */
const FUTURE_FLAGS_WITH_VALUE = new Set(['--minutes-before', '--stop-after-race']);

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

/** Parsed (and validated) operate arguments. */
export interface OperateArgs {
  date?: string;
  course?: string;
  /** Always `'plan-only'` in this phase (nothing can switch it). */
  mode: 'plan-only';
  /** Future-mode flags the operator passed (kept only to warn they are inert). */
  requestedFutureFlags: string[];
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real, strictly-formatted YYYY-MM-DD calendar date. Pure. */
export function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Parses argv (already sliced past `node script`). Recognises `--date` and
 * `--course`, and captures the (inert) future flags so the plan can warn they
 * are not active. The mode is ALWAYS `'plan-only'` — nothing in argv can enable
 * execution in this phase. Validation errors are collected, not thrown. Pure.
 */
export function parseOperateArgs(argv: readonly string[]): OperateArgs {
  let date: string | undefined;
  let course: string | undefined;
  const requestedFutureFlags: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (v) date = v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v) course = v;
    } else if (FUTURE_FLAG_NAMES.has(a)) {
      requestedFutureFlags.push(a);
      // Consume (and ignore) a value for value-taking future flags so it is not
      // misread as another token. The value is intentionally discarded — inert.
      if (FUTURE_FLAGS_WITH_VALUE.has(a)) i++;
    }
    // Unknown flags are ignored; nothing can enable execution in this phase.
  }

  if (!date) {
    errors.push('Missing required --date YYYY-MM-DD.');
  } else if (!isValidIsoDate(date)) {
    errors.push(`Invalid --date "${date}" (expected a real YYYY-MM-DD calendar date).`);
  }

  return { date, course, mode: 'plan-only', requestedFutureFlags, errors };
}

/* -------------------------------------------------------------------------- */
/* Schedule arithmetic                                                        */
/* -------------------------------------------------------------------------- */

/** A stored race row (the CLI reads these SELECT-only and passes them in). */
export interface OperateRaceInput {
  id?: string | number | null;
  race_name?: string | null;
  off_time?: string | null;
  course?: string | null;
  status?: string | null;
}

/** The computed timing windows for one race (all HH:mm UTC, or null). */
export interface RaceOperateWindow {
  race_id: string | null;
  race_name: string | null;
  off_time: string | null;
  status: string | null;
  /** Off time (HH:mm UTC). */
  off_hhmm: string | null;
  /** T-15 general refresh window. */
  refresh_hhmm: string | null;
  /** T-7 suggested pipeline refresh. */
  pipeline_refresh_hhmm: string | null;
  /** T-5 pre-off capture window. */
  capture_hhmm: string | null;
  /** Off-time lock (no model re-run after this). */
  post_off_lock_hhmm: string | null;
  /** Result-check window (off + 30m). */
  result_check_hhmm: string | null;
}

/** Formats an ISO instant (+ optional minute offset) as HH:mm UTC, or null. Pure. */
export function hhmmUtc(iso: string | null | undefined, offsetMin = 0): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + offsetMin * 60000).toISOString().slice(11, 16);
}

/** Sort key for off_time: known instants ascending, unknowns last. Pure. */
function offTimeSortKey(offTime: string | null | undefined): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** Builds one race's schedule windows. Pure; missing off_time -> null windows. */
export function buildRaceOperateWindow(race: OperateRaceInput): RaceOperateWindow {
  const off = race.off_time ?? null;
  return {
    race_id: race.id != null && String(race.id).trim() !== '' ? String(race.id) : null,
    race_name: race.race_name && race.race_name.trim() !== '' ? race.race_name.trim() : null,
    off_time: off,
    status: race.status ?? null,
    off_hhmm: hhmmUtc(off, 0),
    refresh_hhmm: hhmmUtc(off, -REFRESH_OFFSET_MIN),
    pipeline_refresh_hhmm: hhmmUtc(off, -PIPELINE_REFRESH_OFFSET_MIN),
    capture_hhmm: hhmmUtc(off, -CAPTURE_OFFSET_MIN),
    post_off_lock_hhmm: hhmmUtc(off, 0),
    result_check_hhmm: hhmmUtc(off, RESULT_CHECK_OFFSET_MIN),
  };
}

/* -------------------------------------------------------------------------- */
/* Command plan                                                               */
/* -------------------------------------------------------------------------- */

/** A documented operator command (NEVER executed by this phase). */
export interface OperateCommand {
  label: string;
  command: string;
  /** True if running the command writes to the database. */
  writesDb: boolean;
  /** True if the command must not be run without explicit manual approval. */
  requiresApproval: boolean;
}

/** True for a command that is safe to auto-run (read-only, no approval). */
export function isAutoRunnable(command: OperateCommand): boolean {
  return !command.writesDb && !command.requiresApproval;
}

/** The full, deterministic controlled-operate plan. */
export interface OperatePlan {
  date: string;
  course: string | null;
  mode: 'plan-only';
  /** The current most-useful next action (reused from the dashboard logic). */
  nextAction: NextAction;
  races: RaceOperateWindow[];
  preflight: OperateCommand[];
  perRaceCommands: OperateCommand[];
  settlement: OperateCommand[];
  endOfDay: OperateCommand[];
  /** Reminder that pending (unresulted) races are left untouched. */
  pendingRacesNote: string;
  /** The read-only dashboard URL to view. */
  dashboardUrl: string;
  dashboardNote: string;
  /** Reminder that the status polling endpoint is read-only. */
  statusApiNote: string;
  postOffNote: string;
  safetyNotes: readonly string[];
  futureFlags: ReadonlyArray<{ flag: string; description: string }>;
  warnings: string[];
}

/** Canonical course slug (matches every report path builder in the project). */
function slugifyCourse(course?: string | null): string {
  return (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Builds the read-only dashboard URL `…/?date=<date>&course=<course>`. Pure. */
export function buildDashboardUrl(date: string, course?: string | null): string {
  const params = new URLSearchParams({ date });
  if (course && course.trim() !== '') params.set('course', course.trim());
  return `http://localhost:3000/?${params.toString()}`;
}

/** Inputs to {@link buildOperatePlan}. */
export interface OperatePlanInput {
  date: string;
  course?: string | null;
  races: readonly OperateRaceInput[];
  /** Current time (epoch ms) used only to derive the next action. */
  now: number;
  requestedFutureFlags?: readonly string[];
}

/**
 * Builds the deterministic controlled race-day operating plan: the current next
 * action, per-race schedule windows, preflight checks, the per-race operator
 * commands (pipeline refresh flagged manual-approval), the result-settlement
 * steps (dry-run first; the commit step flagged manual-approval), the end-of-day
 * reporting commands, the dashboard reminder, the documented (inactive) future
 * flags, and the safety notes. Pure; performs no I/O and runs nothing.
 */
export function buildOperatePlan(input: OperatePlanInput): OperatePlan {
  const { date, now } = input;
  const course = input.course && input.course.trim() !== '' ? input.course.trim() : null;
  const dayArgs = `--date ${date}${course ? ` --course ${course}` : ''}`;
  const exportArgs = `--from ${date} --to ${date}${course ? ` --course ${course}` : ''}`;
  const slug = slugifyCourse(course);
  const suffix = slug ? `-${slug}` : '';
  const trainingExportPath = `data/exports/training-data-${date}-to-${date}${suffix}.csv`;
  // The commit flag is appended as documented DATA only (never executed here).
  const commitFlag = `--${'commit'}`;

  const races = [...input.races]
    .sort((a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time))
    .map(buildRaceOperateWindow);

  const nextRaces: NextRaceLike[] = races.map((r) => ({
    off_time: r.off_time,
    status: r.status,
  }));
  const nextAction = deriveNextAction(nextRaces, now, { date, course });

  const preflight: OperateCommand[] = [
    { label: 'Verify environment variables are present (names only)', command: 'npm run check:env', writesDb: false, requiresApproval: false },
    { label: 'Verify database schema / connectivity (read-only probes)', command: 'npm run check:db', writesDb: false, requiresApproval: false },
  ];

  const perRaceCommands: OperateCommand[] = [
    {
      label: 'T-7 pipeline refresh — racecards + odds + model (WRITES DB — manual approval only)',
      command: `npm run pipeline:day -- ${dayArgs} ${commitFlag}`,
      writesDb: true,
      requiresApproval: true,
    },
    {
      label: `T-${DEFAULT_MINUTES_BEFORE} pre-off capture (read-only snapshot report)`,
      command: `npm run capture:t-minus -- ${dayArgs} --minutes-before ${DEFAULT_MINUTES_BEFORE}`,
      writesDb: false,
      requiresApproval: false,
    },
  ];

  const settlement: OperateCommand[] = [
    {
      label: 'Results automation — dry-run first (audits only; never settles)',
      command: `npm run results:auto -- ${dayArgs}`,
      writesDb: false,
      requiresApproval: false,
    },
    {
      label: 'Results automation — settle the audited settle-ready races (WRITES DB — future / explicit manual approval only)',
      command: `npm run results:auto -- ${dayArgs} ${commitFlag}`,
      writesDb: true,
      requiresApproval: true,
    },
  ];

  const endOfDay: OperateCommand[] = [
    { label: 'End-of-day report', command: `npm run report:day -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Training-data export (local CSV only)', command: `npm run export:training-data -- ${exportArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Tipster audit', command: `npm run tipsters:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Confidence audit', command: `npm run confidence:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'No-bet gate research audit', command: `npm run gates:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Place / each-way research audit', command: `npm run place:audit -- ${dayArgs} --places 4`, writesDb: false, requiresApproval: false },
    { label: 'Day lessons report', command: `npm run lessons:day -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    {
      label: `ML shadow evaluation (only if ${trainingExportPath} exists)`,
      command: `npm run ml:evaluate -- --input ${trainingExportPath}`,
      writesDb: false,
      requiresApproval: false,
    },
  ];

  const warnings: string[] = [];
  if (races.length === 0) warnings.push(NO_RACES_WARNING);
  const requested = input.requestedFutureFlags ?? [];
  if (requested.length > 0) {
    warnings.push(
      `Future flag(s) ${[...requested].sort().join(', ')} are not implemented in this phase; the plan remains plan-only.`,
    );
  }

  return {
    date,
    course,
    mode: 'plan-only',
    nextAction,
    races,
    preflight,
    perRaceCommands,
    settlement,
    endOfDay,
    pendingRacesNote:
      'Pending (unresulted) races are left untouched — results are only settled once officially available, and only via an explicitly approved manual step.',
    dashboardUrl: buildDashboardUrl(date, course),
    dashboardNote: 'View the read-only race-day dashboard (auto-refreshes; no commit or write controls).',
    statusApiNote:
      'The /api/race-day/status polling endpoint is read-only (GET only — no database writes, no commit, no betting).',
    postOffNote: POST_OFF_NO_RERUN_NOTE,
    safetyNotes: SAFETY_NOTES,
    futureFlags: FUTURE_FLAGS,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Runner seam (injected; future --run-once-readonly). Fake runner in tests.  */
/* -------------------------------------------------------------------------- */

export type OperateStepStatus = 'ok' | 'failed' | 'skipped';

/** The outcome of one (read-only) step as reported by an injected runner. */
export interface OperateStepResult {
  label: string;
  command: string;
  status: OperateStepStatus;
  note?: string;
}

/**
 * An injected command runner. In a future phase a real runner could execute a
 * read-only command; in tests it is always a FAKE that merely records the call.
 * It is never given an approval/write command (those are skipped before it).
 */
export type OperateRunner = (command: OperateCommand) => OperateStepResult;

/** The report from a (simulated) read-only run. */
export interface OperateRunReport {
  executed: OperateStepResult[];
  /** Commands withheld from the runner because they need manual approval. */
  skipped: OperateStepResult[];
}

/** All commands across the routinely-run sections, in plan order. Pure. */
export function collectPlanCommands(plan: OperatePlan): OperateCommand[] {
  return [...plan.preflight, ...plan.perRaceCommands, ...plan.settlement, ...plan.endOfDay];
}

/**
 * Simulates a READ-ONLY run by driving the injected runner over ONLY the
 * auto-runnable (read-only, no-approval) commands. Any command that writes the
 * database or requires approval (e.g. anything carrying the commit flag) is
 * NEVER passed to the runner — it is recorded as `skipped`. Pure with respect to
 * the runner (no I/O of its own). This is the seam a future `--run-once-readonly`
 * mode would use; nothing in this phase calls it outside tests.
 */
export function simulateReadOnlyRun(
  plan: OperatePlan,
  runner: OperateRunner,
): OperateRunReport {
  const executed: OperateStepResult[] = [];
  const skipped: OperateStepResult[] = [];

  for (const command of collectPlanCommands(plan)) {
    if (isAutoRunnable(command)) {
      executed.push(runner(command));
    } else {
      skipped.push({
        label: command.label,
        command: command.command,
        status: 'skipped',
        note: 'requires manual approval (writes DB) — never auto-executed',
      });
    }
  }

  return { executed, skipped };
}

/* -------------------------------------------------------------------------- */
/* Rendering (pure, deterministic)                                            */
/* -------------------------------------------------------------------------- */

function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? DASH : value;
}

function renderCommandLines(commands: readonly OperateCommand[]): string[] {
  return commands.map((c) => {
    const tag = c.requiresApproval
      ? ' **[MANUAL APPROVAL — WRITES DB]**'
      : c.writesDb
        ? ' **[writes DB]**'
        : '';
    return `- ${c.label}:${tag}\n  \`${c.command}\``;
  });
}

/**
 * Renders the deterministic controlled race-day operating plan as Markdown.
 * Pure: the same plan always yields the same string (no timestamps — the next
 * action is derived from the caller-supplied `now`). Missing values render as an
 * em dash. Times are UTC.
 */
export function renderOperatePlanMarkdown(plan: OperatePlan): string {
  const courseLabel = plan.course ?? `${DASH} (all courses on this date)`;
  const blocks: string[] = [];

  blocks.push('# Controlled race-day operating plan (decision-support only)');
  blocks.push(
    [
      `Date: ${plan.date}  ·  Course: ${courseLabel}`,
      'Mode: plan-only (nothing is executed; no database writes; no orders)',
      'All times UTC.',
    ].join('  \n'),
  );

  if (plan.warnings.length > 0) {
    blocks.push(['## Warnings', ...plan.warnings.map((w) => `- ${w}`)].join('\n'));
  }

  blocks.push(
    [
      '## Current next action',
      `- ${plan.nextAction.headline}`,
      `  ${plan.nextAction.detail}`,
      `  Suggested (read-only): ${plan.nextAction.suggestedCommand ? `\`${plan.nextAction.suggestedCommand}\`` : DASH}`,
    ].join('\n'),
  );

  blocks.push(['## 1. Preflight', ...renderCommandLines(plan.preflight)].join('\n'));

  const scheduleLines: string[] = [
    '## 2. Per-race schedule (UTC)',
    '',
    '| Race | Off | T-15 refresh | T-7 pipeline | T-5 capture | Off-lock | Result check |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  if (plan.races.length === 0) {
    scheduleLines.push(`| ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`);
  } else {
    for (const r of plan.races) {
      scheduleLines.push(
        `| ${orDash(r.race_name)} | ${orDash(r.off_hhmm)} | ${orDash(r.refresh_hhmm)} | ${orDash(r.pipeline_refresh_hhmm)} | ${orDash(r.capture_hhmm)} | ${orDash(r.post_off_lock_hhmm)} | ${orDash(r.result_check_hhmm)} |`,
      );
    }
  }
  scheduleLines.push('');
  scheduleLines.push(`- ${plan.postOffNote}`);
  blocks.push(scheduleLines.join('\n'));

  blocks.push(
    ['## 3. Per-race operator commands', ...renderCommandLines(plan.perRaceCommands)].join('\n'),
  );

  blocks.push(
    [
      '## 4. Result settlement',
      ...renderCommandLines(plan.settlement),
      `- ${plan.pendingRacesNote}`,
    ].join('\n'),
  );

  blocks.push(['## 5. End of day', ...renderCommandLines(plan.endOfDay)].join('\n'));

  blocks.push(
    ['## 6. Dashboard', `- ${plan.dashboardNote}`, `  ${plan.dashboardUrl}`, `- ${plan.statusApiNote}`].join('\n'),
  );

  blocks.push(
    [
      '## 7. Future flags (documented, NOT active in this phase)',
      ...plan.futureFlags.map((f) => `- \`${f.flag}\` — ${f.description}`),
    ].join('\n'),
  );

  blocks.push(['## 8. Safety', ...plan.safetyNotes.map((s) => `- ${s}`)].join('\n'));

  return blocks.join('\n\n') + '\n';
}
