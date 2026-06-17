/**
 * Pure, display-only "Race Intelligence" derivations for the race-day dashboard.
 *
 * DECISION-SUPPORT / SHADOW LAYER ONLY. Nothing here changes probability, EV,
 * staking, ranking, the recommendation, or any persisted value — it only reads
 * already-stored per-runner fields (model_prob, ev, odds, rank, finish_pos) and
 * labels a few comparison candidates for the operator to eyeball at the course:
 *
 *   - Most likely winner      : highest model win probability (else market favourite)
 *   - Win-value candidate      : highest positive expected value
 *   - Each-way / place-value    : a SHADOW heuristic (not the favourite, mid-priced,
 *                                 top-5 model rank, positive EV) — never a bet
 *                                 instruction and never implies place terms/payout
 *
 * There is NO I/O here: no DB, no network, no writes, no model maths. Every
 * function is deterministic given its inputs, so the whole module is unit-testable
 * without a database. Missing data yields `null` candidates the UI renders as
 * "—" / "unknown" / "Not enough data". This is not betting advice.
 */

/** Em dash used for unknown / not-applicable labels. */
const DASH = '\u2014';

/** Lower bound (decimal odds) of the each-way "place value" band (~3/1). */
export const EACH_WAY_MIN_ODDS = 4.0;
/** Upper bound (decimal odds) of the each-way "place value" band (~20/1). */
export const EACH_WAY_MAX_ODDS = 21.0;
/** Lowest EV rank considered for the each-way shadow pick (excludes the rank-1 win pick). */
export const EACH_WAY_MIN_RANK = 2;
/** Highest EV rank considered for the each-way shadow pick (top-5 preferences). */
export const EACH_WAY_MAX_RANK = 5;
/** Field size at/above which the race is flagged as larger / more volatile. */
export const LARGE_FIELD_THRESHOLD = 8;

/** Warning surfaced when no model probabilities exist and the favourite is used. */
export const MODEL_PROB_UNAVAILABLE_WARNING =
  'Model win probabilities unavailable — most likely winner falls back to the market favourite.';
/** Warning surfaced when no positive-EV runner exists. */
export const NO_WIN_VALUE_WARNING =
  'No positive expected-value candidate in this race.';
/** Message surfaced when the each-way shadow heuristic finds nothing. */
export const NO_EACH_WAY_WARNING =
  'Not enough data for an each-way / place-value candidate.';
/** Static disclaimer the panel always shows for the each-way shadow candidate. */
export const EACH_WAY_DISCLAIMER =
  'Each-way / place-value candidate is a display-only interpretation; place terms are unknown and this is not betting advice.';

/** Basis for how the "most likely winner" was chosen. */
export type MostLikelyBasis = 'model_prob' | 'market_favourite';

/** Minimal read-only per-runner shape the derivations consume. */
export interface RaceIntelRunner {
  runner_id: string;
  horse_name: string;
  odds: number | null;
  market_prob?: number | null;
  model_prob: number | null;
  ev: number | null;
  confidence_score?: number | null;
  rank: number | null;
  /** Recorded finishing position once the race is settled, else null. */
  finish_pos?: number | null;
}

/** Inputs for {@link buildRaceIntelligence}. All read-only. */
export interface RaceIntelInput {
  /** The full scored field (read-only) for this race; may be empty. */
  runners: RaceIntelRunner[];
  /** The market favourite (shortest odds), or null when unpriced. */
  favourite: RaceIntelRunner | null;
  /** The EXISTING recommendation's runner id (unchanged by this layer), or null. */
  modelPickRunnerId: string | null;
  /** True once the race is resulted, so finishing positions may be shown. */
  settled: boolean;
}

/** A labelled display candidate. */
export interface IntelCandidate {
  runner_id: string;
  horse_name: string;
  odds: number | null;
  /** Finishing position when settled + known, else null (rendered "—"). */
  finish_pos: number | null;
  /** Human-readable basis for why this runner was chosen. */
  basis: string;
  /** True when this candidate is the same runner as the model pick. */
  isModelPick: boolean;
}

/** The full display-only intelligence read-model for one race. */
export interface RaceIntelligence {
  mostLikelyWinner: IntelCandidate | null;
  winValueCandidate: IntelCandidate | null;
  eachWayCandidate: IntelCandidate | null;
  marketFavourite: IntelCandidate | null;
  warnings: string[];
}

/** Finite-number type guard (rejects null/undefined/NaN/Infinity). */
function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Deterministic argmax over `runners` by `value`: higher value wins; ties are
 * broken by lower EV rank, then lexicographically smaller runner_id, so the
 * result never depends on input order. Runners whose value is null/non-finite
 * are skipped. Returns null when nothing qualifies. Pure.
 */
function selectBest(
  runners: RaceIntelRunner[],
  value: (r: RaceIntelRunner) => number | null | undefined,
): RaceIntelRunner | null {
  let best: RaceIntelRunner | null = null;
  let bestVal = Number.NEGATIVE_INFINITY;
  for (const r of runners) {
    const v = value(r);
    if (!isFiniteNum(v)) continue;
    if (v > bestVal || (v === bestVal && best !== null && tieBreakLess(r, best))) {
      best = r;
      bestVal = v;
    }
  }
  return best;
}

/** True when `a` should outrank `b` on a value tie (lower rank, then id). */
function tieBreakLess(a: RaceIntelRunner, b: RaceIntelRunner): boolean {
  const ra = isFiniteNum(a.rank) ? a.rank : Number.POSITIVE_INFINITY;
  const rb = isFiniteNum(b.rank) ? b.rank : Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb;
  return String(a.runner_id) < String(b.runner_id);
}

