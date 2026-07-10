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
 */

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  buildPredictionAuditRow,
  summarizePredictionAudit,
  type AuditCardInput,
  type PredictionAuditRow,
  type PredictionAuditSummary,
  type BadgeTone,
} from '@/lib/predictionAudit';
import { cardConfidenceDiagnostic } from '@/lib/confidenceCardDiagnostics';

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

/* ------------------------------- styling ---------------------------------- */

const TONE_COLORS: Record<BadgeTone, { color: string; bg: string; border: string }> = {
  pos: { color: '#1a7f37', bg: '#dafbe1', border: '#aceebb' },
  neg: { color: '#cf222e', bg: '#ffebe9', border: '#ffcecb' },
  warn: { color: '#9a6700', bg: '#fff8c5', border: '#eed888' },
  neutral: { color: '#656d76', bg: '#f6f8fa', border: '#d0d7de' },
};

function badgeStyle(tone: BadgeTone): CSSProperties {
  const t = TONE_COLORS[tone];
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 700,
    color: t.color,
    background: t.bg,
    border: `1px solid ${t.border}`,
  };
}

const styles = {
  page: {
    maxWidth: 860,
    margin: '0 auto',
    padding: '24px 16px 48px',
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
    color: '#1f2328',
  } as CSSProperties,
  h1: { fontSize: 22, fontWeight: 700, margin: 0 } as CSSProperties,
  scope: { fontSize: 13, color: '#656d76', marginTop: 4 } as CSSProperties,
  disclaimer: {
    fontSize: 12,
    color: '#656d76',
    background: '#f6f8fa',
    border: '1px solid #d0d7de',
    borderRadius: 6,
    padding: '8px 12px',
    margin: '12px 0 20px',
    lineHeight: 1.5,
  } as CSSProperties,
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: 8,
    marginBottom: 24,
  } as CSSProperties,
  summaryCard: {
    background: '#f6f8fa',
    border: '1px solid #d0d7de',
    borderRadius: 6,
    padding: '8px 10px',
  } as CSSProperties,
  summaryLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: '#656d76',
    textTransform: 'uppercase' as const,
  } as CSSProperties,
  summaryValue: { fontSize: 18, fontWeight: 700, marginTop: 2 } as CSSProperties,
  card: {
    border: '1px solid #d0d7de',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    background: '#ffffff',
  } as CSSProperties,
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'baseline',
    flexWrap: 'wrap' as const,
  } as CSSProperties,
  raceName: { fontSize: 15, fontWeight: 700, minWidth: 0 } as CSSProperties,
  offTime: { fontSize: 13, color: '#656d76', whiteSpace: 'nowrap' as const } as CSSProperties,
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
    color: '#656d76',
    textTransform: 'uppercase' as const,
    marginTop: 10,
    marginBottom: 2,
  } as CSSProperties,
  line: { fontSize: 13, lineHeight: 1.6, overflowWrap: 'anywhere' as const } as CSSProperties,
  muted: { color: '#656d76' } as CSSProperties,
  small: { fontSize: 11, color: '#656d76', lineHeight: 1.5 } as CSSProperties,
  backLink: { fontSize: 13, color: '#0969da', textDecoration: 'none' } as CSSProperties,
};

/* ------------------------------- components ------------------------------- */

