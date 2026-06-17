/**
 * Pure helpers for the READ-ONLY each-way / place outcome audit.
 *
 * RESEARCH / DECISION-SUPPORT ONLY. Given already-resolved per-race data (model
 * pick, market favourite, alternatives, the full field with finishing positions,
 * plus optional confidence / data-quality bands) and a configurable number of
 * "places", it counts which selections WON (finished 1st) and which PLACED
 * (finished within the configured top-N) and renders a deterministic Markdown
 * report.
 *
 * It deliberately does NOT:
 *   - assume real bookmaker place terms (the top-N marker is SIMULATED),
 *   - compute any payout / each-way profit-and-loss (no odds or place fractions),
 *   - give betting advice or guarantees,
 *   - touch the model, staking, ranking, recommendation, or the database.
 *
 * There is NO I/O here: no DB, no network, no writes. Given the same inputs every
 * function returns the same output, so the whole module is unit-testable without
 * a database. Missing finishing positions are handled safely (treated as
 * not-placed / unknown and rendered "—").
 */

/** Em dash for unknown / missing values. */
const DASH = '\u2014';

/** Default simulated place marker when none is supplied. */
export const DEFAULT_PLACES = 4;

/** Standard, always-shown research disclaimers (rendered once in the header). */
export const PLACE_SIMULATED_WARNING =
  'Place terms are SIMULATED (a top-N finishing marker) — NOT real bookmaker each-way terms.';
export const NOT_ADVICE_WARNING =
  'Research / decision-support only — not betting advice, and no guarantees.';
export const NO_PAYOUT_WARNING =
  'No each-way payout or profit/loss is calculated — this is a placed / not-placed count only.';
/** Per-race warning when a race has no recorded finishing positions yet. */
export const RESULT_PENDING_WARNING =
  'Result pending — finishing positions unavailable.';

/** A runner with its (optional) finishing position. */
export interface AuditRunner {
  runner_id: string;
  horse_name: string;
  finish_pos: number | null;
}

/** All read-only inputs for one race. */
export interface PlaceAuditRaceInput {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  course: string | null;
  modelPick: AuditRunner | null;
  favourite: AuditRunner | null;
  alternatives: AuditRunner[];
  /** The full field (source of the winner + race size). */
  runners: AuditRunner[];
  /** Model pick confidence band (e.g. 'High' / 'Medium' / 'Low'). */
  confidenceLabel?: string | null;
  /** Data-quality verdict (e.g. 'OK' / 'DEGRADED' / 'STALE'). */
  runQuality?: string | null;
  /** Race row status (e.g. 'result' once settled). */
  status?: string | null;
}

export interface PlaceAuditConfig {
  /** Simulated number of places (top-N marker). */
  places: number;
}

/** A selection evaluated against the configured place terms. */
export interface AuditPick {
  runner: AuditRunner;
  finishPos: number | null;
  placed: boolean;
  won: boolean;
}

export interface PlaceAuditRaceResult {
  race_id: string;
  off_time: string | null;
  race_name: string | null;
  raceSize: number;
  places: number;
  settled: boolean;
  winner: AuditRunner | null;
  modelPick: AuditPick | null;
  favourite: AuditPick | null;
  alternatives: AuditPick[];
  bestAlternativeFinish: number | null;
  confidenceLabel: string | null;
  runQuality: string | null;
  warnings: string[];
}

export interface BandStat {
  picks: number;
  won: number;
  placed: number;
}

export interface PlaceAuditSummary {
  raceCount: number;
  settledRaceCount: number;
  modelPickWon: number;
  modelPickPlaced: number;
  alternativesWon: number;
  alternativesPlaced: number;
  favouriteWon: number;
  favouritePlaced: number;
  modelPickLostButPlaced: number;
  racesWhereAlternativeWon: number;
  racesWhereAlternativePlaced: number;
  byConfidenceBand: Record<string, BandStat>;
  byDataQuality: Record<string, BandStat>;
}

