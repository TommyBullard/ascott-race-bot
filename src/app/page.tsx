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
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/UiPrimitives';
import RaceExplanationPanel from '@/components/RaceExplanationPanel';
import RaceIntelligencePanel from '@/components/RaceIntelligencePanel';
import RaceTimelinePanel from '@/components/RaceTimelinePanel';
import SettlementStatusPanel from '@/components/SettlementStatusPanel';
import PlaceAuditPanel from '@/components/PlaceAuditPanel';
import ProofOfUpdatePanel from '@/components/ProofOfUpdatePanel';
import CommandCentrePanel from '@/components/CommandCentrePanel';
import { buildCommandCentre } from '@/lib/commandCentre';
import DecisionConsolePanel from '@/components/DecisionConsolePanel';
import { buildDecisionConsole } from '@/lib/decisionConsole';
import GenaiCommentaryPanel from '@/components/GenaiCommentaryPanel';
import MlShadowComparisonPanel from '@/components/MlShadowComparisonPanel';
import type { GenaiCommentaryRow } from '@/lib/genaiCommentaryView';
import {
  buildRaceDayNavView,
  isAllCoursesMode,
  ALL_COURSES_BANNER_MESSAGE,
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
import { cardConfidenceDiagnostic } from '@/lib/confidenceCardDiagnostics';
import type { ConfidenceComponent } from '@/lib/confidenceDiagnostics';
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
  /** `races.handicap_flag`, or null/absent when unrecorded. Display-only. */
  isHandicap?: boolean | null;
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
    /** No lock row AND the window has passed (post-off) — a factual gap. */
    lock_missing: number;
    /** No lock row but the window is still open — expected (Phase 5C). */
    not_locked_yet?: number;
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

/**
 * TEMPORARY legacy-light compatibility surface for the page wrapper.
 *
 * The value matches the current LIGHT value of `--rb-bg-app` in
 * `src/styles/tokens.css`. It is deliberately a fixed literal and does NOT
 * automatically track that token — the contrast test detects drift between the
 * two, but nothing here follows the token at runtime. That is the point: the
 * whole purpose of this constant is to stay light when the token goes dark.
 *
 * WHY THIS EXISTS. This page is still a legacy light-only design: it renders
 * hard-coded light surfaces (`styles.card`, `styles.panel`, `styles.nextRace`
 * at `#fff`; `styles.accuracyBar`, `styles.perfPanel` at `#f6f8fa`; plus
 * tinted banners) with hard-coded dark foregrounds. Two facts follow:
 *
 *   - Leaving this wrapper TRANSPARENT lets it sit on the shell's `.rb-app`
 *     background, which is `#12161c` under `prefers-color-scheme: dark`.
 *     Text inheriting `styles.page`'s `#1f2328` then renders at ~1.15:1 —
 *     effectively invisible.
 *   - Replacing that foreground with dark-aware `--rb-text-*` tokens is NOT a
 *     safe fix on its own. Those tokens become light in the dark scheme, and
 *     the child surfaces above are still hard-coded light, so the text would
 *     land light-on-light (~1.13:1 on `#fff`). A foreground may only migrate
 *     together with its own containing surface.
 *
 * Pinning an opaque light surface here keeps every existing foreground on the
 * light background it was designed and measured against, in BOTH schemes.
 *
 * THIS IS TRANSITIONAL, NOT DARK-MODE SUPPORT. It is contrast containment, not
 * a native dark homepage, not a completed token migration, and not a new
 * permanent design token.
 *
 * REMOVAL CONDITION. Delete this constant and the `background` on
 * `styles.page` once every homepage region — the cards, the panels, the tinted
 * banners and the imported panel components — has completed PAIRED
 * foreground/surface migration onto `--rb-*` tokens. Until then, removing it
 * reintroduces the ~1.15:1 failure.
 */
const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';

const EV_POSITIVE_COLOR = '#1a7f37';
const EV_NEGATIVE_COLOR = '#cf222e';

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

/*
 * SEMANTIC CLASSES FOR THE MIGRATED RACE-CARD CORE (evidence part 2b-i).
 *
 * These replace `evColorStyle`, `CONFIDENCE_COLORS` and `componentColor`, which
 * returned hard-coded light-scheme literals and are now deleted — the race card
 * was their last consumer. `EV_POSITIVE_COLOR` / `EV_NEGATIVE_COLOR` survive
 * because `roiColor` (the tipster panels, still legacy) genuinely still uses
 * them.
 *
 * Three regimes coexisted during part 2a; the card now joins the token side, so
 * the split is by REGION rather than by regime: `evClassSummary` on the part 1
 * summary panels, `evClassNextRace` on the sticky next-race card, and these on
 * the race cards. They return the same shared classes and are kept separate
 * only so a later change to one region cannot silently repaint another.
 */
function evClassRaceCard(ev: number | null): string {
  if (ev !== null && ev > 0) {
    return 'rb-ev--positive';
  }
  if (ev !== null && ev < 0) {
    return 'rb-ev--negative';
  }
  return 'rb-ev--neutral';
}

/**
 * Confidence band -> token class for the race card. `Record` rather than an
 * if/else chain so a new `ConfidenceLabel` member fails the build here instead
 * of silently taking the failure colour.
 */
const RACE_CARD_CONFIDENCE_CLASSES: Record<ConfidenceLabel, string> = {
  High: 'rb-conf--high',
  Medium: 'rb-conf--medium',
  Low: 'rb-conf--low',
};

function confidenceClassRaceCard(label: ConfidenceLabel): string {
  return RACE_CARD_CONFIDENCE_CLASSES[label];
}

/**
 * Diagnostic component level -> token class. `ConfidenceLevel` is a CLOSED
 * four-member union that really does include `unknown`, and the breakdown panel
 * renders that case, so `rb-conf--unknown` ships with a genuine consumer. It
 * maps to muted text rather than a status colour: an absent signal must not be
 * dressed as a weak one. This map replaces `componentColor`'s `#8c959f`.
 */
const RACE_CARD_COMPONENT_CLASSES: Record<ConfidenceComponent['level'], string> = {
  high: 'rb-conf--high',
  medium: 'rb-conf--medium',
  low: 'rb-conf--low',
  unknown: 'rb-conf--unknown',
};

function componentClassRaceCard(level: ConfidenceComponent['level']): string {
  return RACE_CARD_COMPONENT_CLASSES[level];
}

/**
 * Collapsible, closed-by-default "why this confidence?" breakdown — the same
 * six-component decomposition `npm run confidence:audit` computes offline,
 * reused verbatim client-side via the pure `cardConfidenceDiagnostic`. Purely
 * explanatory: renders already-computed signals only, never changes the pick,
 * stake, probability, or the label shown above it. Returns null when there is
 * no model pick to explain.
 */
function ConfidenceBreakdownPanel({ card, nowMs }: { card: RaceCard; nowMs: number }) {
  const diag = cardConfidenceDiagnostic(card, nowMs);
  if (!diag) return null;

  const rows: Array<[string, ConfidenceComponent]> = [
    ['Data', diag.data],
    ['Market', diag.market],
    ['Tipster', diag.tipster],
    ['Contextual', diag.contextual],
    ['Race type', diag.race_type],
    ['Execution', diag.execution],
  ];

  return (
    <details className="rb-evidence-section-rule" style={styles.altList}>
      <summary className="rb-evidence-muted" style={styles.altSummary}>
        Why this confidence?
      </summary>
      <div className="rb-evidence-secondary" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
        Original label: <strong>{diag.original_confidence_label ?? '—'}</strong>
        {' · '}
        Diagnostic view:{' '}
        <strong className={componentClassRaceCard(diag.overall.level)}>
          {diag.overall.level === 'unknown' ? '—' : diag.overall.level.toUpperCase()}
        </strong>
        <div className="rb-evidence-muted" style={{ marginTop: 2 }}>{diag.overall.reason}</div>
      </div>
      {rows.map(([label, c]) => (
        <div key={label} className="rb-evidence-secondary" style={styles.altRow}>
          <span style={{ width: 68, flexShrink: 0 }}>{label}</span>
          <span
            className={componentClassRaceCard(c.level)}
            style={{ width: 52, flexShrink: 0, fontWeight: 700 }}
          >
            {c.level === 'unknown' ? '—' : c.level.toUpperCase()}
          </span>
          <span
            className="rb-evidence-muted"
            style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
          >
            {c.reason}
          </span>
        </div>
      ))}
      <div className="rb-evidence-muted" style={{ fontSize: 11, marginTop: 8 }}>
        Read-only explanation of the model&apos;s own confidence signals. Never changes the pick,
        stake, or probability.
      </div>
    </details>
  );
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

/*
 * `evColorStyle` was deleted in evidence part 2b-i. Its last three consumers
 * (LockedDecisionPanel, the live model pick and the alternatives rows) now use
 * `evClassRaceCard`. The weight it carried is preserved by the classes
 * themselves: `.rb-ev--positive` and `.rb-ev--negative` declare
 * `font-weight: 700` while `.rb-ev--neutral` declares none, reproducing the old
 * helper's `{}` fall-through exactly.
 */

/** Formats a points P/L as a signed value to 2dp (e.g. "+3.50pt", "-1.00pt"). */
function formatProfit(points: number): string {
  const sign = points > 0 ? '+' : points < 0 ? '\u2212' : '';
  return `${sign}${Math.abs(points).toFixed(2)}pt`;
}

/**
 * P/L or ROI -> token-backed class, for the MIGRATED SUMMARY SURFACES ONLY.
 *
 * SLICE 3D part 1. This REPLACES the former `profitColor`, which has been
 * removed: all four of its call sites (AccuracyBar ×2, PerformancePanel ×2)
 * were inside this migration, so it had no remaining consumer. `roiColor` is
 * the separate legacy helper that still serves the out-of-scope InFormPanel,
 * and it — with `EV_POSITIVE_COLOR` / `EV_NEGATIVE_COLOR` — is untouched.
 *
 * Branch conditions are identical; zero is a genuine neutral outcome, not a
 * missing one, so it takes the neutral class rather than a status colour.
 */
function profitClass(points: number): string {
  if (points > 0) {
    return 'rb-ev--positive';
  }
  if (points < 0) {
    return 'rb-ev--negative';
  }
  return 'rb-ev--neutral';
}

/**
 * EV -> token-backed class, for the MIGRATED NEXT-RACE SURFACE ONLY.
 *
 * SLICE 3D part 2a. A third semantic helper exists on purpose, one per surface
 * regime: `evClassSummary` for the part 1 summary panels, this for the
 * next-race panel, and the legacy `evColorStyle` for the race-card core that
 * part 2b migrates. Each is used exclusively inside a region that owns a
 * matching surface, so none can put a dark-aware token colour on a legacy light
 * surface (~2.30:1) or a legacy colour on a token surface (~2.92:1).
 *
 * Branch conditions are identical to `evColorStyle`, except that its `{}`
 * fall-through — which silently inherited — becomes an explicit neutral class.
 * Part 2b folds the remaining race-card sites into a single helper.
 */
function evClassNextRace(ev: number | null): string {
  if (ev !== null && ev > 0) {
    return 'rb-ev--positive';
  }
  if (ev !== null && ev < 0) {
    return 'rb-ev--negative';
  }
  return 'rb-ev--neutral';
}

/**
 * Confidence band -> token-backed class, for the NEXT-RACE SURFACE ONLY.
 *
 * SLICE 3D part 2a. Mirrors the legacy `CONFIDENCE_COLORS` lookup exactly, and
 * deliberately mirrors its SHAPE too: a `Record<ConfidenceLabel, string>` is
 * exhaustive at compile time, so adding a member to `ConfidenceLabel` fails the
 * build here until this map is extended on purpose. An if/else chain with a
 * default would instead have routed a new band silently to the failure colour.
 *
 * `ladderToDisplay` and `displayConfidence` are both total over
 * High | Medium | Low, so no `unknown` class is reachable on this surface. The
 * legacy map stays for the race-card core.
 */
const NEXT_RACE_CONFIDENCE_CLASSES: Record<ConfidenceLabel, string> = {
  High: 'rb-conf--high',
  Medium: 'rb-conf--medium',
  Low: 'rb-conf--low',
};

function confidenceClassNextRace(label: ConfidenceLabel): string {
  return NEXT_RACE_CONFIDENCE_CLASSES[label];
}

/**
 * EV -> token-backed class, for the MIGRATED SUMMARY SURFACES ONLY.
 *
 * SLICE 3D part 1 deliberately introduces this ALONGSIDE `evColorStyle` rather
 * than replacing it. `evColorStyle` still serves four race-card call sites that
 * sit on the legacy `#fff` card surface, which part 2 migrates.
 *
 * Two helpers coexist on purpose, and this is NOT a partial pairing: each one
 * is used exclusively within a region that owns a matching surface regime, so
 * neither ever puts a dark-aware token colour on a legacy light surface
 * (~2.30:1) nor a legacy colour on a token surface (~2.92:1). Part 2 retires
 * `evColorStyle` and folds its call sites into this helper.
 */
function evClassSummary(ev: number | null): string {
  if (ev !== null && ev > 0) {
    return 'rb-ev--positive';
  }
  if (ev !== null && ev < 0) {
    return 'rb-ev--negative';
  }
  return 'rb-ev--neutral';
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
    // Temporary contrast containment — see LEGACY_LIGHT_PAGE_SURFACE.
    background: LEGACY_LIGHT_PAGE_SURFACE,
  } as CSSProperties,
  cardList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  } as CSSProperties,
  /*
   * SLICE 3D part 2b-i: surface, border, radius and foreground now come from
   * the paired `rb-evidence-panel` class — the SAME class the part 1 summary
   * panels use, because both are raised evidence regions. Only geometry
   * remains inline. (The sticky next-race panel deliberately stays on
   * `rb-evidence-card`/elevated so it reads as lifted above these.)
   */
  card: {
    padding: 16,
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  } as CSSProperties,
  /* SLICE 3D part 2b-i: rule supplied by `rb-evidence-header-rule`. */
  cardHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 8,
    marginBottom: 12,
  } as CSSProperties,
  offTime: {
    fontSize: 22,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  /* SLICE 3D part 2b-i: colour supplied by `rb-evidence-muted` at the call site. */
  subtitle: {
    fontSize: 13,
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
  /* SLICE 3D part 2b-i: colour supplied by `rb-evidence-muted` at the call site. */
  freshOk: {} as CSSProperties,
  freshStale: {
    color: '#9a6700',
    fontWeight: 700,
    background: '#fff8c5',
    border: '1px solid #eac54f',
    borderRadius: 999,
    padding: '1px 8px',
  } as CSSProperties,
  /*
   * SLICE 3D part 2b-i: the lone `#afb8c1` faint tier folds into
   * `rb-evidence-muted` rather than earning a third text token — one separator
   * glyph does not justify a distinct tier.
   */
  freshSep: {} as CSSProperties,
  /* SLICE 3D part 2b-i: colour supplied by `rb-evidence-muted` at the call site. */
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
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
  /*
   * SLICE 3D part 2b-i: `statLabel` is DELETED. It combined a legacy colour
   * with a 4px right margin, and an inline colour always beats a class, so it
   * could never be overridden per-region. Part 2a forked the two next-race
   * sites; part 2b-i moves the last six (LockedDecisionPanel ×3, the live model
   * pick ×3) to `rb-evidence-muted` plus the same structural margin, leaving
   * the key with no consumer.
   */
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
  /* SLICE 3D part 2b-i: rule supplied by `rb-evidence-section-rule`. */
  altList: {
    marginTop: 12,
    paddingTop: 8,
  } as CSSProperties,
  /* SLICE 3D part 2b-i: colour supplied by `rb-evidence-secondary` at the call site. */
  altRow: {
    display: 'flex',
    gap: 12,
    fontSize: 13,
    padding: '2px 0',
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  muted: {
    color: '#656d76',
  } as CSSProperties,
  /*
   * SLICE 3D part 1: surface, border, radius and foreground now come from the
   * paired `rb-evidence-panel` class. Only GEOMETRY remains inline — the
   * compact wrapping row, its gap and the tabular figures are unchanged.
   */
  accuracyBar: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'baseline',
    gap: 14,
    padding: '10px 14px',
    marginBottom: 16,
    fontSize: 14,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  accuracyMetric: {
    fontWeight: 700,
  } as CSSProperties,
  /*
   * SLICE 3D part 1: these three carry the migrated summary surfaces' text, so
   * their colour moves to `rb-evidence-muted` at the call site and only
   * structure remains here. `marginLeft: auto` and `flexBasis: 100%` are the
   * load-bearing layout for the bar and are preserved exactly.
   */
  accuracySep: {} as CSSProperties,
  accuracyUpdated: {
    marginLeft: 'auto',
    fontSize: 12,
    fontWeight: 400,
  } as CSSProperties,
  accuracyScopeLabel: {
    flexBasis: '100%',
    fontSize: 12,
    fontStyle: 'italic' as const,
    fontWeight: 400,
  } as CSSProperties,
  /* SLICE 3D part 1: paired via `rb-evidence-panel`; geometry only inline. */
  perfPanel: {
    padding: '10px 14px',
    marginBottom: 16,
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
  /* SLICE 3D part 1: colour supplied by `rb-evidence-muted` at the call site. */
  perfScope: {
    fontSize: 12,
  } as CSSProperties,
  /* SLICE 3D part 1: colour supplied by `rb-evidence-muted` at the call site. */
  perfNote: {
    fontSize: 12,
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
    // SLICE 3D.4a: explicit legacy foreground (previously inherited). Shared by
    // TipsterStatusPanel and InFormPanel — one definition, two regions.
    color: '#1f2328',
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
  /*
   * The style spread over ALL FIVE nested race-card panels.
   *
   * SLICE 3D part 2b-ii: STRUCTURAL ONLY. Part 2b-i had to pin a temporary
   * white surface plus the legacy primary foreground here, because the five
   * panel files still carried hard-coded legacy colours while the card root had
   * become dark-aware. Those files now declare token foregrounds of their own,
   * so the containment is deleted and the panels simply inherit the paired
   * `rb-evidence-panel` card again — in both schemes.
   *
   * `background: 'transparent'` is declared EXPLICITLY rather than omitted: this
   * object is spread LAST over each panel's own style, and stating the override
   * keeps the "nested panels do not own a surface" contract visible and
   * testable. The dashed rule follows `--rb-border` for the same reason the
   * card's own separators do — a fixed near-white hairline reads as a bright
   * seam on the dark surface. (`--rb-border` is not a foreground token, so it
   * is outside the `var(--rb-text|status|accent-*)` prohibition this file is
   * still under.)
   */
  explanationPanel: {
    border: 'none',
    borderTop: '1px dashed var(--rb-border)',
    borderRadius: 0,
    padding: 0,
    paddingTop: 12,
    marginTop: 12,
    background: 'transparent',
  } as CSSProperties,
  // Mobile / on-course polish: sticky next-race header, warning chips, and a
  // collapsible Alternatives summary. Presentational only.
  /*
   * SLICE 3D part 2a: surface, border, radius and foreground now come from the
   * paired `rb-evidence-card` class. POSITIONING STAYS HERE deliberately —
   * `position: 'sticky'`, `top` and `zIndex` are pinned by appShellAdoption
   * test 29e against this literal, and the stickiness contract must not move
   * into a stylesheet where that test cannot see it.
   */
  nextRace: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 20,
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
  /* SLICE 3D part 2a: colour supplied by `rb-evidence-muted` at the call site. */
  nextRaceLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  } as CSSProperties,
  nextRaceTime: {
    fontSize: 18,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  /* SLICE 3D part 2a: colour supplied by `rb-evidence-muted` at the call site. */
  nextRaceName: {
    fontSize: 13,
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
  /* SLICE 3D part 2b-i: colour supplied by `rb-evidence-muted` at the call site. */
  altSummary: {
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
  } as CSSProperties,
  // SLICE 3D (phase 1): `nextActionLabel`, `nextActionHeadline` and
  // `nextActionDetail` were replaced by the paired `rb-status-frame__*` classes.
  // The command row below stays bespoke — see NextActionWidget.
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
      <span className="rb-evidence-muted">
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
      <span
        className={oddsStale ? undefined : 'rb-evidence-muted'}
        style={oddsStale ? styles.freshStale : styles.freshOk}
      >
        {oddsTime == null
          ? 'Odds update time unavailable'
          : `Odds updated ${oddsAge.text}${oddsStale ? ' · stale' : ''}`}
      </span>
      <span className="rb-evidence-muted" style={styles.freshSep}>·</span>
      <span
        className={modelStale ? undefined : 'rb-evidence-muted'}
        style={modelStale ? styles.freshStale : styles.freshOk}
      >
        {modelTime == null
          ? 'Model has not run yet'
          : `Model updated ${modelAge.text}${modelStale ? ' · stale' : ''}`}
      </span>
      {resultTime != null && (
        <>
          <span className="rb-evidence-muted" style={styles.freshSep}>·</span>
          <span className="rb-evidence-muted" style={styles.freshOk}>
            {`Results checked ${resultAge.text}`}
          </span>
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
    <div className="rb-evidence-card" style={styles.nextRace}>
      <div style={styles.nextRaceTop}>
        <span className="rb-evidence-muted" style={styles.nextRaceLabel}>Next race</span>
        <span style={styles.nextRaceTime}>{formatOffTime(card.off_time)}</span>
        <span style={countdownStyle(cd)}>{cd ? cd.text : 'no time'}</span>
        <span style={statusBadgeStyle(state.tone)}>{state.label}</span>
        {result.label !== '\u2014' && (
          <span style={statusBadgeStyle(result.tone)}>{`Result: ${result.label}`}</span>
        )}
      </div>
      {(card.course || card.race_name) && (
        <div className="rb-evidence-muted" style={styles.nextRaceName}>
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
            {/*
              `styles.statLabel` carries a legacy colour and is SHARED with the
              still-legacy LockedDecisionPanel and RaceCardView. An inline
              colour would beat the token class, so this surface uses the
              label's structural margin only and takes its colour from the
              class. The shared key itself is left untouched for part 2b.
            */}
            <span className="rb-evidence-muted" style={{ marginRight: 4 }}>Odds</span>
            {formatOdds(pick.odds)}
          </span>
          <span className={evClassNextRace(pick.ev)}>
            <span className="rb-evidence-muted" style={{ marginRight: 4 }}>EV</span>
            {formatEv(pick.ev)}
          </span>
          <span
            className={confidenceClassNextRace(
              ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)
            )}
            style={{ fontWeight: 600 }}
          >
            {ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)} conf
          </span>
        </div>
      ) : (
        <div style={styles.nextRacePick}>
          <span className="rb-evidence-muted">
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
    <div className="rb-status-frame rb-status-frame--official" style={{ fontSize: 14 }}>
      <div className="rb-evidence-muted" style={styles.sectionLabel}>
        Official locked decision (T−5)
      </div>
      {ld.decision_status === 'locked_no_bet' && (
        <div>
          <span style={statusBadgeStyle('neg')}>OFFICIAL LOCKED NO BET</span>
          {ld.no_bet_reason && (
            <span className="rb-evidence-muted" style={{ marginLeft: 8 }}>
              {ld.no_bet_reason}
            </span>
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
              <span className="rb-evidence-muted" style={{ marginRight: 4 }}>Odds</span>
              {formatOdds(ld.pick_odds)}
            </span>
            <span className={evClassRaceCard(ld.pick_ev)}>
              <span className="rb-evidence-muted" style={{ marginRight: 4 }}>EV</span>
              {formatEv(ld.pick_ev)}
            </span>
            <span>
              <span className="rb-evidence-muted" style={{ marginRight: 4 }}>Confidence</span>
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
          <span className="rb-evidence-muted" style={{ marginLeft: 8 }}>
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
            <span className="rb-evidence-muted" style={{ marginLeft: 8 }}>
              {ld.data_quality_short_summary}
            </span>
          )}
        </div>
      )}
      <div className="rb-evidence-muted" style={{ fontSize: 11, marginTop: 4 }}>
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
    <article className="rb-evidence-panel" style={styles.card}>
      <header className="rb-evidence-header-rule" style={styles.cardHeader}>
        <div style={{ minWidth: 0 }}>
          <div style={styles.offTime}>{formatOffTime(card.off_time)}</div>
          {(card.course || card.race_name) && (
            <div className="rb-evidence-muted" style={styles.subtitle}>
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
        <div className="rb-evidence-muted" style={styles.sectionLabel}>Market favourite</div>
        {card.favourite ? (
          <RunnerLine runner={card.favourite} />
        ) : (
          <span className="rb-evidence-muted">No market data.</span>
        )}
      </div>

      {/* Official T-minus-5 locked decision (display-only; precedence over the
          live model pick below, which is diagnostic only). Interim pre-Phase-4
          display — no redesign, no write path, no buttons. */}
      {card.lockedDecision && <LockedDecisionPanel ld={card.lockedDecision} />}

      {/* Model pick */}
      <div>
        <div className="rb-evidence-muted" style={styles.sectionLabel}>
          {card.lockedDecision
            ? 'Model pick — live diagnostic (official decision above)'
            : 'Model pick'}
        </div>
        {!card.lockedDecision && (
          <div className="rb-evidence-muted" style={{ fontSize: 11, marginBottom: 4 }}>
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
                <span className="rb-evidence-muted" style={{ marginRight: 4 }}>Odds</span>
                {formatOdds(pick.odds)}
              </span>
              <span className={evClassRaceCard(pick.ev)}>
                <span className="rb-evidence-muted" style={{ marginRight: 4 }}>EV</span>
                {formatEv(pick.ev)}
              </span>
              <span>
                <span className="rb-evidence-muted" style={{ marginRight: 4 }}>Stake</span>
                {pick.stake_amount.toFixed(2)}
              </span>
              <span
                className={confidenceClassRaceCard(
                  ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)
                )}
                style={{ fontWeight: 600 }}
              >
                {ladder ? ladderToDisplay(ladder.label) : displayConfidence(pick.confidence_label)} confidence
              </span>
            </div>
            {ladder && (
              <div className="rb-evidence-muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
                {ladder.reason}
              </div>
            )}
            <ConfidenceBreakdownPanel card={card} nowMs={nowMs} />
            {tags.length > 0 && (
              <div style={styles.tagRow}>
                <span className="rb-evidence-muted" style={{ ...styles.sectionLabel, marginBottom: 0 }}>
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
          <span className="rb-evidence-muted">
            No bet — the model ran but found no qualifying pick for this race
            (this is normal, not an error).
          </span>
        ) : (
          <span className="rb-evidence-muted">No model pick for this race yet.</span>
        )}
      </div>

      {/* Alternatives (EV rank 2-3): collapsed by default to keep cards compact
          on mobile. Read-only. */}
      {card.alternatives.length > 0 && (
        <details className="rb-evidence-section-rule" style={styles.altList}>
          <summary className="rb-evidence-muted" style={styles.altSummary}>
            Alternatives ({card.alternatives.length})
          </summary>
          {card.alternatives.map((alt) => (
            <div key={alt.runner_id} className="rb-evidence-secondary" style={styles.altRow}>
              <span className="rb-evidence-muted" style={{ width: 24 }}>
                {alt.rank != null ? `#${alt.rank}` : ''}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                {alt.horse_name}
              </span>
              <span style={{ width: 64, textAlign: 'right' }}>
                {formatOdds(alt.odds)}
              </span>
              <span
                className={evClassRaceCard(alt.ev)}
                style={{ width: 72, textAlign: 'right' }}
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
      <span className="rb-evidence-muted" style={styles.accuracyScopeLabel}>
        Race-day performance uses latest pre-off model run.
      </span>
    ) : null;

  if (summary.settled === 0) {
    return (
      <div className="rb-evidence-panel" style={styles.accuracyBar}>
        <span className="rb-evidence-muted">
          No settled races yet — accuracy will appear as results come in.
        </span>
        {summary.computedAt && (
          <span className="rb-evidence-muted" style={styles.accuracyUpdated}>
            updated {formatUpdated(summary.computedAt)}
          </span>
        )}
        {scopeLabel}
      </div>
    );
  }

  return (
    <div className="rb-evidence-panel" style={styles.accuracyBar}>
      <span style={styles.accuracyMetric}>
        {summary.winners}/{summary.settled} winners
      </span>
      <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
      <span style={styles.accuracyMetric}>
        {summary.strikeRatePct.toFixed(1)}% strike
      </span>
      <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
      <span className={profitClass(summary.profitLoss)} style={styles.accuracyMetric}>
        {formatProfit(summary.profitLoss)}
      </span>
      <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
      <span className={profitClass(summary.roiPct)} style={styles.accuracyMetric}>
        {summary.roiPct > 0 ? '+' : summary.roiPct < 0 ? '\u2212' : ''}
        {Math.abs(summary.roiPct).toFixed(1)}% ROI
      </span>
      {summary.computedAt && (
        <span className="rb-evidence-muted" style={styles.accuracyUpdated}>
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
  const notYet = performance.lockCoverage?.not_locked_yet ?? 0;
  const notYetSuffix = notYet > 0 ? ` ${notYet} race(s) not yet due to lock.` : '';
  const modeNote =
    performance.officialMode === 'official_locked'
      ? notYet > 0
        ? `OFFICIAL — T-minus-5 locked decisions (${performance.lockCoverage?.locked ?? '?'}/${performance.lockCoverage?.races ?? '?'} locked; ${notYet} not yet due to lock).`
        : 'OFFICIAL — T-minus-5 locked decisions (all races locked).'
      : performance.officialMode === 'mixed'
        ? `MIXED — official locked decisions for ${performance.lockCoverage?.locked ?? '?'}/${performance.lockCoverage?.races ?? '?'} races; ${performance.lockCoverage?.lock_missing ?? '?'} lock-missing race(s) (off passed, no lock) shown separately under the pre-off fallback.${notYetSuffix}`
        : performance.officialMode === 'fallback_pre_off'
          ? 'FALLBACK — no locked decisions in scope; latest pre-off model run (diagnostic rule).'
          : performance.evaluationMode !== 'current'
            ? 'Performance uses latest model run before scheduled off time.'
            : null;
  const cov = performance.lockCoverage;
  const fallback = performance.fallbackPerformance;
  // Read-only deep link to the Prediction Audit page, preserving ?date/?course.
  // Reading window.location during render is safe HERE only because this panel
  // returns null while `performance` is null, and `performance` is populated
  // solely by a client effect — so these links never exist in the server render
  // and cannot produce a hydration mismatch. Left as-is deliberately: changing
  // this URL handling is out of scope for slice 3B.
  const auditHref =
    '/results-audit' + (typeof window !== 'undefined' ? window.location.search : '');

  if (performance.settled_count === 0) {
    return (
      <div className="rb-evidence-panel" style={styles.perfPanel}>
        <div style={styles.perfHeading}>
          <span style={styles.perfTitle}>Recommendation performance</span>
          <span className="rb-evidence-muted" style={styles.perfScope}>{scope}</span>
          <Link href={auditHref} prefetch={false} className="rb-inline-link">
            Prediction Audit →
          </Link>
        </div>
        {modeNote && (
          <div className="rb-evidence-muted" style={styles.perfNote}>{modeNote}</div>
        )}
        <span className="rb-evidence-muted">
          No settled races yet — accuracy will appear as results come in.
        </span>
        {performance.recommendations_total > 0 && (
          <span
            className="rb-evidence-muted"
            style={{ ...styles.perfScope, marginLeft: 8 }}
          >
            {performance.pending_count} pending of {performance.recommendations_total}{' '}
            recommendation{performance.recommendations_total === 1 ? '' : 's'}
          </span>
        )}
        {cov && cov.locked > 0 && (
          <div className="rb-evidence-muted" style={styles.perfNote}>
            {`official no-bet ${cov.locked_no_bet} · no run at lock ${cov.no_run_available} · not locked yet ${cov.not_locked_yet ?? 0} · LOCK MISSING ${cov.lock_missing}`}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rb-evidence-panel" style={styles.perfPanel}>
      <div style={styles.perfHeading}>
        <span style={styles.perfTitle}>Recommendation performance</span>
        <span className="rb-evidence-muted" style={styles.perfScope}>{scope}</span>
        <span className="rb-evidence-muted" style={{ ...styles.accuracyUpdated }}>
          updated {formatUpdated(performance.computedAt)}
        </span>
        <Link href={auditHref} prefetch={false} className="rb-inline-link">
          Prediction Audit →
        </Link>
      </div>
      {modeNote && (
        <div className="rb-evidence-muted" style={styles.perfNote}>{modeNote}</div>
      )}
      <div style={styles.perfRow}>
        <span style={styles.accuracyMetric}>
          {performance.winners}/{performance.settled_count} winners
        </span>
        <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
        <span style={styles.accuracyMetric}>
          {performance.strike_rate.toFixed(1)}% strike
        </span>
        <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
        <span className={profitClass(performance.profit_loss)} style={styles.accuracyMetric}>
          {formatProfit(performance.profit_loss)}
        </span>
        <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
        <span className={profitClass(performance.roi)} style={styles.accuracyMetric}>
          {formatSignedPct(performance.roi)} ROI
        </span>
        {performance.average_ev !== null && (
          <>
            <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
            <span
              className={evClassSummary(performance.average_ev)}
              style={styles.accuracyMetric}
            >
              {formatEv(performance.average_ev)} avg EV
            </span>
          </>
        )}
        <span className="rb-evidence-muted" style={styles.accuracySep}>·</span>
        <span className="rb-evidence-muted" style={styles.perfScope}>
          settled {performance.settled_count} · pending {performance.pending_count}
          {performance.no_bet_races > 0 ? ` · ${performance.no_bet_races} no-bet` : ''}
        </span>
      </div>
      {cov && cov.locked > 0 && (
        <div className="rb-evidence-muted" style={styles.perfNote}>
          {`official no-bet ${cov.locked_no_bet} · no run at lock ${cov.no_run_available} · not locked yet ${cov.not_locked_yet ?? 0} · LOCK MISSING ${cov.lock_missing}`}
        </div>
      )}
      {performance.officialMode === 'mixed' && fallback && fallback.settled_count > 0 && (
        <div className="rb-evidence-muted" style={styles.perfNote}>
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
    // SLICE 3D.4a: the legacy foreground this surface already inherited, now
    // declared explicitly. Same computed colour — see LEGACY_LIGHT_PAGE_SURFACE.
    color: '#1f2328',
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
 * The operator's active-course quick link for all-courses mode. A UI-level
 * convenience shortcut (deliberately NOT in the course-agnostic nav lib) —
 * edit here when the actively-tracked course changes. Navigation only.
 */
const ACTIVE_COURSE_QUICK_LINK = {
  href: '/?day=today&course=Newmarket',
  label: 'Open Newmarket Today →',
} as const;

/**
 * All-courses-mode banner: shown only when the URL has no `?course=` param,
 * warning that lock coverage then includes courses never actively tracked,
 * with a prominent quick link to the tracked course. Rendered only after
 * hydration (`isClient`) so the server render — which cannot see the URL —
 * never flashes it on course-scoped pages. Display/navigation only.
 */
function AllCoursesBanner({ search, isClient }: { search: string; isClient: boolean }) {
  if (!isClient || !isAllCoursesMode(search)) return null;
  return (
    <div style={safetyBannerStyle}>
      <strong>{ALL_COURSES_BANNER_MESSAGE}</strong>
      <div style={{ marginTop: 8 }}>
        {/*
          Same-route scope change (`/` with a course query), so this stays a
          plain anchor for full-document navigation — see the LINK POLICY note
          on RaceDayNav below.
        */}
        <a href={ACTIVE_COURSE_QUICK_LINK.href} style={raceDayPrimaryButtonStyle}>
          {ACTIVE_COURSE_QUICK_LINK.label}
        </a>
      </div>
    </div>
  );
}

/**
 * Homepage race-day navigation, course/date-aware (no hardcoded course): a
 * primary link to today's races for the SELECTED course, a previous-day
 * results link derived from the selected date, and a Prediction Audit deep
 * link preserving the current query. NAVIGATION ONLY — no backend-route call,
 * no DB write, no wager, no write-mode flag. When unscoped it shows a short
 * "choose a view" prompt and generic wording. `search` is the hydration-safe
 * URL query ('' on the server render).
 *
 * LINK POLICY (slice 3B). The two kinds of destination are handled
 * differently, on purpose:
 *
 *   - SAME-ROUTE scope changes (`/` with a different query) stay plain
 *     anchors, so the browser performs a FULL-DOCUMENT navigation. A
 *     client-side transition would keep this page mounted, and three of its
 *     scope-sensitive effects have empty dependency arrays (accuracy, in-form
 *     tipsters, tipster status) while the other two key off the `scoped`
 *     boolean rather than the whole query. The page would therefore keep
 *     showing evidence gathered for the PREVIOUS scope under the new URL. A
 *     full document load guarantees every panel is rebuilt for the new scope.
 *     Do not convert these to Link until URL scope is a dependency of every
 *     relevant data-loading effect.
 *
 *   - The CROSS-ROUTE Prediction Audit destination unmounts this page
 *     entirely, so it has no stale-scope risk and uses Link.
 */
function RaceDayNav({ scoped, search }: { scoped: boolean; search: string }) {
  const nav = buildRaceDayNavView(search);
  return (
    <div style={{ margin: '12px 0 4px' }}>
      {!scoped && (
        <p style={{ margin: '0 0 8px', fontSize: 14, color: '#1f2328' }}>
          {RACE_DAY_NAV_EMPTY_MESSAGE}
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {/* Same-route scope change — full-document navigation, see above. */}
        <a href={nav.primary.href} style={raceDayPrimaryButtonStyle}>
          {nav.primary.label}
        </a>
        {nav.previousDay && (
          // Same-route scope change — full-document navigation, see above.
          <a href={nav.previousDay.href} style={raceDaySecondaryLinkStyle}>
            {nav.previousDay.label}
          </a>
        )}
        {/* Cross-route destination — safe to navigate client-side. */}
        <Link href={nav.audit.href} prefetch={false} style={raceDaySecondaryLinkStyle}>
          {nav.audit.label}
        </Link>
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

/**
 * Maps a next-action tone to the paired `rb-status-frame` classes.
 *
 * SLICE 3D (phase 1) supersedes the former `nextActionStyle` inline palette.
 * The three tone CLASSIFICATIONS are unchanged — only how each is painted:
 * a semantic left border on a neutral token surface, instead of a tinted fill
 * that had no token equivalent. `neutral` deliberately adds no modifier, so it
 * keeps the base border and reads as the quietest of the three.
 *
 * Tone never carries meaning alone: the caller always renders a visible
 * headline and detail.
 */
function nextActionFrameClass(tone: NextActionTone): string {
  const modifier: Record<NextActionTone, string> = {
    pos: ' rb-status-frame--positive',
    warn: ' rb-status-frame--warning',
    neutral: '',
  };
  return `rb-status-frame${modifier[tone]}`;
}

/**
 * Read-only operator "next action" widget. Shows the single most useful next
 * step as TEXT, plus an optional read-only terminal command SUGGESTION rendered
 * as a non-clickable <code> block (never a button, never a commit flag, never
 * executed from the page). Decision-support only.
 */
function NextActionWidget({ action }: { action: NextAction }) {
  return (
    /*
      SLICE 3D (phase 1): the FRAME and its descriptive text migrate to the
      paired `rb-status-frame` pattern — the class declares both a token surface
      and a token foreground, so nothing here inherits a colour that might not
      match it. Tone moves from a tinted fill to a semantic left border, which
      is how the design system already tints a block; the three tone
      classifications themselves are unchanged.

      The command block below is DELIBERATELY untouched. It keeps its own
      self-contained dark pairing, `styles.nextActionCmd`, `overflowX: auto` and
      `wordBreak: break-all`, and remains an inert <code> element with no
      button, handler or copy control.
    */
    <div className={nextActionFrameClass(action.tone)}>
      <span className="rb-status-frame__label">Next action</span>
      <div className="rb-status-frame__headline">{action.headline}</div>
      <div className="rb-status-frame__detail">{action.detail}</div>
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
  // The raw URL query, hydration-safe the same way ('' on the server render);
  // drives the course/date-aware nav wording and the audit deep link.
  const search = useSyncExternalStore(
    subscribeNoop,
    () => window.location.search,
    () => '',
  );
  // True only after hydration. Gates URL-derived banners that must not flash
  // during the server render (which cannot see the query string).
  const isClient = useSyncExternalStore(
    subscribeNoop,
    () => true,
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
  // Shared read-only card projection for the Command Centre + Decision Console
  // (both pure derivations over data already loaded; no new fetch, no writes).
  const timelineRaces = cards.map((c) => ({
    race_id: c.race_id,
    off_time: c.off_time,
    race_name: c.race_name,
    course: c.course,
    oddsUpdatedAt: c.latestOddsSnapshotTime ?? null,
    modelUpdatedAt: c.latestModelRunTime ?? null,
    hasModelRun: c.hasModelRun ?? false,
    status: c.status ?? null,
    resultTime: c.result_time ?? null,
    runQuality: c.observability?.runQuality ?? null,
    lockedDecisionStatus: c.lockedDecision?.decision_status ?? null,
  }));

  // Race-Day Command Centre (read-only): one compact ops view over the cards
  // already loaded + the page's own fetch state. Pure derivation, no new fetch.
  const commandCentre =
    status !== 'loading'
      ? buildCommandCentre({
          now: nowMs,
          feedState: status === 'ready' ? 'ready' : 'error',
          statusPollError: statusError,
          scoped,
          races: timelineRaces,
        })
      : null;

  // Race-Day Decision Console (read-only): every race classified into
  // NEXT ACTION / WARNING / MONITOR / GOOD. Display-only prioritisation.
  const decisionConsole =
    status === 'ready' && cards.length > 0
      ? buildDecisionConsole(timelineRaces, nowMs)
      : null;

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
    // SLICE 3A: structural shell adoption only. AppShell owns the single main
    // landmark (id="rb-main"), so this page no longer renders its own. The
    // dashboard's own container keeps its existing inline styles verbatim —
    // colours, spacing, panels, local links and safety copy are unchanged and
    // are migrated in later slices.
    <AppShell>
      <div style={styles.page}>
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
        {/*
          SLICE 3B: the "How it works" and "Tipster Leaderboard" links that sat
          here are now supplied by AppShell's primary and mobile navigation
          (Methodology / Tipster Evidence), so the local duplicates — and their
          wrapper — were removed. The course/date-aware race-day navigation
          below is NOT duplicated by the shell and stays.
        */}
      </div>
      <p
        style={{
          margin: '4px 0 0',
          fontSize: 14,
          color: '#57606a',
          overflowWrap: 'anywhere',
        }}
      >
        Model and tipster analysis for UK &amp; Irish racing.
      </p>

      {/*
        SLICE 3C: the safety statement sits directly beneath the descriptive
        intro, ABOVE the operational panels. CommandCentrePanel and
        DecisionConsolePanel are both conditional and can be tall, so leaving
        the banner below them could push the page's only detailed safety copy
        out of the first screen. The intro paragraph above is now purely
        descriptive — its "decision-support only, not betting advice ... not
        guarantees" clause said nothing this banner does not say in full.
      */}
      <SafetyBanner />

      {commandCentre && <CommandCentrePanel view={commandCentre} />}

      {decisionConsole && <DecisionConsolePanel view={decisionConsole} />}

      <LiveModeBar
        scoped={scoped}
        cardsUpdatedMs={cardsUpdatedMs}
        statusUpdatedMs={statusUpdatedMs}
        statusError={statusError}
        nowMs={nowMs}
      />

      <AllCoursesBanner search={search} isClient={isClient} />
      <RaceDayNav scoped={scoped} search={search} />

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

      {/*
        SLICE 3D.2: the three message states use the shared primitives, matching
        /leaderboard and /results-audit. Each primitive carries its own paired
        surface AND foreground via `rb-state` / `rb-skeleton`, so none of them
        inherits `styles.page`'s legacy `#1f2328` — they stay readable in both
        colour schemes without the page owning a token foreground.

        `level={2}` is deliberate: the page has one `<h1>`, and the three
        top-level panels that already render headings use `<h2>`. The primitive
        default of 3 would create an h1 -> h3 skip.
      */}
      {status === 'loading' && (
        <LoadingSkeleton lines={4} label="Loading recommendations" />
      )}

      {status === 'error' && (
        <ErrorState
          title="Recommendations unavailable"
          detail={error ? `Reported: ${error}` : undefined}
          level={2}
        >
          Couldn&apos;t load recommendations right now. Please refresh to try again.
        </ErrorState>
      )}

      {status === 'ready' && cards.length === 0 && (
        <EmptyState title="No races yet" level={2}>
          No races available for this day yet.
        </EmptyState>
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
      </div>
    </AppShell>
  );
}
