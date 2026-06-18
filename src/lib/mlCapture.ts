/**
 * ML learning pipeline — automatic training-example capture (Phase 6, shadow).
 *
 * For a meeting day, reads each SETTLED race's already-computed card (the same
 * pre-off model output the dashboard showed) plus its settle prices, builds a
 * leakage-segregated {@link TrainingExample} per runner, and UPSERTS it into
 * `ml_training_examples`. Run after settlement (the results cron) so the training
 * dataset grows itself, race by race.
 *
 * STRICTLY SHADOW / DECISION-SUPPORT:
 *   - It only READS production output + settle prices and WRITES the shadow
 *     capture table. It never changes probability, EV, staking, ranking, or any
 *     recommendation, and the production model never reads this table.
 *   - IDEMPOTENT: upsert on (race_id, runner_id) — re-running refreshes rows
 *     rather than duplicating, so the 5-min results cron can call it safely.
 *   - NEVER FABRICATES: only settled races are captured; missing values stay null.
 */

import { supabaseAdmin } from './supabaseAdmin';
import { fetchRaceIdsForMeeting, fetchRaceCard, type RaceCard } from './raceData';
import { deriveWon, derivePlaced } from './trainingExport';
import { buildTrainingExample, type TrainingExample } from './mlTrainingExample';

const ML_TRAINING_EXAMPLES_TABLE = 'ml_training_examples';

/** Summary of one capture pass. */
export interface CaptureSummary {
  meetingDate: string;
  racesConsidered: number;
  /** Already-captured races skipped by the watermark (0 when force). */
  racesSkipped: number;
  racesCaptured: number;
  examplesWritten: number;
}

/** Reads settle prices (BSP/SP) for a race's runners. SELECT-only. */
async function fetchSettlePrices(raceId: string): Promise<Map<string, { bsp: number | null; sp: number | null }>> {
  const { data, error } = await supabaseAdmin
    .from('runners')
    .select('id, bsp_decimal, sp_decimal')
    .eq('race_id', raceId);
  if (error) throw new Error(`settle-price lookup failed for ${raceId}: ${error.message}`);
  const map = new Map<string, { bsp: number | null; sp: number | null }>();
  for (const r of (data ?? []) as { id: string; bsp_decimal: number | string | null; sp_decimal: number | string | null }[]) {
    const num = (v: number | string | null): number | null => {
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    };
    map.set(String(r.id), { bsp: num(r.bsp_decimal), sp: num(r.sp_decimal) });
  }
  return map;
}

/** Builds the per-runner training examples for one settled race card. Pure-ish. */
export function buildExamplesForCard(
  card: RaceCard,
  prices: Map<string, { bsp: number | null; sp: number | null }>,
): TrainingExample[] {
  const recommendedId = card.modelPick?.runner_id ?? null;
  const favouriteId = card.favourite?.runner_id ?? null;

  // The race's favourite outcome, stamped on every row for easy querying.
  const favRunner = favouriteId ? card.runners.find((r) => r.runner_id === favouriteId) ?? null : null;
  const favouriteWon = favRunner ? deriveWon(favRunner.finish_pos) : null;
  const favouritePlaced = favRunner ? derivePlaced(favRunner.finish_pos) : null;

  return card.runners.map((r) => {
    const price = prices.get(r.runner_id) ?? { bsp: null, sp: null };
    const recommended = recommendedId !== null && r.runner_id === recommendedId;
    return buildTrainingExample({
      raceId: card.race_id,
      runnerId: r.runner_id,
      meetingDate: card.off_time ? card.off_time.slice(0, 10) : null,
      course: card.course,
      offTime: card.off_time,
      fieldSize: card.runners.length,
      recommended,
      recommendationRank: recommended ? 1 : null,
      modelProb: r.model_prob,
      marketProb: r.market_prob,
      edge: r.edge,
      ev: r.ev,
      odds: r.odds,
      confidenceScore: r.confidence_score,
      confidenceLabel: recommended ? card.modelPick?.confidence_label ?? null : null,
      isFavourite: favouriteId !== null && r.runner_id === favouriteId,
      finishPos: r.finish_pos,
      favouriteWon,
      favouritePlaced,
      bsp: price.bsp,
      sp: price.sp,
    });
  });
}