export interface PlaceAuditReport {
  date: string;
  course: string | null;
  places: number;
  races: PlaceAuditRaceResult[];
  summary: PlaceAuditSummary;
}

/** Finite-number type guard. */
function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Ensures a positive integer place count (defaults when invalid). */
export function clampPlaces(value: number | null | undefined): number {
  if (!isFiniteNum(value)) return DEFAULT_PLACES;
  const n = Math.trunc(value);
  return n >= 1 ? n : DEFAULT_PLACES;
}

/** True when `finishPos` is a win (1st). */
export function isWinningFinish(finishPos: number | null): boolean {
  return finishPos === 1;
}

/** True when `finishPos` is within the configured top-N places. */
export function isPlacedFinish(finishPos: number | null, places: number): boolean {
  return isFiniteNum(finishPos) && finishPos >= 1 && finishPos <= places;
}

/** Evaluates a runner against the place terms (null runner -> null pick). */
function evaluatePick(runner: AuditRunner | null, places: number): AuditPick | null {
  if (!runner) return null;
  const finishPos = isFiniteNum(runner.finish_pos) ? runner.finish_pos : null;
  return {
    runner,
    finishPos,
    placed: isPlacedFinish(finishPos, places),
    won: isWinningFinish(finishPos),
  };
}

/** Sort key for off_time (unknown last). */
function offKey(off: string | null): number {
  if (!off) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(off);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/** Builds one race's audit result. Pure. */
export function buildPlaceAuditRace(
  input: PlaceAuditRaceInput,
  config: PlaceAuditConfig,
): PlaceAuditRaceResult {
  const places = clampPlaces(config.places);
  const runners = input.runners ?? [];
  const winner = runners.find((r) => isWinningFinish(r.finish_pos)) ?? null;
  const anyFinish = runners.some((r) => isFiniteNum(r.finish_pos));
  const settled = (input.status ?? '').trim().toLowerCase() === 'result' || anyFinish;

  const modelPick = evaluatePick(input.modelPick, places);
  const favourite = evaluatePick(input.favourite, places);
  const alternatives = (input.alternatives ?? []).map(
    (a) => evaluatePick(a, places) as AuditPick,
  );

  const altFinishes = alternatives
    .map((a) => a.finishPos)
    .filter((p): p is number => isFiniteNum(p));
  const bestAlternativeFinish =
    altFinishes.length > 0 ? Math.min(...altFinishes) : null;

  const warnings: string[] = [];
  if (!settled) warnings.push(RESULT_PENDING_WARNING);

  return {
    race_id: input.race_id,
    off_time: input.off_time ?? null,
    race_name: input.race_name ?? null,
    raceSize: runners.length,
    places,
    settled,
    winner,
    modelPick,
    favourite,
    alternatives,
    bestAlternativeFinish,
    confidenceLabel: input.confidenceLabel ?? null,
    runQuality: input.runQuality ?? null,
    warnings,
  };
}

/** Normalises a band label to an upper-case key, or 'UNKNOWN'. */
function bandKey(label: string | null): string {
  const k = (label ?? '').trim().toUpperCase();
  return k === '' ? 'UNKNOWN' : k;
}

/** Adds one model-pick observation into a band map (mutates the map). */
function addBand(map: Record<string, BandStat>, key: string, pick: AuditPick): void {
  const stat = map[key] ?? { picks: 0, won: 0, placed: 0 };
  stat.picks += 1;
  if (pick.won) stat.won += 1;
  if (pick.placed) stat.placed += 1;
  map[key] = stat;
}

/** Aggregates the per-race results into a summary. Pure. */
export function buildPlaceAuditSummary(
  races: PlaceAuditRaceResult[],
): PlaceAuditSummary {
  const summary: PlaceAuditSummary = {
    raceCount: races.length,
    settledRaceCount: 0,
    modelPickWon: 0,
    modelPickPlaced: 0,
    alternativesWon: 0,
    alternativesPlaced: 0,
    favouriteWon: 0,
    favouritePlaced: 0,
    modelPickLostButPlaced: 0,
    racesWhereAlternativeWon: 0,
    racesWhereAlternativePlaced: 0,
    byConfidenceBand: {},
    byDataQuality: {},
  };

  for (const race of races) {
    if (race.settled) summary.settledRaceCount += 1;

    if (race.modelPick) {
      if (race.modelPick.won) summary.modelPickWon += 1;
      if (race.modelPick.placed) summary.modelPickPlaced += 1;
      if (!race.modelPick.won && race.modelPick.placed) {
        summary.modelPickLostButPlaced += 1;
      }
      addBand(summary.byConfidenceBand, bandKey(race.confidenceLabel), race.modelPick);
      addBand(summary.byDataQuality, bandKey(race.runQuality), race.modelPick);
    }

    if (race.favourite) {
      if (race.favourite.won) summary.favouriteWon += 1;
      if (race.favourite.placed) summary.favouritePlaced += 1;
    }

    const altWon = race.alternatives.filter((a) => a.won).length;
    const altPlaced = race.alternatives.filter((a) => a.placed).length;
    summary.alternativesWon += altWon;
    summary.alternativesPlaced += altPlaced;
    if (altWon > 0) summary.racesWhereAlternativeWon += 1;
    if (altPlaced > 0) summary.racesWhereAlternativePlaced += 1;
  }

  return summary;
}

/** Builds the full report: races sorted by off time + summary. Pure. */
export function buildPlaceAuditReport(args: {
  date: string;
  course: string | null;
  inputs: readonly PlaceAuditRaceInput[];
  config: PlaceAuditConfig;
}): PlaceAuditReport {
  const places = clampPlaces(args.config.places);
  const races = [...args.inputs]
    .sort((a, b) => offKey(a.off_time) - offKey(b.off_time))
    .map((input) => buildPlaceAuditRace(input, { places }));

  return {
    date: args.date,
    course: args.course,
    places,
    races,
    summary: buildPlaceAuditSummary(races),
  };
}

/* -------------------------------- rendering ------------------------------- */

/** Renders a value or the em dash when null/empty. */
function orDash(value: string | number | null): string {
  if (value === null || value === undefined) return DASH;
  if (typeof value === 'string') return value.trim() === '' ? DASH : value;
  return String(value);
}

/** Formats an ISO off time as local HH:MM, or a dash. */
function formatClock(iso: string | null): string {
  if (!iso) return DASH;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return DASH;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Renders a pick as "name — finish P — placed: yes/no". */
function renderPick(pick: AuditPick | null): string {
  if (!pick) return DASH;
  const finish = isFiniteNum(pick.finishPos) ? `finish ${pick.finishPos}` : `finish ${DASH}`;
  return `${pick.runner.horse_name} — ${finish} — placed: ${pick.placed ? 'yes' : 'no'}${pick.won ? ' (WON)' : ''}`;
}

/** Preferred display order for bands; unknown bands sort after, alphabetically. */
function orderedKeys(map: Record<string, BandStat>, preferred: string[]): string[] {
  const present = Object.keys(map);
  const ordered = preferred.filter((k) => present.includes(k));
  const extra = present.filter((k) => !preferred.includes(k)).sort();
  return [...ordered, ...extra];
}

function renderBandSection(
  title: string,
  map: Record<string, BandStat>,
  preferred: string[],
): string[] {
  const keys = orderedKeys(map, preferred);
  const lines = [`### ${title}`];
  if (keys.length === 0) {
    lines.push('- Not available');
    return lines;
  }
  for (const key of keys) {
    const s = map[key];
    lines.push(`- ${key} — picks: ${s.picks} · won: ${s.won} · placed: ${s.placed}`);
  }
  return lines;
}

/**
 * Renders a deterministic Markdown report. No timestamps, no randomness, no
 * payout maths — placed / not-placed counts only, with the research disclaimers
 * shown once at the top. Pure.
 */
export function renderPlaceAuditMarkdown(report: PlaceAuditReport): string {
  const { summary } = report;
  const lines: string[] = [];

  const heading = report.course
    ? `# Each-way / Place Audit — ${report.date} ${report.course}`
    : `# Each-way / Place Audit — ${report.date}`;
  lines.push(heading);
  lines.push('');
  lines.push(`> ${PLACE_SIMULATED_WARNING}`);
  lines.push(`> ${NOT_ADVICE_WARNING}`);
  lines.push(`> ${NO_PAYOUT_WARNING}`);
  lines.push('');
  lines.push(
    `Configured places: ${report.places} · Races: ${summary.raceCount} · Settled: ${summary.settledRaceCount}`,
  );
  lines.push('');

  lines.push('## Summary');
  lines.push(`- Model pick — won: ${summary.modelPickWon} · placed: ${summary.modelPickPlaced}`);
  lines.push(`- Alternatives — won: ${summary.alternativesWon} · placed: ${summary.alternativesPlaced}`);
  lines.push(`- Market favourite — won: ${summary.favouriteWon} · placed: ${summary.favouritePlaced}`);
  lines.push(`- Model pick lost but placed: ${summary.modelPickLostButPlaced}`);
  lines.push(`- Races where an alternative won: ${summary.racesWhereAlternativeWon}`);
  lines.push(`- Races where an alternative placed: ${summary.racesWhereAlternativePlaced}`);
  lines.push('');

  lines.push(
    ...renderBandSection('Place performance by confidence band', summary.byConfidenceBand, [
      'HIGH',
      'MEDIUM',
      'LOW',
    ]),
  );
  lines.push('');
  lines.push(
    ...renderBandSection('Place performance by data quality', summary.byDataQuality, [
      'OK',
      'DEGRADED',
      'STALE',
      'INVALID',
    ]),
  );
  lines.push('');

  lines.push('## Races');
  if (report.races.length === 0) {
    lines.push('- No races found.');
  }
  for (const race of report.races) {
    lines.push('');
    lines.push(
      `### ${formatClock(race.off_time)} — ${orDash(race.race_name)} (field ${race.raceSize})`,
    );
    lines.push(
      `- Winner: ${race.winner ? `${race.winner.horse_name} (finish 1)` : DASH}`,
    );
    lines.push(`- Model pick: ${renderPick(race.modelPick)}`);
    lines.push(`- Market favourite: ${renderPick(race.favourite)}`);
    if (race.alternatives.length === 0) {
      lines.push(`- Alternatives: ${DASH}`);
    } else {
      const alts = race.alternatives
        .map((a) => {
          const finish = isFiniteNum(a.finishPos) ? a.finishPos : DASH;
          return `${a.runner.horse_name} (finish ${finish}, placed: ${a.placed ? 'yes' : 'no'})`;
        })
        .join(' ; ');
      lines.push(`- Alternatives: ${alts}`);
    }
    lines.push(`- Best alternative finish: ${orDash(race.bestAlternativeFinish)}`);
    lines.push(`- Configured places: ${race.places}`);
    if (race.warnings.length > 0) {
      lines.push(`- Warnings: ${race.warnings.join(' · ')}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Builds the deterministic output path for a date (+ optional course). */
export function buildPlaceAuditPath(date: string, course: string | null): string {
  const slug = course
    ? `-${course.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
    : '';
  return `reports/place-audit-${date}${slug}.md`;
}

/** Parses CLI args: `--date`, `--course`, `--places`. Pure (argv only). */
export function parsePlaceAuditArgs(argv: readonly string[]): {
  date: string | null;
  course: string | null;
  places: number;
} {
  let date: string | null = null;
  let course: string | null = null;
  let places: number = DEFAULT_PLACES;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      date = v === '' ? null : v;
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      course = v === '' ? null : v;
    } else if (a === '--places') {
      const v = Number((argv[++i] ?? '').trim());
      places = clampPlaces(Number.isFinite(v) ? v : null);
    }
  }

  // Reject anything that is not a strict YYYY-MM-DD calendar date.
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = null;
  }

  return { date, course, places };
}
