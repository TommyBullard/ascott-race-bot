/**
 * Pure helpers for the read-only "pre-off race-day snapshot" report
 * (scripts/snapshotPreOff.ts).
 *
 * The snapshot records, per race, the model's FINAL PRE-OFF run — the latest
 * `model_runs` row with `run_time <= races.off_time` — straight from stored
 * model history. It never calls the model, never fetches live odds, never
 * imports results, and never writes to the database; the script only SELECTs
 * and then writes a Markdown file.
 *
 * Everything here is pure and deterministic: argument parsing, the report path,
 * the per-race warnings, and the Markdown rendering. All time logic is relative
 * to each race's `off_time` (never the wall clock), so a given report object
 * always renders to the same string — which is what the tests assert.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A selected run is "far before off" when it predates the off time by more than
 * this margin (15 minutes). Surfaced as a warning so a stale early snapshot is
 * visible, not silently trusted as the final pre-off state.
 */
export const PRE_OFF_FAR_BEFORE_OFF_MS = 15 * 60 * 1000;

/** Parsed CLI options for the snapshot script. */
export interface PreOffSnapshotArgs {
  /** Target meeting date (YYYY-MM-DD); undefined when missing/invalid. */
  date?: string;
  /** Optional course filter (verbatim; normalised by the caller for matching). */
  course?: string;
}

/**
 * Parses argv (already sliced past `node script`). `--date` requires a strict
 * YYYY-MM-DD value (anything else leaves `date` undefined so the caller can
 * error out); `--course` is taken verbatim (trimmed). Pure; read-only.
 */
export function parsePreOffSnapshotArgs(
  argv: readonly string[],
): PreOffSnapshotArgs {
  const args: PreOffSnapshotArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const value = (argv[++i] ?? '').trim();
      if (DATE_RE.test(value)) args.date = value;
    } else if (a === '--course') {
      const value = (argv[++i] ?? '').trim();
      if (value !== '') args.course = value;
    }
  }
  return args;
}

/**
 * Builds the deterministic report path:
 *   `reports/pre-off-snapshot-<date>[-<course-slug>].md`
 * The course is slugified (lower-cased, non-alphanumerics collapsed to `-`) so
 * the filename is filesystem-safe; an empty/missing course is omitted. Pure.
 */
export function buildPreOffSnapshotPath(
  date: string,
  course?: string | null,
): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug
    ? `reports/pre-off-snapshot-${date}-${slug}.md`
    : `reports/pre-off-snapshot-${date}.md`;
}

