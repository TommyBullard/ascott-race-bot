/**
 * Slice 2 — AppShell adoption on /how-it-works, /leaderboard, /results-audit.
 *
 * The three adopted routes are RENDERED with `renderToStaticMarkup`, so the
 * landmark, disclaimer, navigation and content assertions are made against the
 * real HTML rather than against source text. The two client pages render their
 * pre-fetch state (effects do not run during static rendering), which is
 * exactly the loading state a first paint produces.
 *
 * Where a contract cannot be reached by rendering — the leaderboard table only
 * exists once its fetch resolves, and this suite adds no DOM or network test
 * dependency — the preserved behaviour is pinned as a SOURCE contract instead.
 * Those assertions are labelled, and they cover precisely the things the slice
 * promised not to change: the endpoints, the poll cadence, the column set, the
 * sort defaults, and the query-string handling.
 *
 * This file renders components and reads files. It opens no database, calls no
 * provider, runs no model, creates no lock and settles no result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import RecommendationsPage from '../src/app/page';
import HowItWorksPage from '../src/app/how-it-works/page';
import LeaderboardPage from '../src/app/leaderboard/page';
import ResultsAuditPage from '../src/app/results-audit/page';
import {
  AppShell,
  MAIN_LANDMARK_ID,
  PLANNED_DESTINATIONS,
  PRIMARY_DESTINATIONS,
  SHELL_DISCLAIMER,
} from '../src/components/AppShell';
import { MODEL_FLOW_STEPS } from '../src/components/ModelFlowVisual';

const HOMEPAGE_SRC = readFileSync('src/app/page.tsx', 'utf8');
const HOW_IT_WORKS_SRC = readFileSync('src/app/how-it-works/page.tsx', 'utf8');
const LEADERBOARD_SRC = readFileSync('src/app/leaderboard/page.tsx', 'utf8');
const RESULTS_AUDIT_SRC = readFileSync('src/app/results-audit/page.tsx', 'utf8');
const LAYOUT_SRC = readFileSync('src/app/layout.tsx', 'utf8');
const TOKENS_CSS = readFileSync('src/styles/tokens.css', 'utf8');

const ADOPTED_SRC: Record<string, string> = {
  '/': HOMEPAGE_SRC,
  '/how-it-works': HOW_IT_WORKS_SRC,
  '/leaderboard': LEADERBOARD_SRC,
  '/results-audit': RESULTS_AUDIT_SRC,
};

/**
 * Every adopted route, rendered once each. The dashboard joined in slice 3A;
 * its pre-fetch render is the loading state, since effects do not run during
 * static rendering and all three of its external stores return their server
 * snapshots (scoped=false, search='', isClient=false).
 */
const ADOPTED: { route: string; html: string }[] = [
  { route: '/', html: renderToStaticMarkup(h(RecommendationsPage)) },
  { route: '/how-it-works', html: renderToStaticMarkup(h(HowItWorksPage)) },
  { route: '/leaderboard', html: renderToStaticMarkup(h(LeaderboardPage)) },
  { route: '/results-audit', html: renderToStaticMarkup(h(ResultsAuditPage)) },
];

/** Counts non-overlapping occurrences of a literal. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Source with comments removed, for assertions about what the code DOES.
 * Documentation legitimately quotes markup and prose it is describing — the
 * methodology page's own doc block explains that it no longer renders a
 * `<main>` — and a structural assertion must not read that as the code.
 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** All anchors as {href, ariaCurrent}, independent of attribute order. */
function anchors(html: string): { href: string | null; ariaCurrent: string | null }[] {
  return [...html.matchAll(/<a\b([^>]*)>/g)].map((match) => ({
    href: /href="([^"]*)"/.exec(match[1])?.[1] ?? null,
    ariaCurrent: /aria-current="([^"]*)"/.exec(match[1])?.[1] ?? null,
  }));
}

/** Returns the substring from `start` up to the first `end` after it. */
function sliceBetween(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `expected to find ${start}`);
  const to = html.indexOf(end, from);
  assert.notEqual(to, -1, `expected to find ${end} after ${start}`);
  return html.slice(from, to + end.length);
}

/** Import specifiers in a source file. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
}

const SHELL_COMPONENT_SRC: Record<string, string> = {
  'AppShell.tsx': readFileSync('src/components/AppShell.tsx', 'utf8'),
  'AppNavigation.tsx': readFileSync('src/components/AppNavigation.tsx', 'utf8'),
  'navDestinations.ts': readFileSync('src/components/navDestinations.ts', 'utf8'),
  'UiPrimitives.tsx': readFileSync('src/components/UiPrimitives.tsx', 'utf8'),
};

/* ===================== 1-5. shell adoption and landmarks =================== */

test('1. each adopted page renders through AppShell', () => {
  for (const { route, html } of ADOPTED) {
    assert.match(html, /^<div class="rb-app">/, `${route} must render the shell root`);
    assert.match(html, /<header class="rb-header">/, `${route} must render the shell header`);
    assert.match(html, /<nav class="rb-nav rb-nav--primary"/, `${route} primary nav`);
    assert.match(html, /<nav class="rb-nav rb-nav--mobile"/, `${route} mobile nav`);
    // The page imports the shell rather than reimplementing it.
    assert.match(ADOPTED_SRC[route], /from '@\/components\/AppShell'/);
  }
});

test('2. each adopted page has exactly one main landmark', () => {
  for (const { route, html } of ADOPTED) {
    assert.equal((html.match(/<main\b/g) ?? []).length, 1, `${route}: one <main>`);
    assert.equal((html.match(/<\/main>/g) ?? []).length, 1, `${route}: one </main>`);
    // No element carries an explicit main role either.
    assert.equal(/role="main"/.test(html), false, `${route}: no role="main"`);
  }
});

test('3. AppShell owns rb-main on each adopted page', () => {
  for (const { route, html } of ADOPTED) {
    const main = /<main[^>]*>/.exec(html);
    assert.ok(main, `${route} must render a main element`);
    assert.match(main[0], new RegExp(`id="${MAIN_LANDMARK_ID}"`), `${route}: shell-owned id`);
    assert.match(main[0], /class="rb-main"/, `${route}: shell-owned class`);
    assert.match(main[0], /tabindex="-1"/i, `${route}: focusable skip target`);
    // The page source no longer opens its own main element.
    assert.equal(
      /<main[\s>]/.test(codeOf(ADOPTED_SRC[route])),
      false,
      `${route}: no page-owned <main>`
    );
  }
});

test('4. the skip link targets rb-main on each adopted page', () => {
  for (const { route, html } of ADOPTED) {
    const skip = /<a class="rb-skip-link" href="([^"]+)"/.exec(html);
    assert.ok(skip, `${route} must render a skip link`);
    assert.equal(skip[1], `#${MAIN_LANDMARK_ID}`, `${route}: skip link points at the main id`);
    assert.ok(
      html.indexOf('rb-skip-link') < html.indexOf('<header'),
      `${route}: skip link precedes the header`
    );
  }
});

