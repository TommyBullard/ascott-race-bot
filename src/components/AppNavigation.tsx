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
 * It performs NO data fetching, NO browser storage, NO history or router
 * mutation, NO state, NO effects, and exposes NO write control. The pathname is
 * used only to compute `aria-current` — it is never rendered as visible text.
 *
 * Everything else in the shell stays a server component: `AppShell` renders
 * this inside its `<nav>` landmarks, so only the navigation list crosses the
 * client boundary.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  MOBILE_DESTINATIONS,
  PLANNED_DESTINATIONS,
  PRIMARY_DESTINATIONS,
  isNavDestinationActive,
  type NavDestination,
} from './navDestinations';

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

export function AppNavigation({ variant, pathname }: AppNavigationProps) {
  // Called unconditionally, as hooks must be. Outside a router context it
  // resolves to null, which simply means "no destination is active".
  const detected = usePathname();
  const current = resolveActivePathname(pathname, detected);

  const isMobile = variant === 'mobile';
  const destinations = isMobile ? MOBILE_DESTINATIONS : PRIMARY_DESTINATIONS;

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
