'use client';

/**
 * Tipster Leaderboard page (/leaderboard).
 *
 * Renders every tracked tipster from `/api/tipsters/leaderboard` in a SORTABLE
 * table: activate any column header to sort asc/desc (default: final weight
 * desc). Active and demoted tipsters are shown distinctly (demoted rows are
 * muted and carry a badge). ROI is a signed percentage coloured green/red;
 * reliability is a 0–1 bar so low-sample tipsters are obvious. Polls for
 * real-time updates.
 *
 * INTEGRITY: every value is read straight from the API (which reads
 * `tipster_priors` / `tipsters`). Missing fields render as "—"; nothing is
 * fabricated client-side.
 *
 * Expected response: `{ tipsters: TipsterLeaderboardEntry[] }`.
 *
 * SHELL ADOPTION. `AppShell` owns the single main landmark, so this page no
 * longer renders its own. The endpoint, the 30-second poll, the sort semantics
 * and every column are unchanged; sorting became a real button so it is
 * keyboard-operable, and the table gained `aria-sort` plus a scrollable
 * container rather than losing columns on narrow screens. Read-only: no write
 * control exists anywhere on this page.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/AppShell';
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  StatusBadge,
} from '@/components/UiPrimitives';

/** Mirrors the server `TipsterLeaderboardEntry`. */
interface TipsterLeaderboardEntry {
  tipster_id: string;
  name: string;
  affiliation: string | null;
  source: string | null;
  longRunRoi: number | null;
  recentRoi30d: number | null;
  strikeRate: number | null;
  longestLosingStreak: number | null;
  reliability: number | null;
  finalWeight: number | null;
  betsCount: number | null;
  isActive: boolean;
  asOfDate: string | null;
}

type LoadStatus = 'loading' | 'ready' | 'error';
type SortDir = 'asc' | 'desc';

/** Poll cadence, in milliseconds. Unchanged from the pre-shell page. */
const POLL_INTERVAL_MS = 30000;

/** The read-only endpoint backing this page. */
const LEADERBOARD_ENDPOINT = '/api/tipsters/leaderboard';

const POSITIVE_COLOR = 'var(--rb-status-positive)';
const NEGATIVE_COLOR = 'var(--rb-status-failure)';
const MUTED = 'var(--rb-market-neutral)';

const DASH = '—';