test('5. no adopted page nests a main landmark inside another', () => {
  for (const { route, html } of ADOPTED) {
    const firstOpen = html.indexOf('<main');
    const firstClose = html.indexOf('</main>');
    assert.notEqual(firstOpen, -1);
    assert.notEqual(firstClose, -1);
    // Nothing between the shell's <main> and its </main> opens another one.
    const inner = html.slice(firstOpen + 5, firstClose);
    assert.equal(/<main\b/.test(inner), false, `${route}: nested <main> found`);
  }
});

/* ==================== 6-7. methodology content preserved ================== */

test('6. the methodology page keeps its complete content', () => {
  const html = ADOPTED.find((p) => p.route === '/how-it-works')!.html;

  assert.match(html, /How the model works/);
  // The framing sentence, unchanged.
  assert.match(html, /Racing Bot is a decision-support tool, not a bookmaker/);
  assert.match(html, /never places bets for you and never guarantees an outcome/);

  // All five stages, each a real level-2 heading, in order.
  const stages = [
    '1. Data collection',
    '2. Race analysis',
    '3. Tipster consensus',
    '4. Data quality checks',
    '5. Confidence and safeguards',
  ];
  let cursor = -1;
  for (const stage of stages) {
    assert.match(html, new RegExp(`<h2 class="rb-section-header__title">${stage}</h2>`));
    const at = html.indexOf(stage);
    assert.ok(at > cursor, `${stage} must keep its position in the sequence`);
    cursor = at;
  }

  // Every bullet survives the reframing.
  for (const point of [
    'Market odds',
    'Race runners',
    'Tipster selections',
    'Timing and freshness data',
    'Estimates runner probabilities',
    'Compares the model view with the available odds',
    'Looks for value opportunities',
    'Aggregates tipster selections',
    'Measures which runners have the most support',
    'Compares the tipster consensus with the model recommendation',
    'Checks for missing odds',
    'Checks for stale odds',
    'Checks for incomplete markets',
    'Checks for missing or unmatched tipster data',
    'Adjusts confidence when data quality is weaker',
    'Suppresses staking when market data is unreliable',
    'Keeps the recommendation visible for transparency',
  ]) {
    assert.ok(html.includes(point), `missing methodology point: ${point}`);
  }

  // The two standing caveats, verbatim.
  assert.match(html, /Sometimes the best decision is not to bet/);
  assert.match(html, /should not be treated as guaranteed\s+outcomes/);

  // Exactly one h1, and the stages sit below it.
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);

  // The existing outbound link still works.
  assert.ok(anchors(html).some((a) => a.href === '/'), 'the Recommendations link survives');
});

test('7. ModelFlowVisual is still rendered, unchanged', () => {
  const html = ADOPTED.find((p) => p.route === '/how-it-works')!.html;
  assert.match(HOW_IT_WORKS_SRC, /from '@\/components\/ModelFlowVisual'/);
  assert.match(html, /aria-label="Model pipeline flow"/);
  for (const step of MODEL_FLOW_STEPS) {
    assert.ok(html.includes(step), `missing flow step: ${step}`);
  }
});

/* ======================= 8-12. navigation architecture ==================== */

test('8. the active destination is the one marked with aria-current', () => {
  // Rendered through the shell's explicit override, which is the same value
  // `usePathname` supplies at runtime.
  const cases: [string, string][] = [
    ['/', '/'],
    ['/how-it-works', '/how-it-works'],
    ['/how-it-works/detail', '/how-it-works'],
    ['/leaderboard', '/leaderboard'],
    ['/leaderboard/tipster-1', '/leaderboard'],
    ['/results-audit', '/results-audit'],
    ['/results-audit?date=2026-07-28', '/results-audit'],
  ];

  for (const [pathname, expected] of cases) {
    const html = renderToStaticMarkup(
      h(AppShell, { pathname, children: h('p', null, 'content') })
    );
    const active = [...new Set(anchors(html).filter((a) => a.ariaCurrent === 'page').map((a) => a.href))];
    assert.deepEqual(active, [expected], `${pathname} should activate ${expected}`);
  }
});

test('9. Overview is not active on any adopted nested route', () => {
  for (const pathname of ['/how-it-works', '/leaderboard', '/results-audit']) {
    const html = renderToStaticMarkup(
      h(AppShell, { pathname, children: h('p', null, 'content') })
    );
    const overview = anchors(html).filter((a) => a.href === '/');
    assert.ok(overview.length > 0, 'Overview must still be linked');
    for (const link of overview) {
      assert.equal(link.ariaCurrent, null, `Overview must not be current on ${pathname}`);
    }
  }
});

test('10. internal destinations are next/link, resolved from the live route', () => {
  const navSrc = readFileSync('src/components/AppNavigation.tsx', 'utf8');
  assert.match(navSrc, /import Link from 'next\/link'/);
  assert.match(navSrc, /import \{ usePathname \} from 'next\/navigation'/);
  assert.match(navSrc, /<Link\b/);

  // No page hardcodes its own path: a literal silently drifts on a rename.
  for (const [route, src] of Object.entries(ADOPTED_SRC)) {
    assert.equal(
      /<AppShell[^>]*pathname/.test(src),
      false,
      `${route} must let the navigation detect the route`
    );
  }

  // Every rendered destination is a real, existing route. An arbitrary path is
  // NOT acceptable merely because it starts with "/" — that would let a link to
  // a non-existent route pass the very check meant to catch it. Instead the
  // QUERY is stripped and the remaining PATH must be a known destination: the
  // dashboard's own race-day nav and the audit back-link legitimately carry
  // ?date/?course/?day, but they may only ever point at a route that exists.
  const known = new Set([`#${MAIN_LANDMARK_ID}`, ...PRIMARY_DESTINATIONS.map((d) => d.href)]);
  for (const { route, html } of ADOPTED) {
    for (const anchor of anchors(html)) {
      const href = anchor.href ?? '';
      const path = href.split('?')[0].split('#')[0] || '/';
      assert.ok(
        known.has(href) || known.has(path),
        `${route}: unexpected link target ${href}`
      );
      assert.equal(href.startsWith('http'), false, `${route}: no external link expected`);
    }
  }
});

test('11. planned destinations are never links on an adopted page', () => {
  for (const { route, html } of ADOPTED) {
    for (const planned of PLANNED_DESTINATIONS) {
      assert.equal('href' in planned, false, 'a planned destination has no href');
      // Present and marked, but never inside an anchor.
      assert.ok(
        html.includes(
          `<li class="rb-nav__item rb-nav__item--planned"><span class="rb-nav__planned">` +
            `${planned.label}<span class="rb-nav__planned-tag">Planned</span></span></li>`
        ),
        `${route}: ${planned.label} must render as a marked non-link`
      );
      // Scoped to the NAVIGATION regions. The contract is that a planned
      // destination is never a navigable link — not that the word may never
      // appear in page copy: the dashboard's own race-day nav legitimately
      // reads "View Today's Races", which is a different thing entirely.
      for (const region of html.match(/<nav\b[\s\S]*?<\/nav>/g) ?? []) {
        for (const anchor of region.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? []) {
          assert.equal(
            anchor.includes(planned.label),
            false,
            `${route}: ${planned.label} linked in navigation`
          );
        }
      }
    }
  }
});

