/**
 * Pure planning + one-shot orchestration for Railway race-day automation.
 *
 * Railway cron jobs run a single command and exit — so this module is the
 * decision-support, NEVER-betting core that:
 *
 *   1. resolves "today" as a UTC race-day meeting date (deterministic given
 *      `now`, so it is unit-testable and needs no daily edits on Railway);
 *   2. builds the recommended Railway cron plan (the three one-shot jobs:
 *      pipeline refresh, T-minus capture, results auto-check) with their exact
 *      commands + the every-5-minutes schedule (see RACE_DAY_CRON_SCHEDULE);
 *   3. provides the testable orchestration seam (`runRefreshOnce`) used by the
 *      `race-day:refresh-today` helper, which spawns the EXISTING `pipeline:day`
 *      command exactly once and returns — it never loops.
 *
 * HARD INVARIANTS (also enforced by railwayCronPlan.test.ts):
 *   - No bets are ever placed and no auto-betting is ever enabled. The only
 *     occurrences of "bet" here are NEGATED safety disclaimers.
 *   - It changes no model, staking, or recommendation logic — it only schedules
 *     and orchestrates the already-tested pipeline.
 *   - It introduces no public UI write control. Writes happen only in the
 *     backend cron jobs, authenticated by CRON_SECRET; the public UI stays
 *     read-only.
 *   - One-shot only: no `while`, no `setInterval`, no recursion. Railway does
 *     the scheduling; each run does its work once and exits.
 *
 * No I/O lives here (no DB, no network, no child process, no env). The CLIs
 * inject the real spawn; this module stays pure and deterministic.
 */

import { resolveCronMeetingDate } from './cronDate';
import { dashboardUrl } from './raceDayPipeline';

/** Every race-day cron job runs on the same 5-minute cadence. */
export const RACE_DAY_CRON_SCHEDULE = '*/5 * * * *';
/** Default course when none is supplied. */
export const DEFAULT_RACE_DAY_COURSE = 'Ascot';
/** Default base URL for the dashboard link + pipeline cron calls. */
export const DEFAULT_BASE_URL = 'http://localhost:3000';
/** Default T-minus capture window (minutes before off time). */
export const DEFAULT_MINUTES_BEFORE = 5;

/**
 * Resolves today's race-day meeting date as `YYYY-MM-DD` (UTC). UK racing runs
 * ~13:00–18:00 local, which is the same calendar day in UTC, so a UTC date is
 * correct during racing hours and matches how racecards are stored. Deterministic
 * given `now` (delegates to the shared cron date resolver). Pure.
 */
export function resolveRaceDayToday(now: Date = new Date()): string {
  return resolveCronMeetingDate({}, now).meetingDate;
}

/** Fixed, always-shown safety disclaimers (decision-support only). */
export const RACE_DAY_SAFETY_WARNINGS: readonly string[] = [
  'Decision-support only — this automation never places bets and never enables auto-betting.',
  'The public UI stays read-only — no public user can trigger a database write.',
  'Database writes happen ONLY inside the backend cron jobs, authenticated by CRON_SECRET.',
  'These cron jobs are one-shot commands: each runs once and exits — never an infinite loop.',
  'Model, staking, and recommendation logic are unchanged — this only refreshes stored data.',
  'results:auto is dry-run by default; switching it to --commit is a deliberate, documented step.',
] as const;

/* -------------------------------------------------------------------------- */
/* Cron plan                                                                  */
/* -------------------------------------------------------------------------- */

export type CronJobId = 'pipeline-refresh' | 't-minus-capture' | 'results-auto-check';

/** One Railway cron job: a one-shot command + its schedule + safety metadata. */
export interface CronJobSpec {
  id: CronJobId;
  name: string;
  schedule: string;
  /** Recommended date-safe command (resolves "today"; no daily edits). */
  command: string;
  /** Explicit date-pinned form (must be updated each race day). */
  datePinnedCommand: string;
  /** True only when running this job as shown writes to the database. */
  writesDb: boolean;
  note: string;
}