function outcomeBadge(outcome: 'won' | 'lost' | 'pending' | 'unevaluable' | null) {
  if (outcome === null) return null;
  const tone: BadgeTone =
    outcome === 'won' ? 'pos' : outcome === 'lost' ? 'neg' : 'neutral';
  const label = outcome === 'pending' ? 'PENDING — not counted' : outcome.toUpperCase();
  return <span style={badgeStyle(tone)}>{label}</span>;
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
    <div style={styles.summaryGrid}>
      {cells.map(([label, value]) => (
        <div key={label} style={styles.summaryCard}>
          <div style={styles.summaryLabel}>{label}</div>
          <div style={styles.summaryValue}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function OfficialBlock({ row }: { row: PredictionAuditRow }) {
  const locked = row.locked;
  if (row.display_status === 'not_locked_yet') {
    return <div style={{ ...styles.line, ...styles.muted }}>Not locked yet — the T-minus-5 window has not closed.</div>;
  }
  if (row.display_status === 'lock_missing') {
    return (
      <div style={styles.line}>
        <span style={badgeStyle('warn')}>LOCK MISSING</span>{' '}
        <span style={styles.muted}>
          No official decision was captured (never backfilled; not a loss). Diagnostic below is fallback only.
        </span>
      </div>
    );
  }
  if (row.display_status === 'no_run_available') {
    return (
      <div style={styles.line}>
        <span style={badgeStyle('warn')}>NO MODEL RUN AT LOCK</span>{' '}
        <span style={styles.muted}>(separate bucket; not a loss, not a no-bet)</span>
      </div>
    );
  }
  if (row.display_status === 'locked_no_bet') {
    return (
      <div style={styles.line}>
        <span style={badgeStyle('neutral')}>OFFICIAL NO-BET</span>{' '}
        <span style={styles.muted}>
          {orDash(locked?.no_bet_reason)} (valid decision — not a loss)
        </span>
      </div>
    );
  }
  // locked_pick
  return (
    <div style={styles.line}>
      <strong>{orDash(locked?.pick_horse_name)}</strong>
      {' · odds '}
      {fmtOdds(locked?.pick_odds)}
      {' · stake '}
      {fmtStake(locked?.pick_stake)}
      {' · EV '}
      {fmtEv(locked?.pick_ev)}
      {' · confidence '}
      {orDash(locked?.pick_confidence_label)}{' '}
      {outcomeBadge(row.locked_outcome)}
    </div>
  );
}

function DiagnosticBlock({ row }: { row: PredictionAuditRow }) {
  if (!row.diagnostic) {
    return (
      <div style={{ ...styles.line, ...styles.muted }}>
        {row.diagnostic_run_exists
          ? 'No bet — the pre-off run made no rank-1 recommendation.'
          : 'No pre-off model run recorded.'}
      </div>
    );
  }
  const d = row.diagnostic;
  const detail = row.diagnosticDetail;
  return (
    <div style={styles.line}>
      <strong>{orDash(d.horse_name)}</strong>
      {' · odds '}
      {fmtOdds(d.odds)}
      {' · stake '}
      {fmtStake(detail?.stake_amount)}
      {' · EV '}
      {fmtEv(detail?.ev)}
      {' · confidence '}
      {orDash(detail?.confidence_label)}{' '}
      {outcomeBadge(row.diagnostic_outcome)}
    </div>
  );
}

/** One-line confidence summary reusing the existing card diagnostic. */
function ConfidenceLine({ card, nowMs }: { card: PageCard; nowMs: number }) {
  const pick = card.modelPick;
  if (!pick) return null;
  const diag = cardConfidenceDiagnostic(
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
    nowMs,
  );
  if (!diag) return null;
  return (
    <div style={styles.small}>
      Confidence: original <strong>{orDash(diag.original_confidence_label)}</strong> ·
      diagnostic view{' '}
      <strong>{diag.overall.level === 'unknown' ? DASH : diag.overall.level.toUpperCase()}</strong>{' '}
      ({diag.overall.reason})
    </div>
  );
}

function RaceAuditCard({ card, row, nowMs }: { card: PageCard; row: PredictionAuditRow; nowMs: number }) {
  return (
    <article style={styles.card}>
      <header style={styles.cardHeader}>
        <div style={styles.raceName}>{row.race_name ?? '(unknown race)'}</div>
        <div style={styles.offTime}>{fmtOffTime(row.off_time)}</div>
      </header>
      <div style={{ marginTop: 6 }}>
        <span style={badgeStyle(row.badge.tone)}>{row.badge.label}</span>
      </div>
      <div style={styles.line}>
        {row.settled ? (
          <>
            Winner: <strong>{row.winner_name ?? 'result recorded — winner not in model data'}</strong>
          </>
        ) : card.status === 'result' ? (
          // Settled per the race row, but the winner is outside the model's
          // scored field — shown honestly; still conservatively NOT counted.
          <span style={styles.muted}>
            Result recorded — winner not in model data (conservatively not counted).
          </span>
        ) : (
          <span style={styles.muted}>Result pending — not counted.</span>
        )}
      </div>
      <div style={styles.sectionLabel}>Official locked decision (T−5 — source of truth)</div>
      <OfficialBlock row={row} />
      <div style={styles.sectionLabel}>Final pre-off diagnostic pick (comparison only — not official)</div>
      <DiagnosticBlock row={row} />
      <div style={{ marginTop: 8 }}>
        <ConfidenceLine card={card} nowMs={nowMs} />
      </div>
    </article>
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
        const res = await fetch(`/api/recommendations${query}`, {
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
    <main style={styles.page}>
      <a href={`/${search}`} style={styles.backLink}>
        ← Dashboard
      </a>
      <h1 style={{ ...styles.h1, marginTop: 8 }}>Prediction Audit</h1>
      <div style={styles.scope}>
        {meta.date ?? DASH}
        {meta.course ? ` · ${meta.course}` : ''}
      </div>
      <div style={styles.disclaimer}>
        Official decision = the immutable T-minus-5 locked record (`locked_race_decisions`).
        Final pre-off diagnostic picks are comparison only, never the official decision.
        Pending races are never losses; official no-bets, no-run and lock-missing races are
        separate buckets, never losses, and missing locks are never backfilled.
        Decision-support only — nothing here places or settles bets.
      </div>

      {error && <div style={{ ...styles.line, color: '#cf222e' }}>{error}</div>}
      {!error && cards === null && <div style={{ ...styles.line, ...styles.muted }}>Loading…</div>}
      {!error && cards !== null && cards.length === 0 && (
        <div style={{ ...styles.line, ...styles.muted }}>
          No races found for this date/course. Try /results-audit?date=YYYY-MM-DD&course=Newmarket.
        </div>
      )}

      {cards !== null && cards.length > 0 && (
        <>
          <SummaryStrip summary={summary} />
          {rows.map((row, i) => (
            <RaceAuditCard key={row.race_id} card={cards[i]} row={row} nowMs={nowMs} />
          ))}
        </>
      )}
    </main>
  );
}
