/**
 * Pure helpers for the READ-ONLY race-day "proof of update" report
 * (scripts/proofDay.ts).
 *
 * Given read-only signals gathered SELECT-only from stored DB state (races,
 * runners, the latest odds snapshot, model runs, recommendations, result status)
 * plus best-effort reads of the audit tables (`cron_runs`, `ml_training_examples`,
 * `genai_commentary`) and a filesystem check for a generated commentary file,
 * this assembles a durable, timestamped proof of WHEN the app last refreshed each
 * stage, and renders it as deterministic Markdown.
 *
 * Everything here is pure and deterministic given its inputs (the CLI gathers the
 * data and writes the file; `now` is passed in, never read from the clock here).
 * There is NO database access, NO network, NO child process, NO environment read,
 * and NO file I/O in this module. When an audit table is missing the report
 * degrades gracefully and names the migration needed.
 *
 * Decision-support / audit only: it changes no model, recommendation, or staking
 * logic, places no bets, and proves WHEN data refreshed — never that any
 * selection will win.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DASH = '\u2014';

/**
 * Odds are flagged stale beyond this age. Mirrors the model's 10-minute
 * STALE_ODDS threshold (2× the 5-minute odds cadence); kept local so this audit
 * module stays import-free and standalone. Informational only.
 */
export const PROOF_STALE_ODDS_MS = 600_000;

/** Migration files for the audit tables this report reads (graceful when absent). */
export const AUDIT_MIGRATIONS: Readonly<Record<string, string>> = {
  cron_runs: '20260618030000_cron_runs.sql',
  ml_training_examples: '20260618040000_ml_training_examples.sql',
  genai_commentary: '20260618020000_genai_commentary.sql',
};

/* -------------------------------------------------------------------------- */
/* Arguments + paths                                                          */
/* -------------------------------------------------------------------------- */

