/**
 * Racing Bot application shell — course-agnostic, read-only, presentational.
 *
 * SLICE 1 SCOPE. This component establishes the structural and visual frame
 * for the multi-course UK & Ireland rebuild: skip link, header landmark,
 * navigation landmarks, and a single `<main>` landmark with a stable id.
 *
 * It is deliberately a SERVER component: no `'use client'`, no hooks, no
 * router access, no browser storage, no environment access, no data fetching
 * and no write controls. The caller passes the current `pathname` if it has
 * one, and active-route marking is computed by the pure
 * `isNavDestinationActive` helper below, so the shell renders identically on
 * the server and the client.
 *
 * NOT YET MOUNTED. Every existing page (`/`, `/how-it-works`, `/leaderboard`,
 * `/results-audit`) currently renders its own `<main>`. Mounting this shell in
 * the root layout today would nest `<main>` inside `<main>` on every route, so
 * adoption happens per route in Slice 2 as each page's own `<main>` is
 * migrated. Slice 1 ships the foundation and the tokens only.
 *
 * NAVIGATION POLICY. Only routes that actually exist are rendered as links.
 * Planned destinations carry no `href` field at all — they are structurally
 * incapable of becoming a link, so the shell can never produce a 404.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import type { ReactNode } from 'react';

/** Course-agnostic product identity. Never names a single racecourse. */
export const APP_NAME = 'Racing Bot';
export const APP_TAGLINE = 'UK & Ireland Racing Analytics';

/** Stable id for the single `<main>` landmark; also the skip-link target. */
export const MAIN_LANDMARK_ID = 'rb-main';

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

/** Inert regions reserving space for controls that arrive in later slices. */
export const PLACEHOLDER_SLOTS: readonly { label: string; state: string }[] = [
  { label: 'Search', state: 'Planned' },
  { label: 'Date', state: 'Planned' },
  { label: 'Scope', state: 'Planned' },
];

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

export interface AppShellProps {
  children: ReactNode;
  /**
   * Current route path, when the caller can supply it safely. Used only to set
   * `aria-current="page"`. Omit it and no destination is marked active.
   */
  pathname?: string | null;
  /** Optional extra class on the shell root. */
  className?: string;
}

/** Renders one navigation anchor, marking the active route for AT and sight. */
function NavLink({
  destination,
  pathname,
  useShortLabel = false,
}: {
  destination: NavDestination;
  pathname: string | null | undefined;
  useShortLabel?: boolean;
}) {
  const active = isNavDestinationActive(pathname, destination.href);
  return (
    <li className="rb-nav__item">
      <a
        className="rb-nav__link"
        href={destination.href}
        aria-current={active ? 'page' : undefined}
      >
        {useShortLabel ? destination.shortLabel : destination.label}
      </a>
    </li>
  );
}

export function AppShell({ children, pathname = null, className }: AppShellProps) {
  const rootClass = className ? `rb-app ${className}` : 'rb-app';

  return (
    <div className={rootClass}>
      <a className="rb-skip-link" href={`#${MAIN_LANDMARK_ID}`}>
        Skip to main content
      </a>

      <header className="rb-header">
        <div className="rb-header__inner">
          <div className="rb-identity">
            <span className="rb-identity__mark" aria-hidden="true">
              RB
            </span>
            <span className="rb-identity__text">
              <span className="rb-identity__name">{APP_NAME}</span>
              <span className="rb-identity__tagline">{APP_TAGLINE}</span>
            </span>
          </div>

          {/*
            Reserved control regions. Inert by construction — no input, no
            button, no handler — and each states its planned status in visible
            text so nothing reads as operable.
          */}
          <div className="rb-control-channel">
            {PLACEHOLDER_SLOTS.map((slot) => (
              <div className="rb-slot" key={slot.label}>
                <span className="rb-slot__label">{slot.label}</span>
                <span className="rb-slot__state">{slot.state}</span>
              </div>
            ))}
          </div>
        </div>

        <nav className="rb-nav rb-nav--primary" aria-label="Primary">
          <ul className="rb-nav__list">
            {PRIMARY_DESTINATIONS.map((destination) => (
              <NavLink key={destination.href} destination={destination} pathname={pathname} />
            ))}
            {PLANNED_DESTINATIONS.map((planned) => (
              <li className="rb-nav__item rb-nav__item--planned" key={planned.label}>
                {/* Not an anchor: planned destinations have no route to visit. */}
                <span className="rb-nav__planned">
                  {planned.label}
                  <span className="rb-nav__planned-tag">Planned</span>
                </span>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="rb-main" id={MAIN_LANDMARK_ID} tabIndex={-1}>
        {children}
      </main>

      {/* Working destinations only — no disabled item can trap a mobile user. */}
      <nav className="rb-nav rb-nav--mobile" aria-label="Primary mobile">
        <ul className="rb-nav__list">
          {MOBILE_DESTINATIONS.map((destination) => (
            <NavLink
              key={destination.href}
              destination={destination}
              pathname={pathname}
              useShortLabel
            />
          ))}
        </ul>
      </nav>
    </div>
  );
}

export default AppShell;
