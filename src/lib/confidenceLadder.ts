/**
 * Evidence-based confidence LADDER — DISPLAY + EXPLANATION ONLY.
 *
 * The dashboard's recommendation confidence is, by default, a band applied to
 * the numeric confidence score that ALSO drives fractional-Kelly staking. That
 * numeric score is intentionally conservative and is left untouched here. This
 * module derives a SEPARATE, evidence-based label (LOW / MEDIUM / HIGH) plus a
 * human-readable reason from already-computed signals, so a recommendation can
 * be shown as MEDIUM/HIGH only when several genuine signals agree — never to
 * manufacture confidence.
 *
 * HARD INVARIANTS (enforced by construction + tests):
 *   - PURE + DETERMINISTIC. Same signals in → same label/reason out. No I/O.
 *   - NEVER TOUCHES STAKING OR PICKS. It imports no betting engine, changes no
 *     probability, EV, stake, ranking, recommendation, or persisted confidence.
 *     It is consumed only by the read-only dashboard for display.
 *   - NO FAKE CONFIDENCE. HIGH requires multiple positive signals; stale odds,
 *     invalid/critical data, missing material odds, weak EV, or stake
 *     suppression cannot be HIGH (and usually force LOW).
 *   - TIPSTER ABSENCE REDUCES, NEVER ALONE FORCES LOW. Missing consensus is a
 *     downgrade; it only forces LOW together with a volatile field.
 *   - GENAI IS NOT AN INPUT. Reviewed GenAI commentary may explain evidence on
 *     the dashboard, but it can never raise this label.
 */

import { STALE_ODDS_THRESHOLD_MS } from './modelDataQuality';

export type LadderLabel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Tunable thresholds (documented; not fit to any single day). */
export const LADDER_TUNING = {
  /** EV at/above which the edge counts as "positive" (MEDIUM gate). */
  evPositive: 0.01,
  /** EV at/above which the edge counts as "meaningfully positive" (HIGH gate). */
  evStrong: 0.05,
  /** model_prob − market_prob that counts as a "large" model edge. */
  largeEdge: 0.05,
  /** Field size at/above which a field is treated as large/volatile. */
  largeField: 16,
  /** Market completeness that counts as "near-complete" runner odds. */
  completenessNear: 0.8,
  /** Market completeness that counts as "complete" runner odds. */
  completenessFull: 0.95,
  /** Consecutive recent runs with the same pick that count as "stable". */
  stabilityMinRuns: 2,
} as const;

/** Cross-run stability evidence (optional; null when no history is available). */
export interface StabilitySignal {
  /** Consecutive recent pre-off runs whose top pick equals the current pick. */
  samePickRuns: number;
  /** EV stayed positive across those runs. */
  evStayedPositive: boolean;
  /** The pick's odds stayed reasonably stable across those runs. */
  oddsStable: boolean;
  /** Data quality did not degrade across those runs. */
  qualityHeldUp: boolean;
}

/** The already-computed signals the ladder reasons over. Missing → null. */
export interface LadderSignals {
  /** EV per unit for the model pick. */
  ev: number | null;
  modelProb: number | null;
  marketProb: number | null;
  /** The model pick is also the market favourite (shortest price). */
  modelIsFavourite: boolean;
  /** The model pick also has the highest model probability in the field. */
  modelIsMostLikely: boolean;
  /** Run-quality verdict: OK / DEGRADED / STALE / INVALID (or null). */
  runQuality: string | null;
  /** The latest odds snapshot is stale (older than the freshness threshold). */
  oddsStale: boolean;
  /** Market completeness (priced/declared, 0..1) when known, else null. */
  marketCompleteness: number | null;
  /** Explicit critical data-quality flags, when known. */
  criticalDataFlags: readonly string[];
  /** A material amount of runner odds is missing. */
  missingRunnerOdds: boolean;
  /** Declared field size, when known. */
  fieldSize: number | null;
  /** Stake suppression was applied (a safety gate fired). */
  suppressed: boolean;
  /** Tipster/model alignment label (e.g. ALIGNED / DIVERGENT / NO_TIPSTER_CONSENSUS). */
  tipsterAlignmentLabel: string | null;
  /** Cross-run stability, when history is available; else null. */
  stability: StabilitySignal | null;
}

/** The ladder verdict for display. */
export interface ConfidenceLadderResult {
  label: LadderLabel;
  /** Human-readable "<LABEL> because …" explanation for the dashboard. */
  reason: string;
  /** The positive signals that were present. */
  positives: string[];
  /** Caps that prevent HIGH (e.g. stale odds, critical data). */
  caps: string[];
  /** Signals that reduce (but do not alone force LOW) confidence. */
  downgrades: string[];
}

function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function joinTop(items: readonly string[], n: number): string {
  return items.slice(0, n).join(' + ');
}

