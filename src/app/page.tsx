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

import { useEffect, useState, type CSSProperties } from 'react';
import RaceExplanationPanel from '@/components/RaceExplanationPanel';
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
}

/** The model's rank-1 pick (mirrors the server `RaceCardPick`). */
interface RaceCardPick extends RaceCardRunner {
  confidence_label: string;
  stake_amount: number;
  stake_pct: number;
  rationale: Record<string, unknown> | null;
  isFavourite: boolean;
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
   * Read-only model observability for this race (from the current run's
   * config_json, surfaced by the API in Batch J1). Optional/null-safe: absent or
   * empty for races without a current run, in which case the explanation panel
   * renders its empty state.
   */
  observability?: RaceObservabilityLike | null;
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
  /** Run-selection rule behind these figures; `pre_off` is the default. */
  evaluationMode?: 'pre_off' | 'current';
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
  } as CSSProperties,
  countdown: {
    fontSize: 13,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 999,
    whiteSpace: 'nowrap' as const,
    fontVariantNumeric: 'tabular-nums' as const,
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
    </div>
  );
}


function RaceCardView({ card, nowMs }: { card: RaceCard; nowMs: number }) {
  const cd = countdownTo(card.off_time, nowMs);
  const pick = card.modelPick;
  const tags = pick ? deriveWhyTags(pick) : [];

  return (
    <article style={styles.card}>
      <header style={styles.cardHeader}>
        <div>
          <div style={styles.offTime}>{formatOffTime(card.off_time)}</div>
          {(card.course || card.race_name) && (
            <div style={styles.subtitle}>
              {[card.course, card.race_name].filter(Boolean).join(' \u2014 ')}
            </div>
          )}
        </div>
        <span style={countdownStyle(cd)}>{cd ? cd.text : 'no time'}</span>
      </header>

      {/* Data freshness: odds + model recency (read-only). */}
      <FreshnessRow card={card} nowMs={nowMs} />

      {/* Market favourite */}
      <div style={styles.favouriteRow}>
        <div style={styles.sectionLabel}>Market favourite</div>
        {card.favourite ? (
          <RunnerLine runner={card.favourite} />
        ) : (
          <span style={styles.muted}>No market data.</span>
        )}
      </div>

      {/* Model pick */}
      <div>
        <div style={styles.sectionLabel}>Model pick</div>
        {pick ? (
          <>
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
                    CONFIDENCE_COLORS[displayConfidence(pick.confidence_label)],
                  fontWeight: 600,
                }}
              >
                {displayConfidence(pick.confidence_label)} confidence
              </span>
            </div>
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
            No bet — the model ran but found no qualifying recommendation.
          </span>
        ) : (
          <span style={styles.muted}>No model pick for this race yet.</span>
        )}
      </div>

      {/* Alternatives (EV rank 2-3) */}
      {card.alternatives.length > 0 && (
        <div style={styles.altList}>
          <div style={styles.sectionLabel}>Alternatives</div>
          {card.alternatives.map((alt) => (
            <div key={alt.runner_id} style={styles.altRow}>
              <span style={{ width: 24, color: '#8c959f' }}>
                {alt.rank != null ? `#${alt.rank}` : ''}
              </span>
              <span style={{ flex: 1 }}>{alt.horse_name}</span>
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
        </div>
      )}

      {/* Model explanation: read-only observability from the current run. Renders
          its own empty state when this race has no usable observability. */}
      <RaceExplanationPanel
        {...deriveRaceExplanationProps(card.observability)}
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
 * Header bar summarising live model accuracy: "X/Y winners · strike rate ·
 * profit · ROI", with a last-updated time. Renders nothing until the first
 * snapshot loads.
 */
function AccuracyBar({ accuracy }: { accuracy: ModelAccuracy | null }) {
  if (!accuracy) {
    return null;
  }

  if (accuracy.racesSettled === 0) {
    return (
      <div style={styles.accuracyBar}>
        <span style={styles.muted}>
          No settled races yet — accuracy will appear as results come in.
        </span>
        <span style={styles.accuracyUpdated}>
          updated {formatUpdated(accuracy.computedAt)}
        </span>
      </div>
    );
  }

  return (
    <div style={styles.accuracyBar}>
      <span style={styles.accuracyMetric}>
        {accuracy.winners}/{accuracy.racesSettled} winners
      </span>
      <span style={styles.accuracySep}>·</span>
      <span style={styles.accuracyMetric}>
        {accuracy.strikeRatePct.toFixed(1)}% strike
      </span>
      <span style={styles.accuracySep}>·</span>
      <span
        style={{ ...styles.accuracyMetric, color: profitColor(accuracy.profitPoints) }}
      >
        {formatProfit(accuracy.profitPoints)}
      </span>
      <span style={styles.accuracySep}>·</span>
      <span
        style={{ ...styles.accuracyMetric, color: profitColor(accuracy.roiPct) }}
      >
        {accuracy.roiPct > 0 ? '+' : accuracy.roiPct < 0 ? '\u2212' : ''}
        {Math.abs(accuracy.roiPct).toFixed(1)}% ROI
      </span>
      <span style={styles.accuracyUpdated}>
        updated {formatUpdated(accuracy.computedAt)}
      </span>
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

  if (performance.settled_count === 0) {
    return (
      <div style={styles.perfPanel}>
        <div style={styles.perfHeading}>
          <span style={styles.perfTitle}>Recommendation performance</span>
          <span style={styles.perfScope}>{scope}</span>
        </div>
        {performance.evaluationMode !== 'current' && (
          <div style={styles.perfNote}>
            Performance uses latest model run before scheduled off time.
          </div>
        )}
        <span style={styles.muted}>
          No settled races yet — accuracy will appear as results come in.
        </span>
        {performance.recommendations_total > 0 && (
          <span style={{ ...styles.perfScope, marginLeft: 8 }}>
            {performance.pending_count} pending of {performance.recommendations_total}{' '}
            recommendation{performance.recommendations_total === 1 ? '' : 's'}
          </span>
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
      {performance.evaluationMode !== 'current' && (
        <div style={styles.perfNote}>
          Performance uses latest model run before scheduled off time.
        </div>
      )}
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

export default function RecommendationsPage() {
  const [cards, setCards] = useState<RaceCard[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string>('');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [accuracy, setAccuracy] = useState<ModelAccuracy | null>(null);
  const [performance, setPerformance] = useState<ModelPerformance | null>(null);
  const [inForm, setInForm] = useState<InFormTipster[] | null>(null);
  const [tipsterStatus, setTipsterStatus] = useState<TipsterStatusSummary | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        setStatus('loading');
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
        setStatus('ready');
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Unknown error');
        setStatus('error');
      }
    }

    load();
    return () => controller.abort();
  }, []);

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
        const res = await fetch('/api/tipsters/status', { signal: controller.signal });
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

  return (
    <main style={styles.page}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <h1>Bet Recommendations</h1>
        <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <a href="/how-it-works" style={{ fontSize: 14, color: '#0969da', textDecoration: 'none' }}>
            How it works
          </a>
          <a href="/leaderboard" style={{ fontSize: 14, color: '#0969da', textDecoration: 'none' }}>
            Tipster Leaderboard →
          </a>
        </span>
      </div>

      <AccuracyBar accuracy={accuracy} />

      <PerformancePanel performance={performance} />

      <TipsterStatusPanel status={tipsterStatus} />

      <InFormPanel tipsters={inForm} />

      {status === 'loading' && (
        <p style={styles.muted}>Loading recommendations…</p>
      )}

      {status === 'error' && (
        <p style={{ color: EV_NEGATIVE_COLOR }}>Error: {error}</p>
      )}

      {status === 'ready' && cards.length === 0 && (
        <p style={styles.muted}>No races available.</p>
      )}

      {status === 'ready' && cards.length > 0 && (
        <div style={styles.cardList}>
          {cards.map((card) => (
            <RaceCardView key={card.race_id} card={card} nowMs={nowMs} />
          ))}
        </div>
      )}
    </main>
  );
}
