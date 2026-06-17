/**
 * Pure helpers for the READ-ONLY "tomorrow race-day preflight pack"
 * (scripts/dayPreflightPack.ts).
 *
 * Given only a date + course it produces a deterministic pre-race-day
 * CHECKLIST / report: the environment checks, the dashboard URL, the required
 * operating commands (the DB-writing ones flagged manual/backend-only), the
 * end-of-day reporting commands, a safety checklist, a data-freshness checklist,
 * the known result-data caveats, and the operator reminders.
 *
 * Everything here is pure and deterministic: argument parsing, the report path,
 * the command strings, and the Markdown rendering. There is NO database access,
 * NO network, NO child-process spawning, NO environment read and NO file I/O
 * (the CLI writes the file). It runs nothing — the documented `pipeline:day` and
 * `results:auto` commit commands are DATA only, flagged manual/backend approval,
 * and are never executed. Given the same inputs it always renders the same
 * string. Decision-support only: no auto-betting, no bet placement, no orders.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* -------------------------------------------------------------------------- */
/* Checklists / caveats (exported so tests can assert them verbatim)          */
/* -------------------------------------------------------------------------- */

/** Section 5 — the fixed safety checklist. */
export const SAFETY_CHECKLIST: readonly string[] = [
  'No auto-betting is enabled (there is none) — decision-support only.',
  'No bet placement and no orders of any kind.',
  'No model probability / staking / ranking / tipster-weighting math changes during the race day.',
  'No code changes inside the final 10 minutes before any off.',
  'Always run results:auto as a dry-run BEFORE any approved backend result commit.',
];

/** Section 6 — the data-freshness checklist. */
export const FRESHNESS_CHECKLIST: readonly string[] = [
  'Odds updated — the dashboard "odds updated X ago" indicator is fresh.',
  'Model updated — the dashboard "model updated X ago" indicator is fresh.',
  'T-minus capture available — a capture:t-minus snapshot has been taken pre-off.',
  'Result status — each race shows its settlement status once officially resulted.',
];

/** Section 7 — the known result-data caveats. */
export const KNOWN_CAVEATS: readonly string[] = [
  'The free Racing API result endpoint can lag — official finishing positions may appear later than the off time.',
  'The free endpoint provides finishing positions but NOT SP/BSP.',
  'Manual SP/BSP enrichment is optional (import a BSP CSV later if needed); prices are never fabricated.',
];

/** Section 8 — the operator reminders. */
export const OPERATOR_REMINDERS: readonly string[] = [
  'Use the per-day performance block as the source of truth for settled count, winners/losers, P/L and ROI.',
  'The top-level legacy accuracy figure may differ (it is a lifetime/global scope) — prefer the scoped performance block.',
];

/** The read-only status-endpoint reminder. */
export const STATUS_API_NOTE =
  'The /api/race-day/status polling endpoint is read-only (GET only — no database writes, no commit, no betting).';

/* -------------------------------------------------------------------------- */
/* Argument parsing + output path                                             */
/* -------------------------------------------------------------------------- */

/** Parsed (and validated) preflight arguments. */
export interface PreflightArgs {
  date?: string;
  course?: string;
  errors: string[];
}

/** True only for a real, strictly-formatted YYYY-MM-DD calendar date. Pure. */
export function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Parses argv (already sliced past `node script`). Recognises `--date` and
 * `--course`. Validation errors (missing/invalid date) are collected, not
 * thrown. Pure; read-only.
 */
export function parsePreflightArgs(argv: readonly string[]): PreflightArgs {
  let date: string | undefined;
  let course: string | undefined;
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (v) date = v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v) course = v;
    }
  }

  if (!date) {
    errors.push('Missing required --date YYYY-MM-DD.');
  } else if (!isValidIsoDate(date)) {
    errors.push(`Invalid --date "${date}" (expected a real YYYY-MM-DD calendar date).`);
  }

  return { date, course, errors };
}

