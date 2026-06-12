/**
 * Validation + classification core for the one-off historical-race loader.
 *
 * PURE (no I/O, no DB): takes the untrusted parsed JSON of a historical-race
 * import and reports structural errors, soft warnings, and a per-race
 * classification of whether the race would actually "count" in the backtest
 * (i.e. has at least one priced runner AND exactly one recorded winner).
 *
 * INTEGRITY: this module NEVER invents data. It only inspects what was provided
 * and flags what is missing (a race with no winner is reported as "won't count",
 * not silently completed). The loader script refuses to commit when placeholder
 * EXAMPLE data is detected, so the template can't be inserted by accident.
 *
 * The required columns + enum values encoded here were verified against the live
 * PostgREST OpenAPI spec (2026-06-13), not assumed.
 */

/** `races.status` enum (public.race_status). Settled past race => 'result'. */
export const RACE_STATUS = [
  'scheduled',
  'open',
  'off',
  'result',
  'abandoned',
] as const;
export type RaceStatus = (typeof RACE_STATUS)[number];

/** `runners.runner_status` enum (public.runner_status). A horse that ran => 'ran'. */
export const RUNNER_STATUS = [
  'declared',
  'non_runner',
  'withdrawn',
  'ran',
] as const;
export type RunnerStatus = (typeof RUNNER_STATUS)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER_RE = /example/i;

export interface RunnerInput {
  horse_name: string;
  /** Pre-race decimal price the model scores on (>1). A runner needs this to be "priced". */
  odds_decimal?: number;
  /** Betfair SP used to settle a winning bet (>1). Needed for true BSP ROI. */
  bsp_decimal?: number;
  /** Official SP (>1), used only as a last-resort settlement fallback. */
  sp_decimal?: number;
  /** Finishing position (>=1). The winner is finish_pos === 1. */
  finish_pos?: number | null;
  /** runner_status enum; defaults to 'ran' for a historical settled race. */
  status?: string;
  trainer?: string;
  jockey?: string;
}

export interface SelectionInput {
  /** Free-text tipster name -> tipster_selections.raw_tipster_name (required). */
  tipster_name: string;
  affiliation?: string;
  /** Must match a runner's horse_name in the same race. */
  horse_name: string;
  /** Optional explicit canonical tipster id (else resolved by name, else null). */
  tipster_id?: string;
}

export interface RaceInput {
  course: string;
  country: string;
  race_name: string;
  /** YYYY-MM-DD. */
  meeting_date: string;
  /** ISO timestamp (e.g. 2025-06-18T14:30:00Z). */
  off_time: string;
  /** races.handicap_flag (required by DB); structural, not a result. Default false. */
  handicap?: boolean;
  /** races.status enum; default 'result' (a settled past race). */
  status?: string;
  /** market_snapshots.source_label; default 'historical_import'. */
  source_label?: string;
  /** runner_quotes.quote_type label; default 'historical'. */
  quote_type?: string;
  runners: RunnerInput[];
  tipster_selections?: SelectionInput[];
}

/** Real, proofed tipster prior stats (enables needle weighting). Never fabricated. */
export interface TipsterInput {
  canonical_name: string;
  display_name?: string;
  affiliation?: string;
  /** YYYY-MM-DD. */
  as_of_date: string;
  bets_count: number;
  wins_count: number;
  roi_bsp_gross?: number;
  roi_bsp_net?: number;
  ae_bsp?: number;
  strike_rate?: number;
}

export interface HistoricalImport {
  races: RaceInput[];
  tipsters?: TipsterInput[];
}

/** Per-race read on whether it satisfies the backtest's "counts" criteria. */
export interface RaceClassification {
  index: number;
  label: string;
  runnerCount: number;
  pricedCount: number;
  winnerHorse: string | null;
  winnerCount: number;
  winnerHasBsp: boolean;
  selectionCount: number;
  /** Selections that can carry a needle weight (explicit id or a supplied prior). */
  linkableSelectionCount: number;
  /** True iff >=1 priced runner AND exactly one winner — the backtest will score it. */
  wouldCount: boolean;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  races: RaceClassification[];
  /** Races that would be scored by the backtest. */
  countable: number;
  /** Tipster prior rows supplied. */
  tipsterCount: number;
  /** True if any field contains placeholder EXAMPLE text. */
  hasPlaceholder: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validates an untrusted parsed import and classifies each race. Returns
 * structural `errors` (which must block a commit), soft `warnings` (which do
 * not), and a per-race classification mirroring the backtest's "counts" rule.
 * Performs no mutation and invents no values.
 */
export function validateImport(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const races: RaceClassification[] = [];
  let hasPlaceholder = false;

  const flagPlaceholder = (v: unknown) => {
    if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) hasPlaceholder = true;
  };

