'use client';

/**
 * Recommendations dashboard.
 *
 * Fetches one rich card per race from `/api/recommendations` and renders them
 * sorted by off time, each with a live countdown, the market favourite, the
 * model's rank-1 pick (with a "Why" rationale), and 1-2 alternatives. No UI
 * libraries — inline styles only; this is a personal tool, so clarity over
 * polish.
 *
 * Expected response: `{ races: RaceCard[] }`.
 */

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import RaceExplanationPanel from '@/components/RaceExplanationPanel';
import RaceIntelligencePanel from '@/components/RaceIntelligencePanel';
import RaceTimelinePanel from '@/components/RaceTimelinePanel';
import SettlementStatusPanel from '@/components/SettlementStatusPanel';
import PlaceAuditPanel from '@/components/PlaceAuditPanel';
import ProofOfUpdatePanel from '@/components/ProofOfUpdatePanel';
import GenaiCommentaryPanel from '@/components/GenaiCommentaryPanel';
import MlShadowComparisonPanel from '@/components/MlShadowComparisonPanel';
import type { GenaiCommentaryRow } from '@/lib/genaiCommentaryView';
import {
  TODAY_ASCOT_HREF,
  YESTERDAY_ASCOT_HREF,
  VIEW_TODAY_LABEL,
  VIEW_YESTERDAY_LABEL,
  RACE_DAY_NAV_EMPTY_MESSAGE,
} from '@/lib/raceDayNav';
import {
  buildTipsterStatusLines,
  type TipsterStatusSummary,
} from '@/lib/tipsterStatus';
import {
  deriveRaceExplanationProps,
  type RaceObservabilityLike,
} from '@/lib/raceExplanation';
import { formatRelativeAge, isStaleAge } from '@/lib/relativeTime';
import { STALE_ODDS_THRESHOLD_MS } from '@/lib/modelDataQuality';
import { cardConfidenceLadder, type LadderLabel } from '@/lib/confidenceLadder';
import {
  hasRaceDayScope,
  selectDashboardSummary,
  shouldShowAccuracyBar,
  type DashboardSummary,
} from '@/lib/raceDaySummary';
import {
  RACE_DAY_REFRESH_MS,
  deriveRaceState,
  deriveResultStatus,
  deriveCaptureStatus,
  raceStateBadge,
  resultStatusBadge,
  captureStatusBadge,
  selectNextRace,
  buildRaceWarningChips,
  type StatusTone,
} from '@/lib/raceDayStatus';
import { buildRaceIntelligence } from '@/lib/raceIntelligence';
import { buildRaceDayTimeline } from '@/lib/raceDayTimeline';
import { buildSettlementView } from '@/lib/settlementStatus';
import { buildPlaceAuditView } from '@/lib/placeAuditView';
import { buildProofPanelView } from '@/lib/proofPanel';
import { deriveRaceLockStatus } from '@/lib/lockCoverage';
import {
  deriveNextAction,
  type NextAction,
  type NextActionTone,
} from '@/lib/operatorNextAction';
import { buildLiveStatusView } from '@/lib/liveStatus';
import type { RaceDayStatusResponse } from '@/lib/raceDayStatusApi';

/** A runner as shown on a card (mirrors the server `RaceCardRunner`). */
interface RaceCardRunner {
  runner_id: string;
  horse_name: string;
  odds: number | null;
  market_prob: number | null;
  model_prob: number | null;
  edge: number | null;
  ev: number | null;
  confidence_score: number | null;
  rank: number | null;
  /** Recorded finishing position once settled (1 = winner); null/absent otherwise. */
  finish_pos?: number | null;
}

/** The model's rank-1 pick (mirrors the server `RaceCardPick`). */
interface RaceCardPick extends RaceCardRunner {
  confidence_label: string;
  stake_amount: number;
  stake_pct: number;
  rationale: Record<string, unknown> | null;
  isFavourite: boolean;
}

/**
 * The official T-minus-5 locked decision for a race (mirrors the fields of the
 * server `LockedDecision` this page displays). Read-only display data from
 * `locked_race_decisions` — never a betting instruction. Nulls mean "not
 * recorded"; nothing is ever fabricated client-side.
 */
interface RaceCardLockedDecision {
  decision_status: 'locked_pick' | 'locked_no_bet' | 'no_run_available';
  lock_time: string;
  no_bet_reason: string | null;
  pick_horse_name: string | null;
  pick_odds: number | null;
  pick_ev: number | null;
  pick_stake: number | null;
  pick_confidence_label: string | null;
  run_quality: string | null;
  data_quality_short_summary: string | null;
}

/** One race card (mirrors the server `RaceCard`). */
interface RaceCard {
  race_id: string;
  off_time: string | null;
  course: string | null;
  race_name: string | null;
  favourite: RaceCardRunner | null;
  modelPick: RaceCardPick | null;
  alternatives: RaceCardRunner[];
  /**
   * Full scored field (read-only) for the display-only Race Intelligence panel.
   * Optional for back-compat with older responses; absent/empty -> the panel
   * renders its "unknown" / "Not enough data" states.
   */
  runners?: RaceCardRunner[];
  /**
   * True when a current model run exists for this race. Distinguishes
   * "ran but no qualifying bet" (true + `modelPick` null) from "no run yet"
   * (false). Optional for back-compat with older responses.
   */
  hasModelRun?: boolean;
  /** Latest odds snapshot time (ISO) for the freshness indicator; null/absent if none. */
  latestOddsSnapshotTime?: string | null;
  /** Latest model run time (ISO) for the freshness indicator; null/absent if none. */
  latestModelRunTime?: string | null;
  /**
   * Race row status (e.g. 'result' once settled) for the read-only race-state /
   * result-status badges. Optional for back-compat with older responses.
   */
  status?: string | null;
  /**
   * Result recorded time (ISO) for the read-only "results checked X ago" line;
   * null/absent when not yet resulted.
   */
  result_time?: string | null;
  /**
   * Read-only model observability for this race (from the current run's
   * config_json, surfaced by the API in Batch J1). Optional/null-safe: absent or
   * empty for races without a current run, in which case the explanation panel
   * renders its empty state.
   */
  observability?: RaceObservabilityLike | null;
  /**
   * Read-only, human-approved shadow GenAI commentary for this race (display
   * only). Absent/empty unless a reviewer approved a candidate. Never
   * model-active; not a decision input.
   */
  genaiCommentary?: GenaiCommentaryRow[] | null;
  /**
   * Official T-minus-5 locked decision (Phase 3, additive). Optional for
   * back-compat with older responses; null/absent when the race has no lock
   * yet, in which case the live model display stands alone as diagnostic.
   */
  lockedDecision?: RaceCardLockedDecision | null;
}

/**
 * One ML SHADOW race entry from the read-only /api/ml/shadow-comparison overlay.
 * Research/display only; never model-active and never a decision input.
 */
interface MlShadowApiRace {
  race_id: string;
  ml_pick: { runner_name: string | null; ml_prob: number | null; ml_rank: number | null } | null;
  warnings?: {
    small_sample?: boolean;
    small_sample_text?: string | null;
    data_differs?: boolean;
    data_differs_text?: string | null;
  } | null;
}

/** Live model accuracy snapshot (mirrors the server `ModelAccuracy`). */
interface ModelAccuracy {
  racesSettled: number;
  winners: number;
  strikeRatePct: number;
  profitPoints: number;
  roiPct: number;
  computedAt: string;
}

/**
 * Per-day recommendation performance (mirrors the server
 * `ModelPerformanceResult`, Phase 5B). Computed from stored recommendation odds
 * and stake; pending races are never counted as losses.
 */
interface ModelPerformance {
  recommendations_total: number;
  settled_count: number;
  pending_count: number;
  winners: number;
  losers: number;
  strike_rate: number;
  profit_loss: number;
  roi: number;
  average_ev: number | null;
  total_staked: number;
  no_bet_races: number;
  date: string;
  course: string | null;
  computedAt: string;
  /** Decision-selection rule behind these figures (`locked_first` default). */
  evaluationMode?: 'locked_first' | 'pre_off' | 'current';
  /**
   * Which rule labels the top-level figures under locked-first (Phase 5B):
   * official locked decisions, mixed (some lock-missing), or pre-off fallback.
   */
  officialMode?: 'official_locked' | 'fallback_pre_off' | 'mixed';
  /** Lock coverage counts for the scope (Phase 5B). */
  lockCoverage?: {
    races: number;
    locked: number;
    locked_pick: number;
    locked_no_bet: number;
    no_run_available: number;
    lock_missing: number;
    coverage_pct: number;
  };
  /** Pre-off fallback figures for ONLY the lock-missing races (mixed mode). */
  fallbackPerformance?: {
    recommendations_total: number;
    settled_count: number;
    pending_count: number;
    winners: number;
    losers: number;
    strike_rate: number;
    profit_loss: number;
    roi: number;
    average_ev: number | null;
    total_staked: number;
    no_bet_races: number;
  };
}

/** A tipster's pick in one of today's races (mirrors server `TodaysPick`). */
interface TodaysPick {
  race_id: string;
  runner_id: string;
  horse_name: string;
}

/** An in-form tipster (mirrors the server `InFormTipster`). */
interface InFormTipster {
  tipster_id: string;
  name: string;
  longRunRoi: number | null;
  recentRoi30d: number | null;
  longestLosingStreak: number | null;
  needleScore: number | null;
  finalWeight: number | null;
  todaysPicks: TodaysPick[];
}

type LoadStatus = 'loading' | 'ready' | 'error';
type ConfidenceLabel = 'High' | 'Medium' | 'Low';

