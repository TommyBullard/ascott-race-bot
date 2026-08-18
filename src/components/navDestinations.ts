/**
 * Racing Bot navigation model — pure data, one pure builder, one pure predicate.
 *
 * This module is deliberately separate from both `AppShell.tsx` (a server
 * component) and `AppNavigation.tsx` (the one client component). The shell
 * renders the client navigation, and the client navigation needs the
 * destination list; if that list lived in the shell, the two modules would
 * import each other. Keeping the model here breaks the cycle and leaves it
 * importable from either side of the server/client boundary.
 *
 * No JSX, no React, no `'use client'`, no side effects, no clock read.
 *
 * NAVIGATION POLICY. Only routes that actually exist are described as links.
 * Planned destinations carry no `href` field at all — they are structurally
 * incapable of becoming a link, so navigation can never produce a 404.
 *
 * STATIC vs DYNAMIC. Four destinations are fixed routes and stay constants.
 * The racing destinations depend on the CURRENT racing date, so they are built
 * per render by {@link buildPrimaryDestinations} — never frozen into a
 * module-level constant, which would bake in whichever date the module first
 * loaded (at build time, for a statically rendered page).
 */

import { isIsoRacingDate } from './racingDate';

/** A destination that exists today and may safely be linked. */
export interface NavDestination {
  /** In-app route that is known to exist. */
  href: string;
  /** Full label used in the header navigation. */
  label: string;
  /** Condensed label used in the mobile bottom bar. */
  shortLabel: string;
}

/**
 * A destination that does NOT exist yet.
 *
 * There is intentionally no `href` on this type. A planned destination cannot
 * be rendered as an anchor without a compile error, which is what keeps
 * "no misleading links" a structural guarantee rather than a convention.
 */
export interface PlannedDestination {
  label: string;
}

/**
 * Fixed routes, verified to exist in `src/app`.
 *
 * Deliberately excludes the date-dependent racing destinations: this array is
 * evaluated once at module load, which is exactly the wrong lifetime for a
 * value derived from "today".
 */
export const PRIMARY_DESTINATIONS: readonly NavDestination[] = [
  { href: '/', label: 'Overview', shortLabel: 'Overview' },
  { href: '/how-it-works', label: 'Methodology', shortLabel: 'Method' },
  { href: '/leaderboard', label: 'Tipster Evidence', shortLabel: 'Tipsters' },
  { href: '/results-audit', label: 'Official Record', shortLabel: 'Record' },
];

/** Destinations arriving in later slices. Shown as clearly unavailable. */
export const PLANNED_DESTINATIONS: readonly PlannedDestination[] = [{ label: 'Operations' }];

/** Hard ceiling on mobile bottom-bar destinations. */
export const MOBILE_NAV_MAX_DESTINATIONS = 5;

/** The date page's meetings-list anchor. One definition, used by both sides. */
export const MEETINGS_ANCHOR_ID = 'meetings';

/**
 * Builds the header destinations for a given current racing date.
 *
 * RACING FIRST. `Today` and `Meetings` sit immediately after `Overview`,
 * because they are the product's primary entry points into a race day.
 *
 * A null/malformed date yields the static destinations ALONE. That is the
 * fail-safe: an absent date must never become `/date/undefined`, and a missing
 * link is better than a link that 404s. Pure — the date is a parameter.
 */
export function buildPrimaryDestinations(
  todayDate: string | null | undefined,
): readonly NavDestination[] {
  const [overview, ...rest] = PRIMARY_DESTINATIONS;
  // Validated through the SAME predicate the routes use, so a value that could
  // not be a route can never be rendered as one.
  if (!isIsoRacingDate(todayDate)) return PRIMARY_DESTINATIONS;
  return [
    overview,
    { href: `/date/${todayDate}`, label: 'Today', shortLabel: 'Today' },
    {
      href: `/date/${todayDate}#${MEETINGS_ANCHOR_ID}`,
      label: 'Meetings',
      shortLabel: 'Meetings',
    },
    ...rest,
  ];
}

/**
 * Mobile bottom navigation: working ROUTE destinations only, capped.
 *
 * Planned destinations are excluded entirely so the bar can never trap a user
 * on a disabled control, and FRAGMENT destinations are excluded too: a bottom
 * bar is for moving between pages, while `Meetings` scrolls within a page
 * `Today` already reaches. Excluding it is also what keeps the bar within its
 * five-slot ceiling WITHOUT displacing an established destination — all four
 * original entries survive and `Today` joins them.
 *
 * Order is otherwise the header order, so the two navigations never disagree
 * about precedence.
 */
export function buildMobileDestinations(
  todayDate: string | null | undefined,
): readonly NavDestination[] {
  return buildPrimaryDestinations(todayDate)
    .filter((destination) => !destination.href.includes('#'))
    .slice(0, MOBILE_NAV_MAX_DESTINATIONS);
}

/** The static mobile set, for consumers that have no date to supply. */
export const MOBILE_DESTINATIONS: readonly NavDestination[] = PRIMARY_DESTINATIONS.slice(
  0,
  MOBILE_NAV_MAX_DESTINATIONS,
);

/**
 * Pure active-route test.
 *
 * `/` matches only itself (it would otherwise prefix-match every route).
 * Other routes match themselves and their descendants, at a SEGMENT boundary —
 * so `/date/2026-08-170` is not a descendant of `/date/2026-08-17`. A
 * null/unknown pathname simply yields no active item — never a guess.
 *
 * FRAGMENT DESTINATIONS ARE NEVER ACTIVE. A destination whose href carries a
 * `#` targets a section of a page another destination already represents, and
 * the fragment is not part of `usePathname()` on the server or the client.
 * Marking it `aria-current="page"` would put the state on two destinations at
 * once and make it non-deterministic between server and browser. So `Meetings`
 * is a discoverable link, while `Today` owns the current-date route family —
 * one clear owner, no client state invented to distinguish them.
 */
export function isNavDestinationActive(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  if (href.includes('#')) return false;
  // Ignore any query string or hash the caller may have included.
  const path = pathname.split('?')[0].split('#')[0];
  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (href === '/') return normalised === '/';
  return normalised === href || normalised.startsWith(`${href}/`);
}