/** Formats a ROI fraction (0.12 => +12.0%), or a dash when unknown. */
function formatRoi(roi: number | null): string {
  if (roi === null) {
    return DASH;
  }
  const pct = roi * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Colours a ROI fraction green/red/neutral. */
function roiColor(roi: number | null): string {
  if (roi !== null && roi > 0) return POSITIVE_COLOR;
  if (roi !== null && roi < 0) return NEGATIVE_COLOR;
  return MUTED;
}

/** Formats a strike rate (0-1) as a percentage, or a dash. */
function formatPct(value: number | null): string {
  return value === null ? DASH : `${(value * 100).toFixed(1)}%`;
}

/** Formats a number to `dp` decimals, or a dash. */
function formatNum(value: number | null, dp = 2): string {
  return value === null ? DASH : value.toFixed(dp);
}

/** Formats an integer, or a dash. */
function formatInt(value: number | null): string {
  return value === null ? DASH : String(Math.round(value));
}

/** Each sortable column: a key, header label, alignment, and a sort accessor. */
interface Column {
  key: string;
  label: string;
  align: 'left' | 'right';
  /** Comparable value; `null` always sorts last regardless of direction. */
  value: (t: TipsterLeaderboardEntry) => number | string | null;
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Tipster', align: 'left', value: (t) => t.name.toLowerCase() },
  {
    key: 'source',
    label: 'Source',
    align: 'left',
    value: (t) => (t.source ?? t.affiliation ?? '').toLowerCase() || null,
  },
  { key: 'longRunRoi', label: 'All-time ROI', align: 'right', value: (t) => t.longRunRoi },
  { key: 'recentRoi30d', label: '30d ROI', align: 'right', value: (t) => t.recentRoi30d },
  { key: 'strikeRate', label: 'Strike', align: 'right', value: (t) => t.strikeRate },
  {
    key: 'longestLosingStreak',
    label: 'Streak',
    align: 'right',
    value: (t) => t.longestLosingStreak,
  },
  { key: 'reliability', label: 'Reliability', align: 'right', value: (t) => t.reliability },
  { key: 'finalWeight', label: 'Weight', align: 'right', value: (t) => t.finalWeight },
  { key: 'betsCount', label: 'Bets', align: 'right', value: (t) => t.betsCount },
  { key: 'isActive', label: 'Status', align: 'left', value: (t) => (t.isActive ? 1 : 0) },
];

/** A 0–1 reliability bar; width scales with the value, dash when unknown. */
function ReliabilityBar({ value }: { value: number | null }) {
  if (value === null) {
    return <span style={{ color: MUTED }}>{DASH}</span>;
  }
  const clamped = Math.max(0, Math.min(1, value));
  // Low sample (low reliability) reads amber; well-proofed reads green.
  const fill =
    clamped >= 0.5
      ? 'var(--rb-status-positive)'
      : clamped >= 0.25
        ? 'var(--rb-status-warning)'
        : 'var(--rb-status-failure)';
  return (
    <span className="rb-bar">
      <span className="rb-bar__track">
        <span
          className="rb-bar__fill"
          style={{ width: `${clamped * 100}%`, background: fill }}
        />
      </span>
      <span className="rb-bar__value">{(clamped * 100).toFixed(0)}%</span>
    </span>
  );
}

/** Sort indicator glyph for the active column. */
function sortGlyph(active: boolean, dir: SortDir): string {
  if (!active) return ' ';
  return dir === 'asc' ? '▲' : '▼';
}

export default function LeaderboardPage() {
  const [rows, setRows] = useState<TipsterLeaderboardEntry[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<string>('');
  const [sortKey, setSortKey] = useState<string>('finalWeight');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch(LEADERBOARD_ENDPOINT, {
          signal: controller.signal,
        });
        if (!res.ok) {
          let message = `Request failed (${res.status})`;
          try {
            const body = await res.json();
            if (body?.error) message = body.error;
          } catch {
            // Non-JSON error body; keep the default message.
          }
          throw new Error(message);
        }
        const data = await res.json();
        const list: TipsterLeaderboardEntry[] = Array.isArray(data?.tipsters)
          ? data.tipsters
          : [];
        setRows(list);
        setUpdatedAt(Date.now());
        setStatus('ready');
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
        setStatus('error');
      }
    }

    load();
    // Poll for real-time updates as discovery/promotion runs.
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  function onSort(key: string) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Text columns default to A→Z; numeric/status default to high→low.
      setSortDir(key === 'name' || key === 'source' ? 'asc' : 'desc');
    }
  }

  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sortKey) ?? COLUMNS[0];
    const dirMul = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.value(a);
      const bv = col.value(b);
      // Nulls always last, regardless of direction.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dirMul;
      }
      return (av - bv) * dirMul;
    });
  }, [rows, sortKey, sortDir]);

  const activeCount = rows.filter((r) => r.isActive).length;

  return (
    <AppShell>
      <div className="rb-stack">
        <div className="rb-page-header">
          <h1 className="rb-page-title">Tipster Leaderboard</h1>
          <Link href="/" className="rb-inline-link">
            ← Recommendations
          </Link>
        </div>

        {status === 'loading' && <LoadingSkeleton lines={6} label="Loading leaderboard" />}

        {status === 'error' && (
          <ErrorState
            title="Leaderboard unavailable"
            detail={error ? `Reported: ${error}` : undefined}
          >
            Couldn&apos;t load the leaderboard right now. Please refresh to try again.
          </ErrorState>
        )}

        {status === 'ready' && rows.length === 0 && (
          <EmptyState title="No tracked tipsters yet">
            The leaderboard will populate once tipster performance data is available.
          </EmptyState>
        )}

        {status === 'ready' && rows.length > 0 && (
          <>
            <p className="rb-meta">
              {rows.length} tracked · {activeCount} active ·{' '}
              {rows.length - activeCount} demoted
              {updatedAt !== null &&
                ` · updated ${new Date(updatedAt).toLocaleTimeString()}`}
            </p>
            {/*
              The analytical columns are never dropped on a narrow screen —
              hiding evidence is worse than scrolling to it. The region is
              focusable so the overflow is reachable by keyboard as well.
            */}
            <div
              className="rb-scroll-x"
              role="region"
              aria-label="Tipster leaderboard table"
              tabIndex={0}
            >
              <table className="rb-table">
                <caption className="rb-visually-hidden">
                  Tracked tipsters with performance evidence. Activate a column
                  header to change the sort order.
                </caption>
                <thead>
                  <tr>
                    {COLUMNS.map((c) => {
                      const active = c.key === sortKey;
                      return (
                        <th
                          key={c.key}
                          scope="col"
                          className={c.align === 'right' ? 'rb-num' : undefined}
                          aria-sort={
                            active
                              ? sortDir === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          <button
                            type="button"
                            className={
                              c.align === 'right' ? 'rb-sort rb-sort--right' : 'rb-sort'
                            }
                            data-active={active ? 'true' : 'false'}
                            onClick={() => onSort(c.key)}
                          >
                            {c.label}
                            {/*
                              Decorative only. The sort state is carried by
                              `aria-sort` on the header cell above; repeating it
                              in the button's accessible name would make screen
                              readers announce it twice per column.
                            */}
                            <span className="rb-sort__glyph" aria-hidden="true">
                              {sortGlyph(active, sortDir)}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t) => (
                    <tr key={t.tipster_id} className={t.isActive ? undefined : 'rb-row--demoted'}>
                      <th scope="row" style={{ fontWeight: 700 }}>
                        {t.name}
                      </th>
                      <td>
                        {t.source ?? t.affiliation ?? <span style={{ color: MUTED }}>{DASH}</span>}
                      </td>
                      <td className="rb-num" style={{ color: roiColor(t.longRunRoi) }}>
                        {formatRoi(t.longRunRoi)}
                      </td>
                      <td className="rb-num" style={{ color: roiColor(t.recentRoi30d) }}>
                        {formatRoi(t.recentRoi30d)}
                      </td>
                      <td className="rb-num">{formatPct(t.strikeRate)}</td>
                      <td className="rb-num">{formatInt(t.longestLosingStreak)}</td>
                      <td className="rb-num">
                        <ReliabilityBar value={t.reliability} />
                      </td>
                      <td className="rb-num">{formatNum(t.finalWeight, 3)}</td>
                      <td className="rb-num">{formatInt(t.betsCount)}</td>
                      <td>
                        <StatusBadge tone={t.isActive ? 'positive' : 'warning'}>
                          {t.isActive ? 'ACTIVE' : 'DEMOTED'}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
