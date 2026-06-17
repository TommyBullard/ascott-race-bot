/**
 * Pure helpers for the read-only "end-of-day race report" (scripts/reportDay.ts).
 *
 * The report joins, per race, the model's FINAL PRE-OFF run — the latest
 * `model_runs` row with `run_time <= races.off_time` — to the official result
 * (`runners.finish_pos`), the stored rank-1 recommendation (odds / stake / EV /
 * confidence), and the persisted data-quality / tipster observability. It is the
 * end-of-day counterpart to the pre-off snapshot: the snapshot describes the
 * pre-off decision; this report adds the official outcome, P/L, a day summary,
 * and a factual pattern analysis.
 *
 * Everything here is PURE and DETERMINISTIC: argument parsing, the report path,
 * the win/place classification, the summary + pattern aggregation, and the
 * Markdown rendering. There is NO database access, NO network, NO model maths,
 * staking, ranking or tipster-weighting logic, and NO mutation. All time logic
 * is relative to each race's own `off_time` (never the wall clock), and the
 * report's `generatedAt` is taken verbatim from the input — so a given report
 * object always renders to the same string (which is what the tests assert).
 *
 * Honesty rules (mirroring the rest of the project): nothing is fabricated. A
 * missing value renders as an em dash (`—`), never an invented number. The P/L
 * and summary maths REUSE the existing pure {@link summarizeModelPerformance}
 * so the report can never diverge from the dashboard's performance figures.
 */

import {
  summarizeModelPerformance,
  type ModelPerformance,
  type RecommendationOutcome,
} from './modelPerformance';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The em dash used for every missing/unknown value. */
const DASH = '\u2014';

/** The evaluation rule behind every figure in the report. */
export const DAY_REPORT_EVALUATION_MODE = 'pre_off' as const;

/**
 * Highest finishing position counted as a "place". Actual place terms vary by
 * field size and race type and are NOT stored, so a top-3 finish is used as a
 * documented, conservative approximation of "placed". A 1st is a win; 2nd–3rd is
 * "placed but did not win".
 */
export const PLACE_MAX_POSITION = 3;

/* -------------------------------------------------------------------------- */
/* Arguments + output path                                                    */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the report script. */
export interface DayReportArgs {
  /** Target meeting date (YYYY-MM-DD); undefined when missing/invalid. */
  date?: string;
  /** Optional course filter (verbatim; normalised by the caller for matching). */
  course?: string;
}

/**
 * Parses argv (already sliced past `node script`). `--date` requires a strict
 * YYYY-MM-DD value (anything else leaves `date` undefined so the caller can
 * error out); `--course` is taken verbatim (trimmed). Pure; read-only. Mirrors
 * `parsePreOffSnapshotArgs` so the two read-only tools behave identically.
 */
export function parseDayReportArgs(argv: readonly string[]): DayReportArgs {
  const args: DayReportArgs = {};
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
 *   `reports/day-report-<date>[-<course-slug>].md`
 * The course is slugified (lower-cased, non-alphanumerics collapsed to `-`) so
 * the filename is filesystem-safe; an empty/missing course is omitted. Pure.
 */
export function buildDayReportPath(date: string, course?: string | null): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug
    ? `reports/day-report-${date}-${slug}.md`
    : `reports/day-report-${date}.md`;
}

/* -------------------------------------------------------------------------- */
/* Data shapes (the renderer's input)                                         */
/* -------------------------------------------------------------------------- */

/** One scored runner with its official finishing position (or null). */
export interface DayReportRunner {
  /** Runner id (used to join the result and compare pick vs favourite). */
  runner_id: string;
  horse_name: string;
  /** Stored decimal odds, or null when not recorded. */
  odds: number | null;
  /** Stored EV per 1 unit (fraction, e.g. 0.12 = +12%), or null. */
  ev: number | null;
  /** Model probability (0..1), or null. */
  model_prob: number | null;
  /** Market-implied probability (0..1), or null. */
  market_prob: number | null;
  /** Official finishing position from `runners.finish_pos`, or null. */
  finish_pos: number | null;
}