/**
 * Derives the evidence-based confidence label + reason. Pure; deterministic.
 *
 * GenAI is deliberately absent from {@link LadderSignals}: this function cannot
 * be influenced by generated commentary.
 */
export function evaluateConfidenceLadder(s: LadderSignals): ConfidenceLadderResult {
  const positives: string[] = [];
  const downgrades: string[] = [];
  const caps: string[] = [];

  const ev = isFiniteNum(s.ev) ? s.ev : null;
  const evPositive = ev != null && ev >= LADDER_TUNING.evPositive;
  const evStrong = ev != null && ev >= LADDER_TUNING.evStrong;

  const edge = isFiniteNum(s.modelProb) && isFiniteNum(s.marketProb) ? s.modelProb - s.marketProb : null;
  const largeEdge = edge != null && edge >= LADDER_TUNING.largeEdge;
  const agreement = s.modelIsFavourite || largeEdge;

  const q = (s.runQuality ?? '').toUpperCase();
  const dataInvalid = q === 'INVALID' || q === 'STALE';
  const dataDegraded = q === 'DEGRADED';
  const dataOK = q === 'OK';
  const hasCritical = (s.criticalDataFlags ?? []).length > 0;

  const completeness = isFiniteNum(s.marketCompleteness) ? s.marketCompleteness : null;
  const missingOdds =
    s.missingRunnerOdds || (completeness != null && completeness < LADDER_TUNING.completenessNear);
  // When completeness is unknown, only an OK run-quality verdict implies coverage.
  const coverageFull = completeness == null ? dataOK : completeness >= LADDER_TUNING.completenessFull;
  const coverageNear = completeness == null ? dataOK : completeness >= LADDER_TUNING.completenessNear;

  const fieldVolatile = isFiniteNum(s.fieldSize) && s.fieldSize >= LADDER_TUNING.largeField;
  const tip = (s.tipsterAlignmentLabel ?? '').toUpperCase();
  const tipsterAligned = /ALIGN|CONFIRM|SUPPORT/.test(tip);
  const tipsterDivergent = /DIVERG|CONTRA|OPPOS/.test(tip);
  const noTipsterConsensus = tip === '' || tip === 'NO_TIPSTER_CONSENSUS' || tip === 'NO_RECOMMENDATION';
  const suppressed = s.suppressed === true;
  const pickUnsupported = !s.modelIsMostLikely && !s.modelIsFavourite && !largeEdge;
  const st = s.stability;
  const stable =
    st != null &&
    st.samePickRuns >= LADDER_TUNING.stabilityMinRuns &&
    st.evStayedPositive &&
    st.oddsStable &&
    st.qualityHeldUp;

  // --- Hard caps (cannot be HIGH) ----------------------------------------
  if (s.oddsStale) caps.push('stale odds');
  if (dataInvalid) caps.push(`data quality ${q || 'unknown'}`);
  if (hasCritical) caps.push(`critical data flag(s): ${s.criticalDataFlags.join(', ')}`);
  if (missingOdds) caps.push('missing/incomplete runner odds');
  if (suppressed) caps.push('stake suppression applied');

  // --- Positive signals --------------------------------------------------
  if (!s.oddsStale) positives.push('fresh odds');
  if (dataOK && !hasCritical) positives.push('clean data');
  if (coverageFull) positives.push('complete runner odds');
  else if (coverageNear && !missingOdds) positives.push('near-complete runner odds');
  if (evPositive) positives.push(evStrong ? 'strong positive EV' : 'positive EV');
  if (s.modelIsFavourite) positives.push('model agrees with market favourite');
  else if (largeEdge) positives.push('large model edge over market');
  if (s.modelIsMostLikely) positives.push('model pick is most likely winner');
  if (isFiniteNum(s.fieldSize) && !fieldVolatile) positives.push('field not volatile');
  if (!suppressed) positives.push('no stake suppression');
  if (tipsterAligned) positives.push('tipster support aligned');
  if (stable) positives.push('pick stable across recent runs');

  // --- Downgrades (reduce, do not alone force LOW) -----------------------
  if (pickUnsupported) downgrades.push('pick disagrees with the favourite and is not the most likely winner');
  if (noTipsterConsensus) downgrades.push('no tipster consensus');
  if (tipsterDivergent) downgrades.push('tipsters diverge from the model');
  if (dataDegraded) downgrades.push('mildly degraded data');
  if (fieldVolatile) downgrades.push('large/volatile field');
  if (!evPositive) downgrades.push('weak EV edge');

  // --- LOW conditions (force LOW) ----------------------------------------
  const forceLow =
    s.oddsStale ||
    dataInvalid ||
    hasCritical ||
    missingOdds ||
    suppressed ||
    !evPositive ||
    (noTipsterConsensus && fieldVolatile) ||
    pickUnsupported;

  let label: LadderLabel;
  if (forceLow) {
    label = 'LOW';
  } else {
    const canHigh =
      !s.oddsStale &&
      dataOK &&
      !hasCritical &&
      coverageNear &&
      s.modelIsMostLikely &&
      agreement &&
      evStrong &&
      !fieldVolatile &&
      !suppressed &&
      (tipsterAligned || positives.length >= 6); // aligned OR sufficient alternative support
    label = canHigh ? 'HIGH' : 'MEDIUM';
  }

  // Caps can never coexist with HIGH (defence in depth).
  if (label === 'HIGH' && caps.length > 0) label = 'MEDIUM';

  const reason = buildReason(label, positives, downgrades, caps);
  return { label, reason, positives, caps, downgrades };
}

