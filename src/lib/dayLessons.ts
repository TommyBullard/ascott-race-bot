/**
 * Pure helpers for the READ-ONLY "race-day lessons" report (scripts/dayLessons.ts).
 *
 * Given an already-resolved, read-only view of a completed race day — the final
 * performance summary (computed elsewhere by the existing pure
 * `summarizeModelPerformance`), plus each race's model pick, market favourite,
 * alternatives and recorded finishing positions — this module summarises the day
 * into LESSONS for model / site improvement: a performance recap, race-by-race
 * notes, a factual pattern analysis, win-vs-value-vs-place observations, future
 * action ideas, and safety disclaimers.
 *
 * Everything here is PURE and DETERMINISTIC: argument parsing, the report path,
 * the win/place classification, the pattern aggregation, and the Markdown
 * rendering. There is NO database access, NO network, NO model maths, staking,
 * ranking or tipster-weighting logic, and NO mutation. The performance figures
 * are passed in verbatim (the caller reuses the dashboard's pure performance
 * maths), so this report can never diverge from the dashboard. A missing value
 * renders as an em dash (`—`); nothing is fabricated.
 *
 * Decision-support / research ONLY. It is NOT betting advice, claims NO edge, and
 * explicitly warns that one day is far too small a sample to change production.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The em dash used for every missing/unknown value. */
const DASH = '\u2014';

/** The evaluation rule behind every figure (the honest "as-of off time" record). */
export const DAY_LESSONS_EVALUATION_MODE = 'pre_off' as const;

/**
 * Highest finishing position counted as a "place". Real place terms vary by
 * field size and race type and are NOT stored, so a top-3 finish is used as a
 * documented, conservative approximation. A 1st is a win; 2nd–3rd is "placed but
 * did not win". (This mirrors the end-of-day report's convention.)
 */
export const PLACE_MAX_POSITION = 3;

/** Minimum runners for a race to count as a "big field" in the pattern analysis. */
export const BIG_FIELD_MIN_RUNNERS = 16;

/** Safety disclaimers shown in the report header and the Safety section. */
export const NOT_ADVICE_NOTE =
  'This is decision-support research only — not betting advice and not a tip.';
export const NO_EDGE_NOTE =
  'No betting edge or profit is claimed; the figures merely describe one settled day at the stored stakes and odds.';
export const SAMPLE_SIZE_NOTE =
  'One race day is far too small a sample to justify any production model, staking, ranking or site change — treat every lesson below as a hypothesis to test over many days, never a conclusion, and do not overfit to a single day.';

/**
 * Future-action IDEAS (research prompts only — nothing here is executed). Worded
 * to avoid embedding any runnable command/flag; the audited results settlement
 * step always runs separately from the site, never from this report.
 */
export const FUTURE_ACTION_IDEAS: readonly string[] = [
  'Earlier settlement: consider whether running the audited results:auto backend settlement step sooner (separately, never from the site) would record finishing positions earlier, so lessons are available the same evening.',
  'Race intelligence: consider whether shadow-only GenAI / race-intelligence notes could add context the market-based model lacks — strictly non-predictive, never naming a winner, never a betting input.',
  'Each-way / place research: where the model pick repeatedly placed but did not win, consider the read-only place research view (a simulated top-N marker only, no payouts).',
  'Guard against overfitting: validate any idea across many days with leakage-aware evaluation before changing production; a single day proves nothing.',
];

/* -------------------------------------------------------------------------- */
/* Arguments + output path                                                    */
/* -------------------------------------------------------------------------- */

