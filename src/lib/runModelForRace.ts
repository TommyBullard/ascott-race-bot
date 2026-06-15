/**
 * Model writer: compute and persist a model run for a single race.
 *
 * This is the producer that powers the read side (`fetchRaceRecommendations`).
 * It runs the TypeScript engine (tipster-weighted probabilities -> EV ->
 * confidence -> fractional Kelly) and writes the results across the three
 * model tables:
 *   - `model_runs`           : one row per run (run metadata + snapshot anchor)
 *   - `model_runner_scores`  : per-runner probabilities / EV / rank
 *   - `recommendations`      : the single best bet for the run (one row; the
 *                              table is keyed by `model_run_id`)
 *
 * Idempotency ("the race has exactly one CURRENT run") is achieved append-only:
 * the NEW run and its children are inserted FIRST, stamped `is_current = true`;
 * then the race's OTHER current rows (run + children) are SUPERSEDED — marked
 * `is_current = false` with a `superseded_at` timestamp. Historical rows are
 * never deleted, so any past run stays queryable for audit.
 *
 * Ordering: insert-new-then-supersede-others. If an insert fails, the previous
 * current run remains intact (nothing was superseded yet). If superseding fails
 * after the inserts, the race transiently has more than one current run, but
 * readers pick the NEWEST current run (by `run_time`), so they still return the
 * new pick; the next run cleans up the stragglers. The new run and its children
 * are excluded from the supersede so they stay current.
 *
 * NOTE: supabase-js cannot wrap multiple statements in a single transaction, so
 * this is a best-effort sequence rather than atomic. For strict atomicity, move
 * this logic into a Postgres function invoked via `supabaseAdmin.rpc(...)`.
 */

import { supabaseAdmin } from './supabaseAdmin';
import {
  fetchLatestBankroll,
  fetchRaceModelInputs,
  fetchTipsterSelections,
  getTipsterStats,
  type RaceModelInputs,
  type RaceModelInputsDiagnostics,
  type TipsterPriorStats,
} from './raceData';
import {
  calculateEV,
  confidenceScore,
  kellyStake,
  labelConfidence,
} from './bettingEngine';
import {
  calculateModelProbabilities,
  type TipsterSelection,
  type TipsterStats,
} from './modelProbabilities';
import { buildModelRunMetadata } from './modelRunMetadata';
import {
  assessDataQuality,
  MIN_MARKET_COMPLETENESS,
  ODDS_REFRESH_INTERVAL_MS,
  STALE_ODDS_THRESHOLD_MS,
  MIN_RUNNER_COUNT,
} from './modelDataQuality';
import { computeAdjustedConfidence } from './modelConfidence';
import {
  buildSupersedePatch,
  currentMarker,
  selectRunIdsToSupersede,
} from './modelRunHistory';
import { logSkippedModelRun } from './modelRunAttempts';

const MODEL_RUNS_TABLE = 'model_runs';
const MODEL_RUNNER_SCORES_TABLE = 'model_runner_scores';
const RECOMMENDATIONS_TABLE = 'recommendations';

/**
 * Bankroll used for stake sizing when no `options.bankroll` is given and the
 * `bankroll_ledger` is empty (no balance to read).
 */
const DEFAULT_BANKROLL = 1000;

/** Fractional-Kelly multiplier the engine uses; recorded on the run. */
const DEFAULT_BASE_KELLY_FRACTION = 0.2;

/** Signal concentration parameter recorded on the run (engine does not use it). */
const DEFAULT_SIGNAL_KAPPA = 1;

/**
 * Allowed `model_runs.bet_mode` values (a NOT NULL Postgres ENUM):
 * - `strict_ev`            : only stake when the bet is positive-EV.
 * - `mandatory_every_race` : force a stake on every race (uses the floor).
 */
export type BetMode = 'strict_ev' | 'mandatory_every_race';

/**
 * Default `bet_mode`. `strict_ev` matches this writer's behavior: fractional
 * Kelly returns 0 for non-positive-EV runners, so only +EV runners become
 * recommendations. Use `mandatory_every_race` (via `options.betMode`) only once
 * a forced-floor staking path is implemented here.
 */
