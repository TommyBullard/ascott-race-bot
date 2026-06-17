/**
 * Pure helpers for the LIVE race-day operating-plan MVP
 * (scripts/raceDayLivePlan.ts). Phase 10 of the autonomous race-day workflow.
 *
 * This produces a SAFE, deterministic operating SCHEDULE + operator command plan
 * for a race day. It is strictly DECISION-SUPPORT and PLAN-ONLY:
 *   - it executes NOTHING and writes NO database;
 *   - it prints the per-race timing windows (T-10 refresh, T-5 capture, off,
 *     post-off lock, result check), the preflight checks, the manual/operator
 *     commands, the end-of-day reporting commands, and the safety notes;
 *   - the only DB-writing command it documents (`pipeline:day … --commit`) is
 *     flagged as MANUAL-APPROVAL and is never run by this phase;
 *   - the future modes (--operate / --allow-writes / --auto-results) are
 *     DOCUMENTED but NOT implemented here.
 *
 * Everything in this module is pure and deterministic: argument parsing, the
 * schedule arithmetic, the command plan, and the Markdown rendering. There is no
 * database access, no network, no child-process spawning, and no environment
 * read here (the CLI does the optional SELECT-only race lookup and passes the
 * rows in). Missing values render as an em dash / "unknown"; nothing is
 * fabricated. All times are rendered in UTC (the off_time storage convention).
 */

const DASH = '\u2014';

/** Schedule offsets (minutes) relative to each race's off time. */
export const REFRESH_OFFSET_MIN = 10;
export const CAPTURE_OFFSET_MIN = 5;
export const RESULT_CHECK_OFFSET_MIN = 30;

/** Default T-minus capture target (minutes before off). */
export const DEFAULT_MINUTES_BEFORE = 5;

/** The exact warning shown when no stored races are found for the date/course. */
export const NO_RACES_WARNING =
  'No stored races found; run racecards ingest manually when appropriate.';

/** Future operating modes — DOCUMENTED here but NOT implemented in this phase. */
export const FUTURE_MODES: ReadonlyArray<{ flag: string; description: string }> = [
  { flag: '--operate', description: 'would execute the scheduled operations automatically. NOT implemented in this phase.' },
  { flag: '--allow-writes', description: 'would permit DB-writing commands (e.g. pipeline:day --commit). NOT implemented in this phase.' },
  { flag: '--auto-results', description: 'would auto-run results:auto / import on a schedule. NOT implemented in this phase.' },
];

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

/** Parsed (and validated) live-plan arguments. */
export interface LivePlanArgs {
  date?: string;
  course?: string;
  output?: string;
  /** Future-mode flags the operator passed (kept only to warn they are inert). */
  requestedFutureModes: string[];
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FUTURE_MODE_FLAGS = new Set(['--operate', '--allow-writes', '--auto-results']);

/** True only for a real, strictly-formatted YYYY-MM-DD calendar date. Pure. */
export function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Parses argv (already sliced past `node script`). Recognises `--date`,
 * `--course`, `--output`, and the (inert) future-mode flags. Validation errors
 * (missing/invalid date) are collected, not thrown. Pure.
 */
export function parseLivePlanArgs(argv: readonly string[]): LivePlanArgs {
  let date: string | undefined;
  let course: string | undefined;
  let output: string | undefined;
  const requestedFutureModes: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (v) date = v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v) course = v;
    } else if (a === '--output') {
      const v = (argv[++i] ?? '').trim();
      if (v) output = v;
    } else if (FUTURE_MODE_FLAGS.has(a)) {
      requestedFutureModes.push(a);
    }
    // Unknown flags are ignored; nothing can enable execution in this phase.
  }

  if (!date) {
    errors.push('Missing required --date YYYY-MM-DD.');
  } else if (!isValidIsoDate(date)) {
    errors.push(`Invalid --date "${date}" (expected a real YYYY-MM-DD calendar date).`);
  }

  return { date, course, output, requestedFutureModes, errors };
}

