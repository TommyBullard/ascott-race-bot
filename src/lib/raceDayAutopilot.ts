/**
 * Pure helpers for the one-command race-day AUTOPILOT MVP
 * (scripts/raceDayAutopilot.ts). Phase 8 of the autonomous race-day workflow.
 *
 * The autopilot PLANS (and, only with an explicit opt-in, runs) the existing
 * SAFE read-only / reporting commands for a date + course. It is strictly
 * DECISION-SUPPORT:
 *   - default is plan-only (prints a plan, runs nothing, writes nothing);
 *   - `--run-readonly` may execute ONLY the whitelisted read-only commands;
 *   - it NEVER places bets, NEVER passes `--commit`, NEVER writes the database,
 *     NEVER runs the model / pipeline / odds / racecards, and NEVER trains or
 *     activates any ML or GenAI feature.
 *
 * Everything here is pure and deterministic: argument parsing, the command plan,
 * the safety gate, the read-only run orchestration (over an INJECTED runner), and
 * the Markdown rendering. There is no database access, no network, no child
 * process spawning, and no environment reads in this module. Missing values
 * render as an em dash / "unknown"; nothing is fabricated.
 */

const DASH = '\u2014';

/** Default minutes-before for the T-minus capture target. */
export const DEFAULT_MINUTES_BEFORE = 5;

/** Upper bound for --minutes-before (24h) — guards against typos, not policy. */
export const MAX_MINUTES_BEFORE = 1440;

/** The autopilot operating modes. */
export type AutopilotMode = 'plan-only' | 'run-readonly';

/**
 * The whitelisted READ-ONLY / reporting commands the autopilot may run (in
 * `--run-readonly` mode), in execution order. Every entry is read-only and never
 * receives `--commit`. Nothing else is runnable.
 */
export const READONLY_COMMAND_IDS = [
  'results:auto',
  'snapshot:pre-off',
  'capture:t-minus',
  'report:day',
  'export:training-data',
  'tipsters:audit',
  'confidence:audit',
  'gates:audit',
] as const;

export type ReadonlyCommandId = (typeof READONLY_COMMAND_IDS)[number];

/** Commands the autopilot must NEVER run, with the reason, for the plan output. */
export const NEVER_RUN_COMMANDS: ReadonlyArray<{ command: string; reason: string }> = [
  { command: 'pipeline:day', reason: 'runs the model and writes model runs / recommendations to the database.' },
  { command: 'pipeline:watch', reason: 'long-running loop that repeatedly writes to the database.' },
  { command: 'model:day', reason: 'runs the model and writes recommendations to the database.' },
  { command: 'import:results --commit', reason: 'mutates result rows in the database.' },
  { command: 'any command containing --commit', reason: 'performs database writes.' },
  { command: 'any GenAI API call', reason: 'external API and not model-active in this app (shadow only).' },
  { command: 'any bet placement', reason: 'this tool never places bets.' },
];

/** Script ids that are explicitly forbidden from the runnable set (defence-in-depth). */
const FORBIDDEN_SCRIPT_IDS = new Set<string>(['pipeline:day', 'pipeline:watch', 'model:day', 'run:model']);

const READONLY_ID_SET = new Set<string>(READONLY_COMMAND_IDS);

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