/** The model's rank-1 pick for the selected run (a superset of a runner). */
export interface DayReportPick extends DayReportRunner {
  /** Stored stake (points/units), or null. */
  stake: number | null;
  /** Confidence label (e.g. "Low"), or null. */
  confidence_label: string | null;
}

/** One race's fully-resolved end-of-day record (the renderer's input). */
export interface DayReportRace {
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
  /** Count of runs with `run_time > off_time` (ignored by this report). */
  post_off_run_count: number;
  /** True when the race has an official result (a finish_pos = 1 is recorded). */
  has_result: boolean;
  /** Name of the winning runner (finish_pos = 1), or null when no result. */
  winner_name: string | null;
  /** Rank-1 recommendation, or null when the selected run made no bet. */
  pick: DayReportPick | null;
  /** Market favourite (highest stored market_prob), or null. */
  favourite: DayReportRunner | null;
  /** Up to two next-best runners by EV. */
  alternatives: DayReportRunner[];
  /** Run-quality verdict from config_json (OK/DEGRADED/STALE/...), or null. */
  run_quality: string | null;
  /** One-line data-quality summary, or null. */
  data_quality_short_summary: string | null;
  /** Structured data-quality flags (verbatim from the run), never fabricated. */
  data_quality_flags: string[];
  /** One-line tipster consensus summary, or null. */
  tipster_short_summary: string | null;
  /** Tipster/model alignment label (ALIGNED/DIVERGENT/...), or null. */
  tipster_alignment_label: string | null;
}

/** The full report payload passed to {@link renderDayReportMarkdown}. */
export interface DayReport {
  date: string;
  course: string | null;
  /** When the report was generated (ISO 8601); shown verbatim, never invented. */
  generatedAt: string;
  races: DayReportRace[];
}

/* -------------------------------------------------------------------------- */
/* Classification helpers (pure)                                              */
/* -------------------------------------------------------------------------- */

/** True when a confidence label is "Low" (case-insensitive), else false. */
export function isLowConfidence(label: string | null | undefined): boolean {
  return typeof label === 'string' && label.trim().toLowerCase() === 'low';
}

/** True for a finishing position in 1..{@link PLACE_MAX_POSITION} (a place). */
export function isPlacedPosition(pos: number | null | undefined): boolean {
  return (
    typeof pos === 'number' &&
    Number.isFinite(pos) &&
    pos >= 1 &&
    pos <= PLACE_MAX_POSITION
  );
}

/** True for a finishing position that placed (2..max) but did not win (1). */
export function placedButNotWon(pos: number | null | undefined): boolean {
  return isPlacedPosition(pos) && pos !== 1;
}

/** The model pick's outcome relative to the official result. */
export type PickResultStatus = 'no_bet' | 'pending' | 'won' | 'lost';

/**
 * Classifies the rank-1 pick against the result: `no_bet` when the selected run
 * made no recommendation, `pending` when the race has no official result yet,
 * `won` when the pick finished 1st, otherwise `lost`. Pure.
 */
export function pickResultStatus(race: DayReportRace): PickResultStatus {
  if (!race.pick) return 'no_bet';
  if (!race.has_result) return 'pending';
  return race.pick.finish_pos === 1 ? 'won' : 'lost';
}

/* -------------------------------------------------------------------------- */
/* Per-race warnings (pure, deterministic)                                    */
/* -------------------------------------------------------------------------- */

/** The per-race warnings surfaced in the report. */
export interface DayReportRaceWarnings {
  /** No model run exists at or before the off time. */
  noPreOffRun: boolean;
  /** No official result is recorded for the race. */
  noOfficialResult: boolean;
  /** Post-off runs exist but were ignored (report uses run_time <= off_time). */
  postOffRunsIgnored: boolean;
}