const EV_POSITIVE_COLOR = '#1a7f37';
const EV_NEGATIVE_COLOR = '#cf222e';

const CONFIDENCE_COLORS: Record<ConfidenceLabel, string> = {
  High: '#1a7f37',
  Medium: '#9a6700',
  Low: '#cf222e',
};

/** Edge (model_prob − market_prob) above which the model meaningfully diverges. */
const MODEL_EDGE_THRESHOLD = 0.02;

/** Odds above which a pick counts as a "big-price" play. */
const BIG_PRICE_ODDS = 8;

/** Normalises a model confidence label (any casing) to a display label. */
function displayConfidence(label: string): ConfidenceLabel {
  switch ((label ?? '').trim().toLowerCase()) {
    case 'high':
      return 'High';
    case 'medium':
    case 'med':
      return 'Medium';
    default:
      return 'Low';
  }
}

/** Maps an evidence-ladder label (LOW/MEDIUM/HIGH) to a display label. */
function ladderToDisplay(label: LadderLabel): ConfidenceLabel {
  return label === 'HIGH' ? 'High' : label === 'MEDIUM' ? 'Medium' : 'Low';
}

/** Formats a decimal odds value, or a dash when unknown. */
function formatOdds(odds: number | null): string {
  return odds === null ? '\u2014' : odds.toFixed(2);
}

/** Formats a probability (0-1) as a percentage, or a dash when unknown. */
function formatProb(prob: number | null): string {
  return prob === null ? '\u2014' : `${(prob * 100).toFixed(1)}%`;
}