  if (!isObject(raw)) {
    return {
      errors: ['Top-level JSON must be an object: { "races": [...] }.'],
      warnings,
      races,
      countable: 0,
      tipsterCount: 0,
      hasPlaceholder: false,
    };
  }

  const tipsters = Array.isArray(raw.tipsters) ? raw.tipsters : [];
  const tipsterNames = new Set<string>();
  tipsters.forEach((t, i) => {
    if (!isObject(t)) {
      errors.push(`tipsters[${i}]: must be an object.`);
      return;
    }
    flagPlaceholder(t.canonical_name);
    if (!isNonEmptyString(t.canonical_name)) {
      errors.push(`tipsters[${i}].canonical_name is required.`);
    } else {
      tipsterNames.add(t.canonical_name.trim().toLowerCase());
    }
    if (!isNonEmptyString(t.as_of_date) || !DATE_RE.test(t.as_of_date as string)) {
      errors.push(`tipsters[${i}].as_of_date must be YYYY-MM-DD.`);
    }
    if (!isFiniteNumber(t.bets_count) || (t.bets_count as number) < 0) {
      errors.push(`tipsters[${i}].bets_count must be a non-negative number.`);
    }
    if (!isFiniteNumber(t.wins_count) || (t.wins_count as number) < 0) {
      errors.push(`tipsters[${i}].wins_count must be a non-negative number.`);
    }
  });

  if (!Array.isArray(raw.races) || raw.races.length === 0) {
    errors.push('`races` must be a non-empty array.');
    return {
      errors,
      warnings,
      races,
      countable: 0,
      tipsterCount: tipsters.length,
      hasPlaceholder,
    };
  }

