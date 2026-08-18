/**
 * Racing Bot application shell — course-agnostic, read-only, presentational.
 *
 * It provides the structural and visual frame for the multi-course UK & Ireland
 * rebuild: skip link, header landmark, navigation landmarks, a single `<main>`
 * landmark with a stable id, and the standing decision-support disclaimer.
 *
 * SHARED COMPONENT — NOT inherently server-only.
 *
 * It carries no `'use client'` directive, and that is exactly what makes it
 * SHARED rather than server-only: a module without the directive is compiled
 * into whichever graph imports it. `/how-it-works` and the canonical `/date`
 * routes are server pages, so there it server-renders; `/`, `/leaderboard`
 * and `/results-audit` are `'use client'` pages that import it directly, so
 * there it is bundled for the BROWSER and re-runs on hydration.
 *
 * CONSEQUENCE, AND IT IS LOAD-BEARING: this component must never read
 * request-time or current-time state. It previously derived the racing date
 * here, which froze `Today` to the BUILD date on statically prerendered
 * pages and produced a hydration mismatch on the client-bundled ones. The
 * navigation date is now owned by `AppNavigation`, after mount. See the
 * MOUNT-GATED DATE note there.
 *
 * So: no hooks, no clock, no browser storage, no environment access, no data
 * fetching, no write controls. The only part that deliberately crosses the
 * client boundary is `AppNavigation`, the one module in the shell that
 * carries `'use client'`.
 *
 * ADOPTION. The shell owns `<main>`, so a page that renders inside it must NOT
 * render its own — nested `<main>` landmarks are invalid and break landmark
 * navigation. Adopted so far: `/how-it-works`, `/leaderboard`,
 * `/results-audit`. The dashboard (`/`) still renders its own `<main>` and is
 * migrated in a later slice.
 *
 * Decision-support only. Nothing here places, recommends or settles a bet.
 */

import type { ReactNode } from 'react';

import { AppNavigation } from './AppNavigation';

/**
 * The navigation model lives in its own module so the shell and the client
 * navigation do not import each other. Re-exported here because the shell is
 * the public entry point for consumers and tests.
 */
export {
  MEETINGS_ANCHOR_ID,
  MOBILE_DESTINATIONS,
  MOBILE_NAV_MAX_DESTINATIONS,
  PLANNED_DESTINATIONS,
  PRIMARY_DESTINATIONS,
  buildMobileDestinations,
  buildPrimaryDestinations,
  isNavDestinationActive,
  type NavDestination,
  type PlannedDestination,
} from './navDestinations';

/** Course-agnostic product identity. Never names a single racecourse. */
export const APP_NAME = 'Racing Bot';
export const APP_TAGLINE = 'UK & Ireland Racing Analytics';

/** Stable id for the single `<main>` landmark; also the skip-link target. */
export const MAIN_LANDMARK_ID = 'rb-main';

/**
 * The standing disclaimer shown once on every page the shell owns.
 *
 * It states the boundary of the product and nothing more: it is not a warning
 * banner, not a call to action, and it never instructs anyone to stake money.
 * It does not replace a page's own evidence limitations — the prediction audit,
 * for example, still explains its locked-versus-diagnostic semantics in full.
 */
// Deliberately one unbroken literal: the safety scans strip this exact string
// before looking for betting language, and a concatenated expression would
// leave half of it behind in the source for the scan to trip over.
// prettier-ignore
export const SHELL_DISCLAIMER = 'Decision-support analytics only. Outputs are evidence-based signals, not guarantees or instructions to place a bet.';

/** Inert regions reserving space for controls that arrive in later slices. */
export const PLACEHOLDER_SLOTS: readonly { label: string; state: string }[] = [
  { label: 'Search', state: 'Planned' },
  { label: 'Date', state: 'Planned' },
  { label: 'Scope', state: 'Planned' },
];

export interface AppShellProps {
  children: ReactNode;
  /*
   * There is deliberately NO `todayDate` prop. Accepting one would let a
   * server page inject a render-time date, which is the defect this shell
   * was corrected for: on a statically prerendered page that date is the
   * BUILD date and it never changes again.
   */
  /**
   * Explicit route override for `aria-current`. Omit it — the normal case —
   * and the navigation detects the live route itself.
   */
  pathname?: string | null;
  /** Optional extra class on the shell root. */
  className?: string;
}

export function AppShell({ children, pathname, className }: AppShellProps) {
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
          <AppNavigation variant="primary" pathname={pathname} />
        </nav>
      </header>

      <main className="rb-main" id={MAIN_LANDMARK_ID} tabIndex={-1}>
        {children}

        {/*
          Scoped to `<main>`, so it is a footer for this page rather than a
          second site-wide landmark, and so the mobile bottom-bar clearance
          already reserved on `.rb-main` protects it too.
        */}
        <footer className="rb-disclaimer">{SHELL_DISCLAIMER}</footer>
      </main>

      {/* Working destinations only — no disabled item can trap a mobile user. */}
      <nav className="rb-nav rb-nav--mobile" aria-label="Primary mobile">
        <AppNavigation variant="mobile" pathname={pathname} />
      </nav>
    </div>
  );
}

export default AppShell;