export interface RailwayCronPlanInput {
  /** Target meeting date (YYYY-MM-DD). Defaults to today (UTC). */
  date?: string;
  /** Course filter. Defaults to Ascot. */
  course?: string;
  /** Base URL for the dashboard link. Defaults to http://localhost:3000. */
  baseUrl?: string;
  /** T-minus capture window. Defaults to 5. */
  minutesBefore?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface RailwayCronPlan {
  date: string;
  course: string;
  schedule: string;
  minutesBefore: number;
  jobs: CronJobSpec[];
  dashboardUrl: string;
  safetyWarnings: readonly string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Quotes a course for a shell command only when it contains whitespace. */
function formatCourseArg(course: string): string {
  return /\s/.test(course) ? `"${course}"` : course;
}

/**
 * Builds the recommended Railway cron plan: three one-shot jobs on the
 * every-5-minutes cadence (RACE_DAY_CRON_SCHEDULE), each with a date-safe
 * command (preferred) and the explicit date-pinned form. Pure; `now` is injectable.
 */
export function buildRailwayCronPlan(input: RailwayCronPlanInput = {}): RailwayCronPlan {
  const now = input.now ?? new Date();
  const course =
    (input.course ?? '').trim() !== '' ? (input.course as string).trim() : DEFAULT_RACE_DAY_COURSE;
  const rawDate = (input.date ?? '').trim();
  const date = DATE_RE.test(rawDate) ? rawDate : resolveRaceDayToday(now);
  const baseUrl = ((input.baseUrl ?? '').trim() !== '' ? (input.baseUrl as string) : DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const minutesBefore =
    Number.isInteger(input.minutesBefore) && (input.minutesBefore as number) > 0
      ? (input.minutesBefore as number)
      : DEFAULT_MINUTES_BEFORE;

  const c = formatCourseArg(course);
  // On Railway (Linux cron shell) $(date -u +%F) resolves today's UTC date, so
  // the date-safe forms never need a daily edit.
  const todaySub = '"$(date -u +%F)"';

  const jobs: CronJobSpec[] = [
    {
      id: 'pipeline-refresh',
      name: 'Pipeline refresh (racecards + odds + model + recommendations)',
      schedule: RACE_DAY_CRON_SCHEDULE,
      command: `npm run race-day:refresh-today -- --course ${c}`,
      datePinnedCommand: `npm run pipeline:day -- --date ${date} --course ${c} --commit`,
      writesDb: true,
      note:
        'Refreshes today\u2019s card via the CRON_SECRET-authenticated cron endpoints. ' +
        'Set PIPELINE_BASE_URL to the deployed web service URL. Never places bets.',
    },
    {
      id: 't-minus-capture',
      name: 'T-minus capture (pre-off snapshot for audit)',
      schedule: RACE_DAY_CRON_SCHEDULE,
      command: `npm run capture:t-minus -- --date ${todaySub} --course ${c} --minutes-before ${minutesBefore}`,
      datePinnedCommand: `npm run capture:t-minus -- --date ${date} --course ${c} --minutes-before ${minutesBefore}`,
      writesDb: false,
      note: 'Read-only snapshot; writes a local capture report file only, never the database.',
    },
    {
      id: 'results-auto-check',
      name: 'Results auto-check (settlement audit, dry-run)',
      schedule: RACE_DAY_CRON_SCHEDULE,
      command: `npm run results:auto -- --date ${todaySub} --course ${c}`,
      datePinnedCommand: `npm run results:auto -- --date ${date} --course ${c}`,
      writesDb: false,
      note:
        'Dry-run audit only. results:auto never writes (its --commit path is gated); the real ' +
        'settlement write path is the manual CSV importer (import:results --commit).',
    },
  ];

  return {
    date,
    course,
    schedule: RACE_DAY_CRON_SCHEDULE,
    minutesBefore,
    jobs,
    dashboardUrl: dashboardUrl(baseUrl, date, course),
    safetyWarnings: RACE_DAY_SAFETY_WARNINGS,
  };
}

/** Renders the cron plan as deterministic text (no timestamps). Pure. */
export function renderRailwayCronPlanText(plan: RailwayCronPlan): string {
  const lines: string[] = [];
  lines.push('Railway race-day automation \u2014 cron plan (read-only; nothing was run or written)');
  lines.push('='.repeat(80));
  lines.push(`Race day : ${plan.date} (UTC)`);
  lines.push(`Course   : ${plan.course}`);
  lines.push(
    `Schedule : ${plan.schedule}  (every 5 minutes \u2014 covers T-15 / T-10 / T-5 before every race)`,
  );
  lines.push('');

  let n = 0;
  for (const job of plan.jobs) {
    n += 1;
    const tag = job.writesDb ? '[WRITES DB]' : '[read-only]';
    lines.push(`Job ${n} \u2014 ${job.name}  ${tag}`);
    lines.push(`  schedule                : ${job.schedule}`);
    lines.push(`  recommended (date-safe) : ${job.command}`);
    lines.push(`  explicit (date-pinned)  : ${job.datePinnedCommand}`);
    lines.push(`  note                    : ${job.note}`);
    lines.push('');
  }

  lines.push(`Public dashboard: ${plan.dashboardUrl}`);
  lines.push('');
  lines.push('Safety:');
  for (const w of plan.safetyWarnings) lines.push(`  - ${w}`);
  lines.push('');
  lines.push('(This planner only prints text. It performs no database writes and places no bets.)');
  return lines.join('\n');
}

/** Parsed args for the read-only `railway:cron-plan` CLI. */
export interface CronPlanArgs {
  date?: string;
  course?: string;
  baseUrl?: string;
  minutesBefore?: number;
}

/** Parses argv for `railway:cron-plan` (all optional). Pure. */
export function parseCronPlanArgs(argv: readonly string[]): CronPlanArgs {
  const args: CronPlanArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (DATE_RE.test(v)) args.date = v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.course = v;
    } else if (a === '--base-url') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.baseUrl = v.replace(/\/+$/, '');
    } else if (a === '--minutes-before') {
      const v = Number.parseInt((argv[++i] ?? '').trim(), 10);
      if (Number.isInteger(v) && v > 0) args.minutesBefore = v;
    }
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* race-day:refresh-today — one-shot pipeline orchestration                    */
/* -------------------------------------------------------------------------- */

/** Parsed args for the `race-day:refresh-today` helper. */
export interface RefreshTodayArgs {
  course: string;
  baseUrl: string;
  /** When true, the helper runs pipeline:day with --commit (its default). */
  commit: boolean;
  /** When true, the helper prints the plan and spawns nothing. */
  dryRun: boolean;
}

/**
 * Parses argv for `race-day:refresh-today`. Commit is the default (this is a
 * backend refresh job); `--dry-run` forces a no-spawn preview. Pure.
 */
export function parseRefreshTodayArgs(argv: readonly string[]): RefreshTodayArgs {
  let course = DEFAULT_RACE_DAY_COURSE;
  let baseUrl = DEFAULT_BASE_URL;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--commit') {
      // Accepted for symmetry; commit is already the default.
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') course = v;
    } else if (a === '--base-url') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') baseUrl = v.replace(/\/+$/, '');
    }
  }
  return { course, baseUrl, commit: !dryRun, dryRun };
}

