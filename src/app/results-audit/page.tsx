'use client';

/**
 * Prediction Audit page (/results-audit) — READ-ONLY.
 *
 * For a ?date=YYYY-MM-DD&course=X scope it shows every race and whether the
 * bot's predictions were correct: the OFFICIAL T-minus-5 locked decision
 * (source of truth, from locked_race_decisions) evaluated against the stored
 * result, side by side with the final pre-off DIAGNOSTIC pick (comparison
 * only), plus a per-race divergence badge and day summary.
 *
 * Data path: GET /api/recommendations (existing, SELECT-only) — this page adds
 * no API, issues no writes, settles nothing, runs no model, fetches no odds.
 * Classification reuses the Phase 5A `lockedDayReport` core verbatim via the
 * pure `predictionAudit` helpers. Decision-support only — not betting advice.
 *
 * SHELL ADOPTION. `AppShell` owns the single main landmark, so this page no
 * longer renders its own. The endpoint, the ?date/?course handling, the
 * official-versus-diagnostic separation and every classification bucket are
 * unchanged — only the presentation moved onto the committed primitives, and
 * the diagnostic block is now labelled "diagnostic, not official" in visible
 * text as well as in its section heading.
 */

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import {
  AnalyticalCard,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  MetricTile,
  StatusBadge,
  type StatusTone,
} from '@/components/UiPrimitives';
import {
  auditConfidenceAsOfMs,
  buildPredictionAuditRow,
  summarizePredictionAudit,
  type AuditCardInput,
  type PredictionAuditRow,
  type PredictionAuditSummary,
  type BadgeTone,
} from '@/lib/predictionAudit';
import { cardConfidenceDiagnosticAsOf } from '@/lib/confidenceCardDiagnostics';

/**
 * The fetched card shape: the audit fields plus the extra read-only fields the
 * confidence summary reuses (all already present on /api/recommendations
 * cards; optional/null-safe for back-compat).
 */
interface PageCard extends AuditCardInput {
  /** Race row status ('result' once settled) — display only, not classification. */
  status?: string | null;
  isHandicap?: boolean | null;
  latestOddsSnapshotTime?: string | null;
  /** Displayed model run's time (ISO) — the audit-safe confidence reference. */
  latestModelRunTime?: string | null;
  observability?: {
    runQuality?: string | null;
    tipsterModelAlignment?: Record<string, unknown> | null;
    marketCompleteness?: number | null;
  } | null;
  modelPick?:
    | (NonNullable<AuditCardInput['modelPick']> & {
        model_prob?: number | null;
        market_prob?: number | null;
      })
    | null;
  runners?: Array<
    NonNullable<AuditCardInput['runners']>[number] & { ev?: number | null }
  > | null;
}

const DASH = '—';

/** The read-only endpoint backing this page. */
const RECOMMENDATIONS_ENDPOINT = '/api/recommendations';

/**
 * No-op subscribe for useSyncExternalStore: the URL query string does not
 * change during the page's lifetime, so there is nothing to subscribe to;
 * module scope keeps the reference stable across renders.
 */
const subscribeNoop = (): (() => void) => () => {};

/* ----------------------------- formatting (pure) -------------------------- */