/** Parsed CLI options for the lessons script. */
export interface DayLessonsArgs {
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
export function parseDayLessonsArgs(argv: readonly string[]): DayLessonsArgs {
  const args: DayLessonsArgs = {};
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
 *   `reports/day-lessons-<date>[-<course-slug>].md`
 * The course is slugified (lower-cased, non-alphanumerics collapsed to `-`); an
 * empty/missing course is omitted. Pure.
 */
export function buildDayLessonsPath(date: string, course?: string | null): string {
  const slug = (course ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug
    ? `reports/day-lessons-${date}-${slug}.md`
    : `reports/day-lessons-${date}.md`;
}

/* -------------------------------------------------------------------------- */
/* Data shapes (the builder's input)                                          */
/* -------------------------------------------------------------------------- */

/**
 * The final performance summary for the day. A structural subset of the existing
 * `ModelPerformanceResult` so the caller can pass that result straight through —
 * the maths stays the dashboard's single source of truth.
 */
export interface DayLessonsPerformance {
  settled_count: number;
  winners: number;
  losers: number;
  profit_loss: number;
  roi: number;
  total_staked: number;
  /** `pre_off` (default) or `current`. */
  evaluationMode: string;
  /** Optional context figures, rendered when present. */
  recommendations_total?: number;
  pending_count?: number;
  strike_rate?: number;
  no_bet_races?: number;
}

/** One scored runner with its official finishing position (or null). */
export interface DayLessonsRunner {
  runner_id: string;
  horse_name: string;
  odds: number | null;
  ev: number | null;
  finish_pos: number | null;
}

/** The model's rank-1 pick (a superset of a runner). */
export interface DayLessonsPick extends DayLessonsRunner {
  confidence_label: string | null;
  stake: number | null;
  /** True when the pick is also the market favourite (shortest odds). */
  is_favourite: boolean;
}

/** One race's fully-resolved end-of-day record (the builder's input). */
export interface DayLessonsRace {
  race_id: string;
  race_name: string | null;
  course: string | null;
  off_time: string | null;
  status: string | null;
  /** Declared field size (runner count); 0 when unknown. */
  field_size: number;
  /** Handicap flag from the race row, or null when unknown. */
  is_handicap: boolean | null;
  /** True when an official result is recorded (a finish_pos = 1 exists). */
  has_result: boolean;
  /** Winning runner's name (finish_pos = 1), or null when no result. */
  winner_name: string | null;
  pick: DayLessonsPick | null;
  favourite: DayLessonsRunner | null;
  alternatives: DayLessonsRunner[];
  /** Run-quality verdict (OK/DEGRADED/STALE/...), or null. */
  run_quality: string | null;
  /** Tipster/model alignment label (ALIGNED/DIVERGENT/NO_TIPSTER_CONSENSUS), or null. */
  tipster_alignment_label: string | null;
}

/** The full read-only input for one race day. */
export interface DayLessonsInput {
  date: string;
  course: string | null;
  /** When the report was generated (ISO 8601); shown verbatim, never invented. */
  generatedAt: string;
  performance: DayLessonsPerformance;
  races: readonly DayLessonsRace[];
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

/** True for a position that placed (2..max) but did not win (1). */
export function placedButNotWon(pos: number | null | undefined): boolean {
  return isPlacedPosition(pos) && pos !== 1;
}

/** The model pick's outcome relative to the official result. */
export type PickResultStatus = 'no_bet' | 'pending' | 'won' | 'lost';

/**
 * Classifies the rank-1 pick against the result: `no_bet` when there is no pick,
 * `pending` when the race has no official result yet, `won` when the pick
 * finished 1st, otherwise `lost`. Pure.
 */
export function pickResultStatus(race: DayLessonsRace): PickResultStatus {
  if (!race.pick) return 'no_bet';
  if (!race.has_result) return 'pending';
  return race.pick.finish_pos === 1 ? 'won' : 'lost';
}

/** True when an alternative runner won (finished 1st). */
function anyAlternativeWon(race: DayLessonsRace): boolean {
  return race.alternatives.some((a) => a.finish_pos === 1);
}

/** True when an alternative runner placed (top-{@link PLACE_MAX_POSITION}). */
function anyAlternativePlaced(race: DayLessonsRace): boolean {
  return race.alternatives.some((a) => isPlacedPosition(a.finish_pos));
}

/* -------------------------------------------------------------------------- */
/* Per-race lesson rows (pure, deterministic)                                 */
/* -------------------------------------------------------------------------- */

/** A compact, fully-derived per-race lesson row (the renderer's input). */
export interface RaceLesson {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  field_size: number;
  is_handicap: boolean | null;
  pick_name: string | null;
  pick_finish_pos: number | null;
  pick_confidence_label: string | null;
  pick_status: PickResultStatus;
  pick_placed: boolean;
  pick_is_favourite: boolean;
  winner_name: string | null;
  favourite_name: string | null;
  favourite_finish_pos: number | null;
  run_quality: string | null;
  tipster_alignment_label: string | null;
  alternative_won: boolean;
  alternative_placed: boolean;
}

/** Sort key for off_time: known instants ascending, unknowns last. */
function offTimeSortKey(offTime: string | null): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** Derives one {@link RaceLesson} from a resolved race. Pure. */
export function buildRaceLesson(race: DayLessonsRace): RaceLesson {
  return {
    race_id: race.race_id,
    off_time: race.off_time,
    race_name: race.race_name,
    field_size: race.field_size,
    is_handicap: race.is_handicap,
    pick_name: race.pick?.horse_name ?? null,
    pick_finish_pos: race.pick?.finish_pos ?? null,
    pick_confidence_label: race.pick?.confidence_label ?? null,
    pick_status: pickResultStatus(race),
    pick_placed: race.pick ? isPlacedPosition(race.pick.finish_pos) : false,
    pick_is_favourite: race.pick?.is_favourite ?? false,
    winner_name: race.winner_name,
    favourite_name: race.favourite?.horse_name ?? null,
    favourite_finish_pos: race.favourite?.finish_pos ?? null,
    run_quality: race.run_quality,
    tipster_alignment_label: race.tipster_alignment_label,
    alternative_won: anyAlternativeWon(race),
    alternative_placed: anyAlternativePlaced(race),
  };
}

/** Builds the per-race lesson rows, sorted by off time (unknown last). Pure. */
export function buildRaceLessons(races: readonly DayLessonsRace[]): RaceLesson[] {
  return [...races]
    .sort((a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time))
    .map(buildRaceLesson);
}

/* -------------------------------------------------------------------------- */
/* Pattern analysis (pure, factual counts)                                    */
/* -------------------------------------------------------------------------- */

/** Factual, data-derived counts over the day's races. */
export interface DayLessonsPatterns {
  low_confidence_winners: number;
  low_confidence_losers: number;
  degraded_data_winners: number;
  degraded_data_losers: number;
  no_tipster_consensus_races: number;
  no_tipster_consensus_winners: number;
  no_tipster_consensus_losers: number;
  /** Races where the model pick was also the market favourite. */
  favourite_aligned_races: number;
  /** ...of those, how many won. */
  favourite_aligned_wins: number;
  /** Races where the market favourite finished 1st. */
  favourite_won_races: number;
  /** Big-field handicaps (field ≥ {@link BIG_FIELD_MIN_RUNNERS} AND handicap). */
  big_field_handicap_races: number;
  big_field_handicap_pick_wins: number;
  big_field_handicap_pick_placed: number;
}

const isDegraded = (race: DayLessonsRace): boolean => race.run_quality === 'DEGRADED';
const isNoConsensus = (race: DayLessonsRace): boolean =>
  race.tipster_alignment_label === 'NO_TIPSTER_CONSENSUS';
const isBigFieldHandicap = (race: DayLessonsRace): boolean =>
  race.is_handicap === true && race.field_size >= BIG_FIELD_MIN_RUNNERS;

/**
 * Counts the report's factual patterns. Every count is derived from stored data
 * only; nothing is inferred when the underlying field is missing. Pure.
 */
export function buildDayLessonsPatterns(
  races: readonly DayLessonsRace[],
): DayLessonsPatterns {
  const patterns: DayLessonsPatterns = {
    low_confidence_winners: 0,
    low_confidence_losers: 0,
    degraded_data_winners: 0,
    degraded_data_losers: 0,
    no_tipster_consensus_races: 0,
    no_tipster_consensus_winners: 0,
    no_tipster_consensus_losers: 0,
    favourite_aligned_races: 0,
    favourite_aligned_wins: 0,
    favourite_won_races: 0,
    big_field_handicap_races: 0,
    big_field_handicap_pick_wins: 0,
    big_field_handicap_pick_placed: 0,
  };

  for (const race of races) {
    const status = pickResultStatus(race);
    const won = status === 'won';
    const lost = status === 'lost';
    const lowConf = race.pick !== null && isLowConfidence(race.pick.confidence_label);

    if (lowConf && won) patterns.low_confidence_winners += 1;
    if (lowConf && lost) patterns.low_confidence_losers += 1;

    if (isDegraded(race) && won) patterns.degraded_data_winners += 1;
    if (isDegraded(race) && lost) patterns.degraded_data_losers += 1;

    if (isNoConsensus(race)) {
      patterns.no_tipster_consensus_races += 1;
      if (won) patterns.no_tipster_consensus_winners += 1;
      if (lost) patterns.no_tipster_consensus_losers += 1;
    }

    if (race.pick !== null && race.pick.is_favourite) {
      patterns.favourite_aligned_races += 1;
      if (won) patterns.favourite_aligned_wins += 1;
    }

    if (race.favourite !== null && race.favourite.finish_pos === 1) {
      patterns.favourite_won_races += 1;
    }

    if (isBigFieldHandicap(race)) {
      patterns.big_field_handicap_races += 1;
      if (won) patterns.big_field_handicap_pick_wins += 1;
      if (race.pick !== null && isPlacedPosition(race.pick.finish_pos)) {
        patterns.big_field_handicap_pick_placed += 1;
      }
    }
  }

  return patterns;
}

/* -------------------------------------------------------------------------- */
/* Win vs value vs place notes (pure)                                         */
/* -------------------------------------------------------------------------- */

/** Race labels grouped into the win/value/place observations. */
export interface WinValuePlaceNotes {
  /** Races where the model pick won. */
  model_won: string[];
  /** Races where the model pick lost but an alternative won. */
  model_lost_alternative_won: string[];
  /** Races where the model pick placed (top-N) but did not win. */
  pick_placed_not_won: string[];
}

/** A short, stable label for a race (HH:MM + name, else the id). */
export function raceLabel(race: Pick<DayLessonsRace, 'off_time' | 'race_name' | 'race_id'>): string {
  const hm = fmtOffTimeHm(race.off_time);
  const name = race.race_name && race.race_name.trim() !== '' ? race.race_name : race.race_id;
  return hm === DASH ? name : `${hm} ${name}`;
}

/** Builds the win-vs-value-vs-place notes. Pure; deterministic (off-time order). */
export function buildWinValuePlaceNotes(
  races: readonly DayLessonsRace[],
): WinValuePlaceNotes {
  const ordered = [...races].sort(
    (a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time),
  );
  const notes: WinValuePlaceNotes = {
    model_won: [],
    model_lost_alternative_won: [],
    pick_placed_not_won: [],
  };

  for (const race of ordered) {
    const status = pickResultStatus(race);
    if (status === 'won') notes.model_won.push(raceLabel(race));
    if (status === 'lost' && anyAlternativeWon(race)) {
      notes.model_lost_alternative_won.push(raceLabel(race));
    }
    if (
      race.pick !== null &&
      race.has_result &&
      placedButNotWon(race.pick.finish_pos)
    ) {
      notes.pick_placed_not_won.push(raceLabel(race));
    }
  }

  return notes;
}

/* -------------------------------------------------------------------------- */
/* Report assembly (pure)                                                     */
/* -------------------------------------------------------------------------- */

/** The fully-derived report payload passed to {@link renderDayLessonsMarkdown}. */
export interface DayLessonsReport {
  date: string;
  course: string | null;
  generatedAt: string;
  evaluationMode: string;
  performance: DayLessonsPerformance;
  races: RaceLesson[];
  patterns: DayLessonsPatterns;
  notes: WinValuePlaceNotes;
}

/** Assembles the deterministic report object from the read-only input. Pure. */
export function buildDayLessonsReport(input: DayLessonsInput): DayLessonsReport {
  return {
    date: input.date,
    course: input.course,
    generatedAt: input.generatedAt,
    evaluationMode: input.performance.evaluationMode,
    performance: input.performance,
    races: buildRaceLessons(input.races),
    patterns: buildDayLessonsPatterns(input.races),
    notes: buildWinValuePlaceNotes(input.races),
  };
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
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(dp) : DASH;
}

/** Formats a signed percentage value (already a percentage), or em dash. */
function fmtSignedPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return DASH;
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Formats a points value (P/L) signed to 2dp with a `pt` suffix, or em dash. */
function fmtPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
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

/** Renders the final performance summary section. Pure. */
function renderPerformanceSection(report: DayLessonsReport): string {
  const p = report.performance;
  const lines: string[] = ['## 1. Final performance summary', ''];
  lines.push(`- Settled races: ${p.settled_count}`);
  lines.push(`- Winners: ${p.winners}`);
  lines.push(`- Losers: ${p.losers}`);
  lines.push(`- Profit/Loss: ${fmtPoints(p.profit_loss)}`);
  lines.push(`- ROI: ${fmtSignedPct(p.roi)}`);
  lines.push(`- Total staked: ${fmtNum(p.total_staked, 2)}`);
  lines.push(`- Evaluation mode: ${p.evaluationMode}`);
  if (typeof p.recommendations_total === 'number') {
    lines.push(`- Recommendations total: ${p.recommendations_total}`);
  }
  if (typeof p.pending_count === 'number') {
    lines.push(`- Pending races: ${p.pending_count}`);
  }
  if (typeof p.strike_rate === 'number') {
    lines.push(`- Strike rate: ${fmtSignedPct(p.strike_rate)}`);
  }
  if (typeof p.no_bet_races === 'number') {
    lines.push(`- No-bet races: ${p.no_bet_races}`);
  }
  return lines.join('\n');
}

/** Renders the race-by-race lessons section. Pure. */
function renderRaceByRaceSection(report: DayLessonsReport): string {
  const lines: string[] = ['## 2. Race-by-race lessons', ''];
  if (report.races.length === 0) {
    lines.push('- No races found.');
    return lines.join('\n');
  }
  for (const race of report.races) {
    const handicap = race.is_handicap === true ? ', handicap' : '';
    const fieldLabel = race.field_size > 0 ? `field ${race.field_size}${handicap}` : `field ${DASH}${handicap}`;
    lines.push('');
    lines.push(`### ${fmtOffTimeHm(race.off_time)} — ${orDash(race.race_name)} (${fieldLabel})`);
    const placedTag = race.pick_placed && race.pick_status !== 'won' ? ' (placed)' : '';
    lines.push(
      `- Model pick: ${orDash(race.pick_name)} — finish ${orDash(race.pick_finish_pos)} ` +
        `(${pickStatusLabel(race.pick_status)}${placedTag})`,
    );
    lines.push(`- Winner: ${orDash(race.winner_name)}`);
    const favTag = race.pick_is_favourite ? ' (= model pick)' : '';
    lines.push(
      `- Market favourite: ${orDash(race.favourite_name)} — finish ${orDash(race.favourite_finish_pos)}${favTag}`,
    );
    lines.push(`- Confidence: ${orDash(race.pick_confidence_label)}`);
    lines.push(`- Data quality: ${orDash(race.run_quality)}`);
    lines.push(`- Tipster alignment: ${orDash(race.tipster_alignment_label)}`);
    lines.push(
      `- Alternative won: ${race.alternative_won ? 'yes' : 'no'} · ` +
        `Alternative placed: ${race.alternative_placed ? 'yes' : 'no'}`,
    );
  }
  return lines.join('\n');
}

/** Renders the pattern-analysis section. Pure. */
function renderPatternsSection(patterns: DayLessonsPatterns): string {
  const lines: string[] = ['## 3. Pattern analysis', ''];
  lines.push(`- Low-confidence winners: ${patterns.low_confidence_winners}`);
  lines.push(`- Low-confidence losers: ${patterns.low_confidence_losers}`);
  lines.push(`- DEGRADED-data winners: ${patterns.degraded_data_winners}`);
  lines.push(`- DEGRADED-data losers: ${patterns.degraded_data_losers}`);
  lines.push(
    `- NO_TIPSTER_CONSENSUS races: ${patterns.no_tipster_consensus_races} ` +
      `(winners ${patterns.no_tipster_consensus_winners} · losers ${patterns.no_tipster_consensus_losers})`,
  );
  lines.push(
    `- Model pick = market favourite: ${patterns.favourite_aligned_races} ` +
      `(won ${patterns.favourite_aligned_wins})`,
  );
  lines.push(`- Races where the market favourite won: ${patterns.favourite_won_races}`);
  lines.push(
    `- Big-field handicaps (field ≥ ${BIG_FIELD_MIN_RUNNERS}): ${patterns.big_field_handicap_races} ` +
      `(pick won ${patterns.big_field_handicap_pick_wins} · pick placed ${patterns.big_field_handicap_pick_placed})`,
  );
  return lines.join('\n');
}

/** Renders a labelled list, or an em dash when empty. Pure. */
function renderLabelList(title: string, labels: string[]): string {
  if (labels.length === 0) return `- ${title}: ${DASH}`;
  return `- ${title}: ${labels.join(' ; ')}`;
}

/** Renders the win-vs-value-vs-place notes section. Pure. */
function renderNotesSection(notes: WinValuePlaceNotes): string {
  const lines: string[] = ['## 4. Win vs value vs place notes', ''];
  lines.push(renderLabelList('Where the model pick won', notes.model_won));
  lines.push(
    renderLabelList('Where the model lost but an alternative won', notes.model_lost_alternative_won),
  );
  lines.push(
    renderLabelList('Where the model pick placed but did not win', notes.pick_placed_not_won),
  );
  return lines.join('\n');
}

/** Renders the future-action ideas section. Pure. */
function renderFutureActionsSection(): string {
  const lines: string[] = ['## 5. Future action ideas', ''];
  for (const idea of FUTURE_ACTION_IDEAS) {
    lines.push(`- ${idea}`);
  }
  return lines.join('\n');
}

/** Renders the safety section. Pure. */
function renderSafetySection(): string {
  return ['## 6. Safety', '', `- ${NOT_ADVICE_NOTE}`, `- ${NO_EDGE_NOTE}`, `- ${SAMPLE_SIZE_NOTE}`].join(
    '\n',
  );
}

/**
 * Renders the deterministic Markdown lessons report. No randomness, no wall
 * clock (the `generatedAt` is taken verbatim from the report), no payout maths.
 * Given the same report object it always returns the same string. Pure.
 */
export function renderDayLessonsMarkdown(report: DayLessonsReport): string {
  const heading = report.course
    ? `# Race-day lessons — ${report.date} ${report.course}`
    : `# Race-day lessons — ${report.date}`;

  const lines: string[] = [heading, ''];
  lines.push(
    `_Generated ${report.generatedAt} · evaluation mode: ${report.evaluationMode} · READ-ONLY research_`,
  );
  lines.push('');
  lines.push(`> ${NOT_ADVICE_NOTE}`);
  lines.push(`> ${NO_EDGE_NOTE}`);
  lines.push(`> ${SAMPLE_SIZE_NOTE}`);
  lines.push('');
  lines.push(renderPerformanceSection(report));
  lines.push('');
  lines.push(renderRaceByRaceSection(report));
  lines.push('');
  lines.push(renderPatternsSection(report.patterns));
  lines.push('');
  lines.push(renderNotesSection(report.notes));
  lines.push('');
  lines.push(renderFutureActionsSection());
  lines.push('');
  lines.push(renderSafetySection());
  lines.push('');

  return lines.join('\n');
}