/** The parsed (and validated) autopilot arguments. */
export interface AutopilotArgs {
  date?: string;
  course?: string;
  mode: AutopilotMode;
  minutesBefore: number;
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
 * Parses argv (already sliced past `node script`). Recognises `--date`,
 * `--course`, `--minutes-before`, and the `--run-readonly` flag; unknown flags
 * are ignored (and can never enable anything). Validation errors are collected
 * (invalid/missing date, invalid minutes-before) rather than thrown. Pure.
 */
export function parseAutopilotArgs(argv: readonly string[]): AutopilotArgs {
  let date: string | undefined;
  let course: string | undefined;
  let mode: AutopilotMode = 'plan-only';
  let minutesRaw: string | undefined;
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (v) date = v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v) course = v;
    } else if (a === '--minutes-before') {
      minutesRaw = (argv[++i] ?? '').trim();
    } else if (a === '--run-readonly') {
      mode = 'run-readonly';
    }
    // All other tokens are ignored: the autopilot never enables anything from
    // an unknown flag, and never accepts --commit.
  }

  if (!date) {
    errors.push('Missing required --date YYYY-MM-DD.');
  } else if (!isValidIsoDate(date)) {
    errors.push(`Invalid --date "${date}" (expected a real YYYY-MM-DD calendar date).`);
  }

  let minutesBefore = DEFAULT_MINUTES_BEFORE;
  if (minutesRaw !== undefined) {
    const n = Number(minutesRaw);
    if (minutesRaw === '' || !Number.isInteger(n) || n <= 0 || n > MAX_MINUTES_BEFORE) {
      errors.push(`Invalid --minutes-before "${minutesRaw}" (expected an integer 1..${MAX_MINUTES_BEFORE}).`);
    } else {
      minutesBefore = n;
    }
  }

  return { date, course, mode, minutesBefore, errors };
}

/* -------------------------------------------------------------------------- */
/* Command plan                                                               */
/* -------------------------------------------------------------------------- */

/** A single planned (read-only) command invocation. */
export interface PlannedCommand {
  id: ReadonlyCommandId;
  /** npm script name (identical to the id). */
  script: string;
  /** CLI args passed after `--` (never contains `--commit`). */
  args: string[];
  /** Always true here — the autopilot only plans read-only commands. */
  readonly: boolean;
  /** Optional operator note (e.g. results:auto dry-run caveat). */
  note?: string;
}

/** The full, deterministic race-day plan. */
export interface AutopilotPlan {
  date: string;
  course: string | null;
  mode: AutopilotMode;
  minutesBefore: number;
  commands: PlannedCommand[];
  neverRun: ReadonlyArray<{ command: string; reason: string }>;
  expectedReports: string[];
  manualResultsFallback: string;
}