const DEFAULT_BET_MODE: BetMode = 'strict_ev';

export interface RunModelOptions {
  /**
   * Bankroll for stake sizing. When omitted, the latest
   * `bankroll_ledger.balance_after` (newest `entry_time`) is used, falling back
   * to 1000 (with a logged warning) when the ledger is empty.
   */
  bankroll?: number;
  /** `bet_mode` enum value (default 'strict_ev'). */
  betMode?: BetMode;
  /** `model_runs.model_version` tag (default 'market-v1'). */
  modelVersion?: string;
  /** `model_runs.base_kelly_fraction` (default 0.2). */
  baseKellyFraction?: number;
  /** `model_runs.signal_kappa` (default 1). */
  signalKappa?: number;
}

export interface RunModelResult {
  model_run_id: string;
  race_id: string;
  /** Number of runners scored (rows written to model_runner_scores). */
  scored: number;
  /** Number of recommended bets (rows written to recommendations). */
  recommended: number;
  /** Prior current runs superseded (marked not-current), never deleted. */
  supersededRuns: number;
}

export interface ScoredRunner {
  runner_id: string;
  market_prob: number;
  model_prob: number;
  edge: number;
  ev: number;
  confidence: number;
  stake: number;
  rank: number;
}

/**
 * Maps `tipster_priors`-shaped stats (from {@link getTipsterStats}) into the
 * engine's `TipsterStats` shape. Shared so the writer and the backtest harness
 * convert identically.
 */
export function tipsterStatsFromPriors(
  priors: TipsterPriorStats[],
): TipsterStats[] {
  return priors.map((p) => ({
    tipster_id: p.tipster_id,
    roi: p.roi_bsp_gross,
    ae: p.ae_bsp,
    strike_rate: p.strike_rate,
  }));
}

/**
 * Pure scoring core shared by {@link runModelForRace} (which persists the
 * result) and the backtest harness (which does not), so both evaluate a race
 * identically. Given a race's priced runners plus tipster data, it runs
 * probabilities -> EV -> confidence -> fractional-Kelly stake and returns every
 * runner scored and ranked by EV (descending; `rank` is 1-based).
 *
 * No I/O: callers fetch the inputs and decide what to do with the result.
 */
export function scoreRaceRunners(
  inputs: RaceModelInputs,
  tipsterSelections: TipsterSelection[],
  tipsterStats: TipsterStats[],
  bankroll: number,
): ScoredRunner[] {
  const probabilities = calculateModelProbabilities(
    inputs.runners.map((r) => ({ runner_id: r.runner_id, odds: r.odds_decimal })),
    tipsterSelections,
    tipsterStats,
  );
  const probByRunner = new Map(
    probabilities.map((p) => [String(p.runner_id), p.model_prob]),
  );

  const scored: ScoredRunner[] = inputs.runners.map((r) => {
    const model_prob = probByRunner.get(r.runner_id) ?? 0;
    const ev = calculateEV(model_prob, r.odds_decimal);
    const tipsterCount = new Set(
      tipsterSelections
        .filter((s) => String(s.runner_id) === r.runner_id)
        .map((s) => s.tipster_id),
    ).size;
    const confidence = confidenceScore({
      ev,
      modelProb: model_prob,
      marketProb: r.market_prob,
      tipsterCount,
    });
    const stake = kellyStake(model_prob, r.odds_decimal, bankroll, confidence);
    return {
      runner_id: r.runner_id,
      market_prob: r.market_prob,
      model_prob,
      edge: model_prob - r.market_prob,
      ev,
      confidence,
      stake,
      rank: 0,
    };
  });

  // Rank all runners by EV (descending) for rank_in_race.
  scored.sort((a, b) => b.ev - a.ev);
  scored.forEach((s, i) => {
    s.rank = i + 1;
  });
  return scored;
}

/**
 * Emits a diagnostic trace line only when `DEBUG_MODEL=1` in the environment;
 * silent (no-op) otherwise. Used to diagnose why a race produces no model run.
 */
function traceModel(message: string): void {
  if (process.env.DEBUG_MODEL === '1') {
    console.log(message);
  }
}

