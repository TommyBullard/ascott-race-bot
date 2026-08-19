'use client';

/**
 * Racing header controls — Search, Date and Scope.
 *
 * THE SECOND AND LAST CLIENT COMPONENT IN THE SHELL. `AppNavigation` reads the
 * route; this one owns the interactive controls. Both exist because a server
 * component cannot hold input state — and nothing else in the shell does.
 *
 * WHAT IT MAY REACH. Exactly one network path: the bounded, read-only local
 * endpoint {@link SEARCH_ENDPOINT}. The URL is a module constant with the query
 * carried as encoded parameters, so no user input can construct a different
 * URL and no external host is reachable. It imports no database module, no
 * server module and no environment value.
 *
 * MOUNT-GATED DATE. The Date control's default comes from the same rule as the
 * Today link: nothing dated is rendered on the server or in the first
 * hydration render, so a statically prerendered page cannot freeze a build
 * date into its HTML. See `racingDate.ts`.
 *
 * WRITES NOTHING. Searching, choosing a date and changing scope are display
 * state and navigation only.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { currentRacingDate, isIsoRacingDate } from './racingDate';
import SearchResultsList from './racing/SearchResultsList';
import type { RacingSearchSuccess, SearchResult, SearchScope } from '@/lib/racingSearchContract';

/**
 * The ONLY path this component fetches. A module constant, never derived from
 * input, so an arbitrary or external URL cannot be constructed.
 */
const SEARCH_ENDPOINT = '/api/search/racing';

/** The ONLY route prefix the date control can navigate to. A constant. */
export const DATE_ROUTE_PREFIX = '/date/';

/**
 * The canonical route a chosen date should open, or null if it must not open.
 *
 * Pure and exported so the RULE is tested directly rather than inferred from
 * the source of a component. Empty, partial, malformed and impossible dates all
 * yield null, and the prefix is a constant — so no input can build any other
 * path, absolute URL or scheme.
 */
export function resolveDateHref(value: string | null | undefined): string | null {
  return isIsoRacingDate(value) ? `${DATE_ROUTE_PREFIX}${value}` : null;
}

/** Mirrors the server bound; the input also refuses to search below it. */
const MIN_QUERY_LENGTH = 2;

/** Mirrors the server bound, so an over-long value is never even sent. */
const MAX_QUERY_LENGTH = 64;

/** Quiet period before a search is issued, so typing does not flood the route. */
export const SEARCH_DEBOUNCE_MS = 250;

/** The scopes the selector offers. Fixed; never derived from a response. */
const SCOPE_OPTIONS: readonly { value: SearchScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'meetings', label: 'Meetings' },
  { value: 'races', label: 'Races' },
];

/**
 * Search state, TAGGED WITH THE REQUEST IT BELONGS TO.
 *
 * Carrying `query` and `scope` lets the render decide whether the stored
 * outcome still describes what the user is currently asking. That removes any
 * need to clear state from an effect, and it makes a stale result structurally
 * unable to appear under a newer query.
 */
type SearchState =
  | { status: 'idle'; query: ''; scope: SearchScope }
  | { status: 'searching'; query: string; scope: SearchScope }
  | { status: 'done'; query: string; scope: SearchScope; results: SearchResult[]; truncated: boolean }
  | { status: 'failed'; query: string; scope: SearchScope };

const IDLE: SearchState = { status: 'idle', query: '', scope: 'all' };

/** Stable no-op subscribe: the racing date does not change while mounted. */
const subscribeNoop = (): (() => void) => () => {};

/**
 * Navigates to a local path.
 *
 * Deliberately NOT `useRouter`. That hook THROWS outside an app-router
 * context, which would make the whole shell unrenderable anywhere a router is
 * not mounted — including every existing shell test, which renders the shell
 * with `renderToStaticMarkup`. `usePathname` returns null in that situation;
 * `useRouter` does not, so the shell must not depend on it.
 *
 * The cost is a full document navigation instead of a client transition for
 * the date control alone. Search results remain `next/link` anchors and still
 * transition client-side. The href is always a validated canonical date route
 * built from a module-constant prefix, so this can never become an open
 * redirect.
 */
function navigateToPath(href: string): void {
  if (typeof window === 'undefined') return;
  window.location.assign(href);
}

/** Server and hydration snapshot: no date is known yet. Never a clock read. */
const serverRacingDate = (): string | null => null;

export interface RacingControlsProps {
  /**
   * TEST SEAM ONLY — how a chosen date navigates. Production uses the
   * default, and a test asserts no production caller supplies this.
   */
  navigate?: (href: string) => void;
}

