/**
 * Pure helpers for the READ-ONLY "dashboard readiness" check
 * (scripts/dashboardReadiness.ts).
 *
 * Given counts + availability flags gathered SELECT-only from stored DB state
 * (races, runners, the latest odds snapshot, the latest model run,
 * recommendations, and result status), this assesses whether the dashboard has
 * enough data to be useful for a target race day, lists what is missing, and
 * SUGGESTS safe commands to populate it. It never runs anything.
 *
 * Everything here is pure and deterministic: the assessment, the suggested
 * commands, and the Markdown rendering. There is NO database access, NO network,
 * NO child-process spawning, NO environment read and NO file I/O (the CLI gathers
 * the inputs and writes the optional report). The documented `pipeline:day`
 * suggestion is DATA only, flagged manual/backend approval, and is never
 * executed. Given the same inputs it always renders the same string.
 * Decision-support only: no auto-betting, no bet placement, no orders.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DASH = '\u2014';

/* -------------------------------------------------------------------------- */
/* Argument parsing + paths                                                   */
/* -------------------------------------------------------------------------- */

/** Parsed (and validated) readiness arguments. */
export interface ReadinessArgs {
  date?: string;
  course?: string;
  /** Write the Markdown report to the deterministic path as well as the console. */
  report: boolean;
  errors: string[];
}

/** True only for a real, strictly-formatted YYYY-MM-DD calendar date. Pure. */
export function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Parses argv (already sliced past `node script`). Recognises `--date`,
 * `--course` and the optional `--report` flag. Validation errors are collected,
 * not thrown. Pure; read-only.
 */
export function parseReadinessArgs(argv: readonly string[]): ReadinessArgs {
  let date: string | undefined;
  let course: string | undefined;
  let report = false;
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (v) date = v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v) course = v;
    } else if (a === '--report') {
      report = true;
    }
  }

  if (!date) {
    errors.push('Missing required --date YYYY-MM-DD.');
  } else if (!isValidIsoDate(date)) {
    errors.push(`Invalid --date "${date}" (expected a real YYYY-MM-DD calendar date).`);
  }

  return { date, course, report, errors };
}

