/**
 * Racing Bot navigation model — pure data and one pure predicate.
 *
 * This module is deliberately separate from both `AppShell.tsx` (a server
 * component) and `AppNavigation.tsx` (the one client component). The shell
 * renders the client navigation, and the client navigation needs the
 * destination list; if that list lived in the shell, the two modules would
 * import each other. Keeping the model here breaks the cycle and leaves it
 * importable from either side of the server/client boundary.
 *
 * No JSX, no React, no `'use client'`, no side effects.
 *
 * NAVIGATION POLICY. Only routes that actually exist are described as links.
 * Planned destinations carry no `href` field at all — they are structurally
 * incapable of becoming a link, so navigation can never produce a 404.
 */

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

/** Working routes, verified to exist in `src/app`. */
export const PRIMARY_DESTINATIONS: readonly NavDestination[] = [
  { href: '/', label: 'Overview', shortLabel: 'Overview' },
  { href: '/how-it-works', label: 'Methodology', shortLabel: 'Method' },
  { href: '/leaderboard', label: 'Tipster Evidence', shortLabel: 'Tipsters' },
  { href: '/results-audit', label: 'Official Record', shortLabel: 'Record' },
];

/** Destinations arriving in later slices. Shown as clearly unavailable. */
export const PLANNED_DESTINATIONS: readonly PlannedDestination[] = [
  { label: 'Today' },
  { label: 'Meetings' },
  { label: 'Operations' },
];

/** Hard ceiling on mobile bottom-bar destinations. */
export const MOBILE_NAV_MAX_DESTINATIONS = 5;

/**
 * Mobile bottom navigation: working destinations only, capped.
 * Planned destinations are excluded entirely so the bar can never trap a user
 * on a disabled control.
 */
export const MOBILE_DESTINATIONS: readonly NavDestination[] = PRIMARY_DESTINATIONS.slice(
  0,
  MOBILE_NAV_MAX_DESTINATIONS
);

/**
 * Pure active-route test.
 *
 * `/` matches only itself (it would otherwise prefix-match every route).
 * Other routes match themselves and their descendants. A null/unknown
 * pathname simply yields no active item — never a guess.
 */
export function isNavDestinationActive(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  // Ignore any query string or hash the caller may have included.
  const path = pathname.split('?')[0].split('#')[0];
  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (href === '/') return normalised === '/';
  return normalised === href || normalised.startsWith(`${href}/`);
}
