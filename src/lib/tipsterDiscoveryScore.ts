/**
 * Tipster Discovery Engine — pure scoring, dedup, and capture planning (Phase 4C).
 *
 * This module turns a DISCOVERED tipster profile (a name + a verbatim track
 * record published by a source) into (a) an advisory 0..100 discovery-confidence
 * triage score and (b) a review-table candidate row. It is the SINGLE SOURCE of
 * the discovery rules, and it is deliberately and strictly NON-MODEL:
 *
 *   - It NEVER feeds the model, NEVER changes a tipster weight the model uses,
 *     NEVER touches staking, and NEVER makes a tipster model-active. The score is
 *     an operator triage aid only.
 *   - It is PURE — no I/O, no DB, no network, no GenAI — so every rule is
 *     unit-testable. It NEVER fabricates: a metric scores only when the source
 *     actually published it; missing metrics stay null and score 0 (and, where
 *     essential, attract a penalty).
 *   - Every captured candidate row is forced to `status: 'pending'`. Promotion to
 *     a canonical tipster is a separate, explicit, operator-driven step.
 *
 * Confidence = sum of six metric dimensions (max 100) minus penalties for
 * weak/missing evidence, clamped to 0..100. `reasons` explains every credit and
 * penalty so the operator can see WHY a profile landed where it did. The tier
 * thresholds mirror `tipsterEvidenceScore` (70 / 40) for a consistent review UX.
 */

import { isFiniteNumber } from './dataQualityUtils';

// --- Tracked metrics --------------------------------------------------------

/**
 * A discovered tipster's published track record. EVERY field is optional and
 * may be null: a source contributes only the figures it actually published. ROI
 * values are fractions (0.12 = +12%); rates are fractions in [0, 1].
 */
export interface DiscoveryMetrics {
  /** Settled bets/selections N behind the record (the real sample size). */
  sampleSize?: number | null;
  /** Win strike rate (wins / bets), 0..1. */
  strikeRate?: number | null;
  /** Winners / bets, 0..1 (often equals strikeRate; tracked separately). */
  winnerRate?: number | null;
  /** Placed / bets, 0..1. */
  placedRate?: number | null;
  /** Long-run ROI fraction (the core value signal). */
  roi?: number | null;
  /** Recent-window ROI fraction (momentum). */
  roiRecent?: number | null;
  /** Date (YYYY-MM-DD) of the most recent recorded selection (recency). */
  lastSeenDate?: string | null;
}

/** Review triage tier derived from the discovery-confidence score. */
export type DiscoveryConfidenceTier =
  | 'tier_1_candidate'
  | 'watchlist'
  | 'reject_or_research_more';

/** The advisory confidence assessment. NOT consumed by the model. */
export interface DiscoveryConfidence {
  /** 0..100, higher = stronger evidence the profile is worth reviewing. */
  discovery_confidence: number;
  /** Triage tier derived from the score. */
  confidence_tier: DiscoveryConfidenceTier;
  /** Reliability shrinkage `N / (N + K)` for display/parity with priors. */
  reliability: number;
  /** Whole days since `lastSeenDate` at scoring time, or null when unknown. */
  recency_days: number | null;
  /** Human-readable credits + penalties explaining the score. */
  reasons: string[];
}

// --- Points per dimension (sum to 100) -------------------------------------
const POINTS_SAMPLE_MAX = 22;
const POINTS_LONG_ROI_MAX = 26;
const POINTS_RECENT_ROI_MAX = 14;
const POINTS_WIN_RATE_MAX = 12;
const POINTS_PLACED_RATE_MAX = 8;
const POINTS_RECENCY_MAX = 18;

// --- Penalties (subtracted) ------------------------------------------------
const PENALTY_NO_SAMPLE = 15;
const PENALTY_TINY_SAMPLE = 10;
const PENALTY_NO_ROI = 10;
const PENALTY_STALE = 10;

// --- Sample-size bands ------------------------------------------------------
/** Below this, a sample is "tiny" (statistically meaningless) and penalised. */
export const TINY_SAMPLE_THRESHOLD = 50;
const MODERATE_SAMPLE_THRESHOLD = 200;
/** At/above this, the sample dimension earns full marks. */
export const STRONG_SAMPLE_THRESHOLD = 500;

/** Reliability shrinkage constant: `reliability = N / (N + K)` (matches priors). */
export const RELIABILITY_K = 400;

// --- Recency bands (days since last selection) -----------------------------
/** At/under this many days a profile is "fresh" and earns full recency marks. */
export const FRESH_RECENCY_DAYS = 3;
/** Over this many days the record is "stale" and earns 0 recency + a penalty. */
export const STALE_RECENCY_DAYS = 60;

