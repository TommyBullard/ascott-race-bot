/**
 * Review-only tipster/source EVIDENCE scoring (Phase 4B.1).
 *
 * Scores the QUALITY OF EVIDENCE behind a candidate tipster/source out of 100,
 * purely to help an operator triage the review queue. It is deliberately and
 * strictly NON-MODEL:
 *
 *   - It does NOT feed the model, does NOT change any tipster weight the model
 *     uses, and does NOT touch staking. It is an advisory triage score only.
 *   - It is PURE — no I/O, no DB, no mutation, no network, no GenAI — so every
 *     rule is unit-testable. It never fabricates: a dimension scores only when
 *     the operator actually provides evidence for it; missing evidence scores 0
 *     (and, where the field is essential, attracts a penalty).
 *
 * The score is the sum of eight evidence dimensions (max 100) minus penalties for
 * weak/promotional signals, clamped to 0..100. The tier is derived from the
 * final score. `reasons` explains every credit and penalty so the operator can
 * see WHY a candidate landed where it did.
 */

import { isFiniteNumber } from './dataQualityUtils';

/** Operator-gathered evidence about a candidate tipster/source. All optional. */
export interface EvidenceInput {
  /** A proofed, verifiable long-run record exists (not a one-off purple patch). */
  proofedLongRunRecord?: boolean | null;
  /** Recent form is documented (not just an old headline figure). */
  recentFormEvidence?: boolean | null;
  /** Number of recorded bets/selections behind the record (the real sample N). */
  sampleSize?: number | null;
  /** The FULL history is transparent (every pick, not a cherry-picked subset). */
  transparentFullHistory?: boolean | null;
  /** Bets to value / is measured against BSP/SP, not just winners found. */
  valueOrientation?: boolean | null;
  /** Focused on UK/Ireland racing (relevant to this tool). */
  ukIreRelevance?: boolean | null;
  /** Covers Royal Ascot / the meeting specifically. */
  royalAscotRelevance?: boolean | null;
  /** Accessible in a ToS-compliant way (no scraping/paywall/login bypass). */
  sourceAccessibleCompliant?: boolean | null;
  /** Link to the proofing/results record (evidence the figures are genuine). */
  proofUrl?: string | null;
  /** Claims are screenshot-only (no verifiable, ongoing record). */
  screenshotOnly?: boolean | null;
  /** The staking method is unclear (can't tell level vs variable vs to-value). */
  unclearStaking?: boolean | null;
  /** Marketing/hype claims only ("smash the bookies"), no substantiated record. */
  marketingOnly?: boolean | null;
}

/** Review triage tier derived from the evidence score. */
export type EvidenceTier =
  | 'tier_1_candidate'
  | 'watchlist'
  | 'reject_or_research_more';

/** The advisory evidence assessment. NOT consumed by the model. */
export interface EvidenceScore {
  /** 0..100, higher = stronger evidence. */
  evidence_score: number;
  /** Triage tier derived from the score. */
  evidence_tier: EvidenceTier;
  /** Human-readable credits + penalties explaining the score. */
  reasons: string[];
}

// --- Points per positive dimension (sum to 100) ----------------------------
const POINTS_PROOFED_LONG_RUN = 20;
const POINTS_RECENT_FORM = 12;
const POINTS_SAMPLE_SIZE_MAX = 16;
const POINTS_FULL_HISTORY = 12;
const POINTS_VALUE_ORIENTATION = 12;
const POINTS_UK_IRE = 10;
const POINTS_ROYAL_ASCOT = 8;
const POINTS_ACCESSIBLE_COMPLIANT = 10;

// --- Penalties (subtracted) ------------------------------------------------
const PENALTY_SCREENSHOT_ONLY = 15;
const PENALTY_NO_SAMPLE_SIZE = 10;
const PENALTY_NO_PROOF_URL = 10;
const PENALTY_UNCLEAR_STAKING = 8;
const PENALTY_TINY_SAMPLE = 10;
const PENALTY_MARKETING_ONLY = 15;

// --- Sample-size bands ------------------------------------------------------
/** Below this, a sample is "tiny" (statistically meaningless) and penalised. */
export const TINY_SAMPLE_THRESHOLD = 50;
/** At/above this, the sample dimension earns full marks. */
export const STRONG_SAMPLE_THRESHOLD = 500;
const MODERATE_SAMPLE_THRESHOLD = 200;

// --- Tier thresholds --------------------------------------------------------
export const TIER_1_MIN_SCORE = 70;
export const WATCHLIST_MIN_SCORE = 40;

/** True only for an explicit boolean `true` (null/undefined/other → false). */
function isTrue(value: boolean | null | undefined): boolean {
  return value === true;
}

/** A usable sample size: a finite number > 0, else null (no sample). */
function usableSampleSize(value: number | null | undefined): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

