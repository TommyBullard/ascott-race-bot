/**
 * Pure helpers for the "run the model for a whole race day" operator script
 * (scripts/runModelsForRaceDay.ts, Phase 3B).
 *
 * Argument parsing, per-race outcome accumulation, and summary formatting live
 * here so they are unit-testable without a database. No I/O, no model maths —
 * the script wires these to the existing `runModelForRace` and a races query.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parsed CLI options for the race-day model runner. */
export interface ModelDayArgs {
  /** Target meeting date (YYYY-MM-DD); undefined when missing/invalid. */
  date?: string;
  /** Optional course filter (verbatim; normalised by the caller for matching). */
  course?: string;
  /** Write mode: only writes when true. */
  commit: boolean;
  /** Dry-run flag (explicit; the default is also a dry run). */
  dryRun: boolean;
}

/**
 * Parses argv (already sliced past `node script`). `--date` requires a strict
 * YYYY-MM-DD value (anything else leaves `date` undefined so the caller can
 * error out). `--commit` enables writes; `--dry-run` is explicit but writes are
 * gated solely on `commit`, so without `--commit` nothing is ever written. Pure.
 */
export function parseModelDayArgs(argv: readonly string[]): ModelDayArgs {
  const args: ModelDayArgs = { commit: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--date') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.date = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    }
  }
  return args;
}

/** Whether a race was run, skipped (no priced field), or failed. */
export type RaceRunStatus = 'run' | 'skipped' | 'failed';

/** One race's outcome, fed into {@link summarizeModelDayOutcomes}. */
export interface RaceRunOutcome {
  raceId: string;
  status: RaceRunStatus;
  /** Recommendations written for this race (only meaningful when status='run'). */
  recommended?: number;
}

/** Aggregate counts for the operator summary. */
export interface ModelDaySummary {
  races_found: number;
  races_run: number;
  model_runs_created: number;
  recommendations_created: number;
  no_bet_races: number;
  skipped_races: number;
  failures: number;
}

/**
 * Accumulates per-race outcomes into the summary counts. `races_found` is the
 * total selected; a `run` outcome creates a model run (and contributes its
 * `recommended` count, with `recommended === 0` counted as a no-bet race); a
 * `skipped` race had no priced field (no run written); a `failed` race threw.
 * Pure — does not mutate `outcomes`.
 */
export function summarizeModelDayOutcomes(
  outcomes: readonly RaceRunOutcome[],
): ModelDaySummary {
  const summary: ModelDaySummary = {
    races_found: outcomes.length,
    races_run: 0,
    model_runs_created: 0,
    recommendations_created: 0,
    no_bet_races: 0,
    skipped_races: 0,
    failures: 0,
  };
  for (const o of outcomes) {
    if (o.status === 'run') {
      summary.races_run += 1;
      summary.model_runs_created += 1;
      const rec = typeof o.recommended === 'number' ? o.recommended : 0;
      summary.recommendations_created += rec;
      if (rec === 0) summary.no_bet_races += 1;
    } else if (o.status === 'skipped') {
      summary.skipped_races += 1;
    } else {
      summary.failures += 1;
    }
  }
  return summary;
}

/** Formats the summary as aligned `key: value` lines (no secrets). Pure. */
export function formatModelDaySummary(summary: ModelDaySummary): string[] {
  return Object.entries(summary).map(([k, v]) => `  ${k}: ${v}`);
}