/** Formats expected value as a signed percentage, or a dash when unknown. */
function formatEv(ev: number | null): string {
  if (ev === null) {
    return '\u2014';
  }
  const pct = ev * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** Colors EV green when positive, red when negative, neutral otherwise. */
function evColorStyle(ev: number | null): CSSProperties {
  if (ev !== null && ev > 0) {
    return { color: EV_POSITIVE_COLOR, fontWeight: 700 };
  }
  if (ev !== null && ev < 0) {
    return { color: EV_NEGATIVE_COLOR, fontWeight: 700 };
  }
  return {};
}

/** Formats a points P/L as a signed value to 2dp (e.g. "+3.50pt", "-1.00pt"). */
function formatProfit(points: number): string {
  const sign = points > 0 ? '+' : points < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(points).toFixed(2)}pt`;
}

/** Colors a P/L value green when positive, red when negative, neutral at zero. */
function profitColor(points: number): string {
  if (points > 0) {
    return EV_POSITIVE_COLOR;
  }
  if (points < 0) {
    return EV_NEGATIVE_COLOR;
  }
  return '#656d76';
}

/** Formats a ROI fraction (0.12 => +12.0%), or a dash when unknown. */
function formatRoi(roi: number | null): string {
  if (roi === null) {
    return '\u2014';
  }
  const pct = roi * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Colors a ROI fraction green/red/neutral. */
function roiColor(roi: number | null): string {
  if (roi !== null && roi > 0) {
    return EV_POSITIVE_COLOR;
  }
  if (roi !== null && roi < 0) {
    return EV_NEGATIVE_COLOR;
  }
  return '#656d76';
}

/** Formats the local off time as HH:MM, or a dash when unknown. */
function formatOffTime(iso: string | null): string {
  if (!iso) {
    return '\u2014';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return '\u2014';
  }
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Two-digit zero-pad for countdown segments. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface Countdown {
  text: string;
  /** True once the race is at/after its off time. */
  off: boolean;
}

/** Builds a human countdown from off time to `nowMs`. */
function countdownTo(iso: string | null, nowMs: number): Countdown | null {
  if (!iso) {
    return null;
  }
  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return null;
  }
  const diff = target - nowMs;
  if (diff <= 0) {
    return { text: 'OFF', off: true };
  }
  const totalSeconds = Math.floor(diff / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return { text: `in ${h}h ${pad2(m)}m`, off: false };
  }
  if (m > 0) {
    return { text: `in ${m}m ${pad2(s)}s`, off: false };
  }
  return { text: `in ${s}s`, off: false };
}

type TagTone = 'pos' | 'neg' | 'neutral';
interface WhyTag {
  label: string;
  tone: TagTone;
}

/**
 * Derives short "Why" tags from the model pick's stored output (EV, edge,
 * odds, favourite flag, confidence). These summarise the rationale already
 * persisted in `recommendations.rationale_json` / `model_runner_scores`.
 */
function deriveWhyTags(pick: RaceCardPick): WhyTag[] {
  const tags: WhyTag[] = [];

  if (pick.ev !== null && pick.ev > 0) {
    tags.push({ label: '+EV', tone: 'pos' });
  } else if (pick.ev !== null && pick.ev < 0) {
    tags.push({ label: '\u2212EV', tone: 'neg' });
  }

  // Positive model edge = model rates the runner above the market's price.
  if (pick.edge !== null && pick.edge > MODEL_EDGE_THRESHOLD) {
    tags.push({ label: 'model edge over market', tone: 'pos' });
  }

  // The pick is not the shortest price → the model is fading the favourite.
  if (!pick.isFavourite) {
    tags.push({ label: 'favourite discounted', tone: 'neutral' });
  }

  if (pick.odds !== null && pick.odds > BIG_PRICE_ODDS) {
    tags.push({ label: 'big-price value', tone: 'neutral' });
  }

  const conf = displayConfidence(pick.confidence_label);
  if (conf === 'High') {
    tags.push({ label: 'high confidence', tone: 'pos' });
  } else if (conf === 'Low') {
    tags.push({ label: 'low confidence', tone: 'neg' });
  }

  return tags;
}

const styles = {
  page: {
    maxWidth: 820,
    margin: '2rem auto',
    padding: '0 1rem',
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#1f2328',
  } as CSSProperties,
  cardList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  } as CSSProperties,
  card: {
    border: '1px solid #d0d7de',
    borderRadius: 10,
    padding: 16,
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  } as CSSProperties,
  cardHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    borderBottom: '1px solid #eaeef2',
    paddingBottom: 8,
    marginBottom: 12,
  } as CSSProperties,
  offTime: {
    fontSize: 22,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  subtitle: {
    fontSize: 13,
    color: '#656d76',
    marginTop: 2,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  countdown: {
    fontSize: 13,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 999,
    whiteSpace: 'nowrap' as const,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  statusRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  } as CSSProperties,
  freshnessRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    marginBottom: 12,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  freshOk: {
    color: '#656d76',
  } as CSSProperties,
  freshStale: {
    color: '#9a6700',
    fontWeight: 700,
    background: '#fff8c5',
    border: '1px solid #eac54f',
    borderRadius: 999,
    padding: '1px 8px',
  } as CSSProperties,
  freshSep: {
    color: '#afb8c1',
  } as CSSProperties,
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: '#656d76',
    textTransform: 'uppercase' as const,
    marginBottom: 4,
  } as CSSProperties,
  favouriteRow: {
    fontSize: 14,
    marginBottom: 12,
  } as CSSProperties,
  pickName: {
    fontSize: 18,
    fontWeight: 700,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  pickStats: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 14,
    fontSize: 14,
    marginTop: 4,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  statLabel: {
    color: '#656d76',
    marginRight: 4,
  } as CSSProperties,
  favBadge: {
    display: 'inline-block',
    marginLeft: 8,
    padding: '1px 6px',
    fontSize: 11,
    fontWeight: 700,
    color: '#9a6700',
    background: '#fff8c5',
    border: '1px solid #eac54f',
    borderRadius: 4,
    verticalAlign: 'middle' as const,
  } as CSSProperties,
  tagRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  } as CSSProperties,
  altList: {
    marginTop: 12,
    borderTop: '1px dashed #eaeef2',
    paddingTop: 8,
  } as CSSProperties,
  altRow: {
    display: 'flex',
    gap: 12,
    fontSize: 13,
    color: '#424a53',
    padding: '2px 0',
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  muted: {
    color: '#656d76',
  } as CSSProperties,
  accuracyBar: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'baseline',
    gap: 14,
    padding: '10px 14px',
    marginBottom: 16,
    border: '1px solid #d0d7de',
    borderRadius: 10,
    background: '#f6f8fa',
    fontSize: 14,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  accuracyMetric: {
    fontWeight: 700,
  } as CSSProperties,
  accuracySep: {
    color: '#afb8c1',
  } as CSSProperties,
  accuracyUpdated: {
    marginLeft: 'auto',
    fontSize: 12,
    color: '#656d76',
    fontWeight: 400,
  } as CSSProperties,
  accuracyScopeLabel: {
    flexBasis: '100%',
    fontSize: 12,
    color: '#656d76',
    fontStyle: 'italic' as const,
    fontWeight: 400,
  } as CSSProperties,
  perfPanel: {
    padding: '10px 14px',
    marginBottom: 16,
    border: '1px solid #d0d7de',
    borderRadius: 10,
    background: '#f6f8fa',
    fontSize: 14,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  perfHeading: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 8,
  } as CSSProperties,
  perfTitle: {
    fontWeight: 700,
  } as CSSProperties,
  perfScope: {
    fontSize: 12,
    color: '#656d76',
  } as CSSProperties,
  perfNote: {
    fontSize: 12,
    color: '#656d76',
    fontStyle: 'italic' as const,
    marginBottom: 8,
  } as CSSProperties,
  perfRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'baseline',
    gap: 14,
  } as CSSProperties,
  panel: {
    border: '1px solid #d0d7de',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    background: '#fff',
  } as CSSProperties,
  panelTitle: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: '#424a53',
    marginBottom: 10,
  } as CSSProperties,
  tipsterRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    padding: '6px 0',
    borderTop: '1px solid #f0f3f6',
    fontSize: 13,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  tipsterName: {
    fontWeight: 700,
    minWidth: 130,
  } as CSSProperties,
  tipsterStat: {
    color: '#656d76',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  tipsterPick: {
    marginLeft: 'auto',
    textAlign: 'right' as const,
    color: '#424a53',
  } as CSSProperties,
  tipsterStatusCounts: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
    marginTop: 10,
  } as CSSProperties,
  tipsterStatusCount: {
    fontSize: 12,
    fontWeight: 600,
    color: '#424a53',
    background: '#eaeef2',
    borderRadius: 999,
    padding: '2px 10px',
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  explanationPanel: {
    border: 'none',
    borderTop: '1px dashed #eaeef2',
    borderRadius: 0,
    padding: 0,
    paddingTop: 12,
    marginTop: 12,
    background: 'transparent',
  } as CSSProperties,
  // Mobile / on-course polish: sticky next-race header, warning chips, and a
  // collapsible Alternatives summary. Presentational only.
  nextRace: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 20,
    background: '#fff',
    border: '1px solid #d0d7de',
    borderRadius: 10,
    padding: '10px 14px',
    margin: '12px 0',
    boxShadow: '0 2px 6px rgba(0,0,0,0.10)',
  } as CSSProperties,
  nextRaceTop: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    gap: 8,
  } as CSSProperties,
  nextRaceLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: '#656d76',
  } as CSSProperties,
  nextRaceTime: {
    fontSize: 18,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  nextRaceName: {
    fontSize: 13,
    color: '#656d76',
    marginTop: 4,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  nextRacePick: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'baseline',
    gap: 12,
    marginTop: 6,
    fontSize: 14,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  nextRacePickName: {
    fontWeight: 700,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  altSummary: {
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: '#656d76',
    textTransform: 'uppercase' as const,
  } as CSSProperties,
  nextActionLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: '#656d76',
  } as CSSProperties,
  nextActionHeadline: {
    fontSize: 15,
    fontWeight: 700,
    marginTop: 2,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  nextActionDetail: {
    fontSize: 13,
    color: '#424a53',
    marginTop: 4,
    overflowWrap: 'anywhere' as const,
  } as CSSProperties,
  nextActionCmdRow: {
    marginTop: 8,
  } as CSSProperties,
  nextActionCmdLabel: {
    display: 'block',
    fontSize: 11,
    color: '#656d76',
    marginBottom: 4,
  } as CSSProperties,
  nextActionCmd: {
    display: 'block',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12.5,
    background: '#0d1117',
    color: '#e6edf3',
    border: '1px solid #d0d7de',
    borderRadius: 6,
    padding: '6px 10px',
    overflowX: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  } as CSSProperties,
};

/** A pill style for a "Why" tag, tinted by tone. */
function tagStyle(tone: TagTone): CSSProperties {
  const palette: Record<
    TagTone,
    { bg: string; border: string; color: string }
  > = {
    pos: { bg: '#dafbe1', border: '#aceebb', color: '#1a7f37' },
    neg: { bg: '#ffebe9', border: '#ffcecb', color: '#cf222e' },
    neutral: { bg: '#f6f8fa', border: '#d0d7de', color: '#424a53' },
  };
  const c = palette[tone];
  return {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: c.bg,
    border: `1px solid ${c.border}`,
    color: c.color,
  };
}

/** A pill style for a live race-day status badge, tinted by tone. */
function statusBadgeStyle(tone: StatusTone): CSSProperties {
  const palette: Record<
    StatusTone,
    { bg: string; border: string; color: string }
  > = {
    pos: { bg: '#dafbe1', border: '#aceebb', color: '#1a7f37' },
    neg: { bg: '#ffebe9', border: '#ffcecb', color: '#cf222e' },
    warn: { bg: '#fff8c5', border: '#eac54f', color: '#9a6700' },
    neutral: { bg: '#f6f8fa', border: '#d0d7de', color: '#424a53' },
  };
  const c = palette[tone];
  return {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    background: c.bg,
    border: `1px solid ${c.border}`,
    color: c.color,
  };
}

/** Countdown pill colour: blue while pending, red once off, grey if unknown. */
function countdownStyle(cd: Countdown | null): CSSProperties {
  if (!cd) {
    return { ...styles.countdown, background: '#f6f8fa', color: '#656d76' };
  }
  if (cd.off) {
    return { ...styles.countdown, background: '#ffebe9', color: '#cf222e' };
  }
  return { ...styles.countdown, background: '#ddf4ff', color: '#0969da' };
}

/** A single runner line: "Name — odds (market prob%)". */
function RunnerLine({ runner }: { runner: RaceCardRunner }) {
  return (
    <span>
      <strong>{runner.horse_name}</strong>
      <span style={styles.muted}>
        {' '}
        — {formatOdds(runner.odds)} ({formatProb(runner.market_prob)})
      </span>
    </span>
  );
}

/**
 * Compact "odds updated / model updated X ago" freshness row. Read-only display:
 * it shows recency from the persisted timestamps and flags staleness, but never
 * recomputes any model value. Stale odds use the existing
 * `STALE_ODDS_THRESHOLD_MS`; the model is flagged stale when its persisted
 * data-quality verdict (`runQuality`) is `STALE`.
 */
function FreshnessRow({
  card,
  nowMs,
}: {
  card: RaceCard;
  nowMs: number;
}) {
  // Odds freshness.
  const oddsTime = card.latestOddsSnapshotTime ?? null;
  const oddsAge = formatRelativeAge(oddsTime, nowMs);
  const oddsStale =
    oddsTime != null && isStaleAge(oddsTime, nowMs, STALE_ODDS_THRESHOLD_MS);

  // Model freshness.
  const modelTime = card.latestModelRunTime ?? null;
  const modelAge = formatRelativeAge(modelTime, nowMs);
  const runQuality = (card.observability?.runQuality ?? '').toUpperCase();
  const modelStale = modelTime != null && runQuality === 'STALE';

  // Result freshness: when the race has a recorded result, how long ago it was
  // checked/recorded (read-only; from the persisted result timestamp).
  const resultTime = card.result_time ?? null;
  const resultAge = formatRelativeAge(resultTime, nowMs);

  return (
    <div style={styles.freshnessRow}>
      <span style={oddsStale ? styles.freshStale : styles.freshOk}>
        {oddsTime == null
          ? 'Odds update time unavailable'
          : `Odds updated ${oddsAge.text}${oddsStale ? ' · stale' : ''}`}
      </span>
      <span style={styles.freshSep}>·</span>
      <span style={modelStale ? styles.freshStale : styles.freshOk}>
        {modelTime == null
          ? 'Model has not run yet'
          : `Model updated ${modelAge.text}${modelStale ? ' · stale' : ''}`}
      </span>
      {resultTime != null && (
        <>
          <span style={styles.freshSep}>·</span>
          <span style={styles.freshOk}>{`Results checked ${resultAge.text}`}</span>
        </>
      )}
    </div>
  );
}


/**
 * Read-only live race-day status row. Derives three decision-support badges
 * purely from stored fields (off time, race status, displayed run time) and the
 * current clock — never from a live API call:
 *  - lifecycle state: upcoming -> T−10 -> T−5 -> off -> result pending -> settled
 *  - result status (DB-derivable): pending / settled (never claims "settle-ready",
 *    which is a results:auto concept needing the Free endpoint)
 *  - capture status: whether the displayed model run is the pre-off run
 */
function RaceStatusRow({ card, nowMs }: { card: RaceCard; nowMs: number }) {
  const stateInput = {
    offTime: card.off_time,
    now: nowMs,
    status: card.status ?? null,
  };
  const stateBadge = raceStateBadge(deriveRaceState(stateInput));
  const resultBadge = resultStatusBadge(deriveResultStatus(stateInput));
  const captureBadge = captureStatusBadge(
    deriveCaptureStatus({
      hasModelRun: card.hasModelRun,
      runTime: card.latestModelRunTime ?? null,
      offTime: card.off_time,
    }),
  );

  return (
    <div style={styles.statusRow}>
      <span style={statusBadgeStyle(stateBadge.tone)}>{stateBadge.label}</span>
      <span style={statusBadgeStyle(resultBadge.tone)}>
        {`Result: ${resultBadge.label}`}
      </span>
      <span style={statusBadgeStyle(captureBadge.tone)}>{captureBadge.label}</span>
    </div>
  );
}

/**
 * Compact, sticky "Next race" header for on-course mobile viewing. Shows the
 * soonest upcoming race (or the latest race once all are off) with its time,
 * countdown/state, model pick (odds / EV / confidence) and result status when
 * off/settled. Read-only; reuses the same pure derivations as the cards and
 * never changes the recommendation. Renders nothing when there is no race.
 */
function NextRacePanel({ card, nowMs }: { card: RaceCard | null; nowMs: number }) {
  if (!card) return null;
  const cd = countdownTo(card.off_time, nowMs);
  const stateInput = { offTime: card.off_time, now: nowMs, status: card.status ?? null };
  const state = raceStateBadge(deriveRaceState(stateInput));
  const result = resultStatusBadge(deriveResultStatus(stateInput));
  const pick = card.modelPick;
  const ladder = pick ? cardConfidenceLadder(card, nowMs) : null;
  return (
    <div style={styles.nextRace}>
      <div style={styles.nextRaceTop}>
        <span style={styles.nextRaceLabel}>Next race</span>
        <span style={styles.nextRaceTime}>{formatOffTime(card.off_time)}</span>
        <span style={countdownStyle(cd)}>{cd ? cd.text : 'no time'}</span>
        <span style={statusBadgeStyle(state.tone)}>{state.label}</span>
        {result.label !== '\u2014' && (
          <span style={statusBadgeStyle(result.tone)}>{`Result: ${result.label}`}</span>
        )}
      </div>
      {(card.course || card.race_name) && (
        <div style={styles.nextRaceName}>
          {[card.course, card.race_name].filter(Boolean).join(' \u2014 ')}
        </div>
      )}
      {/* Official locked decision, compact (display-only; the pick below is a
          live diagnostic and never overrides the lock). */}
      {card.lockedDecision && (
        <div style={{ marginTop: 6 }}>
          {card.lockedDecision.decision_status === 'locked_no_bet' && (
            <span style={statusBadgeStyle('neg')}>OFFICIAL LOCKED NO BET</span>
          )}
          {card.lockedDecision.decision_status === 'locked_pick' && (
            <span style={statusBadgeStyle('pos')}>
              {`OFFICIAL LOCKED PICK: ${card.lockedDecision.pick_horse_name ?? '\u2014'}`}
            </span>
          )}
          {card.lockedDecision.decision_status === 'no_run_available' && (
            <span style={statusBadgeStyle('warn')}>
              OFFICIAL LOCK: NO MODEL RUN AVAILABLE
            </span>
          )}
        </div>
      )}
      {pick ? (
        <div style={styles.nextRacePick}>
          {isStakeSuppressed(pick) && <StakeSuppressedBadge />}
          <span style={styles.nextRacePickName}>{pick.horse_name}</span>
          <span>
            <span style={styles.statLabel}>Odds</span>
            {formatOdds(pick.odds)}
          </span>
          <span style={evColorStyle(pick.ev)}>
            <span style={styles.statLabel}>EV</span>
            {formatEv(pick.ev)}
          </span>
          <span
            style={{
              color:
                CONFIDENCE_COLORS[
                  ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)
                ],
              fontWeight: 600,
            }}
          >
            {ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)} conf
          </span>
        </div>
      ) : (
        <div style={styles.nextRacePick}>
          <span style={styles.muted}>
            {card.hasModelRun
              ? 'No qualifying bet for this race.'
              : 'No model pick yet.'}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * True when a model pick's stake is suppressed (0, null, or missing) — the pick
 * is then diagnostic only and must never read as actionable. Display-only.
 */
function isStakeSuppressed(pick: RaceCardPick): boolean {
  return !(typeof pick.stake_amount === 'number' && pick.stake_amount > 0);
}

/** Warn badge shown next to a stake-suppressed model pick. Display-only. */
function StakeSuppressedBadge() {
  return (
    <span style={statusBadgeStyle('neg')}>
      NO BET — stake suppressed / diagnostic only
    </span>
  );
}

/**
 * Official T-minus-5 locked decision panel (display-only, pre-Phase-4 interim).
 * Shows the immutable `locked_race_decisions` state ABOVE the live model pick so
 * the official decision takes visual precedence. Read-only: renders stored
 * fields verbatim, fabricates nothing, and is never a betting instruction.
 */
function LockedDecisionPanel({ ld }: { ld: RaceCardLockedDecision }) {
  const quality = (ld.run_quality ?? '').toUpperCase();
  const qualityDegraded = quality !== '' && quality !== 'OK' && quality !== 'GOOD';
  return (
    <div style={styles.favouriteRow}>
      <div style={styles.sectionLabel}>Official locked decision (T−5)</div>
      {ld.decision_status === 'locked_no_bet' && (
        <div>
          <span style={statusBadgeStyle('neg')}>OFFICIAL LOCKED NO BET</span>
          {ld.no_bet_reason && (
            <span style={{ ...styles.muted, marginLeft: 8 }}>{ld.no_bet_reason}</span>
          )}
        </div>
      )}
      {ld.decision_status === 'locked_pick' && (
        <div>
          <span style={statusBadgeStyle('pos')}>OFFICIAL LOCKED PICK</span>
          <div style={styles.pickStats}>
            <span style={styles.nextRacePickName}>
              {ld.pick_horse_name ?? '—'}
            </span>
            <span>
              <span style={styles.statLabel}>Odds</span>
              {formatOdds(ld.pick_odds)}
            </span>
            <span style={evColorStyle(ld.pick_ev)}>
              <span style={styles.statLabel}>EV</span>
              {formatEv(ld.pick_ev)}
            </span>
            <span>
              <span style={styles.statLabel}>Confidence</span>
              {ld.pick_confidence_label
                ? displayConfidence(ld.pick_confidence_label)
                : '—'}
            </span>
          </div>
          {!(typeof ld.pick_stake === 'number' && ld.pick_stake > 0) && (
            <div style={{ marginTop: 6 }}>
              <StakeSuppressedBadge />
            </div>
          )}
        </div>
      )}
      {ld.decision_status === 'no_run_available' && (
        <div>
          <span style={statusBadgeStyle('warn')}>
            OFFICIAL LOCK: NO MODEL RUN AVAILABLE
          </span>
          <span style={{ ...styles.muted, marginLeft: 8 }}>
            No model run existed at the capture target — unknown, not a no-bet.
          </span>
        </div>
      )}
      {(qualityDegraded || ld.data_quality_short_summary) && (
        <div style={{ marginTop: 6 }}>
          <span style={statusBadgeStyle('warn')}>
            {`Data quality at lock: ${qualityDegraded ? quality : 'see note'}`}
          </span>
          {ld.data_quality_short_summary && (
            <span style={{ ...styles.muted, marginLeft: 8 }}>
              {ld.data_quality_short_summary}
            </span>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#656d76', marginTop: 4 }}>
        Immutable decision locked at T−5 — results never change it. The live
        model below is diagnostic only.
      </div>
    </div>
  );
}

function RaceCardView({ card, nowMs, mlShadow }: { card: RaceCard; nowMs: number; mlShadow?: MlShadowApiRace | null }) {
  const cd = countdownTo(card.off_time, nowMs);
  const pick = card.modelPick;
  const ladder = pick ? cardConfidenceLadder(card, nowMs) : null;
  const tags = pick ? deriveWhyTags(pick) : [];
  const explain = deriveRaceExplanationProps(card.observability);
  const warningChips = buildRaceWarningChips({
    confidenceLabel: ladder ? ladder.label.toLowerCase() : pick?.confidence_label ?? null,
    runQuality: explain.runQuality,
    alignmentLabel: explain.alignmentLabel,
  });
  // Read-only result-settlement view (backend settles; the UI never commits).
  const settlement = buildSettlementView({
    offTime: card.off_time,
    now: nowMs,
    status: card.status ?? null,
    providedStatus: null,
    freeResultNote: null,
    runners: (card.runners ?? []).map((r) => ({
      horse_name: r.horse_name,
      finish_pos: r.finish_pos ?? null,
    })),
    modelPickFinishPos: card.modelPick?.finish_pos ?? null,
  });

  return (
    <article style={styles.card}>
      <header style={styles.cardHeader}>
        <div style={{ minWidth: 0 }}>
          <div style={styles.offTime}>{formatOffTime(card.off_time)}</div>
          {(card.course || card.race_name) && (
            <div style={styles.subtitle}>
              {[card.course, card.race_name].filter(Boolean).join(' \u2014 ')}
            </div>
          )}
        </div>
        <span style={countdownStyle(cd)}>{cd ? cd.text : 'no time'}</span>
      </header>

      {/* Live race-day status: lifecycle state + result + pre-off capture (read-only). */}
      <RaceStatusRow card={card} nowMs={nowMs} />

      {/* At-a-glance warning chips (LOW confidence / DEGRADED data /
          NO_TIPSTER_CONSENSUS), always visible. Read-only, derived from stored
          fields; not a decision input. */}
      {warningChips.length > 0 && (
        <div style={styles.statusRow}>
          {warningChips.map((chip) => (
            <span key={chip.label} style={statusBadgeStyle(chip.tone)}>
              {chip.label}
            </span>
          ))}
        </div>
      )}

      {/* Data freshness: odds + model recency (read-only). */}
      <FreshnessRow card={card} nowMs={nowMs} />

      {/* Result settlement status (read-only; the backend settles, never the UI). */}
      <SettlementStatusPanel view={settlement} style={styles.explanationPanel} />

      {/* Market favourite */}
      <div style={styles.favouriteRow}>
        <div style={styles.sectionLabel}>Market favourite</div>
        {card.favourite ? (
          <RunnerLine runner={card.favourite} />
        ) : (
          <span style={styles.muted}>No market data.</span>
        )}
      </div>

      {/* Official T-minus-5 locked decision (display-only; precedence over the
          live model pick below, which is diagnostic only). Interim pre-Phase-4
          display — no redesign, no write path, no buttons. */}
      {card.lockedDecision && <LockedDecisionPanel ld={card.lockedDecision} />}

      {/* Model pick */}
      <div>
        <div style={styles.sectionLabel}>
          {card.lockedDecision
            ? 'Model pick — live diagnostic (official decision above)'
            : 'Model pick'}
        </div>
        {!card.lockedDecision && (
          <div style={{ fontSize: 11, color: '#656d76', marginBottom: 4 }}>
            Live/pre-off model diagnostic — not official locked decision.
          </div>
        )}
        {pick ? (
          <>
            {isStakeSuppressed(pick) && (
              <div style={{ marginBottom: 4 }}>
                <StakeSuppressedBadge />
              </div>
            )}
            <div style={styles.pickName}>
              {pick.horse_name}
              {pick.isFavourite && (
                <span style={styles.favBadge}>FAVOURITE</span>
              )}
            </div>
            <div style={styles.pickStats}>
              <span>
                <span style={styles.statLabel}>Odds</span>
                {formatOdds(pick.odds)}
              </span>
              <span style={evColorStyle(pick.ev)}>
                <span style={styles.statLabel}>EV</span>
                {formatEv(pick.ev)}
              </span>
              <span>
                <span style={styles.statLabel}>Stake</span>
                {pick.stake_amount.toFixed(2)}
              </span>
              <span
                style={{
                  color:
                    CONFIDENCE_COLORS[
                      ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)
                    ],
                  fontWeight: 600,
                }}
              >
                {ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)} confidence
              </span>
            </div>
            {ladder && (
              <div style={{ fontSize: 11, color: '#656d76', marginTop: 4, lineHeight: 1.4 }}>
                {ladder.reason}
              </div>
            )}
            {tags.length > 0 && (
              <div style={styles.tagRow}>
                <span style={{ ...styles.sectionLabel, marginBottom: 0 }}>
                  Why
                </span>
                {tags.map((t) => (
                  <span key={t.label} style={tagStyle(t.tone)}>
                    {t.label}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : card.hasModelRun ? (
          <span style={styles.muted}>
            No bet — the model ran but found no qualifying pick for this race
            (this is normal, not an error).
          </span>
        ) : (
          <span style={styles.muted}>No model pick for this race yet.</span>
        )}
      </div>

      {/* Alternatives (EV rank 2-3): collapsed by default to keep cards compact
          on mobile. Read-only. */}
      {card.alternatives.length > 0 && (
        <details style={styles.altList}>
          <summary style={styles.altSummary}>
            Alternatives ({card.alternatives.length})
          </summary>
          {card.alternatives.map((alt) => (
            <div key={alt.runner_id} style={styles.altRow}>
              <span style={{ width: 24, color: '#8c959f' }}>
                {alt.rank != null ? `#${alt.rank}` : ''}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                {alt.horse_name}
              </span>
              <span style={{ width: 64, textAlign: 'right' }}>
                {formatOdds(alt.odds)}
              </span>
              <span
                style={{ width: 72, textAlign: 'right', ...evColorStyle(alt.ev) }}
              >
                {formatEv(alt.ev)}
              </span>
            </div>
          ))}
        </details>
      )}

      {/* Race Intelligence: display-only win / value / each-way comparison
          derived from stored per-runner fields. Read-only; does NOT change the
          model pick, probability, EV, staking, or ranking. */}
      <RaceIntelligencePanel
        intel={buildRaceIntelligence({
          runners: card.runners ?? [],
          favourite: card.favourite,
          modelPickRunnerId: card.modelPick?.runner_id ?? null,
          settled: card.status === 'result',
        })}
        settled={card.status === 'result'}
        style={styles.explanationPanel}
      />

      {/* Model explanation: read-only observability from the current run. Renders
          its own empty state when this race has no usable observability. */}
      <RaceExplanationPanel {...explain} style={styles.explanationPanel} />

      {/* AI shadow commentary: read-only, human-approved notes only. Shows a
          neutral placeholder when no candidate has been approved. Display-only;
          never affects the model pick, probability, EV, staking, or ranking.
          A staleness guard hides any note whose pick no longer matches the
          current run or that predates it. */}
      <GenaiCommentaryPanel
        rows={card.genaiCommentary}
        guard={{
          currentModelPickHorse: pick?.horse_name ?? null,
          currentModelRunTime: card.latestModelRunTime ?? null,
        }}
        style={styles.explanationPanel}
      />

      {/* ML shadow comparison: candidate ML pick shown NEXT TO the regular model
          pick and the market favourite. Read-only research overlay from a
          separate endpoint; never model-active, never changes the pick, EV,
          staking, confidence, or the no-bet gate. Absent overlay -> "not
          available" without touching the regular pick. */}
      <MlShadowComparisonPanel
        regular={
          pick
            ? {
                name: pick.horse_name,
                odds: pick.odds,
                ev: pick.ev,
                confidence: pick.confidence_score,
                stake: pick.stake_amount,
              }
            : null
        }
        marketFav={
          card.favourite
            ? {
                name: card.favourite.horse_name,
                odds: card.favourite.odds,
                impliedProb: card.favourite.market_prob,
              }
            : null
        }
        ml={
          mlShadow?.ml_pick
            ? {
                runner_name: mlShadow.ml_pick.runner_name,
                ml_prob: mlShadow.ml_pick.ml_prob,
                ml_rank: mlShadow.ml_pick.ml_rank,
                smallSample: mlShadow.warnings?.small_sample ?? false,
                smallSampleText: mlShadow.warnings?.small_sample_text ?? null,
                dataDiffers: mlShadow.warnings?.data_differs ?? false,
                dataDiffersText: mlShadow.warnings?.data_differs_text ?? null,
              }
            : null
        }
        style={styles.explanationPanel}
      />
    </article>
  );
}

