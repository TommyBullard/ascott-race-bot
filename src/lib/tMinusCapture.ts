/**
 * Pure helpers for the read-only "T-minus-N pre-race capture" (scripts/captureTMinus.ts).
 *
 * Phase 1 of the autonomous race-day workflow. For each race it records the
 * model state as it stood a configurable number of minutes BEFORE the off — the
 * latest `model_runs` row with `run_time <= (off_time - minutes_before)` — taken
 * straight from stored model history. It never calls the model, never fetches
 * live odds, never imports results, and never writes to the database; the script
 * only SELECTs and then writes a Markdown (and optional JSON) file.
 *
 * The T-minus run is chosen by REUSING the same pure `selectPreOffRun` the
 * dashboard/accuracy use, but with the cutoff moved earlier to the capture
 * target time. Runs after the capture target — even if still pre-off — are NOT
 * selected (they are reported as "a later pre-off run exists"), and post-off
 * runs are always ignored.
 *
 * Everything here is pure and deterministic: argument parsing, the capture-target
 * computation, the run selection, the per-race warnings, the report path, and the
 * Markdown / JSON rendering. All time logic is relative to each race's `off_time`
 * (never the wall clock), and `generatedAt` is taken verbatim from the input, so
 * a given report object always renders to the same string. Nothing is fabricated:
 * a missing value renders as an em dash (`—`) in Markdown / `null` in JSON.
 */

import { selectPreOffRun } from './modelPerformance';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_MINUTE = 60_000;

/** Default minutes-before-off for the capture when `--minutes-before` is omitted. */
export const DEFAULT_MINUTES_BEFORE = 5;

/**
 * A selected run is "far before the capture target" when it predates the capture
 * target time by more than this margin (10 minutes). Surfaced as a warning so a
 * stale early run is visible, not silently trusted as the T-minus state.
 */
export const FAR_BEFORE_CAPTURE_MS = 10 * MS_PER_MINUTE;

/* -------------------------------------------------------------------------- */
/* Arguments + capture target                                                 */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the capture script. */
export interface TMinusCaptureArgs {
  /** Target meeting date (YYYY-MM-DD); undefined when missing/invalid. */
  date?: string;
  /** Optional course filter (verbatim; normalised by the caller for matching). */
  course?: string;
  /**
   * Minutes before the off to capture. Defaults to {@link DEFAULT_MINUTES_BEFORE}
   * when omitted; `undefined` ONLY when an explicit value was invalid (so the
   * caller can error out — distinct from the default).
   */
  minutesBefore: number | undefined;
}

/**
 * Parses argv (already sliced past `node script`). `--date` requires a strict
 * YYYY-MM-DD value (else `date` stays undefined). `--course` is taken verbatim
 * (trimmed). `--minutes-before` must be a positive integer; when omitted it
 * defaults to {@link DEFAULT_MINUTES_BEFORE}; when present but invalid it becomes
 * `undefined` so the caller can reject it. Pure; read-only.
 */
export function parseTMinusCaptureArgs(
  argv: readonly string[],
): TMinusCaptureArgs {
  const args: TMinusCaptureArgs = { minutesBefore: DEFAULT_MINUTES_BEFORE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.date = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    } else if (a === '--minutes-before') {
      const raw = (argv[++i] ?? '').trim();
      const n = Number(raw);
      // Positive integer only; anything else -> undefined (caller errors out).
      args.minutesBefore =
        raw !== '' && Number.isInteger(n) && n > 0 ? n : undefined;
    }
  }
  return args;
}

/**
 * Computes the capture target time = `off_time - minutes_before` as an ISO 8601
 * string, or null when the off time is missing/unparseable. Pure; deterministic.
 */
export function computeCaptureTargetTime(
  offTime: string | null | undefined,
  minutesBefore: number,
): string | null {
  if (!offTime) return null;
  const ms = new Date(offTime).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - minutesBefore * MS_PER_MINUTE).toISOString();
}