/** One scored runner in the snapshot (favourite or alternative). */
export interface SnapshotRunner {
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
export interface SnapshotPick extends SnapshotRunner {
  /** Stored stake (points/units), or null. */
  stake: number | null;
  /** Confidence label (e.g. "Low"), or null. */
  confidence_label: string | null;
}

/** One race's fully-resolved pre-off snapshot (the renderer's input). */
export interface RaceSnapshot {
  race_id: string;
  race_name: string | null;
  course: string | null;
  /** Scheduled off time (ISO 8601), or null when unknown. */
  off_time: string | null;
  /** Selected pre-off model run id, or null when no run is at/before the off. */
  selected_run_id: string | null;
  /** Selected run's `run_time` (ISO 8601), or null. */
  selected_run_time: string | null;
  /**
   * Whether the selected pre-off run is also the DB's current row. `false`
   * means a later (post-off) run superseded it; null when there is no run.
   */
  selected_run_is_current: boolean | null;
  /** Count of runs with `run_time > off_time` (ignored by this snapshot). */
  post_off_run_count: number;
  /** Rank-1 recommendation, or null when the selected run made no bet. */
  pick: SnapshotPick | null;
  /** Market favourite (highest stored market_prob), or null. */
  favourite: SnapshotRunner | null;
  /** Up to two next-best runners by EV. */
  alternatives: SnapshotRunner[];
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

/** The full report payload passed to {@link renderPreOffSnapshotMarkdown}. */
export interface PreOffSnapshotReport {
  date: string;
  course: string | null;
  /** When the report was generated (ISO 8601); shown verbatim, never invented. */
  generatedAt: string;
  races: RaceSnapshot[];
}

/** The per-race warnings surfaced in the report. Pure, deterministic. */
export interface RaceSnapshotWarnings {
  /** No model run exists at or before the off time. */
  noPreOffRun: boolean;
  /** The selected run predates the off by more than {@link PRE_OFF_FAR_BEFORE_OFF_MS}. */
  farBeforeOff: boolean;
  /** Post-off runs exist but were ignored for this snapshot. */
  postOffRunsIgnored: boolean;
}

/**
 * Computes the per-race warnings from a {@link RaceSnapshot}. All comparisons
 * are relative to the race's own `off_time` (never the wall clock), so the
 * result is deterministic. Pure; never throws.
 */
export function buildRaceSnapshotWarnings(
  race: RaceSnapshot,
): RaceSnapshotWarnings {
  const noPreOffRun = race.selected_run_id === null;

  let farBeforeOff = false;
  if (
    race.selected_run_time != null &&
    race.off_time != null &&
    race.off_time !== ''
  ) {
    const runMs = new Date(race.selected_run_time).getTime();
    const offMs = new Date(race.off_time).getTime();
    if (Number.isFinite(runMs) && Number.isFinite(offMs)) {
      farBeforeOff = offMs - runMs > PRE_OFF_FAR_BEFORE_OFF_MS;
    }
  }

  return {
    noPreOffRun,
    farBeforeOff,
    postOffRunsIgnored: race.post_off_run_count > 0,
  };
}

/* --------------------------- Markdown rendering --------------------------- */

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
function renderRunnerLine(runner: SnapshotRunner): string {
  return `${runner.horse_name} — odds ${fmtOdds(runner.odds)} · EV ${fmtEv(runner.ev)}`;
}

/** Renders one race section deterministically. Pure. */
function renderRaceSection(race: RaceSnapshot): string {
  const warnings = buildRaceSnapshotWarnings(race);
  const lines: string[] = [];

  lines.push(`## ${fmtOffTimeHm(race.off_time)} — ${race.race_name ?? '(unknown race)'}`);
  lines.push('');
  lines.push(`- Course: ${orDash(race.course)}`);
  lines.push(`- Off time (UTC): ${orDash(race.off_time)}`);
  lines.push(`- Selected pre-off run: ${orDash(race.selected_run_id)}`);
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
  lines.push(`- Post-off runs ignored: ${race.post_off_run_count}`);
  lines.push('');

  // Model pick / no-bet.
  if (race.pick) {
    lines.push('### Model pick');
    lines.push(`- Pick: ${race.pick.horse_name}`);
    lines.push(`- Odds: ${fmtOdds(race.pick.odds)}`);
    lines.push(`- EV: ${fmtEv(race.pick.ev)}`);
    lines.push(`- Stake: ${fmtStake(race.pick.stake)}`);
    lines.push(`- Confidence: ${orDash(race.pick.confidence_label)}`);
  } else {
    lines.push('### Model pick');
    lines.push('- No bet (the selected pre-off run made no rank-1 recommendation).');
  }
  lines.push('');

  // Market favourite.
  lines.push('### Market favourite');
  lines.push(
    race.favourite ? `- ${renderRunnerLine(race.favourite)}` : '- \u2014',
  );
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
  if (warnings.noPreOffRun) {
    warningLines.push(
      '- ⚠️ No pre-off model run exists for this race (no run at or before the off time).',
    );
  }
  if (warnings.farBeforeOff) {
    warningLines.push(
      '- ⚠️ Selected run is far before the off time (more than 15 minutes); it may not reflect the final pre-off state.',
    );
  }
  if (warnings.postOffRunsIgnored) {
    warningLines.push(
      `- ⚠️ ${race.post_off_run_count} post-off run(s) exist but were ignored (snapshot uses run_time <= off_time).`,
    );
  }
  if (warningLines.length > 0) {
    lines.push('### Warnings');
    lines.push(...warningLines);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Renders the full pre-off snapshot report as deterministic Markdown. Pure:
 * given the same {@link PreOffSnapshotReport} it always returns the same string
 * (no wall-clock reads — `generatedAt` is taken verbatim from the input). Never
 * fabricates: missing values render as an em dash, never an invented number.
 */
export function renderPreOffSnapshotMarkdown(
  report: PreOffSnapshotReport,
): string {
  const blocks: string[] = [];

  blocks.push(`# Pre-off race-day snapshot — ${report.date}`);
  blocks.push(
    [
      `Course: ${report.course ?? 'All'}`,
      `Generated: ${report.generatedAt}`,
      `Races: ${report.races.length}`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> Source of truth: stored model history (the latest `model_runs` row with',
      '> `run_time <= off_time`). Post-off runs are ignored. This report does not',
      '> call the model, fetch live odds, import results, or write to the database,',
      '> and it uses no manual notes. Decision-support only — not betting advice.',
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