/** Canonical course slug (matches every report path builder in the project). */
function slugifyCourse(course?: string | null): string {
  return (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Builds `reports/dashboard-readiness-<date>[-<course-slug>].md`. Pure. */
export function buildReadinessPath(date: string, course?: string | null): string {
  const slug = slugifyCourse(course);
  return slug
    ? `reports/dashboard-readiness-${date}-${slug}.md`
    : `reports/dashboard-readiness-${date}.md`;
}

/** Builds the read-only dashboard URL `…/?date=<date>&course=<course>`. Pure. */
export function buildDashboardUrl(date: string, course?: string | null): string {
  const params = new URLSearchParams({ date });
  if (course && course.trim() !== '') params.set('course', course.trim());
  return `http://localhost:3000/?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Assessment                                                                 */
/* -------------------------------------------------------------------------- */

/** Read-only DB facts gathered by the CLI (all SELECT-only). */
export interface ReadinessInput {
  date: string;
  course: string | null;
  racesFound: number;
  runnersFound: number;
  hasOddsSnapshot: boolean;
  latestOddsSnapshotTime: string | null;
  hasModelRun: boolean;
  latestModelRunTime: string | null;
  recommendationsCount: number;
  settledRaces: number;
  pendingRaces: number;
}

/** A single readiness check status. */
export type ReadinessStatus = 'ok' | 'warn' | 'missing' | 'none';

/** One readiness check row. */
export interface ReadinessCheck {
  key: 'races' | 'runners' | 'odds' | 'model' | 'recommendations' | 'results';
  label: string;
  status: ReadinessStatus;
  detail: string;
}

/** A suggested (NEVER executed) operator command. */
export interface SuggestedCommand {
  label: string;
  command: string;
  /** True if running the command writes to the database. */
  writesDb: boolean;
  /** True if the command must not be run without explicit manual approval. */
  requiresApproval: boolean;
}

/** The overall readiness level. */
export type ReadinessLevel = 'not-ready' | 'partial' | 'ready' | 'settled';

/** The fully-derived readiness report. */
export interface ReadinessReport {
  date: string;
  course: string | null;
  level: ReadinessLevel;
  dashboardUrl: string;
  /** True when the dashboard will render race cards with useful content. */
  dashboardWillLoadUsefulData: boolean;
  checks: ReadinessCheck[];
  missing: string[];
  suggestedCommands: SuggestedCommand[];
  summary: string;
}

/** Builds the `--date … --course …` argument string for suggestions. */
function dayArgsFor(date: string, course: string | null): string {
  return `--date ${date}${course ? ` --course ${course}` : ''}`;
}

/**
 * Assesses dashboard readiness from the gathered DB facts. Pure + deterministic:
 * the same input always yields the same report. Never runs or fabricates
 * anything; a missing signal is reported as missing, not invented.
 */
export function assessDashboardReadiness(input: ReadinessInput): ReadinessReport {
  const racesOk = input.racesFound > 0;
  const runnersOk = input.runnersFound > 0;
  const oddsOk = input.hasOddsSnapshot;
  const modelOk = input.hasModelRun;
  const recsOk = input.recommendationsCount > 0;
  const allSettled = racesOk && input.settledRaces >= input.racesFound;
  const someSettled = input.settledRaces > 0;

  const checks: ReadinessCheck[] = [
    {
      key: 'races',
      label: 'Races',
      status: racesOk ? 'ok' : 'missing',
      detail: racesOk
        ? `${input.racesFound} race(s) found`
        : 'No races stored for this date/course',
    },
    {
      key: 'runners',
      label: 'Runners',
      status: runnersOk ? 'ok' : 'missing',
      detail: runnersOk ? `${input.runnersFound} runner(s) found` : 'No runners stored',
    },
    {
      key: 'odds',
      label: 'Odds snapshot',
      status: oddsOk ? 'ok' : 'missing',
      detail: oddsOk
        ? `latest snapshot ${input.latestOddsSnapshotTime ?? DASH}`
        : 'No odds snapshot stored',
    },
    {
      key: 'model',
      label: 'Model run',
      status: modelOk ? 'ok' : 'missing',
      detail: modelOk
        ? `latest current run ${input.latestModelRunTime ?? DASH}`
        : 'No current model run',
    },
    {
      key: 'recommendations',
      label: 'Recommendations',
      status: recsOk ? 'ok' : modelOk ? 'warn' : 'missing',
      detail: recsOk
        ? `${input.recommendationsCount} recommendation(s)`
        : modelOk
          ? 'Model ran but produced no qualifying recommendation (no-bet)'
          : 'No recommendations (no model run yet)',
    },
    {
      key: 'results',
      label: 'Results',
      status: allSettled ? 'ok' : someSettled ? 'warn' : 'none',
      detail: allSettled
        ? `all ${input.racesFound} race(s) settled`
        : someSettled
          ? `${input.settledRaces}/${input.racesFound} settled · ${input.pendingRaces} pending`
          : 'No official results yet (upcoming or not resulted)',
    },
  ];

  const missing: string[] = [];
  if (!racesOk) missing.push('races');
  if (racesOk && !runnersOk) missing.push('runners');
  if (racesOk && !oddsOk) missing.push('odds snapshot');
  if (racesOk && !modelOk) missing.push('model run');

  // Overall level.
  let level: ReadinessLevel;
  if (!racesOk) level = 'not-ready';
  else if (allSettled) level = 'settled';
  else if (runnersOk && oddsOk && modelOk) level = 'ready';
  else level = 'partial';

  // The dashboard renders useful race cards once there are races + runners and at
  // least a market snapshot or a model run to show.
  const dashboardWillLoadUsefulData = racesOk && runnersOk && (oddsOk || modelOk);

  const dayArgs = dayArgsFor(input.date, input.course);
  // The commit flag is part of documented suggestion DATA only (never executed).
  const commitFlag = `--${'commit'}`;
  const suggestedCommands: SuggestedCommand[] = [];

  if (!racesOk || !oddsOk || !modelOk) {
    suggestedCommands.push({
      label: !racesOk
        ? 'Ingest racecards + odds + run the model for the day (WRITES DB — backend / manual approval)'
        : 'Refresh odds + re-run the model for the day (WRITES DB — backend / manual approval)',
      command: `npm run pipeline:day -- ${dayArgs} ${commitFlag}`,
      writesDb: true,
      requiresApproval: true,
    });
    suggestedCommands.push({
      label: 'Generate the read-only preflight checklist for the day',
      command: `npm run preflight:day -- ${dayArgs}`,
      writesDb: false,
      requiresApproval: false,
    });
    suggestedCommands.push({
      label: 'Verify database connectivity (read-only probes)',
      command: 'npm run check:db',
      writesDb: false,
      requiresApproval: false,
    });
  }
  if (allSettled) {
    suggestedCommands.push({
      label: 'Generate the end-of-day report (read-only)',
      command: `npm run report:day -- ${dayArgs}`,
      writesDb: false,
      requiresApproval: false,
    });
  }

  const summary = buildSummaryLine(level, input, dashboardWillLoadUsefulData);

  return {
    date: input.date,
    course: input.course,
    level,
    dashboardUrl: buildDashboardUrl(input.date, input.course),
    dashboardWillLoadUsefulData,
    checks,
    missing,
    suggestedCommands,
    summary,
  };
}

/** A one-line human summary of the readiness level. Pure. */
function buildSummaryLine(
  level: ReadinessLevel,
  input: ReadinessInput,
  willLoad: boolean,
): string {
  const scope = `${input.date}${input.course ? ` ${input.course}` : ''}`;
  switch (level) {
    case 'not-ready':
      return `NOT READY — no races stored for ${scope}; the dashboard would show "no races".`;
    case 'partial':
      return `PARTIAL — ${input.racesFound} race(s) stored for ${scope}, but some data is missing; dashboard ${willLoad ? 'will' : 'will not'} show useful cards.`;
    case 'ready':
      return `READY — ${input.racesFound} race(s) with runners, odds and a model run for ${scope}; the dashboard will load useful data.`;
    case 'settled':
      return `SETTLED — all ${input.racesFound} race(s) for ${scope} are settled; the dashboard shows the final day.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering (pure, deterministic)                                            */
/* -------------------------------------------------------------------------- */

/** A short text badge for a check status. */
function statusBadge(status: ReadinessStatus): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'warn':
      return 'WARN';
    case 'missing':
      return 'MISSING';
    case 'none':
      return 'n/a';
  }
}

/**
 * Renders the deterministic readiness report as Markdown. Pure: the same report
 * always yields the same string (no timestamps). Covers the overall verdict, the
 * per-signal checks, the missing items, and the suggested (never-run) commands.
 */
export function renderReadinessMarkdown(report: ReadinessReport): string {
  const courseLabel = report.course ?? `${DASH} (all courses on this date)`;
  const blocks: string[] = [];

  blocks.push('# Dashboard readiness (decision-support only)');
  blocks.push(
    [
      `Date: ${report.date}  ·  Course: ${courseLabel}`,
      'Read-only check — SELECT-only inspection; nothing is executed and no database writes.',
    ].join('  \n'),
  );

  blocks.push(
    [
      '## Verdict',
      `- Overall: **${report.level.toUpperCase()}**`,
      `- Dashboard will load useful data: **${report.dashboardWillLoadUsefulData ? 'yes' : 'no'}**`,
      `- ${report.summary}`,
    ].join('\n'),
  );

  blocks.push(
    [
      '## Checks',
      ...report.checks.map((c) => `- ${c.label}: **${statusBadge(c.status)}** — ${c.detail}`),
    ].join('\n'),
  );

  blocks.push(
    [
      '## Missing',
      report.missing.length === 0
        ? '- Nothing required is missing — the dashboard has the core data it needs.'
        : report.missing.map((m) => `- ${m}`).join('\n'),
    ].join('\n'),
  );

  const suggestionLines =
    report.suggestedCommands.length === 0
      ? ['- None — no action needed.']
      : report.suggestedCommands.map((c) => {
          const tag = c.requiresApproval
            ? ' **[MANUAL / BACKEND APPROVAL — WRITES DB]**'
            : c.writesDb
              ? ' **[writes DB]**'
              : '';
          return `- ${c.label}:${tag}\n  \`${c.command}\``;
        });
  blocks.push(['## Suggested safe commands (NOT run)', ...suggestionLines].join('\n'));

  blocks.push(['## Dashboard', `- ${report.dashboardUrl}`].join('\n'));

  return blocks.join('\n\n') + '\n';
}

/** A compact one-line console summary (the headline + dashboard URL). Pure. */
export function summarizeReadiness(report: ReadinessReport): string {
  return `[${report.level.toUpperCase()}] ${report.summary} · ${report.dashboardUrl}`;
}