/** Computes the per-race warnings from a {@link DayReportRace}. Pure. */
export function buildDayReportRaceWarnings(
  race: DayReportRace,
): DayReportRaceWarnings {
  return {
    noPreOffRun: race.selected_run_id === null,
    noOfficialResult: !race.has_result,
    postOffRunsIgnored: race.post_off_run_count > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Outcomes, P/L and the day summary (reuse summarizeModelPerformance)        */
/* -------------------------------------------------------------------------- */

/**
 * Builds evaluated recommendation outcomes from the resolved races, exactly as
 * the dashboard's pre-off evaluation does:
 *   - a race with no selected pre-off run is OUT OF SCOPE (neither outcome nor
 *     no-bet) — a post-off-only race must not be scored;
 *   - a selected run with no rank-1 pick is a NO-BET race;
 *   - otherwise it yields one {@link RecommendationOutcome} (settled iff the
 *     race has an official result; `won` iff the pick finished 1st).
 * Pure; never throws.
 */
export function buildDayReportOutcomes(races: readonly DayReportRace[]): {
  outcomes: RecommendationOutcome[];
  noBetRaces: number;
} {
  const outcomes: RecommendationOutcome[] = [];
  let noBetRaces = 0;

  for (const race of races) {
    if (race.selected_run_id === null) continue; // no pre-off run → out of scope
    if (!race.pick) {
      noBetRaces += 1; // selected run made no rank-1 recommendation → no-bet
      continue;
    }
    outcomes.push({
      settled: race.has_result,
      won: race.pick.finish_pos === 1,
      odds: race.pick.odds,
      stake: race.pick.stake,
      ev: race.pick.ev,
    });
  }

  return { outcomes, noBetRaces };
}

/**
 * The per-day rollup: the standard {@link ModelPerformance} figures plus the
 * total race count and the (fixed) evaluation mode. Built entirely from
 * {@link summarizeModelPerformance}, so it matches the dashboard exactly.
 */
export interface DayReportSummary extends ModelPerformance {
  /** All races in scope (including no-bet and no-pre-off-run races). */
  total_races: number;
  /** Always `pre_off` — the report never uses post-off stale runs. */
  evaluation_mode: typeof DAY_REPORT_EVALUATION_MODE;
}

/** Aggregates the resolved races into a {@link DayReportSummary}. Pure. */
export function buildDayReportSummary(
  races: readonly DayReportRace[],
): DayReportSummary {
  const { outcomes, noBetRaces } = buildDayReportOutcomes(races);
  const performance = summarizeModelPerformance(outcomes, noBetRaces);
  return {
    ...performance,
    total_races: races.length,
    evaluation_mode: DAY_REPORT_EVALUATION_MODE,
  };
}

/**
 * The settled P/L for one race at the stored stake/odds, or null when there is
 * nothing to settle (no bet, or pending). Reuses {@link summarizeModelPerformance}
 * on a single outcome so the per-race figure can never disagree with the day
 * summary's maths. Pure.
 */
export function racePnl(race: DayReportRace): number | null {
  if (!race.pick) return null; // no bet
  if (!race.has_result) return null; // pending — never a loss
  return summarizeModelPerformance([
    {
      settled: true,
      won: race.pick.finish_pos === 1,
      odds: race.pick.odds,
      stake: race.pick.stake,
      ev: race.pick.ev,
    },
  ]).profit_loss;
}

/* -------------------------------------------------------------------------- */
/* Pattern analysis (pure, factual counts)                                    */
/* -------------------------------------------------------------------------- */

/** Factual, data-derived counts over the day's races. */
export interface DayReportPatterns {
  low_confidence_picks: number;
  degraded_data_quality_races: number;
  ok_data_quality_races: number;
  divergent_tipster_races: number;
  no_tipster_consensus_races: number;
  picks_against_favourite: number;
  favourite_won_races: number;
  pick_placed_not_won_races: number;
  alternative_won_races: number;
  alternative_placed_races: number;
  /** Repeated warning combinations worth future no-bet gate research. */
  low_confidence_and_divergent: number;
  low_confidence_and_degraded: number;
  low_confidence_and_no_consensus: number;
  degraded_and_divergent: number;
}

const isDegraded = (race: DayReportRace): boolean =>
  race.run_quality === 'DEGRADED';
const isDivergent = (race: DayReportRace): boolean =>
  race.tipster_alignment_label === 'DIVERGENT';
const isNoConsensus = (race: DayReportRace): boolean =>
  race.tipster_alignment_label === 'NO_TIPSTER_CONSENSUS';
const isLowConfidencePick = (race: DayReportRace): boolean =>
  race.pick !== null && isLowConfidence(race.pick.confidence_label);

/**
 * Counts the report's factual patterns. Every count is derived from stored data
 * only; nothing is inferred when the underlying field is missing. Pure.
 */
export function buildDayReportPatterns(
  races: readonly DayReportRace[],
): DayReportPatterns {
  const patterns: DayReportPatterns = {
    low_confidence_picks: 0,
    degraded_data_quality_races: 0,
    ok_data_quality_races: 0,
    divergent_tipster_races: 0,
    no_tipster_consensus_races: 0,
    picks_against_favourite: 0,
    favourite_won_races: 0,
    pick_placed_not_won_races: 0,
    alternative_won_races: 0,
    alternative_placed_races: 0,
    low_confidence_and_divergent: 0,
    low_confidence_and_degraded: 0,
    low_confidence_and_no_consensus: 0,
    degraded_and_divergent: 0,
  };

  for (const race of races) {
    const lowConf = isLowConfidencePick(race);
    const degraded = isDegraded(race);
    const divergent = isDivergent(race);
    const noConsensus = isNoConsensus(race);

    if (lowConf) patterns.low_confidence_picks += 1;
    if (degraded) patterns.degraded_data_quality_races += 1;
    if (race.run_quality === 'OK') patterns.ok_data_quality_races += 1;
    if (divergent) patterns.divergent_tipster_races += 1;
    if (noConsensus) patterns.no_tipster_consensus_races += 1;

    if (
      race.pick !== null &&
      race.favourite !== null &&
      race.pick.runner_id !== race.favourite.runner_id
    ) {
      patterns.picks_against_favourite += 1;
    }

    if (race.favourite !== null && race.favourite.finish_pos === 1) {
      patterns.favourite_won_races += 1;
    }

    if (
      race.pick !== null &&
      race.has_result &&
      placedButNotWon(race.pick.finish_pos)
    ) {
      patterns.pick_placed_not_won_races += 1;
    }

    if (race.alternatives.some((alt) => alt.finish_pos === 1)) {
      patterns.alternative_won_races += 1;
    }
    if (race.alternatives.some((alt) => placedButNotWon(alt.finish_pos))) {
      patterns.alternative_placed_races += 1;
    }

    if (lowConf && divergent) patterns.low_confidence_and_divergent += 1;
    if (lowConf && degraded) patterns.low_confidence_and_degraded += 1;
    if (lowConf && noConsensus) patterns.low_confidence_and_no_consensus += 1;
    if (degraded && divergent) patterns.degraded_and_divergent += 1;
  }

  return patterns;
}

/* -------------------------------------------------------------------------- */
/* Markdown rendering (pure, deterministic)                                   */
/* -------------------------------------------------------------------------- */

/** Formats a value as text, or an em dash when null/undefined. */
function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return String(value);
}

/** Formats a finite number to a fixed number of decimals, or em dash. */
function fmtNum(value: number | null | undefined, dp: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(dp)
    : DASH;
}

/** Formats decimal odds to 2dp, or em dash. */
function fmtOdds(odds: number | null): string {
  return fmtNum(odds, 2);
}

/** Formats an EV fraction as a signed percentage (e.g. +12.3%), or em dash. */
function fmtEv(ev: number | null): string {
  if (ev === null || !Number.isFinite(ev)) return DASH;
  const pct = ev * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Formats a signed percentage value (already a percentage), or em dash. */
function fmtSignedPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return DASH;
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Formats a points value (P/L) signed to 2dp with a `pt` suffix, or em dash. */
function fmtPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(value).toFixed(2)}pt`;
}

/** Off time as HH:MM (UTC) for headings, or em dash. */
function fmtOffTimeHm(offTime: string | null): string {
  if (!offTime) return DASH;
  const ms = new Date(offTime).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : DASH;
}

/** A human label for the pick's result status. */
function pickStatusLabel(status: PickResultStatus): string {
  switch (status) {
    case 'won':
      return 'Won';
    case 'lost':
      return 'Lost';
    case 'pending':
      return 'Pending (no official result yet)';
    case 'no_bet':
      return 'No bet';
  }
}

/** Renders one runner as a compact line item, including its finish position. */
function renderRunnerLine(runner: DayReportRunner): string {
  return (
    `${runner.horse_name} — odds ${fmtOdds(runner.odds)} · EV ${fmtEv(runner.ev)} ` +
    `· finish ${orDash(runner.finish_pos)}`
  );
}

/** Renders the day summary section. Pure. */
function renderSummarySection(summary: DayReportSummary): string {
  const lines: string[] = ['## Summary', ''];
  lines.push(`- Total races: ${summary.total_races}`);
  lines.push(`- Settled races: ${summary.settled_count}`);
  lines.push(`- Pending races: ${summary.pending_count}`);
  lines.push(`- Recommendations total: ${summary.recommendations_total}`);
  lines.push(`- Winners: ${summary.winners}`);
  lines.push(`- Losers: ${summary.losers}`);
  lines.push(`- Strike rate: ${fmtSignedPct(summary.strike_rate)}`);
  lines.push(`- Total staked: ${fmtNum(summary.total_staked, 2)}`);
  lines.push(`- Profit/Loss: ${fmtPoints(summary.profit_loss)}`);
  lines.push(`- ROI: ${fmtSignedPct(summary.roi)}`);
  lines.push(`- Average EV: ${fmtEv(summary.average_ev)}`);
  lines.push(`- No-bet races: ${summary.no_bet_races}`);
  lines.push(`- Evaluation mode: ${summary.evaluation_mode}`);
  return lines.join('\n');
}

/** Renders the pattern-analysis section. Pure. */
function renderPatternsSection(patterns: DayReportPatterns): string {
  const lines: string[] = ['## Pattern analysis', ''];
  lines.push(`- Low confidence picks: ${patterns.low_confidence_picks}`);
  lines.push(
    `- DEGRADED data-quality races: ${patterns.degraded_data_quality_races}`,
  );
  lines.push(`- OK data-quality races: ${patterns.ok_data_quality_races}`);
  lines.push(`- DIVERGENT tipster races: ${patterns.divergent_tipster_races}`);
  lines.push(
    `- NO_TIPSTER_CONSENSUS races: ${patterns.no_tipster_consensus_races}`,
  );
  lines.push(
    `- Model picks against the market favourite: ${patterns.picks_against_favourite}`,
  );
  lines.push(
    `- Races where the market favourite won: ${patterns.favourite_won_races}`,
  );
  lines.push(
    `- Races where the model pick placed but did not win: ${patterns.pick_placed_not_won_races}`,
  );
  lines.push(
    `- Races where a model alternative won: ${patterns.alternative_won_races}`,
  );
  lines.push(
    `- Races where a model alternative placed: ${patterns.alternative_placed_races}`,
  );
  lines.push(
    `- LOW confidence + DIVERGENT: ${patterns.low_confidence_and_divergent}`,
  );
  lines.push(
    `- LOW confidence + DEGRADED: ${patterns.low_confidence_and_degraded}`,
  );
  lines.push(
    `- LOW confidence + NO_TIPSTER_CONSENSUS: ${patterns.low_confidence_and_no_consensus}`,
  );
  lines.push(`- DEGRADED + DIVERGENT: ${patterns.degraded_and_divergent}`);
  return lines.join('\n');
}

/**
 * Renders the interpretation section. Strictly factual and data-derived: it
 * restates the pre-off record, notes whether contenders/placed alternatives are
 * present in the stored results, and flags repeated LOW-confidence/divergence
 * combinations as candidates for FUTURE no-bet gate research. It makes no
 * prediction, no guarantee of future performance, and gives no betting advice.
 */
function renderInterpretationSection(
  summary: DayReportSummary,
  patterns: DayReportPatterns,
): string {
  const lines: string[] = ['## Interpretation', ''];

  lines.push(
    `- Using pre-off evaluation (the latest model run with ` +
      `\`run_time <= off_time\`), the model's settled record was ` +
      `${summary.winners}/${summary.settled_count} ` +
      `(${fmtSignedPct(summary.strike_rate)} strike) across ` +
      `${summary.total_races} race(s), for ${fmtPoints(summary.profit_loss)} at ` +
      `the stored stakes and odds (ROI ${fmtSignedPct(summary.roi)}).`,
  );

  const foundContenders =
    patterns.alternative_won_races > 0 ||
    patterns.alternative_placed_races > 0 ||
    patterns.pick_placed_not_won_races > 0;
  if (foundContenders) {
    lines.push(
      `- The selections found some contenders in the stored results: a model ` +
        `alternative won in ${patterns.alternative_won_races} race(s) and placed ` +
        `(top ${PLACE_MAX_POSITION}) in ${patterns.alternative_placed_races} ` +
        `race(s); the rank-1 pick placed without winning in ` +
        `${patterns.pick_placed_not_won_races} race(s).`,
    );
  } else {
    lines.push(
      `- No model pick or alternative is recorded as having placed (top ` +
        `${PLACE_MAX_POSITION}) in the stored results for this scope.`,
    );
  }

  lines.push(
    `- Repeated LOW confidence alongside tipster divergence or degraded data are ` +
      `candidates for FUTURE no-bet gate research (LOW+DIVERGENT: ` +
      `${patterns.low_confidence_and_divergent}, LOW+DEGRADED: ` +
      `${patterns.low_confidence_and_degraded}, LOW+NO_TIPSTER_CONSENSUS: ` +
      `${patterns.low_confidence_and_no_consensus}, DEGRADED+DIVERGENT: ` +
      `${patterns.degraded_and_divergent}). Any such gate would require ` +
      `backtesting before activation.`,
  );

  lines.push(
    `- This is a factual end-of-day summary for research and audit only. It is ` +
      `not betting advice and makes no claim or prediction about future ` +
      `performance.`,
  );

  return lines.join('\n');
}