function fmtOdds(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : DASH;
}
function fmtStake(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : DASH;
}
function fmtEv(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DASH;
  const pct = v * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
function fmtOffTime(offTime: string | null): string {
  if (!offTime) return 'no time';
  const ms = Date.parse(offTime);
  if (!Number.isFinite(ms)) return 'no time';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function orDash(v: string | null | undefined): string {
  return v === null || v === undefined || v === '' ? DASH : v;
}

/**
 * Maps the audit helper's tone vocabulary onto the design system's.
 * Presentation only — it never changes how a race was classified.
 */
function toneOf(tone: BadgeTone): StatusTone {
  if (tone === 'pos') return 'positive';
  if (tone === 'neg') return 'failure';
  if (tone === 'warn') return 'warning';
  return 'neutral';
}

const mutedLine: CSSProperties = { color: 'var(--rb-text-muted)' };

/* ------------------------------- components ------------------------------- */

function OutcomeBadge({
  outcome,
}: {
  outcome: 'won' | 'lost' | 'pending' | 'unevaluable' | null;
}) {
  if (outcome === null) return null;
  const tone: BadgeTone =
    outcome === 'won' ? 'pos' : outcome === 'lost' ? 'neg' : 'neutral';
  const label = outcome === 'pending' ? 'PENDING — not counted' : outcome.toUpperCase();
  return <StatusBadge tone={toneOf(tone)}>{label}</StatusBadge>;
}

function SummaryStrip({ summary }: { summary: PredictionAuditSummary }) {
  const cells: Array<[string, string]> = [
    ['Races', String(summary.races)],
    ['Results settled', String(summary.settled)],
    [
      'Official lock coverage',
      `${summary.locked}/${summary.races} (${summary.coverage_pct.toFixed(1)}%)`,
    ],
    ['Official locked picks', String(summary.locked_picks)],
    ['Official winners', String(summary.official_winners)],
    ['Official losers', String(summary.official_losers)],
    ['Official no-bets', String(summary.locked_no_bet)],
    ['No run available', String(summary.no_run_available)],
    ['Lock missing', String(summary.lock_missing)],
    ['Diagnostic winners', String(summary.diagnostic_winners)],
    ['Diag won, official lost', String(summary.diagnostic_won_official_lost)],
    ['Official won, diag lost', String(summary.official_won_diagnostic_lost)],
    [
      'Official P/L (locked odds/stake)',
      `${summary.official.profit_loss >= 0 ? '+' : ''}${summary.official.profit_loss.toFixed(2)}`,
    ],
  ];
  if (summary.not_locked_yet > 0) {
    cells.splice(9, 0, ['Not locked yet', String(summary.not_locked_yet)]);
  }
  return (
    <div className="rb-metric-grid">
      {cells.map(([label, value]) => (
        <MetricTile key={label} label={label} value={value} />
      ))}
    </div>
  );
}

function OfficialBlock({ row }: { row: PredictionAuditRow }) {
  const locked = row.locked;
  if (row.display_status === 'not_locked_yet') {
    return (
      <p className="rb-line rb-line--muted">
        Not locked yet — the T-minus-5 window has not closed.
      </p>
    );
  }
  if (row.display_status === 'lock_missing') {
    return (
      <p className="rb-line">
        <StatusBadge tone="warning">LOCK MISSING</StatusBadge>{' '}
        <span style={mutedLine}>
          No official decision was captured (never backfilled; not a loss). Diagnostic below is fallback only.
        </span>
      </p>
    );
  }
  if (row.display_status === 'no_run_available') {
    return (
      <p className="rb-line">
        <StatusBadge tone="warning">NO MODEL RUN AT LOCK</StatusBadge>{' '}
        <span style={mutedLine}>(separate bucket; not a loss, not a no-bet)</span>
      </p>
    );
  }
  if (row.display_status === 'locked_no_bet') {
    return (
      <p className="rb-line">
        <StatusBadge tone="neutral">OFFICIAL NO-BET</StatusBadge>{' '}
        <span style={mutedLine}>
          {orDash(locked?.no_bet_reason)} (valid decision — not a loss)
        </span>
      </p>
    );
  }
  // locked_pick
  return (
    <p className="rb-line">
      <strong>{orDash(locked?.pick_horse_name)}</strong>
      {' · odds '}
      {fmtOdds(locked?.pick_odds)}
      {' · stake '}
      {fmtStake(locked?.pick_stake)}
      {' · EV '}
      {fmtEv(locked?.pick_ev)}
      {' · confidence '}
      {orDash(locked?.pick_confidence_label)}{' '}
      <OutcomeBadge outcome={row.locked_outcome} />
    </p>
  );
}

function DiagnosticBlock({ row }: { row: PredictionAuditRow }) {
  if (!row.diagnostic) {
    return (
      <p className="rb-line rb-line--muted">
        {row.diagnostic_run_exists
          ? 'No bet — the pre-off run made no rank-1 recommendation.'
          : 'No pre-off model run recorded.'}
      </p>
    );
  }
  const d = row.diagnostic;
  const detail = row.diagnosticDetail;
  return (
    <p className="rb-line">
      <strong>{orDash(d.horse_name)}</strong>
      {' · odds '}
      {fmtOdds(d.odds)}
      {' · stake '}
      {fmtStake(detail?.stake_amount)}
      {' · EV '}
      {fmtEv(detail?.ev)}
      {' · confidence '}
      {orDash(detail?.confidence_label)}{' '}
      <OutcomeBadge outcome={row.diagnostic_outcome} />
    </p>
  );
}

/** One-line confidence summary reusing the existing card diagnostic. */
function ConfidenceLine({ card }: { card: PageCard }) {
  const pick = card.modelPick;
  if (!pick) return null;
  // Judged AS OF the race's own decision instant (run time / lock time / off
  // time) — never the viewing clock — so a settled race is not "limited by
  // execution" merely because the audit is read hours later. Display-only.
  const diag = cardConfidenceDiagnosticAsOf(
    {
      race_id: card.race_id,
      off_time: card.off_time,
      race_name: card.race_name,
      isHandicap: card.isHandicap,
      latestOddsSnapshotTime: card.latestOddsSnapshotTime,
      modelPick: {
        horse_name: pick.horse_name,
        confidence_label: pick.confidence_label ?? null,
        ev: pick.ev,
        model_prob: pick.model_prob ?? null,
        market_prob: pick.market_prob ?? null,
        odds: pick.odds,
      },
      runners: (card.runners ?? []).map((r) => ({ ev: r.ev ?? null })),
      observability: card.observability,
    },
    auditConfidenceAsOfMs(card),
  );
  if (!diag) return null;
  return (
    <p className="rb-note">
      Confidence (as of race time): original{' '}
      <strong>{orDash(diag.original_confidence_label)}</strong> ·
      diagnostic view{' '}
      <strong>{diag.overall.level === 'unknown' ? DASH : diag.overall.level.toUpperCase()}</strong>{' '}
      ({diag.overall.reason})
    </p>
  );
}

function RaceAuditCard({ card, row }: { card: PageCard; row: PredictionAuditRow }) {
  return (
    <AnalyticalCard>
      <div className="rb-card-head">
        <span className="rb-card-title">{row.race_name ?? '(unknown race)'}</span>
        <span className="rb-card-aside">{fmtOffTime(row.off_time)}</span>
      </div>
      <div style={{ marginTop: 'var(--rb-space-2)' }}>
        <StatusBadge tone={toneOf(row.badge.tone)}>{row.badge.label}</StatusBadge>
      </div>
      <p className="rb-line" style={{ marginTop: 'var(--rb-space-2)' }}>
        {row.settled ? (
          <>
            Winner: <strong>{row.winner_name ?? 'result recorded — winner not in model data'}</strong>
          </>
        ) : card.status === 'result' ? (
          // Settled per the race row, but the winner is outside the model's
          // scored field — shown honestly; still conservatively NOT counted.
          <span style={mutedLine}>
            Result recorded — winner not in model data (conservatively not counted).
          </span>
        ) : (
          <span style={mutedLine}>Result pending — not counted.</span>
        )}
      </p>

      <p className="rb-eyebrow">Official locked decision (T−5 — source of truth)</p>
      <OfficialBlock row={row} />

      <p className="rb-eyebrow">
        Final pre-off diagnostic pick — diagnostic, not official
      </p>
      <p className="rb-line" style={{ marginBottom: 'var(--rb-space-1)' }}>
        <StatusBadge tone="analytical" srLabel="Evidence class:">
          DIAGNOSTIC — NOT OFFICIAL
        </StatusBadge>{' '}
        <span style={mutedLine}>comparison only; never the official decision</span>
      </p>
      <DiagnosticBlock row={row} />

      <div style={{ marginTop: 'var(--rb-space-2)' }}>
        <ConfidenceLine card={card} />
      </div>
    </AnalyticalCard>
  );
}

/* --------------------------------- page ----------------------------------- */

interface ApiResponse {
  races?: PageCard[];
  meetingDate?: string;
  course?: string | null;
}

export default function ResultsAuditPage() {
  const [cards, setCards] = useState<PageCard[] | null>(null);
  const [meta, setMeta] = useState<{ date: string | null; course: string | null }>({
    date: null,
    course: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [nowMs] = useState(() => Date.now());
  // The dashboard back-link's query string, read hydration-safely: the server
  // snapshot is '' so SSR and the hydration render both produce href="/", then
  // React swaps in the real ?date/?course after hydration (same pattern the
  // dashboard uses for its URL scope; reading window.location directly during
  // render caused a hydration mismatch).
  const search = useSyncExternalStore(
    subscribeNoop,
    () => window.location.search,
    () => '',
  );

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        // Forward ?date / ?day / ?course verbatim to the existing read API.
        const query = typeof window !== 'undefined' ? window.location.search : '';
        const res = await fetch(`${RECOMMENDATIONS_ENDPOINT}${query}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setError('Failed to load race data.');
          return;
        }
        const data = (await res.json()) as ApiResponse;
        setCards(Array.isArray(data.races) ? data.races : []);
        setMeta({ date: data.meetingDate ?? null, course: data.course ?? null });
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('Prediction audit load failed:', err);
          setError('Failed to load race data.');
        }
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const rows = (cards ?? []).map((c) => buildPredictionAuditRow(c, nowMs));
  const summary = summarizePredictionAudit(rows);

  return (
    <AppShell>
      <div className="rb-stack">
        <div className="rb-page-header">
          <div>
            <h1 className="rb-page-title">Prediction Audit</h1>
            <p className="rb-page-scope">
              {meta.date ?? DASH}
              {meta.course ? ` · ${meta.course}` : ''}
            </p>
          </div>
          <Link href={`/${search}`} className="rb-inline-link">
            ← Dashboard
          </Link>
        </div>

        {/*
          Page-specific evidence limitations. This is NOT the shell disclaimer
          and must not be collapsed into it: it states how this page classifies
          locked, diagnostic, pending and missing evidence.
        */}
        <p className="rb-callout rb-callout--note">
          Official decision = the immutable T-minus-5 locked record (`locked_race_decisions`).
          Final pre-off diagnostic picks are comparison only, never the official decision.
          Pending races are never losses; official no-bets, no-run and lock-missing races are
          separate buckets, never losses, and missing locks are never backfilled.
          Decision-support only — nothing here places or settles bets.
        </p>

        {error && <ErrorState title="Race data unavailable">{error}</ErrorState>}

        {!error && cards === null && <LoadingSkeleton lines={5} label="Loading race data" />}

        {!error && cards !== null && cards.length === 0 && (
          <EmptyState
            title="No races in this scope"
            detail="Example: /results-audit?date=YYYY-MM-DD&course=Newmarket"
          >
            No races found for this date and course.
          </EmptyState>
        )}

        {cards !== null && cards.length > 0 && (
          <>
            <SummaryStrip summary={summary} />
            <div className="rb-stack rb-stack--tight">
              {rows.map((row, i) => (
                <RaceAuditCard key={row.race_id} card={cards[i]} row={row} />
              ))}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