/** Canonical course slug (matches every report path builder in the project). */
function slugifyCourse(course?: string | null): string {
  return (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Inputs to {@link buildAutopilotPlan} (a validated subset of the parsed args). */
export interface AutopilotPlanInput {
  date: string;
  course?: string | null;
  mode: AutopilotMode;
  minutesBefore: number;
}

/**
 * Builds the deterministic race-day plan: the whitelisted read-only commands (in
 * order), the never-run list, the expected report paths, and the manual results
 * fallback. Pure; performs no I/O. The expected report paths exactly match the
 * project's report-path builders (verified by tests).
 */
export function buildAutopilotPlan(input: AutopilotPlanInput): AutopilotPlan {
  const { date, mode, minutesBefore } = input;
  const course = input.course && input.course.trim() !== '' ? input.course.trim() : null;
  const slug = slugifyCourse(course);
  const suffix = slug ? `-${slug}` : '';
  const courseArgs = course ? ['--course', course] : [];

  const commands: PlannedCommand[] = [
    {
      id: 'results:auto',
      script: 'results:auto',
      args: ['--date', date, ...courseArgs],
      readonly: true,
      note: 'Dry-run / fallback only — never settles results or writes to the database.',
    },
    { id: 'snapshot:pre-off', script: 'snapshot:pre-off', args: ['--date', date, ...courseArgs], readonly: true },
    {
      id: 'capture:t-minus',
      script: 'capture:t-minus',
      args: ['--date', date, ...courseArgs, '--minutes-before', String(minutesBefore)],
      readonly: true,
    },
    { id: 'report:day', script: 'report:day', args: ['--date', date, ...courseArgs], readonly: true },
    {
      id: 'export:training-data',
      script: 'export:training-data',
      args: ['--from', date, '--to', date, ...courseArgs],
      readonly: true,
      note: 'Writes a local CSV only (data/exports/…); no database access.',
    },
    { id: 'tipsters:audit', script: 'tipsters:audit', args: ['--date', date, ...courseArgs], readonly: true },
    { id: 'confidence:audit', script: 'confidence:audit', args: ['--date', date, ...courseArgs], readonly: true },
    { id: 'gates:audit', script: 'gates:audit', args: ['--date', date, ...courseArgs], readonly: true },
  ];

  const expectedReports = [
    `reports/pre-off-snapshot-${date}${suffix}.md`,
    `reports/t-minus-${minutesBefore}-capture-${date}${suffix}.md`,
    `reports/day-report-${date}${suffix}.md`,
    `reports/tipster-audit-${date}${suffix}.md`,
    `reports/confidence-audit-${date}${suffix}.md`,
    `reports/no-bet-gate-audit-${date}${suffix}.md`,
  ];

  const manualResultsFallback = `npm run import:results -- --file data/results-${date}${suffix}.csv`;

  return {
    date,
    course,
    mode,
    minutesBefore,
    commands,
    neverRun: NEVER_RUN_COMMANDS,
    expectedReports,
    manualResultsFallback,
  };
}

/* -------------------------------------------------------------------------- */
/* Safety gate + read-only run orchestration                                  */
/* -------------------------------------------------------------------------- */

/** Renders a command as a copy-pasteable `npm run …` invocation. Pure. */
export function formatCommandInvocation(command: PlannedCommand): string {
  return command.args.length > 0
    ? `npm run ${command.script} -- ${command.args.join(' ')}`
    : `npm run ${command.script}`;
}

/**
 * Safety gate: throws unless the command is a whitelisted read-only command with
 * NO `--commit` and a non-forbidden script. Called before every execution so a
 * forbidden or mutating command can never be spawned. Pure.
 */
export function assertReadonlyCommand(command: PlannedCommand): void {
  if (!READONLY_ID_SET.has(command.id)) {
    throw new Error(`Refusing to run non-whitelisted command: "${command.id}".`);
  }
  if (FORBIDDEN_SCRIPT_IDS.has(command.script)) {
    throw new Error(`Refusing to run a forbidden (DB-writing) command: "${command.script}".`);
  }
  if (command.args.some((a) => a.trim().toLowerCase() === '--commit')) {
    throw new Error(`Refusing to run a command containing --commit: "${command.id}".`);
  }
}

/** Builds the spawn args for `npm run <script> -- <args>`. Pure. */
export function buildSpawnArgs(command: PlannedCommand): string[] {
  return ['run', command.script, '--', ...command.args];
}

/** The result of running one read-only command. */
export interface CommandResult {
  id: string;
  ok: boolean;
  exitCode: number | null;
}

/** An injected runner that actually executes a command (real or fake). */
export type CommandRunner = (command: PlannedCommand) => CommandResult;

/** The outcome of running the whole read-only plan. */
export interface RunReadonlyOutcome {
  results: CommandResult[];
  ok: boolean;
  /** The id of the command that failed and stopped the run, else null. */
  stoppedAt: string | null;
}

/**
 * Runs the whitelisted read-only commands in order via the INJECTED runner,
 * stopping at the first failure. Each command passes through
 * {@link assertReadonlyCommand} before execution. Pure orchestration: this
 * function never spawns anything itself — the runner does (the CLI provides a
 * child-process runner; tests provide a fake). Deterministic given the runner.
 */
export function runReadonlyPlan(plan: AutopilotPlan, run: CommandRunner): RunReadonlyOutcome {
  const results: CommandResult[] = [];
  let stoppedAt: string | null = null;
  for (const command of plan.commands) {
    assertReadonlyCommand(command);
    const result = run(command);
    results.push(result);
    if (!result.ok) {
      stoppedAt = command.id;
      break;
    }
  }
  return { results, ok: stoppedAt === null, stoppedAt };
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Renders the deterministic race-day autopilot plan as Markdown. Pure: the same
 * plan always yields the same string (no timestamps). Covers date/course, mode,
 * the safe checklist, the commands it would run, the commands it will never run,
 * the T-minus target, results-automation status, the manual fallback, the
 * expected report outputs, and the safety disclaimer. Missing course -> em dash.
 */
export function renderAutopilotPlanMarkdown(plan: AutopilotPlan): string {
  const courseLabel = plan.course ?? `${DASH} (all courses on this date)`;
  const blocks: string[] = [];

  blocks.push('# Race-day autopilot plan (decision-support only)');
  blocks.push(
    [
      `Date: ${plan.date}  ·  Course: ${courseLabel}`,
      `Mode: ${plan.mode}`,
      `T-minus capture target: ${plan.minutesBefore} minute(s) before off`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> Decision-support only. No auto-betting, no model changes, and no database',
      '> writes in plan-only / read-only audit mode. The autopilot plans (and, only',
      '> with --run-readonly, runs) existing READ-ONLY commands; it never places a',
      '> bet, never passes --commit, and never runs the model / pipeline / odds.',
    ].join('\n'),
  );

  // 1. Date and course.
  blocks.push(['## 1. Date and course', '', `- Date: ${plan.date}`, `- Course: ${courseLabel}`].join('\n'));

  // 2. Mode.
  blocks.push(
    [
      '## 2. Mode',
      '',
      `- **${plan.mode}**`,
      plan.mode === 'plan-only'
        ? '- Plan-only: prints this plan and runs nothing (no commands, no writes).'
        : '- Run-readonly: executes ONLY the whitelisted read-only commands below (no --commit, no DB writes), stopping at the first failure.',
    ].join('\n'),
  );

  // 3. Safe command checklist.
  const checklist = ['## 3. Safe command checklist', ''];
  for (const command of plan.commands) {
    checklist.push(`- [ ] ${command.id}${command.note ? ` — ${command.note}` : ''}`);
  }
  blocks.push(checklist.join('\n'));

  // 4. Commands it would run.
  const would = ['## 4. Commands it would run', ''];
  plan.commands.forEach((command, idx) => {
    would.push(`${idx + 1}. \`${formatCommandInvocation(command)}\``);
  });
  blocks.push(would.join('\n'));

  // 5. Commands it will never run.
  const never = ['## 5. Commands it will never run', ''];
  for (const entry of plan.neverRun) {
    never.push(`- \`${entry.command}\` — ${entry.reason}`);
  }
  blocks.push(never.join('\n'));

  // 6. T-minus capture target.
  const tMinusCommand = plan.commands.find((c) => c.id === 'capture:t-minus');
  blocks.push(
    [
      '## 6. T-minus capture target',
      '',
      `- minutes-before = ${plan.minutesBefore} (default ${DEFAULT_MINUTES_BEFORE})`,
      tMinusCommand ? `- Command: \`${formatCommandInvocation(tMinusCommand)}\`` : `- Command: ${DASH}`,
    ].join('\n'),
  );

  // 7. Results automation status.
  blocks.push(
    [
      '## 7. Results automation status',
      '',
      '- `results:auto` runs in **dry-run / fallback only** mode: it never settles results and never writes to the database.',
      '- The Racing API results endpoint requires the Standard Plan (plan_blocked), so automated settlement is unavailable; use the manual results fallback below.',
    ].join('\n'),
  );

  // 8. Manual results fallback.
  blocks.push(
    [
      '## 8. Manual results fallback',
      '',
      `- \`${plan.manualResultsFallback}\``,
      '- Place the results CSV at that path, then run the importer manually. Without `--commit` it is a dry-run; the autopilot never runs it for you.',
    ].join('\n'),
  );

  // 9. Expected report outputs.
  const reports = ['## 9. Expected report outputs', ''];
  for (const path of plan.expectedReports) {
    reports.push(`- ${path}`);
  }
  blocks.push(reports.join('\n'));

  // 10. Safety disclaimer.
  blocks.push(
    [
      '## 10. Safety disclaimer',
      '',
      '- Decision-support only; not betting advice and no edge is claimed.',
      '- No auto-betting and no bet placement.',
      '- No changes to model probability, staking, ranking, or tipster weighting.',
      '- No database writes in plan-only or read-only audit mode (read-only commands only).',
      '- No ML training/persistence; no GenAI feature is model-active; no no-bet gates are activated.',
    ].join('\n'),
  );

  return blocks.join('\n\n') + '\n';
}