/** Formats an ISO timestamp as a local HH:MM:SS, or a dash when unknown. */
function formatUpdated(iso: string | null): string {
  if (!iso) {
    return '\u2014';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return '\u2014';
  }
  return new Date(ms).toLocaleTimeString();
}

/**
 * Header bar summarising model accuracy: "X/Y winners · strike rate ·
 * profit · ROI", with a last-updated time. Renders nothing until the first
 * snapshot loads.
 *
 * The figures come from {@link selectDashboardSummary}: when the view is scoped
 * to a meeting day/course the bar shows the corrected RACE-DAY performance
 * (pre-off evaluated); otherwise it shows the global LIFETIME accuracy. The
 * legacy lifetime object never overrides a scoped race-day summary.
 */
function AccuracyBar({ summary }: { summary: DashboardSummary | null }) {
  if (!summary) {
    return null;
  }

  const scopeLabel =
    summary.source === 'race_day' ? (
      <span style={styles.accuracyScopeLabel}>
        Race-day performance uses latest pre-off model run.
      </span>
    ) : null;

  if (summary.settled === 0) {
    return (
      <div style={styles.accuracyBar}>
        <span style={styles.muted}>
          No settled races yet — accuracy will appear as results come in.
        </span>
        {summary.computedAt && (
          <span style={styles.accuracyUpdated}>
            updated {formatUpdated(summary.computedAt)}
          </span>
        )}
        {scopeLabel}
      </div>
    );
  }

  return (
    <div style={styles.accuracyBar}>
      <span style={styles.accuracyMetric}>
        {summary.winners}/{summary.settled} winners
      </span>
      <span style={styles.accuracySep}>·</span>
      <span style={styles.accuracyMetric}>
        {summary.strikeRatePct.toFixed(1)}% strike
      </span>
      <span style={styles.accuracySep}>·</span>
      <span
        style={{ ...styles.accuracyMetric, color: profitColor(summary.profitLoss) }}
      >
        {formatProfit(summary.profitLoss)}
      </span>
      <span style={styles.accuracySep}>·</span>
      <span
        style={{ ...styles.accuracyMetric, color: profitColor(summary.roiPct) }}
      >
        {summary.roiPct > 0 ? '+' : summary.roiPct < 0 ? '\u2212' : ''}
        {Math.abs(summary.roiPct).toFixed(1)}% ROI
      </span>
      {summary.computedAt && (
        <span style={styles.accuracyUpdated}>
          updated {formatUpdated(summary.computedAt)}
        </span>
      )}
      {scopeLabel}
    </div>
  );
}