/**
 * Computes and stores a model run for `raceId`, returning a summary, or `null`
 * when the race has no priced runners / market snapshot to model.
 *
 * @throws if any insert/supersede update fails (notably a `bet_mode` enum
 *   mismatch). The new run is inserted before any supersede, so a failed insert
 *   leaves the previous current run intact; a failed supersede leaves extra
 *   current runs that readers tolerate (newest wins) and the next run cleans up.
 */
export async function runModelForRace(
  raceId: string,
  options: RunModelOptions = {},
): Promise<RunModelResult | null> {
  const betMode = options.betMode ?? DEFAULT_BET_MODE;
  const baseKellyFraction =
    options.baseKellyFraction ?? DEFAULT_BASE_KELLY_FRACTION;
  const signalKappa = options.signalKappa ?? DEFAULT_SIGNAL_KAPPA;

  // Bankroll: prefer an explicit option; otherwise read the latest balance from
  // bankroll_ledger, falling back to the default (with a warning) when empty.
  let bankroll: number;
  if (options.bankroll !== undefined) {
    bankroll = options.bankroll;
  } else {
    const ledgerBalance = await fetchLatestBankroll();
    if (ledgerBalance === null) {
      console.warn(
        `[runModelForRace] bankroll_ledger is empty; falling back to default bankroll ${DEFAULT_BANKROLL}.`,
      );
      bankroll = DEFAULT_BANKROLL;
    } else {
      bankroll = ledgerBalance;
    }
  }

  traceModel(`[trace] bankroll = ${bankroll}`);

  // 1. Fetch inputs. Runners+odds are required; tipster data is best-effort so
  //    the run still succeeds (unweighted) if those tables are empty/absent.
  //    `diagnostics` captures the precise skip reason for lightweight logging.
  const diagnostics: RaceModelInputsDiagnostics = { skipReason: null };
  const inputs = await fetchRaceModelInputs(raceId, diagnostics);
  traceModel(
    `[trace] fetchRaceModelInputs -> ${
      inputs === null
        ? 'NULL (no runners OR no snapshot)'
        : `snapshot_id=${inputs.snapshot_id}, priced runners=${inputs.runners.length}`
    }`,
  );
  if (!inputs || inputs.runners.length === 0) {
    // Log the skipped attempt (no model_runs row is written). When inputs is a
    // non-null object with an empty field, the reason is NO_PRICED_RUNNERS;
    // otherwise use the precise reason the fetch reported.
    const reason =
      diagnostics.skipReason ??
      (inputs ? 'NO_PRICED_RUNNERS' : 'NO_MARKET_SNAPSHOT');
    logSkippedModelRun(raceId, reason);
    traceModel(
      `[trace] GUARD HIT -> returning null (reason=${reason})`,
    );
    return null;
  }

  const [tipsterSelections, tipsterPriors] = await Promise.all([
    fetchTipsterSelections(raceId).catch(() => []),
    getTipsterStats().catch(() => []),
  ]);
  traceModel(
    `[trace] tipsterSelections=${tipsterSelections.length}, tipsterPriors=${tipsterPriors.length}`,
  );

  const tipsterStats = tipsterStatsFromPriors(tipsterPriors);

  // Audit/versioning metadata for this run. `input_mode` follows whether any
  // tipster selections were returned. The data-quality flags are the single-
  // source output of `assessDataQuality`, computed only from data we actually
  // have (never fabricated): the declared-vs-priced field, the latest snapshot's
  // age, and tipster-selection matching.
  //
  // NOTE: NO_MARKET_SNAPSHOT / NO_PRICED_RUNNERS cannot fire here — the guard
  // above already returned null when there is no snapshot or no priced runner,
  // so a run is only written when both exist. They remain implemented in the
  // pure helper for other/future callers.
  const pricedRunnerIds = inputs.runners.map((r) => r.runner_id);
  const snapshotAgeMs = (() => {
    if (!inputs.snapshot_time) return null;
    const t = Date.parse(inputs.snapshot_time);
    return Number.isNaN(t) ? null : Math.max(0, Date.now() - t);
  })();
  const dataQuality = assessDataQuality({
    declaredRunnerCount: inputs.declared_runner_count,
    pricedRunnerIds,
    hasMarketSnapshot: true,
    snapshotAgeMs,
    tipsterSelectionRunnerIds: tipsterSelections.map((s) => String(s.runner_id)),
  });
  traceModel(`[trace] data_quality_flags=${JSON.stringify(dataQuality.flags)}`);

  // 2. Score the field. Shared with the backtest harness (`scoreRaceRunners`)
  //    so both evaluate races identically: probabilities -> EV -> confidence ->
  //    fractional-Kelly stake, ranked by EV (descending) for rank_in_race.
  //    Computed before the metadata build so the run's headline confidence is
  //    available to the observational confidence-adjustment layer below;
  //    scoring is pure, so its result is identical regardless of position.
  const scored = scoreRaceRunners(
    inputs,
    tipsterSelections,
    tipsterStats,
    bankroll,
  );

  // Observational only (Batch F1): scale the rank-1 (highest-EV) runner's
  // confidence by data quality. Recorded for monitoring/future use; it does NOT
  // feed probabilities, selection, or staking (those are already computed in
  // `scored` above and are not modified here).
  const baseConfidence = scored.length > 0 ? scored[0].confidence : 0;
  const adjustedConfidence = computeAdjustedConfidence(
    baseConfidence,
    dataQuality.flags,
    dataQuality.metrics,
  );
  traceModel(
    `[trace] adjusted_confidence=${adjustedConfidence} (base=${baseConfidence})`,
  );

  const metadata = buildModelRunMetadata({
    hasUsableTipsterSelections: tipsterSelections.length > 0,
    dataQualityFlags: dataQuality.flags,
    adjustedConfidence,
    modelVersion: options.modelVersion,
    // Record the thresholds used to interpret the flags + the computed metrics
    // + the observational adjusted confidence, for audit/visibility. Stored in
    // config_json (no new DB columns).
    config: {
      data_quality_thresholds: {
        min_market_completeness: MIN_MARKET_COMPLETENESS,
        odds_refresh_interval_ms: ODDS_REFRESH_INTERVAL_MS,
        stale_odds_threshold_ms: STALE_ODDS_THRESHOLD_MS,
        min_runner_count: MIN_RUNNER_COUNT,
      },
      data_quality_metrics: dataQuality.metrics,
      data_quality_adjusted_confidence: adjustedConfidence,
    },
  });

  // 3a. Insert the new model run as the CURRENT run. Capture its generated id.
  const { data: runData, error: runError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .insert({
      race_id: raceId,
      run_time: new Date().toISOString(),
      market_snapshot_id: inputs.snapshot_id,
      model_version: metadata.model_version,
      probability_engine_version: metadata.probability_engine_version,
      staking_engine_version: metadata.staking_engine_version,
      input_mode: metadata.input_mode,
      config_json: metadata.config_json,
      data_quality_flags: metadata.data_quality_flags,
      bet_mode: betMode,
      base_kelly_fraction: baseKellyFraction,
      signal_kappa: signalKappa,
      ...currentMarker(),
    })
    .select('id')
    .single();

  if (runError) {
    throw new Error(
      `Failed to insert model run for race ${raceId}: ${runError.message}`,
    );
  }
  const modelRunId = String((runData as { id: string }).id);

  // 3b. Per-runner scores (all runners), stamped current. The richer columns the
  //     upstream model emits (support_raw, support_deherded, disagreement_bonus,
  //     p_ev_positive) are nullable and not produced by this engine, so they
  //     are left null.
  const scoreRows = scored.map((s) => ({
    model_run_id: modelRunId,
    runner_id: s.runner_id,
    market_prob: s.market_prob,
    model_prob: s.model_prob,
    edge: s.edge,
    ev_per_1: s.ev,
    confidence_score: s.confidence,
    rank_in_race: s.rank,
    ...currentMarker(),
  }));

  const { error: scoresError } = await supabaseAdmin
    .from(MODEL_RUNNER_SCORES_TABLE)
    .insert(scoreRows);
  if (scoresError) {
    throw new Error(
      `Failed to insert model runner scores for race ${raceId}: ${scoresError.message}`,
    );
  }

  // 3c. Recommendation: the `recommendations` table is keyed by `model_run_id`
  //     alone (one row per run), so persist only the SINGLE best bet — the
  //     highest-EV runner worth staking. `scored` is already sorted by EV
  //     descending, so the first staked runner is the top pick. The full
  //     per-runner detail remains in `model_runner_scores`.
  const topBet = scored.find((s) => s.stake > 0);
  const recommended = topBet ? 1 : 0;

  if (topBet) {
    const { error: recsError } = await supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .insert({
        model_run_id: modelRunId,
        race_id: raceId,
        runner_id: topBet.runner_id,
        recommendation_rank: 1,
        confidence_label: labelConfidence(topBet.confidence),
        // `stake_pct` is a PERCENTAGE of bankroll (e.g. 2.0 => 2%), matching the
        // schema's `_pct` naming convention (cf. `kelly_fraction_used`, a
        // fraction). stake_amount / bankroll * 100 yields that percentage.
        stake_pct: bankroll > 0 ? (topBet.stake / bankroll) * 100 : 0,
        stake_amount: topBet.stake,
        kelly_fraction_used: baseKellyFraction,
        mandatory_floor_applied: false,
        daily_cap_restricted: false,
        rationale_json: {
          ev: topBet.ev,
          model_prob: topBet.model_prob,
          market_prob: topBet.market_prob,
          edge: topBet.edge,
          confidence: topBet.confidence,
        },
        ...currentMarker(),
      });
    if (recsError) {
      throw new Error(
        `Failed to insert recommendation for race ${raceId}: ${recsError.message}`,
      );
    }
  }

  // 4. Supersede the race's OTHER current model output now that the new run is
  //    safely written (append-only history: rows are UPDATED, never deleted).
  //    Insert-first means a failed insert above left the previous current run
  //    intact; and if this supersede fails, readers still pick the newest
  //    current run by run_time. The just-inserted run is EXCLUDED, and children
  //    are filtered by the OLDER run ids only, so the new run + its children
  //    stay current. Best-effort (supabase-js cannot transact); see the header.
  const { data: currentRunData, error: currentRunsError } = await supabaseAdmin
    .from(MODEL_RUNS_TABLE)
    .select('id')
    .eq('race_id', raceId)
    .eq('is_current', true);

  if (currentRunsError) {
    throw new Error(
      `Failed to list current model runs for race ${raceId}: ${currentRunsError.message}`,
    );
  }

  // Exclude the just-inserted run so only OLDER current runs are superseded.
  const supersededRunIds = selectRunIdsToSupersede(
    ((currentRunData ?? []) as { id: string }[]).map((r) => String(r.id)),
    modelRunId,
  );

  if (supersededRunIds.length > 0) {
    const patch = buildSupersedePatch();

    // Children (recs, scores) filtered by the OLDER run ids only — never the new
    // run's children — then the older runs themselves. UPDATE, not DELETE, so
    // order is not FK-sensitive; the `is_current` guard avoids rewriting rows
    // already superseded by an earlier run.
    const { error: supRecsError } = await supabaseAdmin
      .from(RECOMMENDATIONS_TABLE)
      .update(patch)
      .in('model_run_id', supersededRunIds)
      .eq('is_current', true);
    if (supRecsError) {
      throw new Error(
        `Failed to supersede prior recommendations for race ${raceId}: ${supRecsError.message}`,
      );
    }

    const { error: supScoresError } = await supabaseAdmin
      .from(MODEL_RUNNER_SCORES_TABLE)
      .update(patch)
      .in('model_run_id', supersededRunIds)
      .eq('is_current', true);
    if (supScoresError) {
      throw new Error(
        `Failed to supersede prior model runner scores for race ${raceId}: ${supScoresError.message}`,
      );
    }

    const { error: supRunsError } = await supabaseAdmin
      .from(MODEL_RUNS_TABLE)
      .update(patch)
      .in('id', supersededRunIds);
    if (supRunsError) {
      throw new Error(
        `Failed to supersede prior model runs for race ${raceId}: ${supRunsError.message}`,
      );
    }
  }

  return {
    model_run_id: modelRunId,
    race_id: raceId,
    scored: scoreRows.length,
    recommended,
    supersededRuns: supersededRunIds.length,
  };
}