/**
 * Builds the argument list passed to `pipeline:day` (after the `--`). Adds
 * `--commit` only when committing. Pure.
 */
export function buildRefreshTodayCommandArgs(opts: {
  date: string;
  course: string;
  baseUrl: string;
  commit: boolean;
}): string[] {
  const args = ['--date', opts.date, '--course', opts.course, '--base-url', opts.baseUrl];
  if (opts.commit) args.push('--commit');
  return args;
}

/** A spawn function injected by the CLI (real) or a test (fake). */
export type RefreshSpawn = (
  script: string,
  npmArgs: readonly string[],
) => { status: number | null; error?: unknown };

export interface RefreshRunResult {
  /** The resolved meeting date the refresh ran for. */
  date: string;
  course: string;
  /** Human-readable command that was run. */
  command: string;
  /** Always 1 — this helper runs exactly one command then returns (one-shot). */
  ranCount: number;
  exitCode: number | null;
  ok: boolean;
}

/**
 * Runs the today-refresh EXACTLY ONCE: resolves today's date, then invokes the
 * injected spawn for `pipeline:day` a single time and returns. There is no loop,
 * no timer, and no recursion — Railway schedules the repeats. Deterministic
 * given `now` + the injected spawn (so a test can prove a single invocation).
 */
export function runRefreshOnce(deps: {
  now: Date;
  course: string;
  baseUrl: string;
  commit: boolean;
  spawn: RefreshSpawn;
}): RefreshRunResult {
  const date = resolveRaceDayToday(deps.now);
  const args = buildRefreshTodayCommandArgs({
    date,
    course: deps.course,
    baseUrl: deps.baseUrl,
    commit: deps.commit,
  });
  const command = `npm run pipeline:day -- ${args.join(' ')}`;
  const result = deps.spawn('pipeline:day', args);
  const exitCode = typeof result.status === 'number' ? result.status : null;
  return {
    date,
    course: deps.course,
    command,
    ranCount: 1,
    exitCode,
    ok: !result.error && exitCode === 0,
  };
}