/** Formats a signed percentage like "+12.5%" / "−8.0%" / "0.0%". */
function formatSignedPct(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/**
 * Per-day recommendation performance panel (Phase 5B): settled vs pending,
 * winners/losers, strike rate, P/L and ROI at the stored recommendation
 * odds/stake, plus average EV and no-bet races. Renders nothing until the first
 * snapshot loads; shows the standard empty-state copy until a race settles.
 */
function PerformancePanel({ performance }: { performance: ModelPerformance | null }) {
  if (!performance) {
    return null;
  }

  const scope = performance.course
    ? `${performance.date} · ${performance.course}`
    : performance.date;

  // Mode-aware evaluation note (Phase 5B): says plainly whether the headline
  // figures are the OFFICIAL locked record, a mixed locked/fallback view, or
  // the pre-off fallback only — so a good diagnostic day can never masquerade
  // as a good official day.
  const modeNote =
    performance.officialMode === 'official_locked'
      ? 'OFFICIAL — T-minus-5 locked decisions (all races locked).'
      : performance.officialMode === 'mixed'
        ? `MIXED — official locked decisions for ${performance.lockCoverage?.locked ?? '?'}/${performance.lockCoverage?.races ?? '?'} races; ${performance.lockCoverage?.lock_missing ?? '?'} lock-missing race(s) shown separately under the pre-off fallback.`
        : performance.officialMode === 'fallback_pre_off'
          ? 'FALLBACK — no locked decisions in scope; latest pre-off model run (diagnostic rule).'
          : performance.evaluationMode !== 'current'
            ? 'Performance uses latest model run before scheduled off time.'
            : null;
  const cov = performance.lockCoverage;
  const fallback = performance.fallbackPerformance;

  if (performance.settled_count === 0) {
    return (
      <div style={styles.perfPanel}>
        <div style={styles.perfHeading}>
          <span style={styles.perfTitle}>Recommendation performance</span>
          <span style={styles.perfScope}>{scope}</span>
        </div>
        {modeNote && <div style={styles.perfNote}>{modeNote}</div>}
        <span style={styles.muted}>
          No settled races yet — accuracy will appear as results come in.
        </span>
        {performance.recommendations_total > 0 && (
          <span style={{ ...styles.perfScope, marginLeft: 8 }}>
            {performance.pending_count} pending of {performance.recommendations_total}{' '}
            recommendation{performance.recommendations_total === 1 ? '' : 's'}
          </span>
        )}
        {cov && cov.locked > 0 && (
          <div style={styles.perfNote}>
            {`official no-bet ${cov.locked_no_bet} · no run at lock ${cov.no_run_available} · LOCK MISSING ${cov.lock_missing}`}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={styles.perfPanel}>
      <div style={styles.perfHeading}>
        <span style={styles.perfTitle}>Recommendation performance</span>
        <span style={styles.perfScope}>{scope}</span>
        <span style={{ ...styles.accuracyUpdated }}>
          updated {formatUpdated(performance.computedAt)}
        </span>
      </div>
      {modeNote && <div style={styles.perfNote}>{modeNote}</div>}
      <div style={styles.perfRow}>
        <span style={styles.accuracyMetric}>
          {performance.winners}/{performance.settled_count} winners
        </span>
        <span style={styles.accuracySep}>·</span>
        <span style={styles.accuracyMetric}>
          {performance.strike_rate.toFixed(1)}% strike
        </span>
        <span style={styles.accuracySep}>·</span>
        <span style={{ ...styles.accuracyMetric, color: profitColor(performance.profit_loss) }}>
          {formatProfit(performance.profit_loss)}
        </span>
        <span style={styles.accuracySep}>·</span>
        <span style={{ ...styles.accuracyMetric, color: profitColor(performance.roi) }}>
          {formatSignedPct(performance.roi)} ROI
        </span>
        {performance.average_ev !== null && (
          <>
            <span style={styles.accuracySep}>·</span>
            <span style={{ ...styles.accuracyMetric, ...evColorStyle(performance.average_ev) }}>
              {formatEv(performance.average_ev)} avg EV
            </span>
          </>
        )}
        <span style={styles.accuracySep}>·</span>
        <span style={styles.perfScope}>
          settled {performance.settled_count} · pending {performance.pending_count}
          {performance.no_bet_races > 0 ? ` · ${performance.no_bet_races} no-bet` : ''}
        </span>
      </div>
      {cov && cov.locked > 0 && (
        <div style={styles.perfNote}>
          {`official no-bet ${cov.locked_no_bet} · no run at lock ${cov.no_run_available} · LOCK MISSING ${cov.lock_missing}`}
        </div>
      )}
      {performance.officialMode === 'mixed' && fallback && fallback.settled_count > 0 && (
        <div style={styles.perfNote}>
          {`Fallback (lock-missing races only, NOT official): ${fallback.winners}/${fallback.settled_count} winners · ${formatProfit(fallback.profit_loss)}`}
        </div>
      )}
    </div>
  );
}

/**
 * Tipster-status panel (Phase 4C-lite): a read-only, plain-language summary of
 * the current tipster state — whether approved selections are feeding the model,
 * how many candidate tips are pending review (not model-active until approved),
 * and that "no consensus" means the model is running market-only. The counts and
 * copy come straight from the server; nothing here recomputes a model value.
 */
function TipsterStatusPanel({ status }: { status: TipsterStatusSummary | null }) {
  if (status === null) {
    return null;
  }

  const lines = buildTipsterStatusLines(status);
  const hasCandidateCounts = status.candidatesPending !== null;

  return (
    <section style={styles.panel}>
      <div style={styles.panelTitle}>Tipster status</div>
      {lines.map((line) => (
        <div key={line} style={styles.muted}>
          {line}
        </div>
      ))}
      {(status.approvedSelections !== null || hasCandidateCounts) && (
        <div style={styles.tipsterStatusCounts}>
          {status.approvedSelections !== null && (
            <span style={styles.tipsterStatusCount}>
              {status.approvedSelections} approved selection
              {status.approvedSelections === 1 ? '' : 's'}
            </span>
          )}
          {hasCandidateCounts && (
            <span style={styles.tipsterStatusCount}>
              {status.candidatesPending} pending review
            </span>
          )}
          {status.candidatesApproved !== null && status.candidatesApproved > 0 && (
            <span style={styles.tipsterStatusCount}>
              {status.candidatesApproved} candidate{status.candidatesApproved === 1 ? '' : 's'} approved
            </span>
          )}
          {status.candidatesRejected !== null && status.candidatesRejected > 0 && (
            <span style={styles.tipsterStatusCount}>
              {status.candidatesRejected} rejected
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * "In-form tipsters" panel: the top needles by weight, each with their 30d ROI,
 * all-time ROI, current losing streak, and pick(s) for today's races. Renders
 * nothing until the list loads; shows a hint when the pool is empty.
 */
function InFormPanel({ tipsters }: { tipsters: InFormTipster[] | null }) {
  if (tipsters === null) {
    return null;
  }

  return (
    <section style={styles.panel}>
      <div style={styles.panelTitle}>In-form tipsters</div>
      {tipsters.length === 0 ? (
        <span style={styles.muted}>
          No model-active tipsters yet. These are approved, proofed needles that
          the model weights — separate from candidate tips, which stay in review
          until approved. Run discovery with real proofed figures to populate the
          pool.
        </span>
      ) : (
        tipsters.map((t) => {
          const pick = t.todaysPicks[0];
          const extra = t.todaysPicks.length - 1;
          return (
            <div key={t.tipster_id} style={styles.tipsterRow}>
              <span style={styles.tipsterName}>{t.name}</span>
              <span style={{ ...styles.tipsterStat, color: roiColor(t.recentRoi30d) }}>
                30d {formatRoi(t.recentRoi30d)}
              </span>
              <span style={{ ...styles.tipsterStat, color: roiColor(t.longRunRoi) }}>
                all-time {formatRoi(t.longRunRoi)}
              </span>
              <span style={styles.tipsterStat}>
                streak{' '}
                {t.longestLosingStreak === null ? '\u2014' : t.longestLosingStreak}
              </span>
              <span style={styles.tipsterPick}>
                {pick
                  ? `today: ${pick.horse_name}${extra > 0 ? ` +${extra}` : ''}`
                  : 'no pick today'}
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

/**
 * Live-mode indicator. When the dashboard is scoped to a meeting day/course it
 * auto-refreshes the read-only data on a fixed cadence; this bar surfaces that
 * (a green "Live mode" dot, the cadence, and when the cards last refreshed).
 * Unscoped (global) views show a static-view note instead. Purely presentational
 * — it triggers no fetches or writes itself.
 */
function LiveModeBar({
  scoped,
  cardsUpdatedMs,
  statusUpdatedMs,
  statusError,
  nowMs,
}: {
  scoped: boolean;
  cardsUpdatedMs: number | null;
  statusUpdatedMs: number | null;
  statusError: boolean;
  nowMs: number;
}) {
  const view = buildLiveStatusView({ statusUpdatedMs, cardsUpdatedMs, statusError });
  const refreshedAge = formatRelativeAge(view.refreshedMs, nowMs);
  const refreshSecs = Math.round(RACE_DAY_REFRESH_MS / 1000);
  return (
    <div style={liveBarStyle(scoped)}>
      <span style={liveDotStyle(scoped)} aria-hidden />
      <strong style={{ letterSpacing: 0.3 }}>
        {scoped ? 'Live mode' : 'Static view'}
      </strong>
      <span style={{ color: '#656d76' }}>
        {scoped
          ? `Auto-refreshing read-only data every ${refreshSecs}s`
          : 'Open a specific race day to see live, auto-refreshing data.'}
      </span>
      {scoped && view.refreshedMs != null && (
        <span
          style={{
            color: '#656d76',
            marginLeft: 'auto',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {`Status refreshed ${refreshedAge.text}`}
        </span>
      )}
      {scoped && view.warning && (
        <span style={liveWarningStyle}>{view.warning}</span>
      )}
    </div>
  );
}

const liveWarningStyle: CSSProperties = {
  flexBasis: '100%',
  color: '#9a6700',
  background: '#fff8c5',
  border: '1px solid #eac54f',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12,
};

function liveBarStyle(scoped: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    fontSize: 13,
    padding: '8px 12px',
    borderRadius: 8,
    margin: '12px 0',
    background: scoped ? '#eafff1' : '#f6f8fa',
    border: `1px solid ${scoped ? '#aceebb' : '#d0d7de'}`,
  };
}

function liveDotStyle(scoped: boolean): CSSProperties {
  return {
    display: 'inline-block',
    width: 10,
    height: 10,
    borderRadius: 999,
    background: scoped ? '#1a7f37' : '#afb8c1',
    boxShadow: scoped ? '0 0 0 3px rgba(26,127,55,0.18)' : 'none',
  };
}

/**
 * Persistent safety banner. This dashboard is decision-support only: it never
 * auto-bets, never places bets/orders, and never writes to the database — result
 * settlement is a separate, audited backend command, not a UI action.
 */
function SafetyBanner() {
  return (
    <div style={safetyBannerStyle}>
      <strong>Decision-support only — not betting advice.</strong> No
      auto-betting and no bet placement, and this page is read-only.
      Recommendations are model outputs, not guarantees. During beta, results may
      be settled manually and can lag behind the live race.
    </div>
  );
}

/**
 * Homepage race-day navigation: a prominent link to today's Ascot dashboard and
 * a secondary link to yesterday's results. NAVIGATION ONLY — plain in-app anchors
 * (`/?date=…&course=…`); no backend-route call, no DB write, no wager, no
 * write-mode flag. When unscoped it shows a short "choose a view" prompt.
 */
function RaceDayNav({ scoped }: { scoped: boolean }) {
  return (
    <div style={{ margin: '12px 0 4px' }}>
      {!scoped && (
        <p style={{ margin: '0 0 8px', fontSize: 14, color: '#1f2328' }}>
          {RACE_DAY_NAV_EMPTY_MESSAGE}
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <a href={TODAY_ASCOT_HREF} style={raceDayPrimaryButtonStyle}>
          {VIEW_TODAY_LABEL}
        </a>
        <a href={YESTERDAY_ASCOT_HREF} style={raceDaySecondaryLinkStyle}>
          {VIEW_YESTERDAY_LABEL}
        </a>
      </div>
    </div>
  );
}

const raceDayPrimaryButtonStyle: CSSProperties = {
  display: 'inline-block',
  background: '#1f883d',
  color: '#ffffff',
  fontSize: 15,
  fontWeight: 700,
  padding: '10px 18px',
  borderRadius: 8,
  textDecoration: 'none',
};

const raceDaySecondaryLinkStyle: CSSProperties = {
  fontSize: 13,
  color: '#0969da',
  textDecoration: 'none',
};

const safetyBannerStyle: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.5,
  color: '#573a00',
  background: '#fff8c5',
  border: '1px solid #eac54f',
  borderRadius: 8,
  padding: '8px 12px',
  margin: '0 0 16px',
};

/**
 * Stable no-op subscribe for `useSyncExternalStore`. The URL scope does not
 * change during a page's lifetime, so there is nothing to subscribe to; defined
 * at module scope so the reference is stable across renders.
 */
const subscribeNoop = (): (() => void) => () => {};

/** Reads the {date, course} scope from the URL (client only) for command hints. */
function readScopeFromUrl(): { date: string | null; course: string | null } {
  if (typeof window === 'undefined') return { date: null, course: null };
  const params = new URLSearchParams(window.location.search);
  return { date: params.get('date'), course: params.get('course') };
}

/** Tone -> container style for the next-action widget. */
function nextActionStyle(tone: NextActionTone): CSSProperties {
  const palette: Record<NextActionTone, { bg: string; border: string }> = {
    pos: { bg: '#eafff1', border: '#aceebb' },
    warn: { bg: '#fff8c5', border: '#eac54f' },
    neutral: { bg: '#f6f8fa', border: '#d0d7de' },
  };
  const c = palette[tone];
  return {
    border: `1px solid ${c.border}`,
    background: c.bg,
    borderRadius: 10,
    padding: '10px 14px',
    margin: '12px 0',
  };
}

/**
 * Read-only operator "next action" widget. Shows the single most useful next
 * step as TEXT, plus an optional read-only terminal command SUGGESTION rendered
 * as a non-clickable <code> block (never a button, never a commit flag, never
 * executed from the page). Decision-support only.
 */
function NextActionWidget({ action }: { action: NextAction }) {
  return (
    <div style={nextActionStyle(action.tone)}>
      <span style={styles.nextActionLabel}>Next action</span>
      <div style={styles.nextActionHeadline}>{action.headline}</div>
      <div style={styles.nextActionDetail}>{action.detail}</div>
      {action.suggestedCommand && (
        <div style={styles.nextActionCmdRow}>
          <span style={styles.nextActionCmdLabel}>
            Suggested (read-only — run in a terminal, not from this page):
          </span>
          <code style={styles.nextActionCmd}>{action.suggestedCommand}</code>
        </div>
      )}
    </div>
  );
}

export default function RecommendationsPage() {
  const [cards, setCards] = useState<RaceCard[]>([]);
  // Read-only SHADOW overlay (separate endpoint). race_id -> ML shadow entry.
  // Never model-active; best-effort; absence leaves the regular pick untouched.
  const [mlByRace, setMlByRace] = useState<Record<string, MlShadowApiRace>>({});
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string>('');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [accuracy, setAccuracy] = useState<ModelAccuracy | null>(null);
  const [performance, setPerformance] = useState<ModelPerformance | null>(null);
  const [inForm, setInForm] = useState<InFormTipster[] | null>(null);
  const [tipsterStatus, setTipsterStatus] = useState<TipsterStatusSummary | null>(null);
  // Whether the dashboard URL scopes to a meeting day/course (?date/?day/?course).
  // useSyncExternalStore returns the server snapshot (false) during SSR and the
  // initial hydration render — so there is no hydration mismatch — then switches
  // to the real URL-derived value on the client. When scoped, the header summary
  // uses the corrected race-day `performance` (selectDashboardSummary) and live
  // mode auto-refreshes the read-only cards.
  const scoped = useSyncExternalStore(
    subscribeNoop,
    () => hasRaceDayScope(window.location.search),
    () => false,
  );
  // Epoch ms of the last successful race-card refresh, for the live-mode
  // "data refreshed X ago" indicator. null until the first load completes.
  const [cardsUpdatedMs, setCardsUpdatedMs] = useState<number | null>(null);
  // Consolidated read-only race-day status poll (live mode): last good snapshot,
  // its refresh time, and whether the latest poll failed (non-blocking warning).
  const [statusData, setStatusData] = useState<RaceDayStatusResponse | null>(null);
  const [statusUpdatedMs, setStatusUpdatedMs] = useState<number | null>(null);
  const [statusError, setStatusError] = useState<boolean>(false);

  useEffect(() => {
    const controller = new AbortController();

    async function load(isInitial: boolean) {
      try {
        if (isInitial) {
          setStatus('loading');
        }
        // Forward the dashboard's own URL query (?day / ?date / ?course) to the
        // read API so deep links like /?date=2026-06-16&course=Ascot work.
        const query =
          typeof window !== 'undefined' ? window.location.search : '';
        const res = await fetch(`/api/recommendations${query}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          let message = `Request failed (${res.status})`;
          try {
            const body = await res.json();
            if (body?.error) {
              message = body.error;
            }
          } catch {
            // Non-JSON error body; keep the default message.
          }
          throw new Error(message);
        }

        const data = await res.json();
        const list: RaceCard[] = Array.isArray(data?.races) ? data.races : [];
        setCards(list);
        setCardsUpdatedMs(Date.now());
        setStatus('ready');

        // Read-only SHADOW overlay from a SEPARATE endpoint. Fail-open: any
        // problem leaves the overlay empty and never affects the recommendation
        // cards. This is research-only and never model-active.
        try {
          const mlRes = await fetch(`/api/ml/shadow-comparison${query}`, {
            signal: controller.signal,
          });
          if (mlRes.ok) {
            const mlData = await mlRes.json();
            const mlRaces: MlShadowApiRace[] = Array.isArray(mlData?.races) ? mlData.races : [];
            const map: Record<string, MlShadowApiRace> = {};
            for (const r of mlRaces) {
              if (r && typeof r.race_id === 'string') map[r.race_id] = r;
            }
            setMlByRace(map);
          }
        } catch {
          // Shadow overlay is best-effort; never blocks the dashboard.
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        // Only surface a hard error on the first load; a failed *background*
        // refresh keeps the last good cards on screen (read-only, best-effort).
        if (isInitial) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setStatus('error');
        }
      }
    }

    load(true);
    // Live mode: when scoped to a meeting day/course, auto-refresh the read-only
    // race cards every RACE_DAY_REFRESH_MS so odds/model/result freshness updates
    // without a manual reload. Read-only fetch of an existing endpoint; the UI
    // never writes. Unscoped (global) views load once.
    const refreshId = scoped
      ? setInterval(() => load(false), RACE_DAY_REFRESH_MS)
      : null;
    return () => {
      controller.abort();
      if (refreshId !== null) {
        clearInterval(refreshId);
      }
    };
  }, [scoped]);

  // Drive the live countdowns: tick once per second while showing results.
  useEffect(() => {
    if (status !== 'ready') {
      return;
    }
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // Live model accuracy: fetch on mount, then poll so it updates dynamically
  // as races are settled. The endpoint recomputes from current DB state each
  // call, so polling is enough to reflect new results.
  useEffect(() => {
    const controller = new AbortController();

    async function loadAccuracy() {
      try {
        // Forward ?day / ?date / ?course so the per-day performance panel matches
        // the race list (the lifetime `accuracy` ignores these params).
        const query =
          typeof window !== 'undefined' ? window.location.search : '';
        const res = await fetch(`/api/accuracy${query}`, { signal: controller.signal });
        if (!res.ok) {
          return; // Leave the bar hidden on a transient failure.
        }
        const data = await res.json();
        if (data?.accuracy) {
          setAccuracy(data.accuracy as ModelAccuracy);
        }
        if (data?.performance) {
          setPerformance(data.performance as ModelPerformance);
        }
      } catch {
        // Aborted or network error; keep the last good snapshot.
      }
    }

    loadAccuracy();
    const id = setInterval(loadAccuracy, 30000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  // In-form tipsters: fetch on mount, then poll so it reflects new discovery
  // runs and today's picks as they land.
  useEffect(() => {
    const controller = new AbortController();

    async function loadInForm() {
      try {
        const res = await fetch('/api/tipsters/in-form', {
          signal: controller.signal,
        });
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        if (Array.isArray(data?.tipsters)) {
          setInForm(data.tipsters as InFormTipster[]);
        }
      } catch {
        // Aborted or network error; keep the last good list.
      }
    }

    loadInForm();
    const id = setInterval(loadInForm, 60000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  // Tipster status (Phase 4C-lite): read-only candidate/selection counts so the
  // dashboard can explain the current tipster state. Polls so it reflects new
  // captures + approvals as they land.
  useEffect(() => {
    const controller = new AbortController();

    async function loadTipsterStatus() {
      try {
        const { date, course } = readScopeFromUrl();
        const qs = new URLSearchParams();
        if (date) qs.set('date', date);
        if (course) qs.set('course', course);
        const suffix = qs.toString() ? `?${qs.toString()}` : '';
        const res = await fetch(`/api/tipsters/status${suffix}`, { signal: controller.signal });
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        if (data?.status) {
          setTipsterStatus(data.status as TipsterStatusSummary);
        }
      } catch {
        // Aborted or network error; keep the last good snapshot.
      }
    }

    loadTipsterStatus();
    const id = setInterval(loadTipsterStatus, 60000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  // Live race-day STATUS poll: only scoped date pages poll the consolidated
  // read-only /api/race-day/status endpoint, on the same 30-60s cadence. On
  // failure it KEEPS the last known status + raises a non-blocking warning; the
  // race cards never break (they have their own data, and the page falls back to
  // the client-derived next action). Read-only fetch; no writes, no commands.
  useEffect(() => {
    const scope = readScopeFromUrl();
    if (!scoped || !scope.date) return;
    const controller = new AbortController();

    async function pollStatus() {
      try {
        const query =
          typeof window !== 'undefined' ? window.location.search : '';
        const res = await fetch(`/api/race-day/status${query}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setStatusError(true); // keep last known data (non-blocking warning)
          return;
        }
        const data = (await res.json()) as RaceDayStatusResponse;
        setStatusData(data);
        setStatusUpdatedMs(Date.now());
        setStatusError(false);
      } catch {
        if (controller.signal.aborted) return;
        setStatusError(true); // keep last known data (non-blocking warning)
      }
    }

    pollStatus();
    const id = setInterval(pollStatus, RACE_DAY_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [scoped]);

  // Scoped race-day views render the same figures in the PerformancePanel below,
  // so the top AccuracyBar would duplicate them. Hide the bar when the summary is
  // race-day scoped; keep it for the unscoped lifetime/global view.
  const dashboardSummary = selectDashboardSummary(accuracy, performance, scoped);
  // The soonest upcoming race (or the latest once all are off) for the sticky
  // on-course "Next race" header. Read-only derivation from the loaded cards.
  const nextRace = status === 'ready' ? selectNextRace(cards, nowMs) : null;
  // Read-only operational timeline derived from the already-loaded cards (no new
  // fetch / API route). Stored DB state only; never written from here.
  const timeline =
    status === 'ready'
      ? buildRaceDayTimeline(
          cards.map((c) => ({
            race_id: c.race_id,
            off_time: c.off_time,
            race_name: c.race_name,
            course: c.course,
            oddsUpdatedAt: c.latestOddsSnapshotTime ?? null,
            modelUpdatedAt: c.latestModelRunTime ?? null,
            hasModelRun: c.hasModelRun,
            status: c.status ?? null,
            resultTime: c.result_time ?? null,
            runQuality: c.observability?.runQuality ?? null,
            lockedDecisionStatus: c.lockedDecision?.decision_status ?? null,
          })),
          nowMs,
        )
      : [];
  // Read-only place / each-way RESEARCH summary for the day (simulated top-N
  // marker only). Derived client-side from the already-loaded cards (no new
  // fetch / API route); reuses the pure `place:audit` counting helpers. Never
  // computes a payout and never writes the database.
  const placeAuditView =
    status === 'ready' && cards.length > 0
      ? buildPlaceAuditView(
          cards.map((c) => ({
            race_id: c.race_id,
            off_time: c.off_time,
            race_name: c.race_name,
            course: c.course,
            modelPick: c.modelPick
              ? {
                  runner_id: c.modelPick.runner_id,
                  horse_name: c.modelPick.horse_name,
                  finish_pos: c.modelPick.finish_pos ?? null,
                }
              : null,
            favourite: c.favourite
              ? {
                  runner_id: c.favourite.runner_id,
                  horse_name: c.favourite.horse_name,
                  finish_pos: c.favourite.finish_pos ?? null,
                }
              : null,
            alternatives: c.alternatives.map((a) => ({
              runner_id: a.runner_id,
              horse_name: a.horse_name,
              finish_pos: a.finish_pos ?? null,
            })),
            runners: (c.runners ?? []).map((r) => ({
              runner_id: r.runner_id,
              horse_name: r.horse_name,
              finish_pos: r.finish_pos ?? null,
            })),
            status: c.status ?? null,
            confidenceLabel: c.modelPick?.confidence_label ?? null,
            runQuality: c.observability?.runQuality ?? null,
          })),
        )
      : null;
  // Read-only operator "next action" suggestion derived from stored race state.
  const nextAction =
    status === 'ready'
      ? deriveNextAction(
          cards.map((c) => ({ off_time: c.off_time, status: c.status ?? null })),
          nowMs,
          readScopeFromUrl(),
        )
      : null;
  // Prefer the server-derived next action from the consolidated status API when
  // available (authoritative); fall back to the client-derived one.
  const effectiveNextAction = statusData?.nextAction ?? nextAction;

  // Read-only "Proof of Update" view derived from the already-loaded cards (no
  // new fetch / API route, no DB writes). Audit-only signals not known to the UI
  // (results source, training capture) render as "unknown" / "not available" and
  // never imply success; GenAI live generation is off by default (shadow-only).
  const proofScope = readScopeFromUrl();
  const proofPanelView =
    status === 'ready'
      ? buildProofPanelView({
          date: proofScope.date,
          course: proofScope.course,
          now: nowMs,
          races: cards.map((c) => {
            const runners = c.runners ?? [];
            return {
              offTime: c.off_time,
              fieldSize: runners.length,
              latestOddsSnapshotTime: c.latestOddsSnapshotTime ?? null,
              latestModelRunTime: c.latestModelRunTime ?? null,
              hasModelRun: c.hasModelRun ?? false,
              status: c.status ?? null,
              finishPosAvailable: runners.some(
                (r) => typeof r.finish_pos === 'number' && Number.isFinite(r.finish_pos),
              ),
              // Live official T-minus lock status (Phase 6A; read-only).
              lockStatus: deriveRaceLockStatus(
                c.lockedDecision?.decision_status ?? null,
                c.off_time,
                nowMs,
              ),
            };
          }),
          runnersCount: cards.reduce((n, c) => n + (c.runners ?? []).length, 0),
          genai: { status: 'not_configured' },
        })
      : null;

  return (
    <main style={styles.page}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: 0 }}>
          Race-Day Recommendations
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: '#0550ae',
              background: '#ddf4ff',
              border: '1px solid #b6e3ff',
              borderRadius: 999,
              padding: '2px 8px',
              textTransform: 'uppercase',
            }}
          >
            Beta
          </span>
        </h1>
        <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <a href="/how-it-works" style={{ fontSize: 14, color: '#0969da', textDecoration: 'none' }}>
            How it works
          </a>
          <a href="/leaderboard" style={{ fontSize: 14, color: '#0969da', textDecoration: 'none' }}>
            Tipster Leaderboard →
          </a>
        </span>
      </div>
      <p
        style={{
          margin: '4px 0 0',
          fontSize: 14,
          color: '#57606a',
          overflowWrap: 'anywhere',
        }}
      >
        Model and tipster analysis for UK &amp; Irish racing — decision-support
        only, not betting advice. Recommendations are model outputs, not
        guarantees.
      </p>

      <LiveModeBar
        scoped={scoped}
        cardsUpdatedMs={cardsUpdatedMs}
        statusUpdatedMs={statusUpdatedMs}
        statusError={statusError}
        nowMs={nowMs}
      />
      <SafetyBanner />

      <RaceDayNav scoped={scoped} />

      <NextRacePanel card={nextRace} nowMs={nowMs} />

      {effectiveNextAction && <NextActionWidget action={effectiveNextAction} />}

      {shouldShowAccuracyBar(dashboardSummary) && (
        <AccuracyBar summary={dashboardSummary} />
      )}

      <PerformancePanel performance={performance} />

      <TipsterStatusPanel status={tipsterStatus} />

      <InFormPanel tipsters={inForm} />

      {status === 'ready' && proofPanelView && (
        <ProofOfUpdatePanel view={proofPanelView} />
      )}

      {status === 'loading' && (
        <p style={styles.muted}>Loading recommendations…</p>
      )}

      {status === 'error' && (
        <p style={{ color: EV_NEGATIVE_COLOR }}>
          Couldn&apos;t load recommendations right now. Please refresh to try
          again.{error ? ` (${error})` : ''}
        </p>
      )}

      {status === 'ready' && cards.length === 0 && (
        <p style={styles.muted}>No races available for this day yet.</p>
      )}

      {status === 'ready' && cards.length > 0 && (
        <RaceTimelinePanel entries={timeline} nowMs={nowMs} />
      )}

      {status === 'ready' && cards.length > 0 && placeAuditView && (
        <PlaceAuditPanel view={placeAuditView} />
      )}

      {status === 'ready' && cards.length > 0 && (
        <div style={styles.cardList}>
          {cards.map((card) => (
            <RaceCardView key={card.race_id} card={card} nowMs={nowMs} mlShadow={mlByRace[card.race_id] ?? null} />
          ))}
        </div>
      )}
    </main>
  );
}