/* -------------------------------------------------------------------------- */
/* T-minus run selection (reuses selectPreOffRun)                             */
/* -------------------------------------------------------------------------- */

/** A model run candidate for T-minus selection (minimal shape). */
export interface TMinusRunCandidate {
  run_id: string;
  /** When the run was produced (ISO 8601). */
  run_time: string;
}

/** The outcome of selecting a T-minus run from a race's run history. */
export interface TMinusSelection {
  /** `off_time - minutes_before` (ISO 8601), or null when off time is unknown. */
  captureTargetTime: string | null;
  /** Latest run id with `run_time <= captureTargetTime`, or null when none. */
  selectedRunId: string | null;
  /** The selected run's `run_time` (ISO 8601), or null. */
  selectedRunTime: string | null;
  /** A run exists after the capture target but at/before the off time. */
  laterPreOffRunExists: boolean;
  /** Count of runs with `run_time > off_time` (always ignored). */
  postOffRunCount: number;
}

/**
 * Selects the T-minus run for a race: the latest run produced at or before the
 * capture target (`off_time - minutes_before`). REUSES {@link selectPreOffRun}
 * with the earlier cutoff. Also reports whether a later pre-off run exists (in
 * the window `(captureTarget, off]`) and how many post-off runs were ignored.
 *
 * Returns an all-empty selection when the off time is missing/unparseable (so
 * the race is flagged "no capture run available"). Pure; never throws; input
 * order does not matter.
 */
