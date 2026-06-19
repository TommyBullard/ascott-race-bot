'use client';

/**
 * Tipster Leaderboard page (/leaderboard).
 *
 * Renders every tracked tipster from `/api/tipsters/leaderboard` in a SORTABLE
 * table: click any column header to sort asc/desc (default: final weight desc).
 * Active and demoted tipsters are shown distinctly (demoted rows are greyed and
 * carry a badge). ROI is a signed percentage coloured green/red; reliability is
 * a 0–1 bar so low-sample tipsters are obvious. Polls for real-time updates.
 *
 * INTEGRITY: every value is read straight from the API (which reads
 * `tipster_priors` / `tipsters`). Missing fields render as "—"; nothing is
 * fabricated client-side.
 *
 * Expected response: `{ tipsters: TipsterLeaderboardEntry[] }`.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';

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

const POSITIVE_COLOR = '#1a7f37';
const NEGATIVE_COLOR = '#cf222e';
const MUTED = '#656d76';

const DASH = '\u2014';

/** Formats a ROI fraction (0.12 => +12.0%), or a dash when unknown. */
function formatRoi(roi: number | null): string {
  if (roi === null) {
    return DASH;
  }
  const pct = roi * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '\u2212' : '';
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

const styles = {
  page: {
    maxWidth: 1040,
    margin: '2rem auto',
    padding: '0 1rem',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#1f2328',
  } as CSSProperties,
  headerRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  } as CSSProperties,
  navLink: {
    fontSize: 14,
    color: '#0969da',
    textDecoration: 'none',
  } as CSSProperties,
  meta: { color: MUTED, fontSize: 13, margin: '4px 0 16px' } as CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 13,
  } as CSSProperties,
  th: {
    textAlign: 'left' as const,
    padding: '8px 10px',
    borderBottom: '2px solid #d0d7de',
    background: '#f6f8fa',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  thRight: {
    textAlign: 'right' as const,
    padding: '8px 10px',
    borderBottom: '2px solid #d0d7de',
    background: '#f6f8fa',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  td: {
    padding: '7px 10px',
    borderBottom: '1px solid #eaeef2',
  } as CSSProperties,
  tdRight: {
    padding: '7px 10px',
    borderBottom: '1px solid #eaeef2',
    textAlign: 'right' as const,
    fontVariantNumeric: 'tabular-nums' as const,
  } as CSSProperties,
  name: { fontWeight: 700 } as CSSProperties,
  muted: { color: MUTED } as CSSProperties,
  demotedRow: { background: '#fafbfc', color: '#8c959f' } as CSSProperties,
  badgeActive: {
    display: 'inline-block',
    padding: '1px 7px',
    fontSize: 11,
    fontWeight: 700,
    color: '#1a7f37',
    background: '#dafbe1',
    border: '1px solid #aceebb',
    borderRadius: 999,
  } as CSSProperties,
  badgeDemoted: {
    display: 'inline-block',
    padding: '1px 7px',
    fontSize: 11,
    fontWeight: 700,
    color: '#9a6700',
    background: '#fff8c5',
    border: '1px solid #eac54f',
    borderRadius: 999,
  } as CSSProperties,
  relWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'flex-end',
    width: '100%',
  } as CSSProperties,
  relTrack: {
    width: 56,
    height: 8,
    borderRadius: 4,
    background: '#eaeef2',
    overflow: 'hidden' as const,
  } as CSSProperties,
};

/** A 0–1 reliability bar; width scales with the value, dash when unknown. */
function ReliabilityBar({ value }: { value: number | null }) {
  if (value === null) {
    return <span style={styles.muted}>{DASH}</span>;
  }
  const clamped = Math.max(0, Math.min(1, value));
  // Low sample (low reliability) reads amber; well-proofed reads green.
  const fill = clamped >= 0.5 ? '#1a7f37' : clamped >= 0.25 ? '#9a6700' : '#cf222e';
  return (
    <span style={styles.relWrap}>
      <span style={styles.relTrack}>
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${clamped * 100}%`,
            background: fill,
          }}
        />
      </span>
      <span style={{ minWidth: 34, textAlign: 'right' }}>
        {(clamped * 100).toFixed(0)}%
      </span>
    </span>
  );
}

/** Sort indicator glyph for the active column. */
function sortGlyph(active: boolean, dir: SortDir): string {
  if (!active) return '\u2009';
  return dir === 'asc' ? ' \u25B2' : ' \u25BC';
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
        const res = await fetch('/api/tipsters/leaderboard', {
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
    const id = setInterval(load, 30000);
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
    <main style={styles.page}>
      <div style={styles.headerRow}>
        <h1>Tipster Leaderboard</h1>
        <Link href="/" style={styles.navLink}>
          ← Recommendations
        </Link>
      </div>

      {status === 'loading' && <p style={styles.muted}>Loading leaderboard…</p>}

      {status === 'error' && (
        <p style={{ color: NEGATIVE_COLOR }}>
          Couldn&apos;t load the leaderboard right now. Please refresh to try
          again.{error ? ` (${error})` : ''}
        </p>
      )}

      {status === 'ready' && rows.length === 0 && (
        <p style={styles.muted}>
          No tracked tipsters yet — the leaderboard will populate once tipster
          performance data is available.
        </p>
      )}

      {status === 'ready' && rows.length > 0 && (
        <>
          <p style={styles.meta}>
            {rows.length} tracked · {activeCount} active ·{' '}
            {rows.length - activeCount} demoted
            {updatedAt !== null &&
              ` · updated ${new Date(updatedAt).toLocaleTimeString()}`}
          </p>
          <table style={styles.table}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    style={c.align === 'right' ? styles.thRight : styles.th}
                    onClick={() => onSort(c.key)}
                    title="Click to sort"
                  >
                    {c.label}
                    {sortGlyph(c.key === sortKey, sortDir)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => {
                const rowStyle = t.isActive ? undefined : styles.demotedRow;
                return (
                  <tr key={t.tipster_id} style={rowStyle}>
                    <td style={styles.td}>
                      <span style={styles.name}>{t.name}</span>
                    </td>
                    <td style={styles.td}>
                      {t.source ?? t.affiliation ?? (
                        <span style={styles.muted}>{DASH}</span>
                      )}
                    </td>
                    <td style={{ ...styles.tdRight, color: roiColor(t.longRunRoi) }}>
                      {formatRoi(t.longRunRoi)}
                    </td>
                    <td style={{ ...styles.tdRight, color: roiColor(t.recentRoi30d) }}>
                      {formatRoi(t.recentRoi30d)}
                    </td>
                    <td style={styles.tdRight}>{formatPct(t.strikeRate)}</td>
                    <td style={styles.tdRight}>{formatInt(t.longestLosingStreak)}</td>
                    <td style={styles.tdRight}>
                      <ReliabilityBar value={t.reliability} />
                    </td>
                    <td style={styles.tdRight}>{formatNum(t.finalWeight, 3)}</td>
                    <td style={styles.tdRight}>{formatInt(t.betsCount)}</td>
                    <td style={styles.td}>
                      <span
                        style={t.isActive ? styles.badgeActive : styles.badgeDemoted}
                      >
                        {t.isActive ? 'ACTIVE' : 'DEMOTED'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