test('12. the mobile bar carries working destinations only', () => {
  for (const { route, html } of ADOPTED) {
    const bar = sliceBetween(html, '<nav class="rb-nav rb-nav--mobile"', '</nav>');
    assert.equal(/rb-nav__planned|rb-nav__item--planned|aria-disabled/.test(bar), false, route);
    for (const planned of PLANNED_DESTINATIONS) {
      assert.equal(bar.includes(planned.label), false, `${route}: ${planned.label} in the bar`);
    }
    const links = bar.match(/<a\b/g) ?? [];
    assert.ok(links.length > 0, `${route}: the bar needs destinations`);
    assert.equal(links.length, PRIMARY_DESTINATIONS.length, `${route}: all working routes`);
  }
});

/* ======================= 13-14. viewport and safe area ==================== */

test('13. viewportFit cover is configured on the root layout', () => {
  assert.match(LAYOUT_SRC, /export const viewport: Viewport = \{/);
  assert.match(LAYOUT_SRC, /viewportFit:\s*'cover'/);
  // Next's own defaults are restated, so adding the export cannot drop them.
  assert.match(LAYOUT_SRC, /width:\s*'device-width'/);
  assert.match(LAYOUT_SRC, /initialScale:\s*1/);
  assert.match(LAYOUT_SRC, /import type \{ Viewport \} from 'next'/);
  // The shell is still not mounted globally.
  assert.equal(/AppShell/.test(LAYOUT_SRC), false, 'the root layout mounts no shell');
});

test('14. mobile main padding clears the fixed bar and the safe area', () => {
  const mobile = TOKENS_CSS.slice(TOKENS_CSS.indexOf('@media (max-width: 699px)'));
  const mainRule = sliceBetween(mobile, '.rb-main {', '}');

  // Height of the bar, plus breathing room, plus the device inset.
  assert.match(mainRule, /padding-bottom:\s*calc\(/);
  assert.match(mainRule, /var\(--rb-touch-target-min\)/);
  assert.match(mainRule, /env\(safe-area-inset-bottom, 0px\)/);

  // The bar itself also respects the inset, so its own content clears it.
  const bar = sliceBetween(TOKENS_CSS, '.rb-nav--mobile {', '}');
  assert.match(bar, /padding-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);
  assert.match(bar, /position:\s*fixed/);

  // The disclaimer is the last thing in main, so main's clearance protects it.
  for (const { route, html } of ADOPTED) {
    const main = sliceBetween(html, '<main', '</main>');
    assert.ok(main.includes(SHELL_DISCLAIMER), `${route}: disclaimer inside main`);
  }
});

/* ========================= 15-16. standing disclaimer ===================== */

test('15. the standing disclaimer appears exactly once per adopted page', () => {
  for (const { route, html } of ADOPTED) {
    assert.equal(count(html, SHELL_DISCLAIMER), 1, `${route}: one disclaimer`);
    assert.equal(count(html, '<footer class="rb-disclaimer">'), 1, `${route}: one footer`);
  }

  // Since slice 3A the dashboard is one of those adopted pages, so it is
  // covered by the loop above rather than excluded here.
  assert.ok(
    ADOPTED.some((p) => p.route === '/'),
    'the homepage must be inside the per-page disclaimer contract'
  );
});

test('16. the disclaimer carries no guarantee, CTA or wager instruction', () => {
  assert.match(SHELL_DISCLAIMER, /^Decision-support analytics only\./);
  assert.equal(
    /\b(bet|back|stake|wager|deposit|join|sign up|claim)\s+(now|today|here)\b/i.test(
      SHELL_DISCLAIMER
    ),
    false
  );
  assert.equal(/guaranteed|guarantee\b|profit|returns|winnings|odds boost/i.test(SHELL_DISCLAIMER), false);
  assert.equal(/\bshould (bet|back|stake)\b|\bplace your\b|\bbest bet\b/i.test(SHELL_DISCLAIMER), false);

  // It does not displace the audit page's own evidence limitations.
  const audit = ADOPTED.find((p) => p.route === '/results-audit')!.html;
  assert.match(audit, /Official decision = the immutable T-minus-5 locked record/);
  assert.match(audit, /missing locks are never backfilled/);
});

/* ====================== 17-22. leaderboard preservation =================== */

test('17. leaderboard polling is still exactly 30 seconds', () => {
  // SOURCE CONTRACT: the interval cannot be observed without running effects.
  assert.match(LEADERBOARD_SRC, /const POLL_INTERVAL_MS = 30000;/);
  assert.match(LEADERBOARD_SRC, /setInterval\(load, POLL_INTERVAL_MS\)/);
  assert.equal(/setInterval\([^)]*\b(?!POLL_INTERVAL_MS)\d+\)/.test(LEADERBOARD_SRC), false);
  assert.match(LEADERBOARD_SRC, /clearInterval\(id\)/, 'the poll is still torn down');
});

test('18. the leaderboard endpoint is unchanged', () => {
  assert.match(LEADERBOARD_SRC, /const LEADERBOARD_ENDPOINT = '\/api\/tipsters\/leaderboard';/);
  assert.match(LEADERBOARD_SRC, /fetch\(LEADERBOARD_ENDPOINT,/);
  const apiPaths = [...LEADERBOARD_SRC.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(apiPaths, ['/api/tipsters/leaderboard'], 'no other API is contacted');
});

test('19. leaderboard sorting behaviour is unchanged', () => {
  // SOURCE CONTRACT: the table renders only once the fetch resolves.
  const keys = [...LEADERBOARD_SRC.matchAll(/\bkey: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, [
    'name',
    'source',
    'longRunRoi',
    'recentRoi30d',
    'strikeRate',
    'longestLosingStreak',
    'reliability',
    'finalWeight',
    'betsCount',
    'isActive',
  ]);
  // Defaults, direction toggle, text-vs-numeric default, and nulls-last.
  assert.match(LEADERBOARD_SRC, /useState<string>\('finalWeight'\)/);
  assert.match(LEADERBOARD_SRC, /useState<SortDir>\('desc'\)/);
  assert.match(LEADERBOARD_SRC, /setSortDir\(\(d\) => \(d === 'asc' \? 'desc' : 'asc'\)\)/);
  assert.match(LEADERBOARD_SRC, /key === 'name' \|\| key === 'source' \? 'asc' : 'desc'/);
  assert.match(LEADERBOARD_SRC, /if \(av === null\) return 1;/);
  assert.match(LEADERBOARD_SRC, /if \(bv === null\) return -1;/);
});

test('20. sortable headers expose aria-sort and are keyboard-operable', () => {
  // SOURCE CONTRACT: the header row only renders once the fetch resolves, and
  // this suite adds no DOM or network test dependency.

  // aria-sort lives on the header cell, which also keeps its column scope.
  assert.match(LEADERBOARD_SRC, /aria-sort=\{/);
  assert.match(LEADERBOARD_SRC, /scope="col"/);
  // Active column reports its direction; every other column reports none.
  assert.match(LEADERBOARD_SRC, /active\s*\?\s*sortDir === 'asc'\s*\?\s*'ascending'\s*:\s*'descending'\s*:\s*'none'/s);

  // The control inside is a real button, so sorting is reachable by keyboard
  // rather than click-only, and it still carries the visible column label.
  assert.match(LEADERBOARD_SRC, /<button\s+type="button"/);
  assert.match(LEADERBOARD_SRC, /\{c\.label\}/);
  assert.equal(/<th[^>]*onClick/.test(LEADERBOARD_SRC), false, 'no click-only header');

  // The arrow is decoration only.
  assert.match(LEADERBOARD_SRC, /<span className="rb-sort__glyph" aria-hidden="true">/);

  // The control carries a visible border and inherits the global focus ring.
  const sort = sliceBetween(TOKENS_CSS, '.rb-sort {', '}');
  assert.match(sort, /border:\s*1px solid var\(--rb-border-strong\)/);
  assert.match(TOKENS_CSS, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--rb-focus-ring\)/);
});

test('20b. the sort button does not repeat the state aria-sort already gives', () => {
  // SOURCE CONTRACT, same reason as test 20.
  //
  // With aria-sort on the header cell AND the state repeated inside the
  // button's accessible name, a screen reader announces it twice per column
  // ("All-time ROI, sorted descending, button, sorted descending").
  assert.equal(
    /sorted \$\{sortDir|', not sorted'|sorted ascending|sorted descending/.test(LEADERBOARD_SRC),
    false,
    'sort state must not be duplicated in hidden text'
  );
  // The duplication lived in a VisuallyHidden inside the button; nothing in the
  // page needs that component now.
  assert.equal(/VisuallyHidden/.test(LEADERBOARD_SRC), false, 'no leftover hidden sort text');

  // The remaining visually-hidden text is the table caption, which names the
  // table rather than restating a state.
  assert.match(LEADERBOARD_SRC, /<caption className="rb-visually-hidden">/);
  assert.equal(
    (LEADERBOARD_SRC.match(/rb-visually-hidden/g) ?? []).length,
    1,
    'exactly one visually-hidden region, and it is the caption'
  );
});

test('21. the leaderboard table sits inside a reachable rb-scroll-x region', () => {
  assert.match(LEADERBOARD_SRC, /className="rb-scroll-x"/);
  assert.match(LEADERBOARD_SRC, /role="region"/);
  assert.match(LEADERBOARD_SRC, /tabIndex=\{0\}/, 'the overflow is reachable by keyboard');
  assert.match(LEADERBOARD_SRC, /aria-label="Tipster leaderboard table"/);
  // The wrapper scrolls; the table keeps a readable floor width instead of
  // dropping analytical columns.
  const scroll = sliceBetween(TOKENS_CSS, '.rb-scroll-x {', '}');
  assert.match(scroll, /overflow-x:\s*auto/);
  const table = sliceBetween(TOKENS_CSS, '.rb-table {', '}');
  assert.match(table, /min-width:\s*\d+px/);
  assert.equal(/display:\s*none/.test(table), false, 'no column is hidden by CSS');
});

test('22. the leaderboard remains read-only', () => {
  assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(LEADERBOARD_SRC), false);
  assert.equal(/<form\b|onSubmit/.test(LEADERBOARD_SRC), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(LEADERBOARD_SRC), false);
  // The only button is the sort control.
  const buttons = LEADERBOARD_SRC.match(/<button\b/g) ?? [];
  assert.equal(buttons.length, 1, 'exactly one control, and it sorts');

  const html = ADOPTED.find((p) => p.route === '/leaderboard')!.html;
  assert.equal(/<form\b/.test(html), false);
  // First paint is the loading state, announced rather than silent.
  assert.match(html, /<div class="rb-skeleton" role="status">/);
});

/* ===================== 23-27. results-audit preservation ================== */

test('23. the results-audit endpoint is unchanged', () => {
  assert.match(RESULTS_AUDIT_SRC, /const RECOMMENDATIONS_ENDPOINT = '\/api\/recommendations';/);
  assert.match(RESULTS_AUDIT_SRC, /fetch\(`\$\{RECOMMENDATIONS_ENDPOINT\}\$\{query\}`/);
  const apiPaths = [...RESULTS_AUDIT_SRC.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(apiPaths, ['/api/recommendations'], 'no other API is contacted');
});

test('24. date and course query handling is unchanged', () => {
  // The query string is forwarded verbatim — the page never reinterprets it.
  assert.match(RESULTS_AUDIT_SRC, /window\.location\.search/);
  assert.match(
    RESULTS_AUDIT_SRC,
    /const query = typeof window !== 'undefined' \? window\.location\.search : '';/
  );
  // The hydration-safe read of the back-link query is preserved exactly.
  assert.match(RESULTS_AUDIT_SRC, /useSyncExternalStore\(/);
  assert.match(RESULTS_AUDIT_SRC, /subscribeNoop/);
  assert.match(RESULTS_AUDIT_SRC, /\(\) => '',/, 'the server snapshot stays empty');
  // Scope is displayed from the API response, not re-derived.
  assert.match(RESULTS_AUDIT_SRC, /data\.meetingDate \?\? null/);
  assert.match(RESULTS_AUDIT_SRC, /data\.course \?\? null/);
});

test('25. official and diagnostic evidence stay explicitly separate', () => {
  const html = ADOPTED.find((p) => p.route === '/results-audit')!.html;

  // The page states the rule up front, in its own words, unchanged.
  assert.match(html, /Final pre-off diagnostic picks are comparison only, never the official decision/);

  // The two blocks keep distinct headings and distinct sources.
  assert.match(RESULTS_AUDIT_SRC, /Official locked decision \(T−5 — source of truth\)/);
  assert.match(RESULTS_AUDIT_SRC, /Final pre-off diagnostic pick — diagnostic, not official/);
  assert.match(RESULTS_AUDIT_SRC, /DIAGNOSTIC — NOT OFFICIAL/);

  // Official figures read locked fields only; diagnostic reads the row's
  // diagnostic fields only. Neither block reaches into the other's data.
  const official = sliceBetween(RESULTS_AUDIT_SRC, 'function OfficialBlock', 'function DiagnosticBlock');
  assert.equal(/row\.diagnostic\b/.test(official), false, 'official never reads diagnostic data');
  assert.match(official, /locked\?\.pick_horse_name/);
  assert.match(official, /row\.locked_outcome/);
});

test('26. diagnostic evidence is never described as official', () => {
  const html = ADOPTED.find((p) => p.route === '/results-audit')!.html;
  for (const src of [html, RESULTS_AUDIT_SRC]) {
    assert.equal(/official diagnostic|diagnostic \(official\)/i.test(src), false);
    // "official" is never used to qualify the diagnostic pick.
    assert.equal(/diagnostic[^.<]{0,24}\bis official\b/i.test(src), false);
  }
  // In the rendered vocabulary, "source of truth" qualifies the locked record
  // and nothing else.
  const truth = [...codeOf(RESULTS_AUDIT_SRC).matchAll(/source of truth/g)];
  assert.equal(truth.length, 1, 'only the locked decision is the source of truth');
  assert.match(codeOf(RESULTS_AUDIT_SRC), /Official locked decision[^<]*source of truth/);
});

test('27. the results audit remains read-only', () => {
  const code = codeOf(RESULTS_AUDIT_SRC);
  assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(code), false);
  assert.equal(/<form\b|<button\b|onSubmit|onClick/.test(code), false);
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(code), false);
  // No settlement, capture or lock path is reachable from this page. Checked
  // on the code: the doc block legitimately says the page "settles nothing".
  assert.equal(/\/api\/settle|\/api\/cron\/|lockTMinus|importResults/.test(code), false);

  const html = ADOPTED.find((p) => p.route === '/results-audit')!.html;
  assert.equal(/<form\b|<button\b/.test(html), false);
  assert.match(html, /<div class="rb-skeleton" role="status">/, 'first paint is the loading state');
});

/* ==================== 28-35. boundaries the slice must hold =============== */

test('28. no API route implementation is reachable from the adopted UI', () => {
  // Durable contract: the UI may CALL a read endpoint by path, but must never
  // import a route handler or reach into server code to do it.
  for (const [name, src] of Object.entries(SHELL_COMPONENT_SRC)) {
    for (const specifier of importsOf(src)) {
      assert.equal(/app\/api|\/route$/.test(specifier), false, `${name} imports ${specifier}`);
      assert.equal(specifier.startsWith('@/lib'), false, `${name} imports server code`);
    }
    assert.equal(/['"`]\/api\//.test(src), false, `${name} references an API path`);
  }
  for (const [route, src] of Object.entries(ADOPTED_SRC)) {
    for (const specifier of importsOf(src)) {
      assert.equal(/app\/api|\/route$/.test(specifier), false, `${route} imports ${specifier}`);
    }
  }
});

test('29. the homepage renders through the shell and owns no main of its own', () => {
  /*
   * Slice 3A supersedes the slice 1/2 contract, which required the opposite:
   * that the dashboard had NOT adopted the shell, pinned by a byte-identity
   * comparison against the slice 1 commit. That comparison has been removed
   * rather than re-anchored to a newer commit — the migration it was guarding
   * against is the change being made here.
   */
  assert.match(HOMEPAGE_SRC, /import AppShell from '@\/components\/AppShell';/);
  assert.match(HOMEPAGE_SRC, /<AppShell>/);
  assert.match(HOMEPAGE_SRC, /<\/AppShell>/);

  // The page's own <main> is gone; the shell's is the only one.
  assert.equal(/<main[\s>]/.test(codeOf(HOMEPAGE_SRC)), false, 'no page-owned <main>');

  // Its container styles survive verbatim — this slice is structural only.
  assert.match(HOMEPAGE_SRC, /<div style=\{styles\.page\}>/);
  assert.match(HOMEPAGE_SRC, /maxWidth: 820/);
  assert.match(HOMEPAGE_SRC, /position: 'sticky' as const/, 'the next-race panel stays sticky');

  // No primitive or token migration happened here; that is slice 3D. Matched on
  // the import path: the dashboard has its own long-standing helpers whose
  // names embed primitive-like words (resultStatusBadge, captureStatusBadge).
  assert.equal(
    importsOf(HOMEPAGE_SRC).some((s) => s.includes('UiPrimitives')),
    false,
    'no primitive adoption in this slice'
  );
  assert.equal(/from '@\/styles\/tokens\.css'/.test(HOMEPAGE_SRC), false);
});

test('29b. every adopted route now renders through the shell', () => {
  assert.deepEqual(
    ADOPTED.map((p) => p.route),
    ['/', '/how-it-works', '/leaderboard', '/results-audit'],
    'all four routes are adopted'
  );
  for (const { route, html } of ADOPTED) {
    assert.match(html, /^<div class="rb-app">/, `${route}: shell root`);
    assert.match(html, /<header class="rb-header">/, `${route}: shell header`);
  }
});

test('29c. the duplicated header links are gone; the shell supplies them', () => {
  const html = ADOPTED.find((p) => p.route === '/')!.html;
  const code = codeOf(HOMEPAGE_SRC);

  // Slice 3B removed the local header anchors. (Superseded the slice 3A
  // contract, which asserted the opposite while duplication was accepted.)
  assert.equal(/<a href="\/how-it-works"/.test(code), false, 'local How-it-works anchor gone');
  assert.equal(/<a href="\/leaderboard"/.test(code), false, 'local Leaderboard anchor gone');

  // Their wrapper was deleted too, not left as an empty element.
  assert.equal(
    /<span style=\{\{ display: 'flex', gap: 16, flexWrap: 'wrap' \}\}>/.test(code),
    false,
    'the empty header wrapper must be removed, not left behind'
  );

  // Each destination now appears EXACTLY twice — once in the shell's primary
  // navigation and once in its mobile bar. Three would mean the local
  // duplicate survived; one would mean the shell lost it.
  const hrefs = anchors(html).map((a) => a.href);
  for (const destination of ['/how-it-works', '/leaderboard']) {
    assert.equal(
      hrefs.filter((h) => h === destination).length,
      2,
      `${destination} must come from the shell's two navs only`
    );
  }

  // ...and they are still reachable under the shell's own labels.
  assert.ok(html.includes('Methodology'), 'Methodology reachable via the shell');
  assert.ok(html.includes('Tipster Evidence'), 'Tipster Evidence reachable via the shell');
});

test('29c-2. course/date-aware navigation is retained and unconverted', () => {
  const html = ADOPTED.find((p) => p.route === '/')!.html;
  const code = codeOf(HOMEPAGE_SRC);

  // The race-day cluster is NOT duplicated by the shell, so all of it stays.
  assert.match(HOMEPAGE_SRC, /function RaceDayNav/, 'course/date-aware nav retained');
  assert.match(HOMEPAGE_SRC, /buildRaceDayNavView/);
  assert.match(HOMEPAGE_SRC, /href: '\/\?day=today&course=Newmarket'/, 'quick link retained');
  assert.match(HOMEPAGE_SRC, /function AllCoursesBanner/);

  /*
   * SAME-ROUTE scope changes must stay PLAIN ANCHORS. A client-side transition
   * keeps this page mounted, and three of its scope-sensitive effects have
   * empty dependency arrays — the dashboard would show evidence from the
   * previous scope under the new URL.
   */
  for (const sameRoute of [
    'ACTIVE_COURSE_QUICK_LINK.href',
    'nav.primary.href',
    'nav.previousDay.href',
  ]) {
    const escaped = sameRoute.replace(/\./g, '\\.');
    assert.match(code, new RegExp(`<a href=\\{${escaped}\\}`), `${sameRoute} stays an anchor`);
    assert.equal(
      new RegExp(`<Link href=\\{${escaped}\\}`).test(code),
      false,
      `${sameRoute} must NOT become a Link — it would strand a stale scope`
    );
  }

  /*
   * CROSS-ROUTE audit destinations unmount this page entirely, so they carry no
   * stale-scope risk and use Link — with prefetch disabled, preserving the
   * plain-anchor property of issuing no speculative request.
   */
  assert.equal((code.match(/<Link\b/g) ?? []).length, 3, 'exactly three Link usages');
  assert.equal(
    (code.match(/prefetch=\{false\}/g) ?? []).length,
    3,
    'every Link disables prefetch'
  );
  assert.equal(
    (code.match(/href=\{auditHref\}/g) ?? []).length,
    2,
    'both PerformancePanel audit links retained'
  );
  assert.match(code, /<Link\s+href=\{nav\.audit\.href\} prefetch=\{false\}/);
  assert.match(HOMEPAGE_SRC, /import Link from 'next\/link';/);

  // Query semantics are untouched: the audit href still preserves the search.
  assert.match(
    HOMEPAGE_SRC,
    /'\/results-audit' \+ \(typeof window !== 'undefined' \? window\.location\.search : ''\)/
  );

  // The shell's own audit destination plus the retained race-day one render.
  assert.ok(
    anchors(html).filter((a) => (a.href ?? '').startsWith('/results-audit')).length >= 3,
    'results-audit remains reachable from the shell and the race-day nav'
  );
});

test('29c-3. the homepage safety copy is consolidated onto one banner (slice 3C)', () => {
  const html = ADOPTED.find((p) => p.route === '/')!.html;
  const code = codeOf(HOMEPAGE_SRC);

  /*
   * SLICE 3C. Before this slice the homepage stated "decision-support only",
   * "not betting advice" and "not guarantees" three times over: in the intro
   * paragraph, in SafetyBanner, and in the shell footer. The intro's copy was
   * a strict subset of SafetyBanner's, so it was reduced to its one unique
   * clause — the product description — and SafetyBanner moved up to take its
   * place. Nothing unique was dropped; the assertions below are what proves
   * that, so they enumerate every clause rather than sampling.
   */

  // 1. The intro paragraph is now purely descriptive, and exact.
  assert.ok(
    html.includes('>Model and tipster analysis for UK &amp; Irish racing.</p>'),
    'intro paragraph is exactly the descriptive sentence'
  );

  /*
   * 2. Its former safety clause is gone from the rendered HTML AND from the
   *    comment-stripped source. Both halves earn their place: the render alone
   *    would miss a copy that exists in the file but is unreachable, while RAW
   *    source would trip over page.tsx's own explanatory comment, which
   *    legitimately quotes the wording it is explaining. `codeOf` strips
   *    comments, so an explanatory comment can neither satisfy this contract
   *    nor defeat it — only rendered or reachable copy counts.
   */
  assert.equal(
    /decision-support\s*only, not betting advice/i.test(html),
    false,
    'the intro no longer restates the safety copy (rendered HTML)'
  );
  assert.equal(
    /decision-support\s*only, not betting advice/i.test(code),
    false,
    'the intro no longer restates the safety copy (comment-stripped source)'
  );
  assert.equal(
    /Recommendations are model outputs, not\s*guarantees\.\s*<\/p>/.test(html),
    false,
    'the intro no longer restates the guarantees clause'
  );

  // 3. SafetyBanner survives, rendered exactly once, from exactly one call site.
  assert.equal(count(code, '<SafetyBanner />'), 1, 'one SafetyBanner call site');
  assert.equal(count(html, 'Decision-support only'), 1, 'SafetyBanner rendered once');

  /*
   * 4. Every clause it carries, matched against the BANNER'S OWN markup rather
   *    than the whole page. That distinction is load-bearing rather than
   *    fastidious: SettlementStatusPanel renders "Results are settled
   *    separately and may be entered manually during beta — this page is
   *    read-only." on this same page once race cards load, so a page-wide
   *    match could be satisfied by a different component while the banner had
   *    quietly lost the clause. Scoping to the fragment binds each guarantee
   *    to the element that is supposed to make it.
   *
   *    Four of these exist nowhere else on the page: the no-auto-betting
   *    guarantee, the no-bet-placement guarantee, the read-only guarantee, and
   *    the beta settlement-lag caveat. Losing any one of them would remove
   *    information, not duplication.
   */
  const banner = sliceBetween(html, 'Decision-support only', '</div>');
  for (const [label, pattern] of [
    ['decision-support boundary', /Decision-support only/],
    ['not betting advice', /not betting advice/],
    ['no auto-betting', /No\s*auto-betting/],
    ['no bet placement', /no bet placement/],
    ['page is read-only', /this page is read-only/],
    ['outputs are not guarantees', /Recommendations are model outputs, not\s*guarantees/],
    [
      'beta settlement lag',
      /During beta, results may\s*be settled manually and can lag behind the live race/,
    ],
  ] as const) {
    assert.match(banner, pattern, `SafetyBanner retains: ${label}`);
  }

  // 5. The shell's standing disclaimer is untouched and still renders once.
  assert.ok(html.includes(SHELL_DISCLAIMER), 'shell disclaimer');
  assert.equal(count(html, SHELL_DISCLAIMER), 1, 'shell disclaimer exactly once');

  /*
   * 6. The anti-regression pin: at most two statements may open with
   *    "decision-support only". Today it is ONE — SafetyBanner's — because the
   *    shell says "Decision-support analytics only", which is deliberately not
   *    this literal. The allowance of two exists so aligning the shell's
   *    wording later stays legal, while a fourth statement creeping back onto
   *    the homepage does not.
   */
  const decisionSupportOnly = (html.toLowerCase().match(/decision-support only/g) ?? []).length;
  assert.ok(
    decisionSupportOnly <= 2,
    `expected at most 2 "decision-support only" statements, found ${decisionSupportOnly}`
  );

  // 7. Order: intro, then the banner, then the operational panels. Asserted on
  //    source because CommandCentrePanel is conditional and absent from the
  //    pre-fetch render this suite exercises.
  const introAt = code.indexOf('Model and tipster analysis for UK &amp; Irish racing.');
  const bannerAt = code.indexOf('<SafetyBanner />');
  const commandCentreAt = code.indexOf('<CommandCentrePanel');
  const liveModeBarAt = code.indexOf('<LiveModeBar');
  assert.notEqual(introAt, -1, 'intro present');
  assert.notEqual(bannerAt, -1, 'banner present');
  assert.notEqual(commandCentreAt, -1, 'command centre present');
  assert.notEqual(liveModeBarAt, -1, 'live-mode bar present');
  assert.ok(introAt < bannerAt, 'SafetyBanner follows the intro paragraph');
  assert.ok(bannerAt < commandCentreAt, 'SafetyBanner precedes CommandCentrePanel');

  // 8. And it did not stay behind at its old position after LiveModeBar. The
  //    single-call-site count above already forbids a duplicate; this pins the
  //    direction of the move so a revert is a test failure, not a silent undo.
  assert.ok(bannerAt < liveModeBarAt, 'SafetyBanner no longer sits after LiveModeBar');

  /*
   * 9. The banner's defensive wording is prose, not capability. "No
   *    auto-betting and no bet placement" is the disclaimer WORKING — test 34
   *    makes the same distinction — so the guarantee that no betting feature
   *    exists is made against identifiers, which no disclaimer would name.
   */
  assert.equal(
    /betfair|placeOrder|place_order|placeBet|place_bet|submitOrder|autoBet|auto_bet|betslip/i.test(
      HOMEPAGE_SRC
    ),
    false,
    'defensive wording introduces no betting integration'
  );
});

test('29d. the homepage data contract is untouched by adoption', () => {
  /*
   * Six endpoints, contacted in THREE deliberately different ways:
   *
   *   - recommendations, ml/shadow-comparison, accuracy and race-day/status
   *     forward the COMPLETE current search verbatim;
   *   - tipsters/status rebuilds a suffix from date + course ONLY, so params
   *     such as ?day=today are deliberately dropped;
   *   - tipsters/in-form receives NO query at all;
   *   - and nothing else is contacted.
   *
   * The three modes are pinned separately below: collapsing any of them into
   * "everything forwards the search" would silently change what an API sees.
   */
  const apiPaths = [...HOMEPAGE_SRC.matchAll(/`?(\/api\/[a-z0-9/-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(apiPaths)].sort(), [
    '/api/accuracy',
    '/api/ml/shadow-comparison',
    '/api/race-day/status',
    '/api/recommendations',
    '/api/tipsters/in-form',
    '/api/tipsters/status',
  ]);

  // Mode 1 — the complete search, forwarded verbatim.
  assert.match(HOMEPAGE_SRC, /fetch\(`\/api\/recommendations\$\{query\}`/);
  assert.match(HOMEPAGE_SRC, /fetch\(`\/api\/ml\/shadow-comparison\$\{query\}`/);
  assert.match(HOMEPAGE_SRC, /fetch\(`\/api\/accuracy\$\{query\}`/);
  assert.match(HOMEPAGE_SRC, /fetch\(`\/api\/race-day\/status\$\{query\}`/);

  // Mode 2 — date + course rebuilt, never the raw search.
  assert.match(HOMEPAGE_SRC, /const \{ date, course \} = readScopeFromUrl\(\);/);
  assert.match(HOMEPAGE_SRC, /const qs = new URLSearchParams\(\);/);
  assert.match(HOMEPAGE_SRC, /if \(date\) qs\.set\('date', date\);/);
  assert.match(HOMEPAGE_SRC, /if \(course\) qs\.set\('course', course\);/);
  assert.match(
    HOMEPAGE_SRC,
    /const suffix = qs\.toString\(\) \? `\?\$\{qs\.toString\(\)\}` : '';/
  );
  assert.match(HOMEPAGE_SRC, /fetch\(`\/api\/tipsters\/status\$\{suffix\}`,\s*\{/);
  assert.equal(
    /fetch\(`\/api\/tipsters\/status\$\{query\}`|\/api\/tipsters\/status\$\{[^}]*search/.test(
      HOMEPAGE_SRC
    ),
    false,
    'tipster status must not switch to raw full-search forwarding'
  );

  // Mode 3 — no query. A plain single-quoted literal leaves nowhere to append
  // one, so the call shape itself is the contract.
  assert.match(HOMEPAGE_SRC, /fetch\('\/api\/tipsters\/in-form',\s*\{/);
  // Anchored to the call: an unanchored backtick search would match a backtick
  // belonging to an EARLIER template (the accuracy fetch) and span to here.
  assert.equal(
    /\/api\/tipsters\/in-form\$\{|fetch\(`[^`]*\/api\/tipsters\/in-form/.test(HOMEPAGE_SRC),
    false,
    'in-form must never gain a query suffix or become a template literal'
  );

  // Polling cadence and the conditions that gate it.
  assert.match(HOMEPAGE_SRC, /setInterval\(\(\) => load\(false\), RACE_DAY_REFRESH_MS\)/);
  assert.match(HOMEPAGE_SRC, /const refreshId = scoped/, 'recommendations poll is scope-gated');
  assert.match(HOMEPAGE_SRC, /setInterval\(pollStatus, RACE_DAY_REFRESH_MS\)/);
  assert.match(HOMEPAGE_SRC, /if \(!scoped \|\| !scope\.date\) return;/);
  assert.match(HOMEPAGE_SRC, /setInterval\(loadAccuracy, 30000\)/);
  assert.match(HOMEPAGE_SRC, /setInterval\(loadInForm, 60000\)/);
  assert.match(HOMEPAGE_SRC, /setInterval\(loadTipsterStatus, 60000\)/);
  assert.match(HOMEPAGE_SRC, /setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 1000\)/);
  assert.equal(
    (HOMEPAGE_SRC.match(/new AbortController\(\)/g) ?? []).length,
    5,
    'every fetching effect still aborts'
  );

  // The three hydration-safe stores keep their server snapshots.
  assert.match(HOMEPAGE_SRC, /\(\) => hasRaceDayScope\(window\.location\.search\),\s*\(\) => false,/);
  assert.match(HOMEPAGE_SRC, /\(\) => window\.location\.search,\s*\(\) => '',/);
  assert.match(HOMEPAGE_SRC, /\(\) => true,\s*\(\) => false,/);

  // Last-known-good status preservation, and the initial-vs-background policy.
  assert.equal(/setStatusData\(null\)/.test(HOMEPAGE_SRC), false);
  assert.match(HOMEPAGE_SRC, /if \(isInitial\) \{/);

  /*
   * Evidence separation survives. FIVE displayed states stay distinct, and
   * `pending` is deliberately NOT one of the four lock buckets: it is a
   * settlement counter with its own field, never a lock outcome and never a
   * loss. Collapsing it into a bucket would misreport an unsettled race.
   */
  for (const bucket of [
    'official no-bet',
    'no run at lock',
    'not locked yet',
    'LOCK MISSING',
  ]) {
    assert.ok(HOMEPAGE_SRC.includes(bucket), `lock bucket label retained: ${bucket}`);
  }

  // pending is surfaced separately, from its own field, in both places.
  assert.match(HOMEPAGE_SRC, /pending \{performance\.pending_count\}/);
  assert.match(HOMEPAGE_SRC, /\{performance\.pending_count\} pending of/);

  // ...and it never appears inside the lock-bucket line itself.
  const lockBucketLines = HOMEPAGE_SRC.split('\n').filter((line) =>
    line.includes('official no-bet')
  );
  assert.ok(lockBucketLines.length > 0, 'the lock-bucket line must exist');
  for (const line of lockBucketLines) {
    assert.equal(
      /pending/.test(line),
      false,
      'pending must not be collapsed into the lock buckets'
    );
  }
  assert.match(HOMEPAGE_SRC, /officialMode === 'official_locked'/);
  assert.match(HOMEPAGE_SRC, /fallbackPerformance/);

  // The suggested operator command stays inert text inside <code>.
  assert.match(HOMEPAGE_SRC, /<code style=\{styles\.nextActionCmd\}>\{action\.suggestedCommand\}<\/code>/);
  assert.equal(/<button/.test(HOMEPAGE_SRC), false, 'no control was introduced');
});

test('29e. the shell adds no overflow ancestor that would break sticky', () => {
  // styles.nextRace is position:sticky. A shell ancestor declaring overflow in
  // either axis would make it resolve against a scrollport that never scrolls.
  assert.match(HOMEPAGE_SRC, /position: 'sticky' as const/);
  for (const selector of ['.rb-app {', '.rb-header {', '.rb-main {']) {
    const block = sliceBetween(TOKENS_CSS, selector, '}');
    assert.equal(/overflow/.test(block), false, `${selector} must not clip`);
  }
});

test('30. no src/lib implementation is pulled into the new UI surface', () => {
  // The new shell components are presentational: no server module at all.
  for (const [name, src] of Object.entries(SHELL_COMPONENT_SRC)) {
    for (const specifier of importsOf(src)) {
      assert.equal(specifier.startsWith('@/lib'), false, `${name} must not import ${specifier}`);
    }
  }

  // Adopted pages may use the PURE helpers they already used before adoption.
  // Pinned exactly, so a new server dependency cannot arrive unnoticed.
  const libImports = Object.fromEntries(
    Object.entries(ADOPTED_SRC).map(([route, src]) => [
      route,
      importsOf(src).filter((s) => s.startsWith('@/lib')).sort(),
    ])
  );
  assert.deepEqual(libImports, {
    // The dashboard's pure display helpers, pinned exactly. Adoption added
    // none; a new server dependency here would be visible immediately.
    '/': [
      '@/lib/commandCentre',
      '@/lib/confidenceCardDiagnostics',
      '@/lib/confidenceDiagnostics',
      '@/lib/confidenceLadder',
      '@/lib/decisionConsole',
      '@/lib/genaiCommentaryView',
      '@/lib/liveStatus',
      '@/lib/lockCoverage',
      '@/lib/modelDataQuality',
      '@/lib/operatorNextAction',
      '@/lib/placeAuditView',
      '@/lib/proofPanel',
      '@/lib/raceDayNav',
      '@/lib/raceDayStatus',
      '@/lib/raceDayStatusApi',
      '@/lib/raceDaySummary',
      '@/lib/raceDayTimeline',
      '@/lib/raceExplanation',
      '@/lib/raceIntelligence',
      '@/lib/relativeTime',
      '@/lib/settlementStatus',
      '@/lib/tipsterStatus',
    ],
    '/how-it-works': [],
    '/leaderboard': [],
    '/results-audit': ['@/lib/confidenceCardDiagnostics', '@/lib/predictionAudit'],
  });
});

test('31. adopted pages access no connector, secret or environment value', () => {
  for (const [route, src] of Object.entries(ADOPTED_SRC)) {
    assert.equal(/process\.env|import\.meta\.env/.test(src), false, route);
    assert.equal(/CRON_SECRET|SERVICE_ROLE|BETFAIR_|RACING_API|API_KEY|SUPABASE_/.test(src), false, route);
    assert.equal(/railway|vercel|stripe|sentry|@supabase|createClient/i.test(src), false, route);
  }
});

test('32. adopted pages issue no browser write and no mutation request', () => {
  for (const [route, src] of Object.entries(ADOPTED_SRC)) {
    assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(src), false, route);
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), false, route);
    assert.equal(/history\.(push|replace)State|window\.location\s*=/.test(src), false, route);
    // Every fetch in the slice is a plain GET of a read-only endpoint.
    for (const call of src.match(/fetch\([^;]*?\)/gs) ?? []) {
      assert.equal(/method/.test(call), false, `${route}: fetch must stay a GET`);
    }
  }
});

test('33. no runtime dependency was added', () => {
  // Durable: pins the dependency SET rather than the file's modification state.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@supabase/supabase-js',
    'next',
    'react',
    'react-dom',
  ]);
});

test('34. no auto-betting or order-placement feature was introduced', () => {
  // PROSE: targets instructions and promises, not mere mention. The methodology
  // page says the product is "not a bookmaker"; the dashboard's safety banner
  // says "No auto-betting and no bet placement". Those are the disclaimers
  // WORKING, so a bare keyword scan would measure the wrong thing — an
  // auto-betting FEATURE is caught by the identifier scan below instead.
  const forbiddenProse =
    /\bbest bet\b|\bsafe bet\b|guaranteed (win|winner|profit|return|roi)|\bbet now\b|\bplace (a|your) (bet|wager)\b|\bbetslip\b|\brecommended stake\b/i;

  for (const { route, html } of ADOPTED) {
    const scanned = html.split(SHELL_DISCLAIMER).join('');
    assert.equal(forbiddenProse.test(scanned), false, `${route}: betting instruction or promise`);
  }

  // IDENTIFIERS: what an actual betting feature would look like in code. These
  // are absolute — no disclaimer has a legitimate reason to name them.
  const forbiddenIdentifiers =
    /betfair|placeOrder|place_order|placeBet|place_bet|submitOrder|autoBet|auto_bet|stake now|betslip/i;
  for (const [route, src] of Object.entries(ADOPTED_SRC)) {
    assert.equal(forbiddenProse.test(src.split(SHELL_DISCLAIMER).join('')), false, route);
    assert.equal(forbiddenIdentifiers.test(src), false, `${route}: betting integration`);
  }
});

test('35. the operational surface is absent from the frontend', () => {
  // Durable: rather than asking whether operational files were edited — which
  // stops meaning anything once committed — assert that the frontend cannot
  // reach them. Producer ownership, locking, settlement and migrations have no
  // presence in the UI, by import or by reference.
  const operational =
    /lockTMinus|autoResults|importResults|producerClaim|producerOwnership|producerPreflight|nationwide|lockedReport|runModelForRace|bettingEngine|supabaseAdmin|locked_race_decisions|producer_run_claims|CRON_SECRET/;

  for (const [name, src] of Object.entries(SHELL_COMPONENT_SRC)) {
    assert.equal(operational.test(src), false, `${name} references operational code`);
  }
  for (const [route, src] of Object.entries(ADOPTED_SRC)) {
    // The audit page legitimately NAMES the locked-decision table in its own
    // explanatory copy; it must not IMPORT or call any operational module.
    for (const specifier of importsOf(src)) {
      assert.equal(operational.test(specifier), false, `${route} imports ${specifier}`);
    }
    // Checked on the CODE: the dashboard's documentation legitimately mentions
    // the offline `npm run confidence:audit` command it mirrors, and the
    // next-action widget renders a suggested command as inert <code> text.
    assert.equal(
      /execSync|spawn\(|child_process|npm run /.test(codeOf(src)),
      false,
      `${route}: no CLI invocation`
    );
  }

  // Migrations and deployment config are not referenced from the UI at all.
  for (const src of [...Object.values(SHELL_COMPONENT_SRC), ...Object.values(ADOPTED_SRC)]) {
    assert.equal(/supabase\/migrations|vercel\.json|railway/i.test(src), false);
  }
});