export function selectTMinusRun(
  runs: readonly TMinusRunCandidate[],
  offTime: string | null | undefined,
  minutesBefore: number,
): TMinusSelection {
  const captureTargetTime = computeCaptureTargetTime(offTime, minutesBefore);
  if (captureTargetTime === null) {
    return {
      captureTargetTime: null,
      selectedRunId: null,
      selectedRunTime: null,
      laterPreOffRunExists: false,
      postOffRunCount: 0,
    };
  }

  // The T-minus run = latest run with run_time <= captureTargetTime.
  const chosen = selectPreOffRun(runs, captureTargetTime);

  const offMs = new Date(offTime as string).getTime();
  const capMs = new Date(captureTargetTime).getTime();
  let laterPreOffRunExists = false;
  let postOffRunCount = 0;
  for (const run of runs) {
    const t = new Date(run.run_time).getTime();
    if (!Number.isFinite(t)) continue;
    if (t > offMs) {
      postOffRunCount += 1;
    } else if (t > capMs) {
      // After the capture target but at/before the off -> a later pre-off run.
      laterPreOffRunExists = true;
    }
  }

  return {
    captureTargetTime,
    selectedRunId: chosen?.run_id ?? null,
    selectedRunTime: chosen?.run_time ?? null,
    laterPreOffRunExists,
    postOffRunCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Data shapes (the renderer's input)                                         */
/* -------------------------------------------------------------------------- */

/** One scored runner in the capture (favourite or alternative). */
export interface TMinusRunner {
  horse_name: string;
  /** Stored decimal odds, or null when not recorded. */
  odds: number | null;
  /** Stored EV per 1 unit (fraction, e.g. 0.12 = +12%), or null. */
  ev: number | null;
  /** Model probability (0..1), or null. */
  model_prob: number | null;
  /** Market-implied probability (0..1), or null. */
  market_prob: number | null;
}

/** The model's rank-1 pick for the selected run (a superset of a runner). */
export interface TMinusPick extends TMinusRunner {
  /**
   * The picked runner's DB id, or null when not recorded. Optional (additive)
   * so existing capture consumers/fixtures are unaffected; the lock workflow
   * uses it for `locked_race_decisions.pick_runner_id`.
   */
  runner_id?: string | null;
  /** Stored stake (points/units), or null. */
  stake: number | null;
  /** Confidence label (e.g. "Low"), or null. */
  confidence_label: string | null;
}

/** One race's fully-resolved T-minus capture (the renderer's input). */
export interface TMinusRaceCapture {
  race_id: string;
  race_name: string | null;
  course: string | null;
  /** Scheduled off time (ISO 8601), or null when unknown. */
  off_time: string | null;
  /** Capture target = off_time - minutes_before (ISO 8601), or null. */
  capture_target_time: string | null;
  /** Selected T-minus run id, or null when none is at/before the capture target. */
  selected_run_id: string | null;
  /** Selected run's `run_time` (ISO 8601), or null. */
  selected_run_time: string | null;
  /**
   * Whether the selected run is also the DB's current row. `false` means a later
   * run superseded it; null when there is no selected run.
   */
  selected_run_is_current: boolean | null;
  /** A pre-off run exists after the capture target but at/before the off. */
  later_pre_off_run_exists: boolean;
  /** Count of runs with `run_time > off_time` (ignored by this capture). */
  post_off_run_count: number;
  /** Rank-1 recommendation, or null when the selected run made no bet. */
  pick: TMinusPick | null;
  /** Market favourite (highest stored market_prob), or null. */
  favourite: TMinusRunner | null;
  /** Up to two next-best runners by EV. */
  alternatives: TMinusRunner[];
  /** Run-quality verdict from config_json (OK/DEGRADED/STALE/...), or null. */
  run_quality: string | null;
  /** Structured data-quality flags (verbatim from the run), never fabricated. */
  data_quality_flags: string[];
  /** One-line data-quality summary, or null. */
  data_quality_short_summary: string | null;
  /** One-line tipster consensus summary, or null. */
  tipster_short_summary: string | null;
  /** Tipster/model alignment label (ALIGNED/DIVERGENT/...), or null. */
  tipster_alignment_label: string | null;
}

/** The full report payload passed to the renderers. */
export interface TMinusCaptureReport {
  date: string;
  course: string | null;
  /** Minutes before the off that the capture targets. */
  minutes_before: number;
  /** When the report was generated (ISO 8601); shown verbatim, never invented. */
  generatedAt: string;
  races: TMinusRaceCapture[];
}

/* -------------------------------------------------------------------------- */
/* Per-race warnings (pure, deterministic)                                    */
/* -------------------------------------------------------------------------- */

/** The per-race warnings surfaced in the capture. */
export interface TMinusCaptureWarnings {
  /** No model run exists at or before the capture target time. */
  noCaptureRun: boolean;
  /** The selected run predates the capture target by more than the margin. */
  farBeforeCapture: boolean;
  /** A later pre-off run exists (after the capture target, at/before the off). */
  laterPreOffRunExists: boolean;
  /** Post-off runs exist but were ignored for this capture. */
  postOffRunsIgnored: boolean;
}

/**
 * Computes the per-race warnings from a {@link TMinusRaceCapture}. All time
 * comparisons are relative to the race's own capture target / off (never the
 * wall clock), so the result is deterministic. Pure; never throws.
 */
export function buildTMinusCaptureWarnings(
  race: TMinusRaceCapture,
): TMinusCaptureWarnings {
  const noCaptureRun = race.selected_run_id === null;

  let farBeforeCapture = false;
  if (
    race.selected_run_time != null &&
    race.capture_target_time != null &&
    race.capture_target_time !== ''
  ) {
    const runMs = new Date(race.selected_run_time).getTime();
    const capMs = new Date(race.capture_target_time).getTime();
    if (Number.isFinite(runMs) && Number.isFinite(capMs)) {
      farBeforeCapture = capMs - runMs > FAR_BEFORE_CAPTURE_MS;
    }
  }

  return {
    noCaptureRun,
    farBeforeCapture,
    laterPreOffRunExists: race.later_pre_off_run_exists,
    postOffRunsIgnored: race.post_off_run_count > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Output path                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Builds the deterministic report path:
 *   `reports/t-minus-<minutes>-capture-<date>[-<course-slug>].<ext>`
 * The course is slugified (lower-cased, non-alphanumerics collapsed to `-`) so
 * the filename is filesystem-safe; an empty/missing course is omitted. Pure.
 */
export function buildTMinusCapturePath(
  date: string,
  minutesBefore: number,
  course?: string | null,
  ext: 'md' | 'json' = 'md',
): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `reports/t-minus-${minutesBefore}-capture-${date}`;
  return slug ? `${base}-${slug}.${ext}` : `${base}.${ext}`;
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

/** Formats a value as text, or an em dash when null/undefined. Pure. */
function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '\u2014';
  return String(value);
}

/** Formats a decimal-odds value to 2dp, or em dash. */
function fmtOdds(odds: number | null): string {
  return odds === null || !Number.isFinite(odds) ? '\u2014' : odds.toFixed(2);
}

/** Formats an EV fraction as a signed percentage (e.g. +12.3%), or em dash. */
function fmtEv(ev: number | null): string {
  if (ev === null || !Number.isFinite(ev)) return '\u2014';
  const pct = ev * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Formats a stake to 2dp, or em dash. */
function fmtStake(stake: number | null): string {
  return stake === null || !Number.isFinite(stake) ? '\u2014' : stake.toFixed(2);
}

/** Off time as HH:MM (UTC) for headings, or em dash. */
function fmtOffTimeHm(offTime: string | null): string {
  if (!offTime) return '\u2014';
  const ms = new Date(offTime).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : '\u2014';
}

/** Renders one runner as a compact line item. Pure. */
function renderRunnerLine(runner: TMinusRunner): string {
  return `${runner.horse_name} — odds ${fmtOdds(runner.odds)} · EV ${fmtEv(runner.ev)}`;
}

/** Renders one race section deterministically. Pure. */
function renderRaceSection(race: TMinusRaceCapture): string {
  const warnings = buildTMinusCaptureWarnings(race);
  const lines: string[] = [];

  lines.push(`## ${fmtOffTimeHm(race.off_time)} — ${race.race_name ?? '(unknown race)'}`);
  lines.push('');
  lines.push(`- Course: ${orDash(race.course)}`);
  lines.push(`- Off time (UTC): ${orDash(race.off_time)}`);
  lines.push(`- Capture target (UTC): ${orDash(race.capture_target_time)}`);
  lines.push(`- Selected model run: ${orDash(race.selected_run_id)}`);
  lines.push(`- Run time: ${orDash(race.selected_run_time)}`);
  lines.push(
    `- Selected run status: ${
      race.selected_run_id === null
        ? '\u2014'
        : race.selected_run_is_current
          ? 'current'
          : 'superseded'
    }`,
  );
  lines.push(`- Later pre-off run exists: ${race.later_pre_off_run_exists ? 'Yes' : 'No'}`);
  lines.push(`- Post-off runs ignored: ${race.post_off_run_count}`);
  lines.push('');

  // Model pick / no-capture / no-bet.
  lines.push('### Model pick');
  if (race.selected_run_id === null) {
    lines.push('- No capture run available (no model run at or before the capture target).');
  } else if (race.pick) {
    lines.push(`- Pick: ${race.pick.horse_name}`);
    lines.push(`- Odds: ${fmtOdds(race.pick.odds)}`);
    lines.push(`- EV: ${fmtEv(race.pick.ev)}`);
    lines.push(`- Stake: ${fmtStake(race.pick.stake)}`);
    lines.push(`- Confidence: ${orDash(race.pick.confidence_label)}`);
  } else {
    lines.push('- No bet (the captured run made no rank-1 recommendation).');
  }
  lines.push('');

  // Market favourite.
  lines.push('### Market favourite');
  lines.push(race.favourite ? `- ${renderRunnerLine(race.favourite)}` : '- \u2014');
  lines.push('');

  // Alternatives.
  lines.push('### Alternatives');
  if (race.alternatives.length === 0) {
    lines.push('- \u2014');
  } else {
    for (const alt of race.alternatives) {
      lines.push(`- ${renderRunnerLine(alt)}`);
    }
  }
  lines.push('');

  // Model explanation / observability.
  lines.push('### Model explanation');
  lines.push(`- Data quality: ${orDash(race.run_quality)}`);
  lines.push(
    `- Data quality flags: ${
      race.data_quality_flags.length ? race.data_quality_flags.join(', ') : '\u2014'
    }`,
  );
  lines.push(`- Data quality summary: ${orDash(race.data_quality_short_summary)}`);
  lines.push(`- Tipster consensus: ${orDash(race.tipster_short_summary)}`);
  lines.push(`- Tipster alignment: ${orDash(race.tipster_alignment_label)}`);
  lines.push('');

  // Warnings (only when present, in a fixed order for determinism).
  const warningLines: string[] = [];
  if (warnings.noCaptureRun) {
    warningLines.push(
      '- ⚠️ No capture run available (no model run at or before the capture target time).',
    );
  }
  if (warnings.farBeforeCapture) {
    warningLines.push(
      '- ⚠️ Selected run is more than 10 minutes before the capture target; it may be stale for a T-minus read.',
    );
  }
  if (warnings.laterPreOffRunExists) {
    warningLines.push(
      '- ℹ️ A later pre-off run exists (after the capture target but before the off); it was NOT used for this capture.',
    );
  }
  if (warnings.postOffRunsIgnored) {
    warningLines.push(
      `- ⚠️ ${race.post_off_run_count} post-off run(s) exist but were ignored (capture uses run_time <= capture target).`,
    );
  }
  if (warningLines.length > 0) {
    lines.push('### Warnings');
    lines.push(...warningLines);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Renders the full T-minus capture report as deterministic Markdown. Pure: given
 * the same {@link TMinusCaptureReport} it always returns the same string (no
 * wall-clock reads — `generatedAt` is taken verbatim). Never fabricates: missing
 * values render as an em dash, never an invented number.
 */
export function renderTMinusCaptureMarkdown(report: TMinusCaptureReport): string {
  const blocks: string[] = [];

  blocks.push(`# T-minus-${report.minutes_before} pre-race capture — ${report.date}`);
  blocks.push(
    [
      `Course: ${report.course ?? 'All'}`,
      `Minutes before off: ${report.minutes_before}`,
      `Generated: ${report.generatedAt}`,
      `Races: ${report.races.length}`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> Source of truth: stored model history (the latest `model_runs` row with',
      '> `run_time <= off_time - minutes_before`). Runs after the capture target',
      '> (even if pre-off) are not selected; post-off runs are ignored. This report',
      '> does not call the model, fetch live odds, import results, use manual notes,',
      '> or write to the database. Decision-support only — not betting advice.',
    ].join('\n'),
  );

  if (report.races.length === 0) {
    blocks.push('_No races matched the given date/course._');
  } else {
    for (const race of report.races) {
      blocks.push(renderRaceSection(race));
    }
  }

  // Single trailing newline; blocks separated by a blank line.
  return blocks.join('\n\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* JSON rendering (pure, deterministic, optional sibling output)              */
/* -------------------------------------------------------------------------- */

/** A race entry in the JSON output: the capture plus its derived warnings. */
export interface TMinusCaptureJsonRace extends TMinusRaceCapture {
  warnings: TMinusCaptureWarnings;
}

/** The JSON output shape: the report with per-race warnings attached. */
export interface TMinusCaptureJson
  extends Omit<TMinusCaptureReport, 'races'> {
  races: TMinusCaptureJsonRace[];
}

/**
 * Builds a JSON-serialisable view of the report, attaching each race's derived
 * warnings. Pure: returns a new object and never mutates the input. The script
 * may `JSON.stringify` this for an optional machine-readable sibling file.
 */
export function buildTMinusCaptureJson(
  report: TMinusCaptureReport,
): TMinusCaptureJson {
  return {
    date: report.date,
    course: report.course,
    minutes_before: report.minutes_before,
    generatedAt: report.generatedAt,
    races: report.races.map((race) => ({
      ...race,
      warnings: buildTMinusCaptureWarnings(race),
    })),
  };
}