/** Builds the "<LABEL> because …" reason string. Pure. */
function buildReason(
  label: LadderLabel,
  positives: readonly string[],
  downgrades: readonly string[],
  caps: readonly string[],
): string {
  if (label === 'HIGH') {
    return `HIGH because ${joinTop(positives, 4) || 'multiple positive signals'}`;
  }
  if (label === 'MEDIUM') {
    const because = positives.length > 0 ? joinTop(positives, 3) : 'some supporting evidence';
    const limits = [...caps, ...downgrades];
    return limits.length > 0
      ? `MEDIUM because ${because}; held back by ${joinTop(limits, 2)}`
      : `MEDIUM because ${because}`;
  }
  const why = [...caps, ...downgrades];
  return why.length > 0
    ? `LOW because ${joinTop(why, 3)}`
    : 'LOW because insufficient supporting evidence';
}

/* -------------------------------------------------------------------------- */
/* Mapping a read-only race card → ladder signals (display)                   */
/* -------------------------------------------------------------------------- */

/** The minimal structural shape the dashboard mapping reads from a RaceCard. */
export interface LadderCardInput {
  modelPick?: {
    ev: number | null;
    model_prob: number | null;
    market_prob: number | null;
    isFavourite: boolean;
  } | null;
  runners?: ReadonlyArray<{ model_prob: number | null }> | null;
  observability?: {
    runQuality?: string | null;
    tipsterModelAlignment?: Record<string, unknown> | null;
  } | null;
  latestOddsSnapshotTime?: string | null;
}

/** Reads `alignment_label` from the observability alignment object. */
function alignmentLabel(card: LadderCardInput): string | null {
  const a = card.observability?.tipsterModelAlignment;
  const label = a && typeof a === 'object' ? (a as Record<string, unknown>).alignment_label : null;
  return typeof label === 'string' && label.trim() !== '' ? label : null;
}

/**
 * Maps a read-only race card (+ the client's current time, for odds staleness)
 * into {@link LadderSignals}. Conservative: signals not surfaced on the card
 * (market completeness, explicit critical flags, suppression, cross-run
 * stability) are left null/empty/false so they can only ever WITHHOLD an
 * upgrade, never manufacture one. Pure.
 */
export function buildLadderSignalsFromCard(card: LadderCardInput, nowMs: number): LadderSignals | null {
  const pick = card.modelPick;
  if (!pick) return null;

  const runners = card.runners ?? [];
  const probs = runners
    .map((r) => r.model_prob)
    .filter((p): p is number => isFiniteNum(p));
  const maxProb = probs.length > 0 ? Math.max(...probs) : null;
  const modelIsMostLikely =
    isFiniteNum(pick.model_prob) && maxProb != null && pick.model_prob >= maxProb - 1e-9;

  const snapMs = card.latestOddsSnapshotTime ? Date.parse(card.latestOddsSnapshotTime) : NaN;
  const oddsStale = Number.isFinite(snapMs) ? nowMs - snapMs > STALE_ODDS_THRESHOLD_MS : true;

  return {
    ev: pick.ev,
    modelProb: pick.model_prob,
    marketProb: pick.market_prob,
    modelIsFavourite: pick.isFavourite,
    modelIsMostLikely,
    runQuality: card.observability?.runQuality ?? null,
    oddsStale,
    marketCompleteness: null,
    criticalDataFlags: [],
    missingRunnerOdds: false,
    fieldSize: runners.length > 0 ? runners.length : null,
    suppressed: false,
    tipsterAlignmentLabel: alignmentLabel(card),
    stability: null,
  };
}

/** Convenience: card + now → ladder verdict, or null when there is no pick. Pure. */
export function cardConfidenceLadder(card: LadderCardInput, nowMs: number): ConfidenceLadderResult | null {
  const signals = buildLadderSignalsFromCard(card, nowMs);
  return signals ? evaluateConfidenceLadder(signals) : null;
}