/**
 * PURE watermark selection: which race ids still need capturing. Skips ids that
 * are already captured, UNLESS `force` (re-capture corrected results). Pure;
 * preserves input order. This is the unit the capture cron and tests both lock.
 */
export function selectUncapturedRaceIds(
  allRaceIds: readonly string[],
  capturedRaceIds: ReadonlySet<string>,
  force = false,
): string[] {
  return force ? [...allRaceIds] : allRaceIds.filter((id) => !capturedRaceIds.has(id));
}

/** Reads the set of race ids already captured for a meeting (the watermark). */
async function fetchCapturedRaceIds(meetingDate: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from(ML_TRAINING_EXAMPLES_TABLE)
    .select('race_id')
    .eq('meeting_date', meetingDate);
  if (error) throw new Error(`captured-watermark lookup failed for ${meetingDate}: ${error.message}`);
  return new Set(((data ?? []) as { race_id: string }[]).map((r) => String(r.race_id)));
}

/** Injected I/O for capture (real defaults; fakes in tests). */
export interface CaptureDeps {
  fetchRaceIds: (meetingDate: string) => Promise<string[]>;
  fetchCapturedRaceIds: (meetingDate: string) => Promise<Set<string>>;
  fetchCard: (raceId: string) => Promise<RaceCard>;
  fetchPrices: (raceId: string) => Promise<Map<string, { bsp: number | null; sp: number | null }>>;
  upsertExamples: (rows: TrainingExample[]) => Promise<void>;
}

/** The real, Supabase-backed capture deps. */
export function defaultCaptureDeps(): CaptureDeps {
  return {
    fetchRaceIds: fetchRaceIdsForMeeting,
    fetchCapturedRaceIds,
    fetchCard: fetchRaceCard,
    fetchPrices: fetchSettlePrices,
    upsertExamples: async (rows) => {
      const { error } = await supabaseAdmin
        .from(ML_TRAINING_EXAMPLES_TABLE)
        .upsert(rows, { onConflict: 'race_id,runner_id' });
      if (error) throw new Error(error.message);
    },
  };
}

/** Options for {@link captureTrainingExamples}. */
export interface CaptureOptions {
  /** Re-capture races already captured (for CORRECTED results). Default false. */
  force?: boolean;
}

/**
 * Captures training examples for every SETTLED, NOT-YET-CAPTURED race in a meeting
 * (the watermark skips already-captured races; `force` re-captures corrected
 * results). Idempotent (upsert on race+runner). Per-race failures are isolated and
 * logged so one bad race never sinks the batch.
 *
 * It reads ONLY DB state (never the results API), so it is fully DECOUPLED from
 * settlement: it captures whatever is settled by ANY means (results cron, the
 * Free-endpoint fallback, or a manual CSV import), and a results-API outage can
 * never starve or poison it. Returns the capture summary.
 *
 * @throws only if the initial races / watermark lookup fails.
 */
export async function captureTrainingExamples(
  meetingDate: string,
  options: CaptureOptions = {},
  deps: CaptureDeps = defaultCaptureDeps(),
): Promise<CaptureSummary> {
  const force = options.force === true;
  const allRaceIds = await deps.fetchRaceIds(meetingDate);
  const captured = force ? new Set<string>() : await deps.fetchCapturedRaceIds(meetingDate);
  const todo = selectUncapturedRaceIds(allRaceIds, captured, force);

  const summary: CaptureSummary = {
    meetingDate,
    racesConsidered: allRaceIds.length,
    racesSkipped: allRaceIds.length - todo.length,
    racesCaptured: 0,
    examplesWritten: 0,
  };

  for (const raceId of todo) {
    try {
      const card = await deps.fetchCard(raceId);
      // Capture only settled races with a model run (else nothing to learn from).
      if ((card.status ?? '') !== 'result' || !card.hasModelRun) continue;

      const prices = await deps.fetchPrices(raceId);
      const examples = buildExamplesForCard(card, prices);
      if (examples.length === 0) continue;

      await deps.upsertExamples(examples);
      summary.racesCaptured++;
      summary.examplesWritten += examples.length;
    } catch (err) {
      console.warn(
        `[captureTrainingExamples] race ${raceId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return summary;
}
