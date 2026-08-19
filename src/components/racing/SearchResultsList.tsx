/**
 * Presentational list of racing search results.
 *
 * No `'use client'`, no hooks, no data fetching, no clock: it renders the data
 * the search endpoint already shaped. Kept separate from the controls so the
 * interactive surface stays small and this list can be rendered in a test
 * without a router.
 *
 * LINKS COME FROM THE SERVER, BUT ARE NOT TRUSTED BLINDLY. `href` is either a
 * canonical stored-handle route or null; this component never builds, repairs
 * or guesses one. It additionally REFUSES anything that is not a same-origin
 * absolute path, so a future server change, a tampered response or a poisoned
 * cache entry cannot turn a result into an off-site or `javascript:` link.
 *
 * TEXT ONLY. Result text is rendered as React children — never as HTML — so
 * there is no injection surface and no match highlighting that would need one.
 */

import Link from 'next/link';

import type { SearchResult } from '@/lib/racingSearchContract';

/** Formats an ISO instant as `HH:mm` in the racing timezone. */
const OFF_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatOffTime(iso: string | null): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return OFF_TIME_FORMAT.format(new Date(ms));
}

/** `2026-08-17` -> `17 Aug 2026`, compact enough for a result row. */
const RESULT_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatResultDate(date: string): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) ? RESULT_DATE_FORMAT.format(new Date(ms)) : date;
}

/** Why a result is not a link, in plain words. Never names an identifier. */
const UNAVAILABLE_NOTE: Record<string, string> = {
  historical: 'Stored before canonical race identity was captured, so it has no permanent page.',
  ambiguous:
    'More than one stored race matches this address, so it cannot be opened safely from here.',
};

export interface SearchResultsListProps {
  results: readonly SearchResult[];
  /** Announced heading for the list region. */
  label: string;
  /** Called when a result link is followed, so a panel can close itself. */
  onNavigate?: () => void;
}

/**
 * True only for a same-origin absolute path such as `/date/2026-08-17`.
 *
 * Rejects absolute URLs, scheme-relative `//host`, the BACKSLASH form `/\host`
 * (WHATWG URL parsing treats a backslash as a slash for special schemes, so
 * `/\evil.example` resolves off-site), and any `javascript:` or `data:`
 * payload. A result failing this renders as static text, exactly as a
 * historical one does.
 */
export function isLocalResultHref(href: string | null): href is string {
  if (typeof href !== 'string' || !href.startsWith('/')) return false;
  const second = href.charAt(1);
  return second !== '/' && second !== '\\';
}

export function SearchResultsList({ results, label, onNavigate }: SearchResultsListProps) {
  return (
    <ul className="rb-search__results" aria-label={label}>
      {results.map((result, index) => {
        const isMeeting = result.kind === 'meeting';
        const title = isMeeting ? result.courseLabel : result.raceName;
        const offTime = isMeeting ? null : formatOffTime(result.offTime);
        // Index participates in the key ONLY as a tie-break within one
        // response; no internal uuid is available here, and none is wanted.
        const key = `${result.kind}-${result.meetingDate}-${title}-${index}`;

        const detail = (
          <>
            <span className="rb-search__result-title">{title}</span>
            <span className="rb-search__result-meta">
              <span className="rb-search__result-kind">{isMeeting ? 'Meeting' : 'Race'}</span>
              {' · '}
              {formatResultDate(result.meetingDate)}
              {!isMeeting && ` · ${result.courseLabel}`}
              {offTime !== null && ` · ${offTime}`}
              {isMeeting &&
                ` · ${result.matchingRaceCount} matching race${result.matchingRaceCount === 1 ? '' : 's'}`}
            </span>
          </>
        );

        return (
          <li className="rb-search__result" key={key}>
            {isLocalResultHref(result.href) ? (
              <Link className="rb-search__result-link" href={result.href} onClick={onNavigate}>
                {detail}
              </Link>
            ) : (
              <div className="rb-search__result-static">
                {detail}
                <span className="rb-search__result-note">
                  {UNAVAILABLE_NOTE[result.availability] ?? 'No permanent page is available.'}
                </span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default SearchResultsList;