  raw.races.forEach((race, ri) => {
    const where = `races[${ri}]`;
    if (!isObject(race)) {
      errors.push(`${where}: must be an object.`);
      return;
    }

    [race.course, race.country, race.race_name].forEach(flagPlaceholder);

    for (const field of ['course', 'country', 'race_name'] as const) {
      if (!isNonEmptyString(race[field])) {
        errors.push(`${where}.${field} is required.`);
      }
    }
    if (!isNonEmptyString(race.meeting_date) || !DATE_RE.test(race.meeting_date as string)) {
      errors.push(`${where}.meeting_date must be YYYY-MM-DD.`);
    }
    if (!isNonEmptyString(race.off_time) || Number.isNaN(Date.parse(race.off_time as string))) {
      errors.push(`${where}.off_time must be a parseable ISO timestamp.`);
    }
    if (race.status !== undefined && !RACE_STATUS.includes(race.status as RaceStatus)) {
      errors.push(`${where}.status must be one of ${RACE_STATUS.join('|')}.`);
    }

    const label = `${isNonEmptyString(race.course) ? race.course : '?'} ${
      isNonEmptyString(race.off_time) ? race.off_time : `#${ri}`
    }`;

    const runners = Array.isArray(race.runners) ? race.runners : null;
    if (!runners || runners.length === 0) {
      errors.push(`${where}.runners must be a non-empty array.`);
      return;
    }

    const horseNames = new Set<string>();
    let pricedCount = 0;
    let winnerCount = 0;
    let winnerHorse: string | null = null;
    let winnerHasBsp = false;

    runners.forEach((runner, ki) => {
      const rwhere = `${where}.runners[${ki}]`;
      if (!isObject(runner)) {
        errors.push(`${rwhere}: must be an object.`);
        return;
      }
      flagPlaceholder(runner.horse_name);

      if (!isNonEmptyString(runner.horse_name)) {
        errors.push(`${rwhere}.horse_name is required.`);
      } else {
        const key = runner.horse_name.trim().toLowerCase();
        if (horseNames.has(key)) {
          errors.push(`${rwhere}: duplicate horse_name "${runner.horse_name}".`);
        }
        horseNames.add(key);
      }

      for (const priceField of ['odds_decimal', 'bsp_decimal', 'sp_decimal'] as const) {
        const val = runner[priceField];
        if (val !== undefined && val !== null) {
          if (!isFiniteNumber(val) || (val as number) <= 1) {
            errors.push(`${rwhere}.${priceField} must be a decimal price > 1.`);
          }
        }
      }
      if (isFiniteNumber(runner.odds_decimal) && (runner.odds_decimal as number) > 1) {
        pricedCount++;
      }

      if (runner.finish_pos !== undefined && runner.finish_pos !== null) {
        const fp = runner.finish_pos;
        if (!isFiniteNumber(fp) || !Number.isInteger(fp) || (fp as number) < 1) {
          errors.push(`${rwhere}.finish_pos must be a positive integer.`);
        } else if (fp === 1) {
          winnerCount++;
          winnerHorse = isNonEmptyString(runner.horse_name) ? runner.horse_name : '?';
          winnerHasBsp = isFiniteNumber(runner.bsp_decimal) && (runner.bsp_decimal as number) > 1;
        }
      }

      if (runner.status !== undefined && !RUNNER_STATUS.includes(runner.status as RunnerStatus)) {
        errors.push(`${rwhere}.status must be one of ${RUNNER_STATUS.join('|')}.`);
      }
    });

    if (winnerCount > 1) {
      errors.push(`${where}: ${winnerCount} runners have finish_pos=1 (only one winner allowed).`);
    }

    // Tipster selections.
    const selections = Array.isArray(race.tipster_selections)
      ? race.tipster_selections
      : [];
    let linkableSelectionCount = 0;
    selections.forEach((sel, si) => {
      const swhere = `${where}.tipster_selections[${si}]`;
      if (!isObject(sel)) {
        errors.push(`${swhere}: must be an object.`);
        return;
      }
      flagPlaceholder(sel.tipster_name);
      if (!isNonEmptyString(sel.tipster_name)) {
        errors.push(`${swhere}.tipster_name is required.`);
      }
      if (!isNonEmptyString(sel.horse_name)) {
        errors.push(`${swhere}.horse_name is required.`);
      } else if (!horseNames.has(sel.horse_name.trim().toLowerCase())) {
        errors.push(
          `${swhere}.horse_name "${sel.horse_name}" does not match any runner in this race.`,
        );
      }
      const linkable =
        isNonEmptyString(sel.tipster_id) ||
        (isNonEmptyString(sel.tipster_name) &&
          tipsterNames.has(sel.tipster_name.trim().toLowerCase()));
      if (linkable) linkableSelectionCount++;
    });

    // Soft warnings (do not block): things that simply reduce what's measurable.
    if (pricedCount === 0) {
      warnings.push(`${label}: no priced runners (odds_decimal) — race won't count.`);
    }
    if (winnerCount === 0) {
      warnings.push(`${label}: no winner (finish_pos=1) — race won't count.`);
    }
    if (winnerCount === 1 && !winnerHasBsp) {
      warnings.push(
        `${label}: winner has no bsp_decimal — ROI will fall back to quoted odds, not true BSP.`,
      );
    }
    if (selections.length > 0 && linkableSelectionCount === 0) {
      warnings.push(
        `${label}: ${selections.length} selection(s) but none are linkable to a supplied tipster prior — needle mode will match the control here.`,
      );
    }

    races.push({
      index: ri,
      label,
      runnerCount: runners.length,
      pricedCount,
      winnerHorse,
      winnerCount,
      winnerHasBsp,
      selectionCount: selections.length,
      linkableSelectionCount,
      wouldCount: pricedCount > 0 && winnerCount === 1,
    });
  });

  const countable = races.filter((r) => r.wouldCount).length;

  if (countable > 0 && tipsters.length === 0) {
    warnings.push(
      'No tipster priors supplied: needle mode will equal the control (no weights to apply).',
    );
  }

  return {
    errors,
    warnings,
    races,
    countable,
    tipsterCount: tipsters.length,
    hasPlaceholder,
  };
}
