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
import { execFileSync } from 'node:child_process';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

const HOW_IT_WORKS_SRC = readFileSync('src/app/how-it-works/page.tsx', 'utf8');
const LEADERBOARD_SRC = readFileSync('src/app/leaderboard/page.tsx', 'utf8');
const RESULTS_AUDIT_SRC = readFileSync('src/app/results-audit/page.tsx', 'utf8');
const LAYOUT_SRC = readFileSync('src/app/layout.tsx', 'utf8');
const TOKENS_CSS = readFileSync('src/styles/tokens.css', 'utf8');

const ADOPTED_SRC: Record<string, string> = {
  '/how-it-works': HOW_IT_WORKS_SRC,
  '/leaderboard': LEADERBOARD_SRC,
  '/results-audit': RESULTS_AUDIT_SRC,
};

/** The three adopted routes, rendered once each. */
const ADOPTED: { route: string; html: string }[] = [
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

/**
 * The reviewed Slice 1 commit this slice is measured against.
 *
 * Anchored to a FIXED commit, not to HEAD. `git status` only reports a file as
 * changed while the work is uncommitted, so a status-based boundary assertion
 * silently becomes a no-op the moment the slice lands — exactly when it would
 * still be needed.
 */
const SLICE_1_BASELINE = '69825036ed1f9f0758de13993f07e868b0349f52';

/**
 * Whether `path` is byte-identical to its content at `commit`.
 *
 * Returns `null` — never throws — when git metadata is unavailable (no git on
 * PATH, an exported source tree, a shallow clone without the baseline commit),
 * so those environments get a clear diagnostic instead of an opaque stack.
 */
function unchangedSince(commit: string, path: string): boolean | null {
  try {
    execFileSync('git', ['diff', '--quiet', commit, '--', path], { stdio: 'pipe' });
    return true;
  } catch (err) {
    // git diff --quiet exits 1 for "differs"; anything else means we could not
    // make the comparison at all.
    return (err as { status?: number }).status === 1 ? false : null;
  }
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
  // a non-existent route pass the very check meant to catch it. The audit's
  // dashboard back-link is the one addition, and it is admitted by shape: the
  // dashboard itself, optionally carrying the forwarded query string.
  const known = new Set([`#${MAIN_LANDMARK_ID}`, ...PRIMARY_DESTINATIONS.map((d) => d.href)]);
  for (const { route, html } of ADOPTED) {
    for (const anchor of anchors(html)) {
      const href = anchor.href ?? '';
      const isDashboardBackLink = href === '/' || href.startsWith('/?');
      assert.ok(
        known.has(href) || isDashboardBackLink,
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
      for (const anchor of html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? []) {
        assert.equal(anchor.includes(planned.label), false, `${route}: ${planned.label} linked`);
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

  // Not rendered on the untouched homepage: it has not adopted the shell.
  const homepage = readFileSync('src/app/page.tsx', 'utf8');
  assert.equal(/AppShell|SHELL_DISCLAIMER/.test(homepage), false, 'homepage is unmigrated');
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

test('29. the homepage keeps its own main and has not adopted the shell', (t) => {
  // Durable content contract — runs in every environment and survives commit.
  const homepage = readFileSync('src/app/page.tsx', 'utf8');
  assert.equal(
    /AppShell|UiPrimitives|AppNavigation|navDestinations|tokens\.css/.test(homepage),
    false,
    'the homepage must not adopt the shell in this slice'
  );
  assert.match(homepage, /<main style=\{styles\.page\}>/, 'it still owns its own main');

  /*
   * SLICE 2 BOUNDARY ASSERTION.
   *
   * Anchored to the reviewed Slice 1 commit, so it keeps its meaning after
   * Slice 2 is committed. It exists because homepage migration is explicitly
   * out of scope for this slice.
   *
   * MUST BE SUPERSEDED DELIBERATELY when the homepage migration begins: at
   * that point this byte-identity check is expected to fail, and the correct
   * response is to remove it together with the "must not adopt the shell"
   * assertion above — not to re-anchor it to a newer commit.
   */
  const identical = unchangedSince(SLICE_1_BASELINE, 'src/app/page.tsx');
  if (identical === null) {
    t.diagnostic(
      `git metadata unavailable — skipped the ${SLICE_1_BASELINE.slice(0, 7)} byte-identity ` +
        'check for src/app/page.tsx; the content contract above still applies'
    );
    return;
  }
  assert.equal(identical, true, `src/app/page.tsx must be byte-identical to ${SLICE_1_BASELINE}`);
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
  // Targets instructions and promises, not mere mention. The methodology page
  // says the product is "not a bookmaker" and "never guarantees an outcome";
  // that is the disclaimer working, not a violation, so a bare keyword scan
  // would be measuring the wrong thing.
  const forbidden =
    /\bbest bet\b|\bsafe bet\b|guaranteed (win|winner|profit|return|roi)|\bbet now\b|\bplace (a|your) (bet|wager)\b|\bbetslip\b|auto-?bet|\brecommended stake\b/i;

  for (const { route, html } of ADOPTED) {
    const scanned = html.split(SHELL_DISCLAIMER).join('');
    assert.equal(forbidden.test(scanned), false, `${route}: betting instruction or promise`);
  }
  for (const [route, src] of Object.entries(ADOPTED_SRC)) {
    assert.equal(forbidden.test(src.split(SHELL_DISCLAIMER).join('')), false, route);
    // No betting integration of any kind.
    assert.equal(/betfair|placeOrder|place_order|exchange|stake now/i.test(src), false, route);
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
    assert.equal(/execSync|spawn\(|child_process|npm run /.test(src), false, `${route}: no CLI`);
  }

  // Migrations and deployment config are not referenced from the UI at all.
  for (const src of [...Object.values(SHELL_COMPONENT_SRC), ...Object.values(ADOPTED_SRC)]) {
    assert.equal(/supabase\/migrations|vercel\.json|railway/i.test(src), false);
  }
});
