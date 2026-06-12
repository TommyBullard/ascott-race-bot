/**
 * Pure aggregation math for the backtest harness.
 *
 * Buckets picks by odds band, computes strike rate / ROI / level-stakes P&L and
 * max drawdown, and summarizes one betting mode's results. No I/O, no DB — these
 * are unit-tested on synthetic rows so the comparison-table math is trustworthy
 * even when the database has no settled races to exercise it live.
 *
 * "Level stakes" means a flat 1-point bet on each pick: a win returns
 * `price - 1` points, a loss costs `1` point. ROI% = total P/L ÷ bets × 100.
 */

export type OddsBand = '<3.0' | '3.0-8.0' | '>8.0';
export const BANDS: OddsBand[] = ['<3.0', '3.0-8.0', '>8.0'];

/** Buckets a pick's decimal odds into a band. 3.0 and 8.0 fall in the middle. */
export function bandOf(odds: number): OddsBand {
  if (odds < 3.0) return '<3.0';
  if (odds <= 8.0) return '3.0-8.0';
  return '>8.0';
}

/** One settled, scored bet in a backtest run. */
export interface Evaluated {
  raceId: string;
  pickOdds: number;
  /** True when the pick was +EV (the bet `runModelForRace` would actually make). */
  pickPositiveEV: boolean;
  won: boolean;
  /** Level-stakes P/L in points: +(price-1) on a win, -1 on a loss. */
  profit: number;
  band: OddsBand;
}

/** Per-odds-band rollup. Rate fields are `null` when the band has no bets. */
export interface BandSummary {
  band: OddsBand;
  races: number;
  wins: number;
  strikeRatePct: number | null;
  profit: number;
  roiPct: number | null;
}

/** A full summary of one betting mode over a set of evaluated races. */
export interface ModeSummary {
  label: string;
  n: number;
  wins: number;
  strikeRatePct: number | null;
  profit: number;
  roiPct: number | null;
  /** How many picks were +EV (the subset the strict-EV writer would bet). */
  positiveEv: number;
  /** Max peak-to-trough drawdown of cumulative P/L, in points (>= 0). */
  maxDrawdown: number;
  bands: BandSummary[];
}

/**
 * Maximum peak-to-trough drawdown of the cumulative level-stakes P/L, walking
 * the bets in order. Returns a non-negative number of points (0 when the curve
 * never dips below a previous peak — e.g. monotonically rising, or a single bet).
 */
export function maxDrawdown(profits: number[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of profits) {
    cumulative += p;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Summarizes a mode's evaluated bets: overall strike rate / P&L / ROI / max
 * drawdown, the +EV subset size, and a per-odds-band breakdown. Pure: rates are
 * `null` (not NaN) where there are no bets, so callers render "—" honestly.
 */
export function summarize(label: string, evaluated: Evaluated[]): ModeSummary {
  const n = evaluated.length;
  const wins = evaluated.filter((e) => e.won).length;
  const profit = evaluated.reduce((sum, e) => sum + e.profit, 0);
  const positiveEv = evaluated.filter((e) => e.pickPositiveEV).length;

  const bands: BandSummary[] = BANDS.map((band) => {
    const inBand = evaluated.filter((e) => e.band === band);
    const bWins = inBand.filter((e) => e.won).length;
    const bProfit = inBand.reduce((sum, e) => sum + e.profit, 0);
    return {
      band,
      races: inBand.length,
      wins: bWins,
      strikeRatePct: inBand.length ? (bWins / inBand.length) * 100 : null,
      profit: bProfit,
      roiPct: inBand.length ? (bProfit / inBand.length) * 100 : null,
    };
  });

  return {
    label,
    n,
    wins,
    strikeRatePct: n ? (wins / n) * 100 : null,
    profit,
    roiPct: n ? (profit / n) * 100 : null,
    positiveEv,
    maxDrawdown: maxDrawdown(evaluated.map((e) => e.profit)),
    bands,
  };
}
