/**
 * Maps an already-fetched, read-only race card into the six-component
 * confidence diagnostic (`confidenceDiagnostics.ts`) — the same decomposition
 * `scripts/confidenceAudit.ts` computes offline, reused verbatim here so the
 * dashboard's "why this confidence?" panel can never drift from the audit.
 *
 * DISPLAY + EXPLANATION ONLY, mirroring `confidenceLadder.ts`'s hard
 * invariants: pure, deterministic, no I/O (no DB, no fs, no network), and it
 * NEVER touches staking, picks, probabilities, or the persisted confidence
 * label — it only explains signals the model already produced. A minimal
 * structural card-input type is used (not `RaceCard` from `raceData.ts`) so
 * this module stays importable client-side without pulling in the
 * server-only Supabase client, exactly like `confidenceLadder.ts`'s
 * `LadderCardInput`.
 *
 * Conservative by construction: any signal not present on the card (raw
 * data-quality flags, cross-run history) is left null/empty, so a missing
 * input can only ever withhold precision — never manufacture a better
 * component than the evidence supports.
 */

import { STALE_ODDS_THRESHOLD_MS } from './modelDataQuality';
import {
  buildRaceDiagnostic,
  detectSimilarEv,
  type ConfidenceInputs,
  type RaceConfidenceDiagnostic,
} from './confidenceDiagnostics';

function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** The minimal structural shape this module reads from a read-only race card. */
export interface ConfidenceCardInput {
  race_id: string;
  off_time?: string | null;
  race_name?: string | null;
  isHandicap?: boolean | null;
  latestOddsSnapshotTime?: string | null;
  modelPick?: {
    horse_name?: string | null;
    confidence_label: string | null;
    ev: number | null;
    model_prob: number | null;
    market_prob: number | null;
    odds: number | null;
  } | null;
  runners?: ReadonlyArray<{ ev: number | null }> | null;
  observability?: {
    runQuality?: string | null;
    tipsterModelAlignment?: Record<string, unknown> | null;
    marketCompleteness?: number | null;
  } | null;
}

/** Reads `alignment_label` from the observability alignment object. */
function alignmentLabel(card: ConfidenceCardInput): string | null {
  const a = card.observability?.tipsterModelAlignment;
  const label = a && typeof a === 'object' ? (a as Record<string, unknown>).alignment_label : null;
  return typeof label === 'string' && label.trim() !== '' ? label : null;
}

/**
 * Maps a card + the client's current time (for odds staleness) into the
 * diagnostic's `ConfidenceInputs`. Raw data-quality flags aren't currently
 * surfaced on the card, so `data_quality_flags` is `[]` — `deriveDataConfidence`
 * then falls back to `run_quality` alone (documented, conservative). Pure.
 */
export function buildConfidenceInputsFromCard(
  card: ConfidenceCardInput,
  nowMs: number,
): ConfidenceInputs {
  const pick = card.modelPick ?? null;
  const runners = card.runners ?? [];

  const separation =
    pick && isFiniteNum(pick.model_prob) && isFiniteNum(pick.market_prob)
      ? Math.abs(pick.model_prob - pick.market_prob)
      : null;

  const snapMs = card.latestOddsSnapshotTime ? Date.parse(card.latestOddsSnapshotTime) : NaN;
  const oddsStale = Number.isFinite(snapMs) ? nowMs - snapMs > STALE_ODDS_THRESHOLD_MS : true;

  return {
    run_quality: card.observability?.runQuality ?? null,
    data_quality_flags: [],
    tipster_alignment_label: alignmentLabel(card),
    market_completeness: card.observability?.marketCompleteness ?? null,
    field_size: runners.length > 0 ? runners.length : null,
    similar_ev: runners.length > 0 ? detectSimilarEv(runners.map((r) => r.ev)) : null,
    model_market_separation: separation,
    pick_odds: pick?.odds ?? null,
    odds_stale: pick ? oddsStale : null,
    is_handicap: card.isHandicap ?? null,
    has_reviewed_context: false,
  };
}

/**
 * Convenience: card + now -> the full per-race diagnostic, or `null` when
 * there is no pick to explain. Pure; reuses `buildRaceDiagnostic` verbatim so
 * the weakest-link `overall` + component reasons match the offline audit
 * exactly. Display-only; never a betting instruction.
 */
export function cardConfidenceDiagnostic(
  card: ConfidenceCardInput,
  nowMs: number,
): RaceConfidenceDiagnostic | null {
  const pick = card.modelPick;
  if (!pick) return null;
  return buildRaceDiagnostic({
    race_id: card.race_id,
    off_time: card.off_time ?? null,
    race_name: card.race_name ?? null,
    model_pick_name: pick.horse_name ?? null,
    original_confidence_label: pick.confidence_label,
    inputs: buildConfidenceInputsFromCard(card, nowMs),
  });
}
