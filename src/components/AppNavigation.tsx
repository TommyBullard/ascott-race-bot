'use client';

/**
 * Racing Bot navigation — the ONE client component in the shell.
 *
 * SCOPE. It renders navigation state and nothing else. It reads the current
 * route with `usePathname` so no page has to hardcode its own path (a literal
 * silently drifts when a route is renamed, which would disable `aria-current`
 * with nothing to catch it). That is the entire reason this file is a client
 * component.
 *
 * MOUNT-GATED DATE. It also owns the current racing date for the `Today` and
 * `Meetings` destinations, derived AFTER mount so that no build-time date can
 * be frozen into a statically prerendered page and no hydration mismatch can
 * occur. See the note in the component body.
 *
 * It performs NO data fetching, NO browser storage, NO history or router
 * mutation, NO state, NO effects, and exposes NO write control. The pathname is
 * used only to compute `aria-current` — it is never rendered as visible text.
 *
 * Everything else in the shell stays a server component: `AppShell` renders
 * this inside its `<nav>` landmarks, so only the navigation list crosses the
 * client boundary.
 */

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { currentRacingDate } from './racingDate';

import {
  PLANNED_DESTINATIONS,
  buildMobileDestinations,
  buildPrimaryDestinations,
  isNavDestinationActive,
  type NavDestination,
} from './navDestinations';

/**
 * Stable no-op subscribe for {@link useSyncExternalStore}.
 *
 * The racing date does not change during a page's lifetime — a viewer sitting
 * on the page across midnight keeps the day they loaded, and a fresh load
 * picks up the new one — so there is nothing to subscribe to. Module-scoped so
 * the reference is stable across renders.
 */
const subscribeNoop = (): (() => void) => () => {};

/**
 * The SERVER and hydration snapshot: no date is known yet.
 *
 * Deliberately a constant, never a clock read. This is the value that is
 * rendered into static HTML, so it must be something that can never go stale.
 */
const serverRacingDate = (): string | null => null;

/** Which navigation this list is rendering. */
export type NavVariant = 'primary' | 'mobile';

export interface AppNavigationProps {
  variant: NavVariant;
  /**
   * Explicit route override. Omit it — the normal case — and the live route is
   * detected. Passing an explicit value (including `null`) suppresses
   * detection, which keeps the active-route rendering deterministic for tests
   * and for any caller that already knows the path.
   */
  pathname?: string | null;
  /**
   * TEST SEAM ONLY — a pre-resolved `YYYY-MM-DD` standing in for post-mount
   * state, so a test can assert the mounted output without a DOM to run
   * effects in.
   *
   * NO PRODUCTION CALLER PASSES THIS, and a test asserts that. Supplying it
   * from a server component would reintroduce the exact defect this design
   * removes: a date fixed at render time, which on a statically prerendered
   * page is the build date forever. A plain string, never a `Date`, so it
   * stays serialisable.
   */
  todayDate?: string | null;
}

/**
 * Reconciles the optional override with the detected route.
 *
 * Extracted as a pure function so the PRODUCTION path is testable. Every
 * behavioural active-route test supplies an explicit override, and outside a
 * router context `usePathname()` resolves to null — so without this seam, code
 * that ignored the detected value entirely would still pass every test while
 * silently dropping `aria-current` on every real page.
 *
 * `undefined` means "not supplied" and defers to detection. An explicit `null`
 * is a deliberate "nothing is active" and is preserved as such.
 */
export function resolveActivePathname(
  override: string | null | undefined,
  detected: string | null
): string | null {
  return override === undefined ? detected : override;
}

/** Renders one navigation anchor, marking the active route for AT and sight. */
function NavLink({
  destination,
  pathname,
  useShortLabel,
}: {
  destination: NavDestination;
  pathname: string | null | undefined;
  useShortLabel: boolean;
}) {
  const active = isNavDestinationActive(pathname, destination.href);
  return (
    <li className="rb-nav__item">
      <Link
        className="rb-nav__link"
        href={destination.href}
        aria-current={active ? 'page' : undefined}
      >
        {useShortLabel ? destination.shortLabel : destination.label}
      </Link>
    </li>
  );
}

export function AppNavigation({ variant, pathname, todayDate }: AppNavigationProps) {
  // Called unconditionally, as hooks must be. Outside a router context it
  // resolves to null, which simply means "no destination is active".
  const detected = usePathname();
  const current = resolveActivePathname(pathname, detected);

  /*
   * MOUNT-GATED DATE.
   *
   * `useSyncExternalStore` is React's designed mechanism for a value the
   * SERVER cannot know: it renders `getServerSnapshot` on the server AND on
   * the hydration render, then switches to `getSnapshot` once mounted. The
   * server snapshot is a constant `null`, so the server HTML and the first
   * client render are byte-identical and a hydration mismatch on the date is
   * structurally impossible.
   *
   * Deriving it here rather than in `AppShell` is what fixes the staleness:
   * the shell is a SHARED module, so on a statically prerendered page its
   * render happens at BUILD time, and any date it computed would be frozen
   * into the HTML until the next deployment. Nothing dated is written to the
   * page until the browser has said what day it actually is.
   *
   * Preferred over `useState` + `useEffect`: that pattern sets state during an
   * effect (which `react-hooks/set-state-in-effect` rejects) and costs an
   * extra render pass. `subscribeNoop` is module-scoped so its reference is
   * stable, matching the existing convention on the dashboard.
   */
  const mountedDate = useSyncExternalStore(subscribeNoop, currentRacingDate, serverRacingDate);

  // `undefined` means "not supplied" and defers to the mounted value; the
  // test seam passes an explicit string to stand in for post-mount state.
  const racingDate = todayDate === undefined ? mountedDate : todayDate;

  const isMobile = variant === 'mobile';
  // A null date yields the STATIC destinations alone, so before mount there
  // is no dated href to be stale and no malformed one to be broken.
  const destinations = isMobile
    ? buildMobileDestinations(racingDate)
    : buildPrimaryDestinations(racingDate);

  return (
    <ul className="rb-nav__list">
      {destinations.map((destination) => (
        <NavLink
          key={destination.href}
          destination={destination}
          pathname={current}
          useShortLabel={isMobile}
        />
      ))}

      {/*
        Planned destinations appear in the header only. The bottom bar carries
        working destinations exclusively, so no disabled item can occupy a
        mobile slot.
      */}
      {isMobile
        ? null
        : PLANNED_DESTINATIONS.map((planned) => (
            <li className="rb-nav__item rb-nav__item--planned" key={planned.label}>
              {/* Not an anchor: planned destinations have no route to visit. */}
              <span className="rb-nav__planned">
                {planned.label}
                <span className="rb-nav__planned-tag">Planned</span>
              </span>
            </li>
          ))}
    </ul>
  );
}

export default AppNavigation;