/** Whether a string field carries a usable value. */
function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** Points (0..POINTS_SAMPLE_SIZE_MAX) for a sample size, banded. Pure. */
function sampleSizePoints(sample: number | null): number {
  if (sample === null) return 0;
  if (sample < TINY_SAMPLE_THRESHOLD) return 4;
  if (sample < MODERATE_SAMPLE_THRESHOLD) return 8;
  if (sample < STRONG_SAMPLE_THRESHOLD) return 12;
  return POINTS_SAMPLE_SIZE_MAX;
}

/** Clamps a number into [0, 100]. */
function clamp100(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Derives the triage tier from a 0..100 score. Pure. */
export function tierForScore(score: number): EvidenceTier {
  if (score >= TIER_1_MIN_SCORE) return 'tier_1_candidate';
  if (score >= WATCHLIST_MIN_SCORE) return 'watchlist';
  return 'reject_or_research_more';
}

/**
 * Scores the evidence behind a candidate tipster/source out of 100 and assigns a
 * review tier. Advisory only — NOT used by the model, weights, or staking.
 *
 * Positive dimensions (max 100): proofed long-run record, recent form, sample
 * size (banded), transparent full history, value orientation, UK/IRE relevance,
 * Royal Ascot relevance, source accessibility/compliance. Penalties: screenshot-
 * only claims, no sample size, no proof URL, unclear staking, tiny sample,
 * marketing-only claims. The score is clamped to 0..100.
 *
 * Pure: does not mutate `input` and never throws.
 */
export function scoreTipsterEvidence(input: EvidenceInput): EvidenceScore {
  const reasons: string[] = [];
  let score = 0;

  // --- Positive dimensions (credit only when evidence is actually present) ---
  if (isTrue(input.proofedLongRunRecord)) {
    score += POINTS_PROOFED_LONG_RUN;
    reasons.push(`+${POINTS_PROOFED_LONG_RUN} proofed long-run record`);
  }
  if (isTrue(input.recentFormEvidence)) {
    score += POINTS_RECENT_FORM;
    reasons.push(`+${POINTS_RECENT_FORM} recent form evidence`);
  }

  const sample = usableSampleSize(input.sampleSize);
  const samplePts = sampleSizePoints(sample);
  if (samplePts > 0) {
    score += samplePts;
    reasons.push(`+${samplePts} sample size (${sample} selections)`);
  }

  if (isTrue(input.transparentFullHistory)) {
    score += POINTS_FULL_HISTORY;
    reasons.push(`+${POINTS_FULL_HISTORY} transparent full history`);
  }
  if (isTrue(input.valueOrientation)) {
    score += POINTS_VALUE_ORIENTATION;
    reasons.push(`+${POINTS_VALUE_ORIENTATION} value orientation`);
  }
  if (isTrue(input.ukIreRelevance)) {
    score += POINTS_UK_IRE;
    reasons.push(`+${POINTS_UK_IRE} UK/Ireland racing relevance`);
  }
  if (isTrue(input.royalAscotRelevance)) {
    score += POINTS_ROYAL_ASCOT;
    reasons.push(`+${POINTS_ROYAL_ASCOT} Royal Ascot relevance`);
  }
  if (isTrue(input.sourceAccessibleCompliant)) {
    score += POINTS_ACCESSIBLE_COMPLIANT;
    reasons.push(`+${POINTS_ACCESSIBLE_COMPLIANT} accessible / ToS-compliant source`);
  }

  // --- Penalties (weak or promotional signals) -------------------------------
  if (isTrue(input.screenshotOnly)) {
    score -= PENALTY_SCREENSHOT_ONLY;
    reasons.push(`-${PENALTY_SCREENSHOT_ONLY} screenshot-only claims`);
  }
  if (sample === null) {
    score -= PENALTY_NO_SAMPLE_SIZE;
    reasons.push(`-${PENALTY_NO_SAMPLE_SIZE} no sample size provided`);
  } else if (sample < TINY_SAMPLE_THRESHOLD) {
    score -= PENALTY_TINY_SAMPLE;
    reasons.push(`-${PENALTY_TINY_SAMPLE} tiny sample (< ${TINY_SAMPLE_THRESHOLD})`);
  }
  if (!hasText(input.proofUrl)) {
    score -= PENALTY_NO_PROOF_URL;
    reasons.push(`-${PENALTY_NO_PROOF_URL} no proof URL`);
  }
  if (isTrue(input.unclearStaking)) {
    score -= PENALTY_UNCLEAR_STAKING;
    reasons.push(`-${PENALTY_UNCLEAR_STAKING} unclear staking`);
  }
  if (isTrue(input.marketingOnly)) {
    score -= PENALTY_MARKETING_ONLY;
    reasons.push(`-${PENALTY_MARKETING_ONLY} marketing-only claims`);
  }

  const evidence_score = clamp100(score);
  return {
    evidence_score,
    evidence_tier: tierForScore(evidence_score),
    reasons,
  };
}