/**
 * Most likely winner = the runner with the highest finite `model_prob`. When no
 * runner has a model probability, falls back to the market `favourite` (basis
 * `market_favourite`). Returns null when neither is available. Pure.
 */
export function deriveMostLikelyWinner(
  runners: RaceIntelRunner[],
  favourite: RaceIntelRunner | null,
): { runner: RaceIntelRunner; basis: MostLikelyBasis } | null {
  const byProb = selectBest(runners, (r) => r.model_prob);
  if (byProb) return { runner: byProb, basis: 'model_prob' };
  if (favourite) return { runner: favourite, basis: 'market_favourite' };
  return null;
}

/**
 * Win-value candidate = the runner with the highest finite, strictly positive
 * `ev`. Returns null when no runner has positive EV. Pure.
 */
export function deriveWinValueCandidate(
  runners: RaceIntelRunner[],
): RaceIntelRunner | null {
  return selectBest(
    runners.filter((r) => isFiniteNum(r.ev) && r.ev > 0),
    (r) => r.ev,
  );
}

/**
 * Each-way / place-value SHADOW candidate (display-only). Pool = runners that
 * are NOT the favourite, sit in the top-5 EV ranks but below the rank-1 win pick
 * ([{@link EACH_WAY_MIN_RANK}, {@link EACH_WAY_MAX_RANK}]), have strictly positive
 * EV, and are mid-priced ([{@link EACH_WAY_MIN_ODDS}, {@link EACH_WAY_MAX_ODDS}]).
 * The best of the pool by EV is returned (ties by rank, then id). Returns null
 * when nothing qualifies. This NEVER implies place terms or a payout. Pure.
 */
export function deriveEachWayCandidate(
  runners: RaceIntelRunner[],
  favouriteId: string | null,
): RaceIntelRunner | null {
  const pool = runners.filter((r) => {
    if (favouriteId !== null && String(r.runner_id) === String(favouriteId)) {
      return false;
    }
    if (!isFiniteNum(r.rank) || r.rank < EACH_WAY_MIN_RANK || r.rank > EACH_WAY_MAX_RANK) {
      return false;
    }
    if (!isFiniteNum(r.ev) || r.ev <= 0) return false;
    if (!isFiniteNum(r.odds) || r.odds < EACH_WAY_MIN_ODDS || r.odds > EACH_WAY_MAX_ODDS) {
      return false;
    }
    return true;
  });
  return selectBest(pool, (r) => r.ev);
}

/**
 * Formats a finishing position as an ordinal ("1st", "2nd", "3rd", "11th"...),
 * or `DASH` for missing / non-positive values. Pure.
 */
export function formatFinishPosition(pos: number | null | undefined): string {
  if (!isFiniteNum(pos)) return DASH;
  const n = Math.trunc(pos);
  if (n <= 0) return DASH;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Wraps a chosen runner into a display candidate (null-safe). */
function toCandidate(
  runner: RaceIntelRunner | null,
  basis: string,
  modelPickRunnerId: string | null,
  settled: boolean,
): IntelCandidate | null {
  if (!runner) return null;
  return {
    runner_id: String(runner.runner_id),
    horse_name: runner.horse_name,
    odds: isFiniteNum(runner.odds) ? runner.odds : null,
    finish_pos:
      settled && isFiniteNum(runner.finish_pos) ? runner.finish_pos : null,
    basis,
    isModelPick:
      modelPickRunnerId !== null &&
      String(runner.runner_id) === String(modelPickRunnerId),
  };
}

/**
 * Assembles the full display-only {@link RaceIntelligence} read-model: the most
 * likely winner, win-value candidate, each-way shadow candidate and market
 * favourite, plus deterministic data warnings. Does NOT change or re-rank the
 * model pick (the caller passes its runner id only for the "= / differs from
 * model pick" comparison flag). Pure & deterministic.
 */
export function buildRaceIntelligence(input: RaceIntelInput): RaceIntelligence {
  const { runners, favourite, modelPickRunnerId, settled } = input;
  const warnings: string[] = [];

  const ml = deriveMostLikelyWinner(runners, favourite);
  if (ml && ml.basis === 'market_favourite') {
    warnings.push(MODEL_PROB_UNAVAILABLE_WARNING);
  }
  const mostLikelyWinner = ml
    ? toCandidate(
        ml.runner,
        ml.basis === 'model_prob'
          ? 'Highest model win probability'
          : 'Market favourite (model probability unavailable)',
        modelPickRunnerId,
        settled,
      )
    : null;

  const wv = deriveWinValueCandidate(runners);
  if (!wv) warnings.push(NO_WIN_VALUE_WARNING);
  const winValueCandidate = toCandidate(
    wv,
    'Highest positive expected value',
    modelPickRunnerId,
    settled,
  );

  const ew = deriveEachWayCandidate(runners, favourite?.runner_id ?? null);
  if (!ew) warnings.push(NO_EACH_WAY_WARNING);
  const eachWayCandidate = toCandidate(
    ew,
    'Not the favourite · top-5 model rank · positive EV · mid-priced',
    modelPickRunnerId,
    settled,
  );

  const marketFavourite = toCandidate(
    favourite,
    'Shortest market odds',
    modelPickRunnerId,
    settled,
  );

  if (runners.length >= LARGE_FIELD_THRESHOLD) {
    warnings.push(`Larger field (${runners.length} runners) — more volatile.`);
  }

  return {
    mostLikelyWinner,
    winValueCandidate,
    eachWayCandidate,
    marketFavourite,
    warnings,
  };
}