/** Renders one race section deterministically. Pure. */
function renderRaceSection(race: DayReportRace): string {
  const warnings = buildDayReportRaceWarnings(race);
  const status = pickResultStatus(race);
  const lines: string[] = [];

  lines.push(
    `### ${fmtOffTimeHm(race.off_time)} — ${race.race_name ?? '(unknown race)'}`,
  );
  lines.push('');
  lines.push(`- Course: ${orDash(race.course)}`);
  lines.push(`- Off time (UTC): ${orDash(race.off_time)}`);
  lines.push(`- Selected pre-off run: ${orDash(race.selected_run_id)}`);
  lines.push(`- Run time: ${orDash(race.selected_run_time)}`);
  lines.push(
    `- Selected run status: ${
      race.selected_run_id === null
        ? DASH
        : race.selected_run_is_current
          ? 'current'
          : 'superseded'
    }`,
  );
  lines.push(`- Post-off runs ignored: ${race.post_off_run_count}`);
  lines.push(`- Winner: ${orDash(race.winner_name)}`);
  lines.push(`- Model pick result: ${pickStatusLabel(status)}`);
  lines.push('');

  // Model pick / no-bet.
  lines.push('#### Model pick');
  if (race.pick) {
    lines.push(`- Pick: ${race.pick.horse_name}`);
    lines.push(`- Finish position: ${orDash(race.pick.finish_pos)}`);
    lines.push(`- Odds: ${fmtOdds(race.pick.odds)}`);
    lines.push(`- EV: ${fmtEv(race.pick.ev)}`);
    lines.push(`- Stake: ${fmtNum(race.pick.stake, 2)}`);
    lines.push(`- P/L: ${fmtPoints(racePnl(race))}`);
    lines.push(`- Confidence: ${orDash(race.pick.confidence_label)}`);
  } else {
    lines.push('- No bet (the selected pre-off run made no rank-1 recommendation).');
  }
  lines.push('');

  // Market favourite.
  lines.push('#### Market favourite');
  lines.push(race.favourite ? `- ${renderRunnerLine(race.favourite)}` : `- ${DASH}`);
  lines.push('');

  // Alternatives.
  lines.push('#### Alternatives');
  if (race.alternatives.length === 0) {
    lines.push(`- ${DASH}`);
  } else {
    for (const alt of race.alternatives) {
      lines.push(`- ${renderRunnerLine(alt)}`);
    }
  }
  lines.push('');

  // Model explanation / observability.
  lines.push('#### Model explanation');
  lines.push(`- Data quality: ${orDash(race.run_quality)}`);
  lines.push(
    `- Data quality flags: ${
      race.data_quality_flags.length ? race.data_quality_flags.join(', ') : DASH
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
  if (warnings.noOfficialResult) {
    warningLines.push(
      '- ⚠️ No official result is recorded for this race (no finishing positions stored).',
    );
  }
  if (warnings.postOffRunsIgnored) {
    warningLines.push(
      `- ⚠️ ${race.post_off_run_count} post-off run(s) exist but were ignored (report uses run_time <= off_time).`,
    );
  }
  if (warningLines.length > 0) {
    lines.push('#### Warnings');
    lines.push(...warningLines);
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Renders the full end-of-day report as deterministic Markdown. Pure: given the
 * same {@link DayReport} it always returns the same string (no wall-clock reads —
 * `generatedAt` is taken verbatim). Never fabricates: missing values render as an
 * em dash, never an invented number.
 */
export function renderDayReportMarkdown(report: DayReport): string {
  const summary = buildDayReportSummary(report.races);
  const patterns = buildDayReportPatterns(report.races);

  const blocks: string[] = [];

  blocks.push(`# End-of-day race report — ${report.date}`);
  blocks.push(
    [
      `Course: ${report.course ?? 'All'}`,
      `Generated: ${report.generatedAt}`,
      `Evaluation mode: ${DAY_REPORT_EVALUATION_MODE}`,
      `Races: ${report.races.length}`,
    ].join('  \n'),
  );
  blocks.push(
    [
      '> Source of truth: stored database data only — the latest `model_runs` row',
      '> with `run_time <= off_time` (the final pre-off run), official results from',
      '> `runners.finish_pos`, and the stored recommendations / observability.',
      '> Post-off runs are ignored and no manual notes are used. This report does',
      '> not call the model, fetch live odds, import results, or write to the',
      '> database. Decision-support only — not betting advice.',
    ].join('\n'),
  );

  blocks.push(renderSummarySection(summary));
  blocks.push(renderPatternsSection(patterns));
  blocks.push(renderInterpretationSection(summary, patterns));

  blocks.push('## Races');
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