export interface ProofArgs {
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

/** Parses `--date` (required) and `--course`. Collects errors; never throws. */
export function parseProofArgs(argv: readonly string[]): ProofArgs {
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
  if (!date) errors.push('Missing required --date YYYY-MM-DD.');
  else if (!isValidIsoDate(date)) errors.push(`Invalid --date "${date}" (expected a real YYYY-MM-DD date).`);
  return { date, course, errors };
}

/** Canonical course slug (matches every report-path builder in the project). */
function slugifyCourse(course?: string | null): string {
  return (course ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Builds `reports/proof-day-<date>[-<course-slug>].md`. Pure. */
export function buildProofPath(date: string, course?: string | null): string {
  const slug = slugifyCourse(course);
  return slug ? `reports/proof-day-${date}-${slug}.md` : `reports/proof-day-${date}.md`;
}

/** Builds the conventional commentary file path for the GenAI proof. Pure. */
export function buildCommentaryPath(date: string, course?: string | null): string {
  const slug = slugifyCourse(course);
  return slug ? `reports/genai-commentary-${date}-${slug}.md` : `reports/genai-commentary-${date}.md`;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** Per-race read-only proof signals (mapped from a RaceCard + model_runs read). */
export interface ProofRaceInput {
  raceId: string;
  offTime: string | null;
  raceName: string | null;
  /** Scored field size (runners on the card); 0 when no model run. */
  fieldSize: number;
  latestOddsSnapshotTime: string | null;
  /** The pre-off model run selected for display, or null. */
  latestModelRunTime: string | null;
  hasModelRun: boolean;
  /** Total model_runs rows for this race (audit), or null when not queried. */
  modelRunsCount: number | null;
  /** Count of model runs after off-time (ignored for display), or null. */
  postOffRunsIgnored: number | null;
  /** 1 when the race has a current recommendation (model pick), else 0. */
  recommendationCount: number;
  status: string | null;
  settled: boolean;
  finishPosAvailable: boolean;
  winnerName: string | null;
}

/** One row read from `cron_runs` (job, finish time, ok, numeric counts). */
export interface ProofCronRow {
  job: string;
  finished_at: string | null;
  ok: boolean | null;
  counts: Record<string, number> | null;
}

/** Per-job reduction of recent cron_runs rows (newest wins). */
export interface ProofCronJob {
  job: string;
  lastRun: string | null;
  lastStatus: 'ok' | 'failed' | null;
  lastOk: string | null;
  counts: Record<string, number> | null;
}

/** Availability + payload for an audit table that may not be migrated yet. */
export interface AuditTableState<T> {
  available: boolean;
  value: T;
}

/** Everything the proof needs (gathered read-only by the CLI). */
export interface DayProofInput {
  date: string;
  course: string | null;
  /** Reference time for stale/fresh + pending checks (passed in; deterministic). */
  now: number;
  races: ProofRaceInput[];
  /** Total stored runners across the meeting's races (SELECT count). */
  runnersFound: number;
  /** cron_runs heartbeat (available=false when the table is missing). */
  cron: AuditTableState<ProofCronJob[]>;
  /** ml_training_examples count (available=false when the table is missing). */
  mlTraining: AuditTableState<number | null>;
  /** GenAI commentary proof. */
  genai: {
    commentaryFilePath: string;
    commentaryFileExists: boolean;
    /** genai_commentary row count (available=false when the table is missing). */
    table: AuditTableState<number | null>;
  };
}

/* -------------------------------------------------------------------------- */
/* Pure derivations                                                           */
/* -------------------------------------------------------------------------- */

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reduces recent cron_runs rows into per-job newest-run + newest-OK + the latest
 * OK run's counts. Deterministic; ignores rows without a usable timestamp; jobs
 * are returned sorted by name. Pure.
 */
export function summarizeProofCron(rows: readonly ProofCronRow[]): ProofCronJob[] {
  const byJob = new Map<string, ProofCronJob>();
  for (const row of rows) {
    const ms = toMs(row.finished_at);
    if (ms === null) continue;
    const cur =
      byJob.get(row.job) ?? { job: row.job, lastRun: null, lastStatus: null, lastOk: null, counts: null };
    const curRunMs = toMs(cur.lastRun);
    if (curRunMs === null || ms > curRunMs) {
      cur.lastRun = row.finished_at;
      cur.lastStatus = row.ok === true ? 'ok' : 'failed';
    }
    if (row.ok === true) {
      const curOkMs = toMs(cur.lastOk);
      if (curOkMs === null || ms > curOkMs) {
        cur.lastOk = row.finished_at;
        cur.counts = row.counts ?? null;
      }
    }
    byJob.set(row.job, cur);
  }
  return [...byJob.values()].sort((a, b) => a.job.localeCompare(b.job));
}

/** Finds a cron job's reduced row by name. Pure. */
export function findCronJob(jobs: readonly ProofCronJob[], job: string): ProofCronJob | null {
  return jobs.find((j) => j.job === job) ?? null;
}

export type OddsFreshness = 'fresh' | 'stale' | 'unknown';

/** Classifies the latest odds snapshot as fresh / stale / unknown. Pure. */
export function oddsFreshness(
  snapshotTime: string | null,
  now: number,
): { status: OddsFreshness; ageMs: number | null } {
  const ms = toMs(snapshotTime);
  if (ms === null) return { status: 'unknown', ageMs: null };
  const ageMs = Math.max(0, now - ms);
  return { status: ageMs > PROOF_STALE_ODDS_MS ? 'stale' : 'fresh', ageMs };
}

/** Latest non-null ISO time across the races for a selector. Pure. */
export function latestRaceTime(
  races: readonly ProofRaceInput[],
  pick: (r: ProofRaceInput) => string | null,
): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const r of races) {
    const ms = toMs(pick(r));
    if (ms !== null && ms > bestMs) {
      bestMs = ms;
      best = pick(r);
    }
  }
  return best;
}

/** Names the migrations for any audit tables that were missing. Pure. */
export function collectMissingMigrations(input: DayProofInput): string[] {
  const missing: string[] = [];
  if (!input.cron.available) missing.push(`cron_runs (${AUDIT_MIGRATIONS.cron_runs})`);
  if (!input.mlTraining.available) {
    missing.push(`ml_training_examples (${AUDIT_MIGRATIONS.ml_training_examples})`);
  }
  if (!input.genai.table.available) missing.push(`genai_commentary (${AUDIT_MIGRATIONS.genai_commentary})`);
  return missing;
}

/** Read-only operator next-step suggestions (never executed). Pure. */
export function suggestOperatorActions(input: DayProofInput): string[] {
  const out: string[] = [];
  const slug = input.course ? ` --course ${input.course}` : '';
  out.push(`npm run dashboard:ready -- --date ${input.date}${slug}`);
  const anyUnsettled = input.races.some((r) => !r.settled);
  if (anyUnsettled) {
    out.push(`npm run results:auto -- --date ${input.date}${slug}   # dry-run audit (read-only)`);
  } else {
    out.push(`npm run report:day -- --date ${input.date}${slug}`);
  }
  if (!input.genai.commentaryFileExists) {
    out.push(`npm run genai:commentary -- --date ${input.date}${slug} --notes <notes.json> --output ${input.genai.commentaryFilePath}`);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rendering (deterministic)                                                  */
/* -------------------------------------------------------------------------- */

function orDash(v: string | null | undefined): string {
  return v && String(v).trim() !== '' ? String(v) : DASH;
}

function offClock(offTime: string | null): string {
  const ms = toMs(offTime);
  if (ms === null) return DASH;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function ageLabel(ms: number | null): string {
  if (ms === null) return DASH;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`;
}

function tableState(available: boolean, value: number | null): string {
  if (!available) return 'table missing (migration needed)';
  return value === null ? 'present (count unavailable)' : `${value}`;
}

/** Sorts races by off-time (unknown last) without mutating the input. Pure. */
function sortedRaces(races: readonly ProofRaceInput[]): ProofRaceInput[] {
  return [...races].sort((a, b) => {
    const am = toMs(a.offTime);
    const bm = toMs(b.offTime);
    if (am === null && bm === null) return 0;
    if (am === null) return 1;
    if (bm === null) return -1;
    return am - bm;
  });
}

/**
 * Renders the full, deterministic proof report (9 sections). Given the same
 * input it always returns the same string. Pure.
 */
export function renderProofMarkdown(input: DayProofInput): string {
  const races = sortedRaces(input.races);
  const settledCount = races.filter((r) => r.settled).length;
  const recommendations = races.reduce((n, r) => n + r.recommendationCount, 0);
  const latestOdds = latestRaceTime(races, (r) => r.latestOddsSnapshotTime);
  const latestModel = latestRaceTime(races, (r) => r.latestModelRunTime);
  const fresh = oddsFreshness(latestOdds, input.now);
  const cronJobs = input.cron.available ? input.cron.value : [];
  const racecardsCron = findCronJob(cronJobs, 'racecards');
  const oddsCron = findCronJob(cronJobs, 'odds');
  const lines: string[] = [];

  lines.push(`# Race-Day Update Proof — ${orDash(input.course)} ${input.date}`);
  lines.push('');
  lines.push('Durable, read-only proof of WHEN each stage last refreshed. Decision-support / audit only.');
  lines.push('');

  // Summary.
  lines.push('## Summary');
  lines.push(`- Races found: ${races.length}`);
  lines.push(`- Runners found: ${input.runnersFound}`);
  lines.push(`- Settled races: ${settledCount} / ${races.length}`);
  lines.push(`- Latest odds snapshot: ${orDash(latestOdds)} (${fresh.status})`);
  lines.push(`- Latest model run: ${orDash(latestModel)}`);
  lines.push(`- Recommendations: ${recommendations}`);
  lines.push(
    `- Audit tables: cron_runs ${input.cron.available ? 'present' : 'MISSING'}, ` +
      `ml_training_examples ${input.mlTraining.available ? 'present' : 'MISSING'}, ` +
      `genai_commentary ${input.genai.table.available ? 'present' : 'MISSING'}`,
  );
  lines.push('');

  // 1. Racecard load proof.
  lines.push('## 1. Racecard load proof');
  lines.push(`- Races found: ${races.length}`);
  lines.push(`- Runners found: ${input.runnersFound}`);
  lines.push(
    `- Latest racecard sync: ${
      input.cron.available
        ? racecardsCron
          ? `${orDash(racecardsCron.lastOk)} (last ${racecardsCron.lastStatus ?? 'unknown'})`
          : 'no racecards run recorded'
        : 'cron_runs table missing — apply migration to capture sync proof'
    }`,
  );
  lines.push('');

  // 2. Odds proof.
  lines.push('## 2. Odds proof');
  lines.push(`- Latest market snapshot: ${orDash(latestOdds)}`);
  const quotes = oddsCron?.counts?.quotesWritten ?? oddsCron?.counts?.snapshotsWritten ?? null;
  lines.push(
    `- Quotes written (last odds run): ${
      input.cron.available ? (quotes === null ? 'not derivable' : String(quotes)) : 'cron_runs table missing'
    }`,
  );
  lines.push(`- Status: ${fresh.status}${fresh.ageMs !== null ? ` (age ${ageLabel(fresh.ageMs)})` : ''}`);
  lines.push('');

  // 3. Model proof.
  lines.push('## 3. Model proof');
  lines.push(`- Latest model run: ${orDash(latestModel)}`);
  lines.push(`- Recommendation count: ${recommendations}`);
  lines.push('- Model runs per race:');
  for (const r of races) {
    const count = r.modelRunsCount === null ? (r.hasModelRun ? '≥1' : '0') : String(r.modelRunsCount);
    lines.push(`  - ${offClock(r.offTime)} ${orDash(r.raceName)}: ${count} run(s), ${r.recommendationCount} rec`);
  }
  lines.push('');

  // 4. Pre-off proof.
  lines.push('## 4. Pre-off proof');
  for (const r of races) {
    const captured = r.hasModelRun && r.latestModelRunTime !== null;
    const postOff = r.postOffRunsIgnored === null ? DASH : String(r.postOffRunsIgnored);
    lines.push(
      `- ${offClock(r.offTime)} ${orDash(r.raceName)}: capture ${captured ? 'available' : 'missing'}, ` +
        `pre-off run ${orDash(r.latestModelRunTime)}, post-off runs ignored ${postOff}`,
    );
  }
  lines.push('');

  // 5. Results proof.
  lines.push('## 5. Results proof');
  for (const r of races) {
    const past = (() => {
      const off = toMs(r.offTime);
      return off !== null && input.now > off;
    })();
    const settlement = r.settled
      ? 'settled'
      : past
        ? 'pending (not yet settled)'
        : 'upcoming';
    lines.push(
      `- ${offClock(r.offTime)} ${orDash(r.raceName)}: status ${orDash(r.status)}, ` +
        `finish_pos ${r.finishPosAvailable ? 'available' : 'none'}, winner ${orDash(r.winnerName)}, ` +
        `source ${r.finishPosAvailable ? 'stored finish positions' : DASH}, settlement ${settlement}`,
    );
  }
  lines.push(
    '- Note: the Standard /v1/results endpoint may be plan-blocked; same-day settlement uses results:auto ' +
      '(Basic/Free) and the manual CSV importer is the audited fallback.',
  );
  lines.push('');

  // 6. Training capture proof.
  lines.push('## 6. Training capture proof');
  lines.push(`- ml_training_examples rows (this meeting): ${tableState(input.mlTraining.available, input.mlTraining.value)}`);
  if (!input.mlTraining.available) {
    lines.push(`- Migration needed: ${AUDIT_MIGRATIONS.ml_training_examples}`);
  }
  lines.push('');

  // 7. GenAI proof.
  lines.push('## 7. GenAI proof');
  lines.push(`- Commentary file: ${input.genai.commentaryFilePath} (${input.genai.commentaryFileExists ? 'present' : 'not generated'})`);
  lines.push(`- Stored commentary rows: ${tableState(input.genai.table.available, input.genai.table.value)}`);
  lines.push('- Source notes: prepared + licence-reviewed via genai:prepare-notes (reviewed evidence only).');
  lines.push('- Shadow-only: yes — never model-active, never a prediction, never betting advice.');
  lines.push('');

  // 8. Operator actions.
  lines.push('## 8. Operator actions');
  lines.push('- Recommended next (read-only / review-gated):');
  for (const cmd of suggestOperatorActions(input)) lines.push(`  - \`${cmd}\``);
  lines.push('');

  // 9. Safety.
  lines.push('## 9. Safety');
  lines.push('- No auto-betting and no bet placement.');
  lines.push('- No UI writes — this proof reads stored state only and writes a single local report file.');
  lines.push('- No guarantee — this proves WHEN data refreshed, not that any selection will win.');
  lines.push('- No model, recommendation, ranking, or staking logic is changed.');
  lines.push('');

  // Missing migrations (graceful degradation).
  const missing = collectMissingMigrations(input);
  if (missing.length > 0) {
    lines.push('## Missing audit migrations');
    lines.push('Apply these in the Supabase SQL editor to complete durable proof:');
    for (const m of missing) lines.push(`- ${m}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('Read-only audit. No model/recommendation/staking change, no auto-betting, no UI writes, no guarantee.');
  lines.push('');
  return lines.join('\n');
}

/** One-line console summary. Pure. */
export function summarizeProof(input: DayProofInput): string {
  const races = input.races.length;
  const settled = input.races.filter((r) => r.settled).length;
  const missing = collectMissingMigrations(input).length;
  return (
    `[PROOF] ${orDash(input.course)} ${input.date}: ${races} race(s), ${settled} settled, ` +
    `${input.runnersFound} runner(s); audit tables missing: ${missing}`
  );
}