export function RacingControls({ navigate = navigateToPath }: RacingControlsProps) {
  const searchInputId = useId();
  const scopeSelectId = useId();
  const dateInputId = useId();
  const statusId = useId();

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [search, setSearch] = useState<SearchState>(IDLE);

  // Mount-gated, exactly as the navigation date is: the server snapshot is a
  // constant null, so no date reaches static HTML and no hydration mismatch
  // is possible. Used only as the date input's initial value.
  const today = useSyncExternalStore(subscribeNoop, currentRacingDate, serverRacingDate);
  const [chosenDate, setChosenDate] = useState('');
  /**
   * The date already navigated to, so leaving the field without editing it
   * does nothing. Without this, tabbing THROUGH the control fired a blur on a
   * pre-filled value and performed a full navigation the user never asked for.
   */
  const committedDate = useRef<string | null>(null);
  const dateValue = chosenDate !== '' ? chosenDate : (today ?? '');

  const trimmed = query.trim();
  const eligible = trimmed.length >= MIN_QUERY_LENGTH && trimmed.length <= MAX_QUERY_LENGTH;

  /** The in-flight request, so a superseded search is aborted, not raced. */
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!eligible) {
      // Abort only. The stored outcome is NOT cleared here: state is never set
      // directly in an effect, and the render already ignores an outcome whose
      // query no longer matches, so nothing stale can be shown.
      inFlight.current?.abort();
      inFlight.current = null;
      return;
    }

    const timer = setTimeout(() => {
      // Abort the previous request before starting another, so at most one is
      // ever outstanding and a slow earlier reply cannot overwrite a later one.
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      setSearch({ status: 'searching', query: trimmed, scope });

      const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(trimmed)}&scope=${encodeURIComponent(scope)}`;
      fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
        .then(async (response) => {
          if (!response.ok) throw new Error('search_failed');
          return (await response.json()) as RacingSearchSuccess;
        })
        .then((body) => {
          if (controller.signal.aborted) return;
          setSearch({
            status: 'done',
            query: trimmed,
            scope,
            results: Array.isArray(body.results) ? body.results : [],
            truncated: body.truncated === true,
          });
        })
        .catch((error: unknown) => {
          // An abort is a superseded search, not a failure to report.
          if (error instanceof DOMException && error.name === 'AbortError') return;
          if (controller.signal.aborted) return;
          setSearch({ status: 'failed', query: trimmed, scope });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmed, scope, eligible]);

  // Abort anything outstanding when the control unmounts.
  useEffect(() => () => inFlight.current?.abort(), []);

  const clearSearch = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setQuery('');
    setSearch(IDLE);
    // The focused result link is about to unmount; put focus somewhere real.
    searchInputRef.current?.focus();
  }, []);

  const goToDate = useCallback(
    (value: string) => {
      // Validated with the SAME predicate the route uses, so a value that could
      // not be a route is never navigated to. Empty and malformed do nothing.
      const href = resolveDateHref(value);
      if (href === null) return;
      // Only an actual change navigates.
      if (committedDate.current === value) return;
      committedDate.current = value;
      navigate(href);
    },
    [navigate],
  );

  /*
   * Only an outcome for the CURRENT query and scope is shown. Anything else
   * — a reply for a query the user has since edited, or results left over
   * from before the input was shortened — is treated as idle.
   */
  const visible: SearchState =
    eligible && search.query === trimmed && search.scope === scope ? search : IDLE;

  const statusMessage =
    visible.status === 'searching'
      ? 'Searching…'
      : visible.status === 'failed'
        ? 'Search is unavailable right now.'
        : visible.status === 'done'
          ? visible.results.length === 0
            ? `No racing found for “${trimmed}”.`
            : `${visible.results.length} result${visible.results.length === 1 ? '' : 's'} for “${trimmed}”.`
          : '';

  return (
    <div
      className="rb-controls"
      onKeyDown={(event) => {
        // Escape dismisses results from anywhere in the control group — including
        // while focus sits on a result link, where a handler bound to the input
        // alone would never fire.
        if (event.key === 'Escape' && (query !== '' || visible.status !== 'idle')) {
          event.preventDefault();
          clearSearch();
        }
      }}
    >
      <div className="rb-controls__field">
        <label className="rb-controls__label" htmlFor={searchInputId}>
          Search racing
        </label>
        <input
          className="rb-controls__input"
          ref={searchInputRef}
          id={searchInputId}
          type="search"
          value={query}
          maxLength={MAX_QUERY_LENGTH}
          autoComplete="off"
          placeholder="Course or race"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.preventDefault();
              clearSearch();
            }
          }}
        />
      </div>

      <div className="rb-controls__field">
        <label className="rb-controls__label" htmlFor={scopeSelectId}>
          Search scope
        </label>
        <select
          className="rb-controls__select"
          id={scopeSelectId}
          value={scope}
          onChange={(event) => setScope(event.target.value as SearchScope)}
        >
          {SCOPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rb-controls__field">
        <label className="rb-controls__label" htmlFor={dateInputId}>
          Go to date
        </label>
        <input
          className="rb-controls__input rb-controls__input--date"
          id={dateInputId}
          type="date"
          value={dateValue}
          /*
           * TYPING NEVER NAVIGATES.
           *
           * `<input type="date">` fires change on every completed segment edit,
           * and the field starts pre-filled — so editing the year of
           * 2026-08-18 momentarily produces 0002-08-18, which is a VALID ISO
           * date. Navigating on change therefore tore the page away mid-keystroke
           * and landed on a nonsense year. The value is only committed on an
           * explicit gesture: Enter, or leaving the field.
           */
          onChange={(event) => setChosenDate(event.target.value)}
          onBlur={(event) => goToDate(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              goToDate(event.currentTarget.value);
            }
          }}
        />
      </div>

      {/*
        One polite live region for every search state, so a screen reader hears
        "Searching", a count, an empty result or a failure — each distinct, and
        never a failure disguised as an empty result.

        `aria-live` WITHOUT `role="status"`: the announcement is identical, and
        the page keeps exactly one status region — the loading skeleton’s — so
        the shell does not add a second one to every page.
      */}
      <p className="rb-controls__status" id={statusId} aria-live="polite" aria-atomic="true">
        {statusMessage}
      </p>

      {visible.status === 'done' && visible.results.length > 0 && (
        <div className="rb-search__panel">
          <SearchResultsList
            results={visible.results}
            label={`Search results for ${trimmed}`}
            onNavigate={clearSearch}
          />
          {visible.truncated && (
            <p className="rb-note">Showing the closest matches. Refine the search for more.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default RacingControls;