/* -------------------------------------------------------------------------- */
/* Schedule arithmetic                                                        */
/* -------------------------------------------------------------------------- */

/** A stored race row (the CLI reads these SELECT-only and passes them in). */
export interface LivePlanRaceInput {
  id?: string | number | null;
  race_name?: string | null;
  off_time?: string | null;
  course?: string | null;
}

/** The computed timing windows for one race (all HH:mm UTC, or null). */
export interface RaceScheduleWindow {
  race_id: string | null;
  race_name: string | null;
  off_time: string | null;
  off_hhmm: string | null;
  refresh_hhmm: string | null;
  capture_hhmm: string | null;
  post_off_lock_hhmm: string | null;
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
export function buildRaceSchedule(race: LivePlanRaceInput): RaceScheduleWindow {
  const off = race.off_time ?? null;
  return {
    race_id: race.id != null && String(race.id).trim() !== '' ? String(race.id) : null,
    race_name: race.race_name && race.race_name.trim() !== '' ? race.race_name.trim() : null,
    off_time: off,
    off_hhmm: hhmmUtc(off, 0),
    refresh_hhmm: hhmmUtc(off, -REFRESH_OFFSET_MIN),
    capture_hhmm: hhmmUtc(off, -CAPTURE_OFFSET_MIN),
    post_off_lock_hhmm: hhmmUtc(off, 0),
    result_check_hhmm: hhmmUtc(off, RESULT_CHECK_OFFSET_MIN),
  };
}

/* -------------------------------------------------------------------------- */
/* Command plan                                                               */
/* -------------------------------------------------------------------------- */

/** A documented operator command (NEVER executed by this phase). */
export interface LivePlanCommand {
  label: string;
  command: string;
  /** True if running the command writes to the database. */
  writesDb: boolean;
  /** True if the command must not be run without explicit manual approval. */
  requiresApproval: boolean;
}

/** The full, deterministic live race-day plan. */
export interface LivePlan {
  date: string;
  course: string | null;
  races: RaceScheduleWindow[];
  preflight: LivePlanCommand[];
  perRaceCommands: LivePlanCommand[];
  endOfDay: LivePlanCommand[];
  dangerousNotes: string[];
  futureModes: ReadonlyArray<{ flag: string; description: string }>;
  manualResultsFallback: string;
  trainingExportPath: string;
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

/** Inputs to {@link buildLivePlan}. */
export interface LivePlanInput {
  date: string;
  course?: string | null;
  races: readonly LivePlanRaceInput[];
  requestedFutureModes?: readonly string[];
}

/**
 * Builds the deterministic live race-day operating plan: per-race schedule
 * windows, preflight checks, the operator command plan (with the single
 * DB-writing command flagged manual-approval), the end-of-day reporting
 * commands, the documented future modes, and warnings. Pure; performs no I/O and
 * runs nothing. Never fabricates: an empty race list yields the no-races warning.
 */
export function buildLivePlan(input: LivePlanInput): LivePlan {
  const { date } = input;
  const course = input.course && input.course.trim() !== '' ? input.course.trim() : null;
  const slug = slugifyCourse(course);
  const suffix = slug ? `-${slug}` : '';
  const dayArgs = `--date ${date}${course ? ` --course ${course}` : ''}`;
  const exportArgs = `--from ${date} --to ${date}${course ? ` --course ${course}` : ''}`;

  const races = [...input.races]
    .sort((a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time))
    .map(buildRaceSchedule);

  const preflight: LivePlanCommand[] = [
    { label: 'Verify environment variables are present (names only)', command: 'npm run check:env', writesDb: false, requiresApproval: false },
    { label: 'Verify database schema / connectivity (read-only probes)', command: 'npm run check:db', writesDb: false, requiresApproval: false },
    { label: 'Results automation dry-run / fallback check', command: `npm run results:auto -- ${dayArgs}`, writesDb: false, requiresApproval: false },
  ];

  const perRaceCommands: LivePlanCommand[] = [
    {
      label: 'Run the model + persist recommendations (WRITES DB — manual approval only)',
      command: `npm run pipeline:day -- ${dayArgs} --commit`,
      writesDb: true,
      requiresApproval: true,
    },
    {
      label: `T-${DEFAULT_MINUTES_BEFORE} pre-off capture (read-only report)`,
      command: `npm run capture:t-minus -- ${dayArgs} --minutes-before ${DEFAULT_MINUTES_BEFORE}`,
      writesDb: false,
      requiresApproval: false,
    },
    {
      label: 'Results automation (dry-run / fallback; never settles)',
      command: `npm run results:auto -- ${dayArgs}`,
      writesDb: false,
      requiresApproval: false,
    },
  ];

  const trainingExportPath = `data/exports/training-data-${date}-to-${date}${suffix}.csv`;
  const endOfDay: LivePlanCommand[] = [
    { label: 'End-of-day report', command: `npm run report:day -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Training-data export (local CSV only)', command: `npm run export:training-data -- ${exportArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Tipster audit', command: `npm run tipsters:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Confidence audit', command: `npm run confidence:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'No-bet gate research audit', command: `npm run gates:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    {
      label: `ML shadow evaluation (only if ${trainingExportPath} exists)`,
      command: `npm run ml:evaluate -- --input ${trainingExportPath}`,
      writesDb: false,
      requiresApproval: false,
    },
  ];

  const manualResultsFallback = `npm run import:results -- --file data/results-${date}${suffix}.csv`;

  const dangerousNotes = [
    'This phase NEVER runs pipeline / model / odds / racecards / write commands. It only prints this plan.',
    '`pipeline:day … --commit` writes model runs and recommendations to the database — run it manually only after review.',
    '`import:results --commit` mutates result rows — requires manual approval; without `--commit` the importer is a dry-run.',
    'No auto-betting and no bet placement under any flag in this phase.',
  ];

  const warnings: string[] = [];
  if (races.length === 0) {
    warnings.push(NO_RACES_WARNING);
  }
  const requested = input.requestedFutureModes ?? [];
  if (requested.length > 0) {
    warnings.push(
      `Future-mode flag(s) ${[...requested].sort().join(', ')} are not implemented in this phase; the plan remains plan-only.`,
    );
  }

  return {
    date,
    course,
    races,
    preflight,
    perRaceCommands,
    endOfDay,
    dangerousNotes,
    futureModes: FUTURE_MODES,
    manualResultsFallback,
    trainingExportPath,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Output path                                                                */
/* -------------------------------------------------------------------------- */

/** Builds `reports/live-plan-<date>[-<course-slug>].md`. Pure. */
export function buildLivePlanPath(date: string, course?: string | null): string {
  const slug = slugifyCourse(course);
  return slug ? `reports/live-plan-${date}-${slug}.md` : `reports/live-plan-${date}.md`;
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? DASH : value;
}

function renderCommandList(commands: readonly LivePlanCommand[]): string[] {
  return commands.map((c) => {
    const tag = c.requiresApproval ? ' **[MANUAL APPROVAL — WRITES DB]**' : c.writesDb ? ' **[writes DB]**' : '';
    return `- ${c.label}:${tag}\n  \`${c.command}\``;
  });
}

/**
 * Renders the deterministic live race-day plan as Markdown. Pure: the same plan
 * always yields the same string (no timestamps). Covers preflight, race
 * discovery, the per-race schedule, the operator command plan, the dangerous-
 * commands notes, end-of-day reporting, the documented (inactive) future modes,
 * and the safety disclaimer. Missing values render as an em dash. Times are UTC.
 */
export function renderLivePlanMarkdown(plan: LivePlan): string {
  const courseLabel = plan.course ?? `${DASH} (all courses on this date)`;
  const blocks: string[] = [];

  blocks.push('# Live race-day operating plan (decision-support only)');
  blocks.push([`Date: ${plan.date}  ·  Course: ${courseLabel}`, 'Mode: plan-only (nothing is executed; no database writes)', 'All times UTC.'].join('  \n'));
  blocks.push(
    [
      '> Decision-support only. This phase PLANS a race day; it executes nothing,',
      '> writes no database, places no bets, and runs no pipeline / model / odds /',
      '> racecards command. The one DB-writing command below (pipeline:day --commit)',
      '> is documented for MANUAL approval only and is never run here.',
    ].join('\n'),
  );

  if (plan.warnings.length > 0) {
    blocks.push(['## Warnings', '', ...plan.warnings.map((w) => `- ⚠️ ${w}`)].join('\n'));
  }

  // 1. Preflight.
  blocks.push(['## 1. Preflight', '', ...renderCommandList(plan.preflight)].join('\n'));

  // 2. Race discovery.
  const discovery = ['## 2. Race discovery', '', `- Races found for ${plan.date} / ${courseLabel}: ${plan.races.length}`];
  if (plan.races.length === 0) {
    discovery.push(`- ⚠️ ${NO_RACES_WARNING}`);
  } else {
    for (const r of plan.races) {
      discovery.push(`- ${orDash(r.off_hhmm)} UTC — ${orDash(r.race_name)}`);
    }
  }
  blocks.push(discovery.join('\n'));

  // 3. Per-race schedule.
  const schedule = ['## 3. Per-race schedule (UTC)', ''];
  if (plan.races.length === 0) {
    schedule.push(`_${DASH} (no stored races; see the warning above)_`);
  } else {
    schedule.push('| Race | T-10 refresh | T-5 capture | Off | Post-off lock | Result check |');
    schedule.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of plan.races) {
      schedule.push(
        `| ${orDash(r.race_name)} | ${orDash(r.refresh_hhmm)} | ${orDash(r.capture_hhmm)} | ${orDash(r.off_hhmm)} | ` +
          `${orDash(r.post_off_lock_hhmm)}+ | ${orDash(r.result_check_hhmm)} |`,
      );
    }
    schedule.push('');
    schedule.push(
      `_T-10 refresh = off ${DASH} ${REFRESH_OFFSET_MIN}m; T-5 capture = off ${DASH} ${CAPTURE_OFFSET_MIN}m; ` +
        `post-off lock from the off time onward (no further pre-off actions); result check ~${RESULT_CHECK_OFFSET_MIN}m after off (official only)._`,
    );
  }
  blocks.push(schedule.join('\n'));

  // 4. Commands to run manually / via future controlled automation.
  blocks.push(
    [
      '## 4. Commands to run manually / via future controlled automation',
      '',
      ...renderCommandList(plan.perRaceCommands),
      `- Manual results fallback (dry-run without \`--commit\`):\n  \`${plan.manualResultsFallback}\``,
      '- After racing: see §6 (end-of-day report / export / audits).',
    ].join('\n'),
  );

  // 5. Dangerous commands.
  blocks.push(['## 5. Dangerous commands (NOT run by this phase)', '', ...plan.dangerousNotes.map((n) => `- ${n}`)].join('\n'));

  // 6. End of day.
  blocks.push(['## 6. End of day', '', ...renderCommandList(plan.endOfDay)].join('\n'));

  // 7. Future modes (documented, not active).
  blocks.push(
    [
      '## 7. Future modes (documented, NOT active in this phase)',
      '',
      ...plan.futureModes.map((m) => `- \`${m.flag}\` — ${m.description}`),
    ].join('\n'),
  );

  // 8. Safety disclaimer.
  blocks.push(
    [
      '## 8. Safety disclaimer',
      '',
      '- Decision-support only; not betting advice and no guarantees.',
      '- No auto-betting and no bet placement.',
      '- Official, weighed-in results only — never settle on provisional data.',
      '- No changes to model probability, staking, ranking, or tipster weighting.',
      '- Plan-only: no database writes and no commands are executed by this phase.',
    ].join('\n'),
  );

  return blocks.join('\n\n') + '\n';
}