// --- Tier thresholds (mirror tipsterEvidenceScore) --------------------------
export const TIER_1_MIN_SCORE = 70;
export const WATCHLIST_MIN_SCORE = 40;

/** Clamps a number into [0, 100]. */
function clamp100(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Clamps a number into [lo, hi]. */
function clampRange(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** A usable sample size: a finite number > 0, else null (no sample). */
function usableSampleSize(value: number | null | undefined): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

/** A usable rate in [0, 1], else null. */
function usableRate(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? clampRange(value, 0, 1) : null;
}

/** A usable ROI fraction (any finite number), else null. */
function usableRoi(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? value : null;
}

/** Reliability shrinkage `N / (N + K)`; 0 for a non-positive/absent sample. */
export function reliabilityOf(sampleSize: number | null, k: number = RELIABILITY_K): number {
  const n = usableSampleSize(sampleSize);
  return n === null ? 0 : n / (n + k);
}

/** Banded points (0..POINTS_SAMPLE_MAX) for a sample size. Pure. */
function sampleSizePoints(sample: number | null): number {
  if (sample === null) return 0;
  if (sample < TINY_SAMPLE_THRESHOLD) return 6;
  if (sample < MODERATE_SAMPLE_THRESHOLD) return 12;
  if (sample < STRONG_SAMPLE_THRESHOLD) return 18;
  return POINTS_SAMPLE_MAX;
}

/**
 * Maps an ROI fraction to points on a line that crosses `atZeroPoints` at ROI=0
 * and reaches `maxPoints` at ROI=`+saturation` (and 0 at ROI=`-saturation`),
 * clamped to [0, maxPoints]. So a profitable record scores high, break-even
 * scores middling, and a losing record scores low — never negative credit.
 */
function roiPoints(
  roi: number,
  maxPoints: number,
  saturation: number,
): number {
  const atZero = maxPoints / 2;
  const perRoi = atZero / saturation;
  return clampRange(atZero + roi * perRoi, 0, maxPoints);
}

/** Parses a YYYY-MM-DD (or ISO) date to a UTC ms epoch, or null. */
function parseDateMs(value: string | null | undefined): number | null {
  if (!value || value.trim() === '') return null;
  const ms = Date.parse(value.length <= 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(ms) ? null : ms;
}

/** Whole days between `lastSeenDate` and `now` (>= 0), or null when unknown. */
export function recencyDaysOf(
  lastSeenDate: string | null | undefined,
  now: Date,
): number | null {
  const seenMs = parseDateMs(lastSeenDate);
  if (seenMs === null) return null;
  const days = Math.floor((now.getTime() - seenMs) / 86_400_000);
  return days < 0 ? 0 : days;
}

/** Banded points (0..POINTS_RECENCY_MAX) for a recency in days. Pure. */
function recencyPoints(recencyDays: number | null): number {
  if (recencyDays === null) return 0;
  if (recencyDays <= FRESH_RECENCY_DAYS) return POINTS_RECENCY_MAX;
  if (recencyDays >= STALE_RECENCY_DAYS) return 0;
  // Linear decay between fresh and stale.
  const span = STALE_RECENCY_DAYS - FRESH_RECENCY_DAYS;
  const frac = 1 - (recencyDays - FRESH_RECENCY_DAYS) / span;
  return clampRange(POINTS_RECENCY_MAX * frac, 0, POINTS_RECENCY_MAX);
}

/** Rounds to one decimal place (stable display + comparison). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Derives the triage tier from a 0..100 score. Pure. */
export function tierForScore(score: number): DiscoveryConfidenceTier {
  if (score >= TIER_1_MIN_SCORE) return 'tier_1_candidate';
  if (score >= WATCHLIST_MIN_SCORE) return 'watchlist';
  return 'reject_or_research_more';
}

/**
 * Scores the evidence behind a DISCOVERED tipster profile out of 100 and assigns
 * a review tier. Advisory only — NOT used by the model, weights, or staking.
 *
 * Dimensions (max 100): sample size (banded), long-run ROI, recent ROI, win
 * rate (strikeRate, falling back to winnerRate), placed rate, recency. Penalties:
 * no sample size, tiny sample (< 50), no ROI evidence at all, stale record
 * (> 60 days). The score is clamped to 0..100. Pure; never mutates input,
 * never throws, never fabricates a missing metric.
 */
export function scoreDiscoveryConfidence(
  metrics: DiscoveryMetrics,
  options: { now?: Date } = {},
): DiscoveryConfidence {
  const now = options.now ?? new Date();
  const reasons: string[] = [];
  let score = 0;

  const sample = usableSampleSize(metrics.sampleSize);
  const longRoi = usableRoi(metrics.roi);
  const recentRoi = usableRoi(metrics.roiRecent);
  // Win rate prefers an explicit strike rate; winnerRate is the honest fallback.
  const winRate = usableRate(metrics.strikeRate) ?? usableRate(metrics.winnerRate);
  const placedRate = usableRate(metrics.placedRate);
  const recency = recencyDaysOf(metrics.lastSeenDate, now);

  // --- Positive dimensions (credit only when the metric is present) ---------
  const samplePts = sampleSizePoints(sample);
  if (samplePts > 0) {
    score += samplePts;
    reasons.push(`+${samplePts} sample size (${sample} bets)`);
  }

  if (longRoi !== null) {
    const pts = round1(roiPoints(longRoi, POINTS_LONG_ROI_MAX, 0.2));
    score += pts;
    reasons.push(`+${pts} long-run ROI (${(longRoi * 100).toFixed(1)}%)`);
  }

  if (recentRoi !== null) {
    const pts = round1(roiPoints(recentRoi, POINTS_RECENT_ROI_MAX, 0.2));
    score += pts;
    reasons.push(`+${pts} recent ROI (${(recentRoi * 100).toFixed(1)}%)`);
  }

  if (winRate !== null) {
    const pts = round1(clampRange(winRate * 2 * POINTS_WIN_RATE_MAX, 0, POINTS_WIN_RATE_MAX));
    score += pts;
    reasons.push(`+${pts} win rate (${(winRate * 100).toFixed(1)}%)`);
  }

  if (placedRate !== null) {
    const pts = round1(clampRange(placedRate * POINTS_PLACED_RATE_MAX, 0, POINTS_PLACED_RATE_MAX));
    score += pts;
    reasons.push(`+${pts} placed rate (${(placedRate * 100).toFixed(1)}%)`);
  }

  const recencyPts = round1(recencyPoints(recency));
  if (recencyPts > 0) {
    score += recencyPts;
    reasons.push(`+${recencyPts} recency (${recency}d since last selection)`);
  }

  // --- Penalties (weak or missing evidence) ---------------------------------
  if (sample === null) {
    score -= PENALTY_NO_SAMPLE;
    reasons.push(`-${PENALTY_NO_SAMPLE} no sample size provided`);
  } else if (sample < TINY_SAMPLE_THRESHOLD) {
    score -= PENALTY_TINY_SAMPLE;
    reasons.push(`-${PENALTY_TINY_SAMPLE} tiny sample (< ${TINY_SAMPLE_THRESHOLD})`);
  }

  if (longRoi === null && recentRoi === null) {
    score -= PENALTY_NO_ROI;
    reasons.push(`-${PENALTY_NO_ROI} no ROI evidence`);
  }

  if (recency !== null && recency > STALE_RECENCY_DAYS) {
    score -= PENALTY_STALE;
    reasons.push(`-${PENALTY_STALE} stale record (> ${STALE_RECENCY_DAYS}d)`);
  }

  const discovery_confidence = round1(clamp100(score));
  return {
    discovery_confidence,
    confidence_tier: tierForScore(discovery_confidence),
    reliability: round1(reliabilityOf(sample) * 100) / 100,
    recency_days: recency,
    reasons,
  };
}

// --- Dedup ------------------------------------------------------------------

/**
 * Normalises a tipster name for dedup: trims, lower-cases, and collapses runs of
 * whitespace to a single space. Matches the in-run dedup used by the existing
 * needle discovery, so the two paths agree on identity. Pure.
 */
export function normalizeTipsterName(name: string): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable dedup key for a discovered profile: `source_label::normalized_name`. */
export function discoveryDedupeKey(sourceLabel: string, name: string): string {
  return `${(sourceLabel ?? '').trim().toLowerCase()}::${normalizeTipsterName(name)}`;
}

// --- Capture row (review-table shape) --------------------------------------

/** A discovered tipster profile as returned by a source adapter (with provenance). */
export interface DiscoveredTipsterProfile {
  /** Tipster name exactly as published (verbatim). */
  discoveredName: string;
  /** The registered source that surfaced this profile (provenance). */
  sourceLabel: string;
  /** Provenance URL for the listing/leaderboard, if any. */
  sourceUrl?: string | null;
  /** Link to the tipster's profile/proofing page, if any. */
  profileUrl?: string | null;
  /** Tipster affiliation as published, if any. */
  affiliation?: string | null;
  /** The verbatim, published track record (all fields optional). */
  metrics: DiscoveryMetrics;
}

/**
 * A `tipster_discovery_candidates` insert/upsert row. `status` is ALWAYS
 * `'pending'`: capture never approves and never makes a tipster active. The
 * `tipster_id` link (when the name already resolves to a canonical tipster) is
 * filled in by the orchestrator, not here.
 */
export interface DiscoveryCandidateRow {
  source_label: string;
  source_url: string | null;
  discovered_name: string;
  normalized_name: string;
  raw_affiliation: string | null;
  profile_url: string | null;
  sample_size: number | null;
  strike_rate: number | null;
  roi: number | null;
  roi_recent: number | null;
  winner_rate: number | null;
  placed_rate: number | null;
  last_seen_date: string | null;
  recency_days: number | null;
  discovery_confidence: number;
  confidence_tier: DiscoveryConfidenceTier;
  confidence_reasons: string[];
  /** Always 'pending' on capture — promotion is a separate, explicit step. */
  status: 'pending';
}

/** Trims a possibly-missing string; empty/blank becomes null. */
function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A finite number, else null (never NaN/Infinity into the row). */
function numOrNull(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? value : null;
}

/**
 * Builds a review-table candidate row from a discovered profile, scoring its
 * confidence and computing recency. Metrics are carried VERBATIM (missing ones
 * stay null — never fabricated). `status` is forced to `'pending'`. Pure.
 */
export function toDiscoveryCandidateRow(
  profile: DiscoveredTipsterProfile,
  options: { now?: Date } = {},
): DiscoveryCandidateRow {
  const now = options.now ?? new Date();
  const confidence = scoreDiscoveryConfidence(profile.metrics, { now });

  return {
    source_label: (profile.sourceLabel ?? '').trim(),
    source_url: trimOrNull(profile.sourceUrl),
    discovered_name: (profile.discoveredName ?? '').trim(),
    normalized_name: normalizeTipsterName(profile.discoveredName),
    raw_affiliation: trimOrNull(profile.affiliation),
    profile_url: trimOrNull(profile.profileUrl),
    sample_size: usableSampleSize(profile.metrics.sampleSize),
    strike_rate: numOrNull(profile.metrics.strikeRate),
    roi: numOrNull(profile.metrics.roi),
    roi_recent: numOrNull(profile.metrics.roiRecent),
    winner_rate: numOrNull(profile.metrics.winnerRate),
    placed_rate: numOrNull(profile.metrics.placedRate),
    last_seen_date: trimOrNull(profile.metrics.lastSeenDate),
    recency_days: confidence.recency_days,
    discovery_confidence: confidence.discovery_confidence,
    confidence_tier: confidence.confidence_tier,
    confidence_reasons: confidence.reasons,
    status: 'pending',
  };
}

// --- Capture plan (pure, dedup'd) ------------------------------------------

/** A discovery capture plan: the rows to upsert + the raw/deduped counts. */
export interface DiscoveryPlan {
  /** Raw profiles received from the source(s). */
  received: number;
  /** Distinct profiles after `(source_label, normalized_name)` dedup. */
  deduped: number;
  /** The candidate rows to upsert (one per distinct profile), all pending. */
  rows: DiscoveryCandidateRow[];
}

/**
 * Builds a dedup'd capture plan from raw discovered profiles. Profiles that
 * resolve to the same `(source_label, normalized_name)` collapse to ONE row;
 * within a collapse the MOST-PROOFED profile (largest sampleSize) wins, so we
 * keep one source's real figures rather than blending (a blend would be a number
 * no source published). Rows with a blank name are skipped (nothing to review).
 *
 * Pure: no I/O, deterministic, and every output row is `status: 'pending'`.
 */
export function buildDiscoveryPlan(
  profiles: readonly DiscoveredTipsterProfile[],
  options: { now?: Date } = {},
): DiscoveryPlan {
  const now = options.now ?? new Date();
  const byKey = new Map<string, DiscoveredTipsterProfile>();

  for (const profile of profiles) {
    if (normalizeTipsterName(profile.discoveredName) === '') continue; // nothing to review
    const key = discoveryDedupeKey(profile.sourceLabel, profile.discoveredName);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, profile);
      continue;
    }
    const existingN = usableSampleSize(existing.metrics.sampleSize) ?? -1;
    const candidateN = usableSampleSize(profile.metrics.sampleSize) ?? -1;
    if (candidateN > existingN) byKey.set(key, profile);
  }

  const rows = [...byKey.values()].map((p) => toDiscoveryCandidateRow(p, { now }));
  return { received: profiles.length, deduped: rows.length, rows };
}