/** Canonical course slug (matches every report path builder in the project). */
function slugifyCourse(course?: string | null): string {
  return (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Builds `reports/preflight-<date>[-<course-slug>].md`. Pure. */
export function buildPreflightPath(date: string, course?: string | null): string {
  const slug = slugifyCourse(course);
  return slug ? `reports/preflight-${date}-${slug}.md` : `reports/preflight-${date}.md`;
}

/** Builds the read-only dashboard URL `…/?date=<date>&course=<course>`. Pure. */
export function buildDashboardUrl(date: string, course?: string | null): string {
  const params = new URLSearchParams({ date });
  if (course && course.trim() !== '') params.set('course', course.trim());
  return `http://localhost:3000/?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* Pack assembly                                                              */
/* -------------------------------------------------------------------------- */

/** A documented operator command (NEVER executed by this generator). */
export interface PreflightCommand {
  label: string;
  command: string;
  /** True if running the command writes to the database. */
  writesDb: boolean;
  /** True if the command must not be run without explicit manual approval. */
  requiresApproval: boolean;
}

/** The fully-derived preflight pack passed to {@link renderPreflightMarkdown}. */
export interface PreflightPack {
  date: string;
  course: string | null;
  checks: PreflightCommand[];
  dashboardUrl: string;
  statusApiNote: string;
  operatingCommands: PreflightCommand[];
  endOfDayCommands: PreflightCommand[];
  safetyChecklist: readonly string[];
  freshnessChecklist: readonly string[];
  caveats: readonly string[];
  operatorReminders: readonly string[];
}

/** Inputs to {@link buildPreflightPack}. */
export interface PreflightPackInput {
  date: string;
  course?: string | null;
}

/**
 * Builds the deterministic preflight pack for one race day. Pure; performs no
 * I/O and runs nothing. The DB-writing commands (`pipeline:day` and the
 * `results:auto` commit step) are documented DATA flagged manual/backend
 * approval — never executed.
 */
export function buildPreflightPack(input: PreflightPackInput): PreflightPack {
  const { date } = input;
  const course = input.course && input.course.trim() !== '' ? input.course.trim() : null;
  const dayArgs = `--date ${date}${course ? ` --course ${course}` : ''}`;
  const exportArgs = `--from ${date} --to ${date}${course ? ` --course ${course}` : ''}`;
  const slug = slugifyCourse(course);
  const suffix = slug ? `-${slug}` : '';
  const trainingExportPath = `data/exports/training-data-${date}-to-${date}${suffix}.csv`;
  // The commit flag is appended as documented DATA only (never executed here).
  const commitFlag = `--${'commit'}`;

  const checks: PreflightCommand[] = [
    { label: 'Verify environment variables are present (names only)', command: 'npm run check:env', writesDb: false, requiresApproval: false },
    { label: 'Verify database schema / connectivity (read-only probes)', command: 'npm run check:db', writesDb: false, requiresApproval: false },
  ];

  const operatingCommands: PreflightCommand[] = [
    {
      label: 'Pipeline refresh — racecards + odds + model (WRITES DB — backend / manual approval only)',
      command: `npm run pipeline:day -- ${dayArgs} ${commitFlag}`,
      writesDb: true,
      requiresApproval: true,
    },
    {
      label: 'T-5 pre-off capture (read-only snapshot report)',
      command: `npm run capture:t-minus -- ${dayArgs} --minutes-before 5`,
      writesDb: false,
      requiresApproval: false,
    },
    {
      label: 'Results automation — dry-run first (audits only; never settles)',
      command: `npm run results:auto -- ${dayArgs}`,
      writesDb: false,
      requiresApproval: false,
    },
    {
      label: 'Results automation — settle audited settle-ready races (BACKEND / MANUAL ONLY — never from the UI)',
      command: `npm run results:auto -- ${dayArgs} ${commitFlag}`,
      writesDb: true,
      requiresApproval: true,
    },
  ];

  const endOfDayCommands: PreflightCommand[] = [
    { label: 'End-of-day report', command: `npm run report:day -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Training-data export (local CSV only)', command: `npm run export:training-data -- ${exportArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Tipster audit', command: `npm run tipsters:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Confidence audit', command: `npm run confidence:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'No-bet gate research audit', command: `npm run gates:audit -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    { label: 'Place / each-way research audit', command: `npm run place:audit -- ${dayArgs} --places 4`, writesDb: false, requiresApproval: false },
    { label: 'Day lessons report', command: `npm run lessons:day -- ${dayArgs}`, writesDb: false, requiresApproval: false },
    {
      label: `ML shadow evaluation (run AFTER the training-data export; only if ${trainingExportPath} exists)`,
      command: `npm run ml:evaluate -- --input ${trainingExportPath}`,
      writesDb: false,
      requiresApproval: false,
    },
  ];

  return {
    date,
    course,
    checks,
    dashboardUrl: buildDashboardUrl(date, course),
    statusApiNote: STATUS_API_NOTE,
    operatingCommands,
    endOfDayCommands,
    safetyChecklist: SAFETY_CHECKLIST,
    freshnessChecklist: FRESHNESS_CHECKLIST,
    caveats: KNOWN_CAVEATS,
    operatorReminders: OPERATOR_REMINDERS,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function renderCommandLines(commands: readonly PreflightCommand[]): string[] {
  return commands.map((c) => {
    const tag = c.requiresApproval
      ? ' **[MANUAL / BACKEND APPROVAL — WRITES DB]**'
      : c.writesDb
        ? ' **[writes DB]**'
        : '';
    return `- ${c.label}:${tag}\n  \`${c.command}\``;
  });
}

function renderChecklist(items: readonly string[]): string[] {
  return items.map((item) => `- [ ] ${item}`);
}

/**
 * Renders the deterministic preflight pack as Markdown. Pure: the same pack
 * always yields the same string (no timestamps). Covers all eight sections.
 */
export function renderPreflightMarkdown(pack: PreflightPack): string {
  const courseLabel = pack.course ?? '\u2014 (all courses on this date)';
  const blocks: string[] = [];

  blocks.push('# Race-day preflight pack (decision-support only)');
  blocks.push(
    [
      `Date: ${pack.date}  ·  Course: ${courseLabel}`,
      'Read-only checklist — nothing here is executed; the DB-writing commands are backend / manual-approval only.',
    ].join('  \n'),
  );

  blocks.push(['## 1. Environment / check commands', ...renderCommandLines(pack.checks)].join('\n'));

  blocks.push(
    ['## 2. Dashboard', '- View the read-only race-day dashboard:', `  ${pack.dashboardUrl}`, `- ${pack.statusApiNote}`].join('\n'),
  );

  blocks.push(
    ['## 3. Required operating commands', ...renderCommandLines(pack.operatingCommands)].join('\n'),
  );

  blocks.push(['## 4. End-of-day commands', ...renderCommandLines(pack.endOfDayCommands)].join('\n'));

  blocks.push(['## 5. Safety checklist', ...renderChecklist(pack.safetyChecklist)].join('\n'));

  blocks.push(['## 6. Data freshness checklist', ...renderChecklist(pack.freshnessChecklist)].join('\n'));

  blocks.push(['## 7. Known caveats', ...pack.caveats.map((c) => `- ${c}`)].join('\n'));

  blocks.push(['## 8. Operator reminders', ...pack.operatorReminders.map((r) => `- ${r}`)].join('\n'));

  return blocks.join('\n\n') + '\n';
}
