/**
 * Tests for the Slice 1 frontend foundation:
 *   - src/styles/tokens.css      (design tokens + shell styling)
 *   - src/components/AppShell.tsx (shell, landmarks, navigation)
 *   - src/components/UiPrimitives.tsx (shared read-only primitives)
 *
 * These are REAL render tests. `react-dom` is already a runtime dependency of
 * this project, so `renderToStaticMarkup` lets us assert on the actual HTML
 * (landmarks, skip-link target, aria-current, badge text) instead of matching
 * source text. No new dependency is introduced. Source scans are still used
 * for the safety rules, where the point is that a construct is ABSENT.
 *
 * Colour contrast is computed from the tokens (WCAG 2.1 relative luminance),
 * not asserted by eye.
 *
 * This file renders components only. It opens no database, calls no provider,
 * runs no model, creates no lock and settles no result. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AppShell,
  APP_NAME,
  APP_TAGLINE,
  MAIN_LANDMARK_ID,
  MOBILE_DESTINATIONS,
  MOBILE_NAV_MAX_DESTINATIONS,
  PLANNED_DESTINATIONS,
  PRIMARY_DESTINATIONS,
  SHELL_DISCLAIMER,
  isNavDestinationActive,
} from '../src/components/AppShell';
import { resolveActivePathname } from '../src/components/AppNavigation';
import {
  AnalyticalCard,
  DEFAULT_SKELETON_LINES,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  MetricTile,
  NeumorphicPanel,
  SectionHeader,
  STATUS_TONE_GLYPHS,
  StatusBadge,
  UnavailableState,
  VisuallyHidden,
  type HeadingLevel,
  type StatusTone,
} from '../src/components/UiPrimitives';

const SHELL_SRC = readFileSync('src/components/AppShell.tsx', 'utf8');
const PRIMITIVES_SRC = readFileSync('src/components/UiPrimitives.tsx', 'utf8');
const NAV_SRC = readFileSync('src/components/AppNavigation.tsx', 'utf8');
const NAV_MODEL_SRC = readFileSync('src/components/navDestinations.ts', 'utf8');
const TOKENS_CSS = readFileSync('src/styles/tokens.css', 'utf8');

/**
 * The SERVER half of the shell. These must never become client components:
 * no `'use client'`, no hooks.
 */
const NEW_TSX = [SHELL_SRC, PRIMITIVES_SRC];

/**
 * Every shell source, including the one sanctioned client component. The
 * safety scans (no fetch, no storage, no secrets, no betting controls) apply
 * to all of them without exception.
 */
const SHELL_SOURCES = [SHELL_SRC, PRIMITIVES_SRC, NAV_SRC, NAV_MODEL_SRC];

/** All anchors as {href, ariaCurrent}, independent of attribute order. */
function anchors(html: string): { href: string | null; ariaCurrent: string | null }[] {
  return [...html.matchAll(/<a\b([^>]*)>/g)].map((match) => ({
    href: /href="([^"]*)"/.exec(match[1])?.[1] ?? null,
    ariaCurrent: /aria-current="([^"]*)"/.exec(match[1])?.[1] ?? null,
  }));
}

/**
 * The stylesheet with comments removed, for structural assertions. Prose in a
 * comment must never satisfy — or defeat — a rule about what the CSS declares.
 */
const TOKENS_CSS_CODE = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule block that declares `box-sizing`, with its selector list. */
function boxSizingRules(): { selectors: string[]; body: string }[] {
  const rules: { selectors: string[]; body: string }[] = [];
  for (const match of TOKENS_CSS_CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/box-sizing\s*:/.test(match[2])) continue;
    rules.push({
      selectors: match[1]
        .split(',')
        .map((selector) => selector.trim())
        .filter(Boolean),
      body: match[2],
    });
  }
  return rules;
}

/** Returns a whole at-rule block (prelude plus body) by brace matching. */
function atRuleBlock(prelude: string): string {
  const start = TOKENS_CSS_CODE.indexOf(prelude);
  assert.notEqual(start, -1, `expected to find ${prelude}`);
  let depth = 0;
  for (let i = TOKENS_CSS_CODE.indexOf('{', start); i < TOKENS_CSS_CODE.length; i += 1) {
    if (TOKENS_CSS_CODE[i] === '{') depth += 1;
    else if (TOKENS_CSS_CODE[i] === '}') {
      depth -= 1;
      if (depth === 0) return TOKENS_CSS_CODE.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated block: ${prelude}`);
}

/** Renders the shell with a single identifiable child. */
function renderShell(pathname?: string | null): string {
  return renderToStaticMarkup(
    h(AppShell, { pathname, children: h('p', { id: 'child-probe' }, 'child content') })
  );
}

/** Returns the substring from `start` up to the first `end` after it. */
function sliceBetween(html: string, start: string, end: string): string {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `expected to find ${start}`);
  const to = html.indexOf(end, from);
  assert.notEqual(to, -1, `expected to find ${end} after ${start}`);
  return html.slice(from, to + end.length);
}

/* ========================== 1. shell renders children ====================== */

test('1. AppShell renders its children inside the main landmark', () => {
  const html = renderShell('/');
  assert.match(html, /<p id="child-probe">child content<\/p>/);

  const main = sliceBetween(html, '<main', '</main>');
  assert.match(main, /child content/, 'children must render inside <main>');
});

/* ============================ 2. skip link target ========================== */

test('2. the skip link targets the main landmark id', () => {
  const html = renderShell('/');

  const skipHref = /<a class="rb-skip-link" href="([^"]+)"/.exec(html);
  assert.ok(skipHref, 'skip link must be present');

  const mainId = /<main[^>]*id="([^"]+)"/.exec(html);
  assert.ok(mainId, 'main landmark must carry an id');

  assert.equal(skipHref[1], `#${mainId[1]}`, 'skip link must point at the main id');
  assert.equal(mainId[1], MAIN_LANDMARK_ID);

  // The skip link must be the first focusable thing on the page.
  assert.ok(
    html.indexOf('rb-skip-link') < html.indexOf('<header'),
    'skip link must precede the header'
  );
  // Focusable programmatically so focus actually moves when it is followed.
  assert.match(html, /<main[^>]*tabindex="-1"/i);
});

/* ============================== 3. landmarks =============================== */

test('3. header, navigation and main landmarks exist (exactly one main)', () => {
  const html = renderShell('/');

  assert.equal((html.match(/<header/g) ?? []).length, 1, 'exactly one header');
  assert.equal((html.match(/<main/g) ?? []).length, 1, 'exactly one main landmark');

  const navs = html.match(/<nav[^>]*>/g) ?? [];
  assert.equal(navs.length, 2, 'a primary nav and a mobile nav');
  // Distinct accessible names so the two are never ambiguous.
  const labels = navs.map((n) => /aria-label="([^"]+)"/.exec(n)?.[1]);
  assert.deepEqual(labels, ['Primary', 'Primary mobile']);
});

/* ======================= 4-5. course-agnostic identity ===================== */

test('4. application branding is course-agnostic', () => {
  const html = renderShell('/');
  assert.equal(APP_NAME, 'Racing Bot');
  assert.equal(APP_TAGLINE, 'UK & Ireland Racing Analytics');
  assert.match(html, /Racing Bot/);
  // Rendered as an HTML entity by React.
  assert.match(html, /UK &amp; Ireland Racing Analytics/);
});

test('5. no single-course branding is introduced', () => {
  const course = /ascot|newmarket|cheltenham|aintree|epsom|goodwood|doncaster/i;
  assert.equal(course.test(renderShell('/')), false, 'rendered shell names no course');
  for (const src of [...SHELL_SOURCES, TOKENS_CSS]) {
    assert.equal(course.test(src), false, 'new source files name no course');
  }
});

/* ========================= 6-7. navigation honesty ========================= */

test('6. every linked destination is a route that actually exists', () => {
  for (const destination of PRIMARY_DESTINATIONS) {
    const file =
      destination.href === '/'
        ? 'src/app/page.tsx'
        : `src/app${destination.href}/page.tsx`;
    assert.equal(existsSync(file), true, `${destination.href} must be backed by ${file}`);
  }
  assert.deepEqual(
    PRIMARY_DESTINATIONS.map((d) => d.href),
    ['/', '/how-it-works', '/leaderboard', '/results-audit']
  );
});

test('7. planned destinations are never rendered as links', () => {
  const html = renderShell('/');

  // Structural guarantee: the planned type carries no href at all.
  for (const planned of PLANNED_DESTINATIONS) {
    assert.equal('href' in planned, false, 'a planned destination must have no href');
  }

  // And nothing renders them inside an anchor.
  const anchorElements = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
  for (const planned of PLANNED_DESTINATIONS) {
    for (const anchor of anchorElements) {
      assert.equal(
        anchor.includes(planned.label),
        false,
        `${planned.label} must not appear inside a link`
      );
    }
    // It is still visible, and visibly marked as planned.
    assert.match(html, new RegExp(`${planned.label}<span class="rb-nav__planned-tag">Planned`));
  }

  // No link anywhere points at a route that does not exist.
  const hrefs = anchors(html).map((a) => a.href ?? '');
  const known = new Set<string>([
    `#${MAIN_LANDMARK_ID}`,
    ...PRIMARY_DESTINATIONS.map((d) => d.href),
  ]);
  for (const href of hrefs) {
    assert.equal(known.has(href), true, `unexpected link target: ${href}`);
  }
});

/* ============================= 8. aria-current ============================= */

test('8. the active route is marked with aria-current="page"', () => {
  const html = renderShell('/leaderboard');

  // Attribute order is not asserted: `next/link` emits className and
  // aria-current before href, and that ordering is not a contract.
  const active = anchors(html)
    .filter((a) => a.ariaCurrent === 'page')
    .map((a) => a.href);
  // Present once in the primary nav and once in the mobile nav.
  assert.deepEqual(active, ['/leaderboard', '/leaderboard']);

  // With no pathname, nothing is guessed as active.
  assert.equal(/aria-current/.test(renderShell(null)), false);
});

test('8b. isNavDestinationActive: exact for "/", prefix for sections', () => {
  assert.equal(isNavDestinationActive('/', '/'), true);
  assert.equal(isNavDestinationActive('/leaderboard', '/'), false, '"/" must not prefix-match');
  assert.equal(isNavDestinationActive('/leaderboard', '/leaderboard'), true);
  assert.equal(isNavDestinationActive('/leaderboard/x', '/leaderboard'), true);
  assert.equal(isNavDestinationActive('/leaderboards', '/leaderboard'), false);
  assert.equal(isNavDestinationActive('/leaderboard/', '/leaderboard'), true, 'trailing slash');
  assert.equal(isNavDestinationActive('/results-audit?date=2026-07-28', '/results-audit'), true);
  assert.equal(isNavDestinationActive(null, '/'), false);
  assert.equal(isNavDestinationActive(undefined, '/'), false);
  assert.equal(isNavDestinationActive('', '/'), false);
});

/* =========================== 9. mobile navigation ========================== */

test('9. mobile navigation has at most five usable destinations and no traps', () => {
  const html = renderShell('/');
  const mobile = sliceBetween(html, '<nav class="rb-nav rb-nav--mobile"', '</nav>');

  const links = mobile.match(/<a\b/g) ?? [];
  assert.ok(links.length > 0, 'mobile nav must have destinations');
  assert.ok(
    links.length <= MOBILE_NAV_MAX_DESTINATIONS,
    `mobile nav has ${links.length} destinations, max is ${MOBILE_NAV_MAX_DESTINATIONS}`
  );
  assert.equal(MOBILE_DESTINATIONS.length, links.length);

  // No disabled/planned item may appear in the bottom bar — neither the label
  // nor the list item that the tablet breakpoint hides.
  assert.equal(/rb-nav__planned|rb-nav__item--planned|aria-disabled/.test(mobile), false);
  for (const planned of PLANNED_DESTINATIONS) {
    assert.equal(mobile.includes(planned.label), false, `${planned.label} must not reach the bar`);
  }

  // Touch target floor is declared for the bottom bar.
  assert.match(TOKENS_CSS, /--rb-touch-target-min:\s*44px/);
  assert.match(TOKENS_CSS, /\.rb-nav--mobile \.rb-nav__link\s*\{[^}]*min-height:\s*var\(--rb-touch-target-min\)/);
});

/* ============================ 10. semantic markup ========================== */

test('10. primitives render semantic elements', () => {
  assert.match(
    renderToStaticMarkup(h(NeumorphicPanel, null, 'body')),
    /^<section class="rb-panel">/
  );
  assert.match(
    renderToStaticMarkup(h(AnalyticalCard, null, 'body')),
    /^<article class="rb-card">/
  );

  const header = renderToStaticMarkup(
    h(SectionHeader, { title: 'Lock coverage', eyebrow: 'Official', description: 'Scope note' })
  );
  assert.match(header, /^<header class="rb-section-header">/);
  assert.match(header, /<h2 class="rb-section-header__title">Lock coverage<\/h2>/);

  assert.match(
    renderToStaticMarkup(h(SectionHeader, { title: 'Sub', level: 3 })),
    /<h3 /,
    'heading level is caller-controlled'
  );

  // A metric is a name/value pair, expressed as one.
  const metric = renderToStaticMarkup(
    h(MetricTile, { label: 'Races locked', value: '18', note: 'of 19 races' })
  );
  assert.match(metric, /<dl class="rb-metric__pair">/);
  assert.match(metric, /<dt class="rb-metric__label">Races locked<\/dt>/);
  assert.match(metric, /<dd class="rb-metric__value rb-tabular">18<\/dd>/);
  assert.match(metric, /<p class="rb-metric__note">of 19 races<\/p>/);

  // Message states are sections; only the error state is assertive.
  assert.match(
    renderToStaticMarkup(h(EmptyState, { title: 'No races in scope', children: 'b' })),
    /^<section class="rb-state rb-state--empty">/
  );
  assert.match(
    renderToStaticMarkup(h(UnavailableState, { title: 'Not recorded', children: 'b' })),
    /^<section class="rb-state rb-state--unavailable">/
  );
  const error = renderToStaticMarkup(h(ErrorState, { title: 'Request failed', children: 'b' }));
  assert.match(error, /^<section class="rb-state rb-state--error" role="alert">/);

  // Each state heading is a real heading carrying an AT-hidden glyph.
  assert.match(error, /<h3 class="rb-state__heading">/);
  assert.match(error, /<span class="rb-state__glyph" aria-hidden="true">/);

  assert.match(
    renderToStaticMarkup(h(VisuallyHidden, null, 'hidden text')),
    /^<span class="rb-visually-hidden">hidden text<\/span>$/
  );
});

test('10b. an out-of-contract heading level cannot become an arbitrary tag', () => {
  // React does not sanitise element type strings, so the level -> tag mapping
  // is enumerated rather than interpolated. A bad level degrades to h3.
  const hostile = 'img src=x onerror=alert(1)' as unknown as HeadingLevel;
  const html = renderToStaticMarkup(h(SectionHeader, { title: 'T', level: hostile }));
  assert.match(html, /<h3 class="rb-section-header__title">T<\/h3>/);
  assert.equal(/onerror|<img/.test(html), false);
});

/* ======================= 11-12. status is never colour-only ================ */

test('11. StatusBadge renders its visible text label', () => {
  const html = renderToStaticMarkup(
    h(StatusBadge, { tone: 'official', children: 'Locked no-bet' })
  );
  assert.match(html, /<span class="rb-badge__text">Locked no-bet<\/span>/);
});

test('12. status is carried by glyph and text, never by colour alone', () => {
  const tones: StatusTone[] = [
    'neutral',
    'analytical',
    'positive',
    'warning',
    'failure',
    'official',
  ];

  // Each tone has its own glyph, so tones stay distinguishable in greyscale.
  const glyphs = tones.map((tone) => STATUS_TONE_GLYPHS[tone]);
  assert.equal(new Set(glyphs).size, tones.length, 'every tone needs a distinct glyph');

  for (const tone of tones) {
    const html = renderToStaticMarkup(h(StatusBadge, { tone, children: `${tone} label` }));
    // Glyph present but hidden from AT (it is a redundant visual encoding).
    assert.match(html, /<span class="rb-badge__glyph" aria-hidden="true">/);
    // Text present and visible.
    assert.match(html, new RegExp(`<span class="rb-badge__text">${tone} label</span>`));
    assert.match(html, new RegExp(`rb-badge--${tone}`));
  }

  // Optional extra context is announced before the label.
  const withSr = renderToStaticMarkup(
    h(StatusBadge, { tone: 'warning', srLabel: 'Data quality:', children: 'Stale odds' })
  );
  assert.match(withSr, /<span class="rb-visually-hidden">Data quality:<\/span>/);

  // The active nav item is likewise not colour-only: aria-current + underline.
  assert.match(TOKENS_CSS, /\.rb-nav__link\[aria-current='page'\]\s*\{[^}]*text-decoration:\s*underline/);
});

/* ========================= 13. skeleton and assistive tech ================= */

test('13. LoadingSkeleton hides its bars from assistive technology', () => {
  const html = renderToStaticMarkup(h(LoadingSkeleton, { lines: 4, label: 'Loading races' }));

  assert.match(html, /^<div class="rb-skeleton" role="status">/);
  assert.match(html, /<span class="rb-visually-hidden">Loading races<\/span>/);

  const bars = html.match(/<span class="rb-skeleton__bar" aria-hidden="true">/g) ?? [];
  assert.equal(bars.length, 4, 'every decorative bar is hidden from AT');

  // Never renders zero bars, whatever the caller passes.
  assert.equal(
    (renderToStaticMarkup(h(LoadingSkeleton, { lines: 0 })).match(/rb-skeleton__bar/g) ?? []).length,
    1
  );
});

/* ====================== 14-18. token and CSS guarantees ==================== */

test('14. reduced-motion CSS is present, including for the skeleton pulse', () => {
  assert.match(TOKENS_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(TOKENS_CSS, /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(TOKENS_CSS, /transition-duration:\s*0\.01ms\s*!important/);
  // Two occurrences: the global guard and the skeleton override.
  assert.ok((TOKENS_CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? []).length >= 2);
});

test('15. focus-visible CSS is present and no outline is ever removed', () => {
  assert.match(TOKENS_CSS, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--rb-focus-ring\)/);
  assert.match(TOKENS_CSS, /outline-offset:/);
  assert.equal(/outline:\s*(none|0)\b/.test(TOKENS_CSS), false, 'outlines must never be removed');
  for (const src of SHELL_SOURCES) {
    assert.equal(/outline:\s*['"]?(none|0)\b/.test(src), false);
  }
});

test('16. interactive shell elements carry a visible border, not only shadow', () => {
  // Shadow is decorative; the border and the text label are the affordance.
  // Interactive borders use the 3:1 token, not the decorative hairline.
  // The mobile bar overrides these rules, and is covered by test 28.
  const navLink = sliceBetween(TOKENS_CSS, '.rb-nav__link {', '}');
  assert.match(navLink, /border:\s*1px solid var\(--rb-border-strong\)/);

  const skip = sliceBetween(TOKENS_CSS, '.rb-skip-link {', '}');
  assert.match(skip, /border:\s*1px solid var\(--rb-border-strong\)/);
  assert.match(skip, /text-decoration:\s*underline/);

  // The active item strengthens the border too, not just the colour.
  assert.match(
    TOKENS_CSS,
    /\.rb-nav__link\[aria-current='page'\]\s*\{[^}]*border-color:\s*var\(--rb-border-strong\)/
  );
});

test('17. raised, elevated, inset and focus shadow tokens exist and are paired', () => {
  for (const token of [
    '--rb-shadow-raised',
    '--rb-shadow-elevated',
    '--rb-shadow-inset',
    '--rb-shadow-focused',
  ]) {
    assert.match(TOKENS_CSS, new RegExp(`${token}:`), `${token} must be defined`);
  }
  // Neumorphism needs a light highlight and a dark shadow in the same value.
  const raised = /--rb-shadow-raised:([^;]+);/.exec(TOKENS_CSS)?.[1] ?? '';
  assert.match(raised, /rgba\(255, 255, 255/, 'raised needs a light highlight');
  assert.match(raised, /rgba\(20, 28, 42/, 'raised needs a dark shadow');
  assert.match(/--rb-shadow-inset:([^;]+);/.exec(TOKENS_CSS)?.[1] ?? '', /inset/);
});

/** Parses the first `:root { ... }` block at or after `fromIndex`. */
function tokenBlock(fromIndex: number): Record<string, string> {
  const start = TOKENS_CSS.indexOf(':root {', fromIndex);
  assert.notEqual(start, -1, 'expected a :root block');
  const end = TOKENS_CSS.indexOf('}', start);
  assert.notEqual(end, -1, 'expected the :root block to close');
  const out: Record<string, string> = {};
  for (const match of TOKENS_CSS.slice(start, end).matchAll(/(--rb-[a-z0-9-]+):\s*([^;]+);/g)) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

/** Light-theme tokens (the first `:root` block). */
function lightTokens(): Record<string, string> {
  return tokenBlock(0);
}

/** Dark-theme overrides (the `:root` block inside the dark media query). */
function darkTokens(): Record<string, string> {
  const media = TOKENS_CSS.indexOf('@media (prefers-color-scheme: dark)');
  assert.notEqual(media, -1, 'a dark scheme must be defined');
  return tokenBlock(media);
}

/** WCAG 2.1 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('18. text and semantic tokens meet WCAG AA on the raised surface', () => {
  const tokens = lightTokens();
  const surface = tokens['--rb-surface-raised'];
  assert.match(surface, /^#[0-9a-f]{6}$/i);

  // Body-sized text must reach 4.5:1. Computed, not eyeballed.
  const bodyText = [
    '--rb-text-primary',
    '--rb-text-secondary',
    '--rb-text-muted',
    '--rb-accent-analytical',
    '--rb-status-positive',
    '--rb-status-warning',
    '--rb-status-failure',
    '--rb-status-official',
    '--rb-market-neutral',
  ];
  for (const token of bodyText) {
    const ratio = contrast(tokens[token], surface);
    assert.ok(ratio >= 4.5, `${token} contrast ${ratio.toFixed(2)}:1 is below 4.5:1`);
  }

  // Primary text is genuinely high contrast, not merely passing.
  const primary = contrast(tokens['--rb-text-primary'], surface);
  assert.ok(primary >= 12, `primary text is only ${primary.toFixed(2)}:1`);

  // Interactive borders must meet WCAG 2.1 SC 1.4.11 (3:1) against BOTH the
  // raised surface and the application background they may sit on.
  for (const bg of [surface, tokens['--rb-bg-app']]) {
    const ratio = contrast(tokens['--rb-border-strong'], bg);
    assert.ok(ratio >= 3, `--rb-border-strong is only ${ratio.toFixed(2)}:1 on ${bg}`);
  }
});

test('18c. the dark scheme meets the same contrast floors', () => {
  const dark = darkTokens();
  const surface = dark['--rb-surface-raised'];
  assert.match(surface, /^#[0-9a-f]{6}$/i);

  for (const token of [
    '--rb-text-primary',
    '--rb-text-secondary',
    '--rb-text-muted',
    '--rb-accent-analytical',
    '--rb-status-positive',
    '--rb-status-warning',
    '--rb-status-failure',
    '--rb-status-official',
    '--rb-market-neutral',
  ]) {
    const ratio = contrast(dark[token], surface);
    assert.ok(ratio >= 4.5, `dark ${token} contrast ${ratio.toFixed(2)}:1 is below 4.5:1`);
  }

  const border = contrast(dark['--rb-border-strong'], surface);
  assert.ok(border >= 3, `dark --rb-border-strong is only ${border.toFixed(2)}:1`);
});

test('18b. the full token vocabulary required by the design system exists', () => {
  const tokens = lightTokens();
  const required = [
    '--rb-bg-app',
    '--rb-surface-raised',
    '--rb-surface-elevated',
    '--rb-surface-inset',
    '--rb-text-primary',
    '--rb-text-secondary',
    '--rb-text-muted',
    '--rb-border',
    '--rb-border-strong',
    '--rb-accent-analytical',
    '--rb-status-positive',
    '--rb-status-warning',
    '--rb-status-failure',
    '--rb-status-official',
    '--rb-market-neutral',
    '--rb-focus-ring',
    '--rb-space-1',
    '--rb-space-2',
    '--rb-space-3',
    '--rb-space-4',
    '--rb-space-5',
    '--rb-space-6',
    '--rb-space-7',
    '--rb-radius-control',
    '--rb-radius-card',
    '--rb-radius-panel',
    '--rb-radius-pill',
    '--rb-font-system',
    '--rb-text-meta',
    '--rb-text-label',
    '--rb-text-body',
    '--rb-text-section',
    '--rb-text-page',
    '--rb-state-hover',
    '--rb-state-selected',
    '--rb-state-active',
    '--rb-state-disabled-opacity',
  ];
  for (const token of required) {
    assert.ok(tokens[token], `${token} must be defined`);
  }
  assert.deepEqual(
    ['--rb-space-1', '--rb-space-2', '--rb-space-3', '--rb-space-4', '--rb-space-5', '--rb-space-6', '--rb-space-7'].map(
      (t) => tokens[t]
    ),
    ['4px', '8px', '12px', '16px', '24px', '32px', '48px']
  );
  // A dark scheme is defined by value only — there is no theme toggle.
  assert.match(TOKENS_CSS, /@media \(prefers-color-scheme: dark\)/);
  for (const src of SHELL_SOURCES) {
    assert.equal(/theme|toggle|setTheme|dark-mode/i.test(src), false, 'no theme toggle in slice 1');
  }
  // A tabular-numeral utility exists for aligned figures.
  assert.match(TOKENS_CSS, /\.rb-tabular\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
});

/* ========================= 19-23. safety source scans ====================== */

test('19. no fetch or API call exists in the new shell or primitive files', () => {
  for (const src of SHELL_SOURCES) {
    assert.equal(/\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket/.test(src), false);
    assert.equal(/['"`]\/api\//.test(src), false, 'no API path is referenced');
    assert.equal(/supabase|createClient/i.test(src), false);
  }
});

test('20. no browser write or storage call exists', () => {
  for (const src of NEW_TSX) {
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), false);
    // No route mutation, no history rewriting.
    assert.equal(/window\.location|history\.(push|replace)|router\.(push|replace)/.test(src), false);
    // No client-side state or effects: these stay server components. Matched
    // as a real directive line and as real hook CALLS, so the files may still
    // describe what they deliberately avoid in their own documentation.
    assert.equal(/^\s*['"]use client['"]\s*;?\s*$/m.test(src), false, 'no use-client directive');
    assert.equal(
      /\buse(State|Effect|Router|Ref|Reducer|Context|SyncExternalStore|LayoutEffect)\s*\(/.test(src),
      false,
      'no React hook calls'
    );
  }
});

test('20b. the one client component is narrowly scoped to navigation state', () => {
  // AppNavigation is the ONLY sanctioned client component in the shell. It may
  // read the route; it may not do anything else a client component can do.
  assert.match(NAV_SRC, /^'use client';/, 'AppNavigation must declare the boundary');

  // Route reading is the entire justification for the boundary.
  assert.match(NAV_SRC, /\busePathname\s*\(\s*\)/);

  // No state, no effects, no storage, no history/router mutation, no fetch.
  assert.equal(
    /\buse(State|Effect|Reducer|SyncExternalStore|LayoutEffect)\s*\(/.test(NAV_SRC),
    false,
    'navigation holds no state and runs no effect'
  );
  assert.equal(/useRouter|router\.(push|replace)|history\.(push|replace)/.test(NAV_SRC), false);
  assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(NAV_SRC), false);
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket/.test(NAV_SRC), false);

  // The pathname is used for aria-current only — never rendered as content.
  // Checked on the visible text, with every tag (and so every href) stripped.
  const visibleText = renderShell('/leaderboard').replace(/<[^>]*>/g, ' ');
  for (const destination of PRIMARY_DESTINATIONS) {
    if (destination.href === '/') continue;
    assert.equal(
      visibleText.includes(destination.href),
      false,
      `${destination.href} must never appear as visible text`
    );
  }

  // The rest of the shell stays server-rendered.
  for (const src of NEW_TSX) {
    assert.equal(/^\s*['"]use client['"]\s*;?\s*$/m.test(src), false);
  }
  assert.equal(/^\s*['"]use client['"]\s*;?\s*$/m.test(NAV_MODEL_SRC), false);
});

test('21. no environment or secret reference exists', () => {
  for (const src of [...SHELL_SOURCES, TOKENS_CSS]) {
    assert.equal(/process\.env|import\.meta\.env/.test(src), false);
    assert.equal(/CRON_SECRET|SERVICE_ROLE|BETFAIR_|RACING_API|API_KEY|SUPABASE_/.test(src), false);
  }
});

test('22. imports stay inside a narrow allowlist', () => {
  for (const src of [...SHELL_SOURCES, TOKENS_CSS]) {
    assert.equal(/railway|vercel|stripe|sentry|@supabase/i.test(src), false);
  }

  const specifiersOf = (src: string) => [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  const inRepo = (s: string) => s === 'react' || s.startsWith('.') || s.startsWith('@/');

  // The server half may import react and in-repo modules only — unchanged.
  for (const src of [SHELL_SRC, PRIMITIVES_SRC, NAV_MODEL_SRC]) {
    for (const specifier of specifiersOf(src)) {
      assert.ok(inRepo(specifier), `unexpected import: ${specifier}`);
    }
  }

  // The navigation component additionally gets exactly two framework imports:
  // the router-aware link and the pathname hook. Nothing else is permitted,
  // and the widening does not apply to any other file.
  const NAV_EXTRA = new Set(['next/link', 'next/navigation']);
  for (const specifier of specifiersOf(NAV_SRC)) {
    assert.ok(
      inRepo(specifier) || NAV_EXTRA.has(specifier),
      `unexpected import in AppNavigation: ${specifier}`
    );
  }

  // The allowance is narrow by construction: no other shell source may reach
  // for `next/*` at all.
  for (const src of [SHELL_SRC, PRIMITIVES_SRC, NAV_MODEL_SRC]) {
    assert.equal(/from 'next\//.test(src), false, 'only AppNavigation may import next/*');
  }
});

test('23. no betting control or betting language exists', () => {
  // The standing disclaimer necessarily contains the phrase it disclaims
  // ("not ... instructions to place a bet"). It is asserted on its own terms
  // in test 24b, and removed here so the scan cannot be satisfied by a
  // negation — or defeated by one.
  const html = renderShell('/').split(SHELL_DISCLAIMER).join('');
  assert.equal(html.includes('place a bet'), false, 'disclaimer removal must be exact');

  for (const src of [...SHELL_SOURCES, TOKENS_CSS, html]) {
    const scanned = src.split(SHELL_DISCLAIMER).join('');
    // No write controls at all.
    assert.equal(/<form|<button|onClick|onSubmit|--commit/.test(scanned), false);
    // No bet-placement or outcome-guarantee vocabulary.
    assert.equal(
      /best bet|safe bet|guaranteed|bet now|place (a )?(bet|wager)|recommended stake|betslip|bookmaker/i.test(
        scanned
      ),
      false
    );
  }
});

test('24b. the standing disclaimer states a boundary, never an instruction', () => {
  const html = renderShell('/');

  // Rendered exactly once, inside the main landmark the shell owns.
  assert.equal(html.split(SHELL_DISCLAIMER).length - 1, 1, 'exactly one disclaimer');
  const main = sliceBetween(html, '<main', '</main>');
  assert.ok(main.includes(SHELL_DISCLAIMER), 'the disclaimer belongs to the page content');
  assert.match(html, /<footer class="rb-disclaimer">/);

  // No imperative call to action, no promise of return.
  assert.equal(
    /\b(bet|back|stake|wager|deposit|join|sign up|claim)\s+(now|today|here)\b/i.test(
      SHELL_DISCLAIMER
    ),
    false,
    'no call to action'
  );
  assert.equal(/guaranteed|guarantee\b|profit|returns|winnings|odds boost/i.test(SHELL_DISCLAIMER), false);
  assert.equal(/\bshould (bet|back|stake)\b|\bplace your\b/i.test(SHELL_DISCLAIMER), false);

  // It says what the product is, and what its output is not.
  assert.match(SHELL_DISCLAIMER, /Decision-support analytics only/);
  assert.match(SHELL_DISCLAIMER, /not\b[^.]*\bguarantees\b/);

  // Quiet, not sticky, and it never becomes a banner.
  const style = sliceBetween(TOKENS_CSS, '.rb-disclaimer {', '}');
  assert.equal(/position:\s*(sticky|fixed)/.test(style), false, 'the disclaimer is not sticky');
  assert.match(style, /color:\s*var\(--rb-text-muted\)/);
});

/* ============ 24-32. code-review corrections (layout and boundaries) ======= */

test('24. border-box sizing is scoped to the shell and covers its descendants', () => {
  const rules = boxSizingRules();
  assert.ok(rules.length > 0, 'the shell must declare border-box sizing');

  for (const rule of rules) {
    assert.match(rule.body, /box-sizing:\s*border-box/);
    for (const selector of rule.selectors) {
      assert.ok(
        selector === '.rb-app' || selector.startsWith('.rb-app '),
        `box-sizing selector "${selector}" escapes the .rb-app scope`
      );
    }
  }

  // Root, every descendant, and generated content.
  const covered = new Set(rules.flatMap((rule) => rule.selectors));
  for (const selector of [
    '.rb-app',
    '.rb-app *',
    '.rb-app *::before',
    '.rb-app *::after',
  ]) {
    assert.ok(covered.has(selector), `${selector} must be covered`);
  }
});

test('25. no global universal box-sizing reset is introduced', () => {
  // The existing pages measure themselves with inline content-box styles, so a
  // document-wide reset would silently resize content this slice must not touch.
  for (const rule of boxSizingRules()) {
    for (const selector of rule.selectors) {
      assert.equal(
        /^(\*|html|body|:root)\b/.test(selector),
        false,
        `global box-sizing reset via "${selector}"`
      );
    }
  }
  assert.equal(
    /(^|\})\s*(\*|html|body)\s*(,[^{]*)?\{[^}]*box-sizing/.test(TOKENS_CSS_CODE),
    false,
    'no top-level universal box-sizing reset'
  );
});

test('26. the shell never becomes an accidental scroll container', () => {
  // Clipping one axis forces the other to compute to `auto`. `.rb-app` would
  // then be a scrollport: `position: sticky` descendants (the dashboard has
  // one) would resolve against a container that never scrolls, and wide
  // analytical content and focus outlines would be clipped unreachably.
  const app = sliceBetween(TOKENS_CSS_CODE, '.rb-app {', '}');
  assert.equal(/overflow/.test(app), false, `.rb-app must declare no overflow:\n${app}`);

  // And no other shell ancestor clips on its behalf.
  for (const selector of ['.rb-header {', '.rb-main {']) {
    const block = sliceBetween(TOKENS_CSS_CODE, selector, '}');
    assert.equal(/overflow/.test(block), false, `${selector} must not clip`);
  }
});

test('27. intentional horizontal scrolling stays available via .rb-scroll-x', () => {
  // Removing the shell-wide clip must not remove the opt-in for content that
  // genuinely needs to scroll sideways, such as a wide analytical table.
  const utility = sliceBetween(TOKENS_CSS_CODE, '.rb-scroll-x {', '}');
  assert.match(utility, /overflow-x:\s*auto/);
  assert.match(utility, /max-width:\s*100%/);
});

test('28. mobile destinations stay bounded by the 3:1 border token', () => {
  const link = sliceBetween(TOKENS_CSS_CODE, '.rb-nav--mobile .rb-nav__link {', '}');

  // Depth and fill are dropped in the bar, so the divider is the only boundary
  // and must be the contrast-compliant token, not the decorative hairline.
  assert.match(link, /border-left:\s*1px solid var\(--rb-border-strong\)/);
  assert.equal(/var\(--rb-border\)/.test(link), false, 'the hairline is not load-bearing here');
  assert.match(link, /box-shadow:\s*none/);

  // The touch target and the text label survive the override.
  assert.match(link, /min-height:\s*var\(--rb-touch-target-min\)/);
  assert.match(link, /font-size:\s*var\(--rb-text-label\)/);
  assert.equal(/display:\s*none/.test(link), false);

  // The bar itself is bounded by the same token.
  const bar = sliceBetween(TOKENS_CSS_CODE, '.rb-nav--mobile {', '}');
  assert.match(bar, /border-top:\s*1px solid var\(--rb-border-strong\)/);

  // The active destination keeps structural and textual indicators, so the
  // current item is never signalled by colour alone in the bar either.
  const activeBar = sliceBetween(
    TOKENS_CSS_CODE,
    ".rb-nav--mobile .rb-nav__link[aria-current='page'] {",
    '}'
  );
  assert.match(activeBar, /border-top-color:\s*var\(--rb-accent-analytical\)/);
  assert.match(
    TOKENS_CSS_CODE,
    /\.rb-nav__link\[aria-current='page'\]\s*\{[^}]*text-decoration:\s*underline/
  );
});

test('28b. the mobile boundary clears 3:1 on the bar surface, light and dark', () => {
  // The bar is painted `--rb-surface-raised` and its links are transparent, so
  // that is the surface the divider sits on in both schemes. Computed with the
  // same WCAG relative-luminance maths as the text tokens, not eyeballed.
  const bar = sliceBetween(TOKENS_CSS_CODE, '.rb-nav--mobile {', '}');
  assert.match(bar, /background:\s*var\(--rb-surface-raised\)/);
  const link = sliceBetween(TOKENS_CSS_CODE, '.rb-nav--mobile .rb-nav__link {', '}');
  assert.match(link, /background:\s*transparent/);

  for (const [scheme, tokens] of [
    ['light', lightTokens()],
    ['dark', darkTokens()],
  ] as const) {
    const ratio = contrast(tokens['--rb-border-strong'], tokens['--rb-surface-raised']);
    assert.ok(ratio >= 3, `${scheme} mobile divider is only ${ratio.toFixed(2)}:1`);
  }
});

test('28c. mobile destinations keep a 44px touch target', () => {
  assert.match(TOKENS_CSS, /--rb-touch-target-min:\s*44px/);
  const link = sliceBetween(TOKENS_CSS_CODE, '.rb-nav--mobile .rb-nav__link {', '}');
  assert.match(link, /min-height:\s*var\(--rb-touch-target-min\)/);
  // Border-box sizing is scoped to the shell, so 44px is the real hit area
  // rather than 44px plus padding and border.
  assert.ok(boxSizingRules().length > 0);
});

test('30. the tablet breakpoint hides the entire planned list item', () => {
  const tablet = atRuleBlock('@media (max-width: 1023px)');

  assert.match(tablet, /\.rb-nav--primary \.rb-nav__item--planned\s*\{[^}]*display:\s*none/);
  // Hiding only the inner label leaves an empty flex child that still consumes
  // the list `gap`, trailing dead space after the last real destination.
  assert.equal(
    /\.rb-nav--primary \.rb-nav__planned\s*\{[^}]*display:\s*none/.test(tablet),
    false,
    'the label-only rule leaves an empty flex item'
  );

  // The shell emits exactly the class that rule targets, and working
  // destinations keep the plain item class so they are never caught by it.
  const html = renderShell('/');
  assert.ok(html.includes('<li class="rb-nav__item">'), 'working items stay unmodified');
  for (const planned of PLANNED_DESTINATIONS) {
    assert.ok(
      html.includes(
        `<li class="rb-nav__item rb-nav__item--planned"><span class="rb-nav__planned">` +
          `${planned.label}<span class="rb-nav__planned-tag">Planned</span></span></li>`
      ),
      `${planned.label} must render as a marked, non-link list item`
    );
  }
});

test('31. the skip link is fixed, so focus is visible after scrolling', () => {
  const skip = sliceBetween(TOKENS_CSS_CODE, '.rb-skip-link {', '}');

  // Absolute resolves against the initial containing block, so once the reader
  // has scrolled the link would return to the top of the DOCUMENT — off-screen
  // at the exact moment it receives focus.
  assert.match(skip, /position:\s*fixed/);
  assert.equal(/position:\s*absolute/.test(skip), false);

  // Parked above the viewport until focused, then inside it at a positive offset.
  assert.match(skip, /top:\s*calc\(-1 \* var\(--rb-space-7\) - var\(--rb-space-5\)\)/);
  const focused = sliceBetween(TOKENS_CSS_CODE, '.rb-skip-link:focus {', '}');
  assert.match(focused, /top:\s*var\(--rb-space-3\)/);

  // Above the header and the fixed mobile bar.
  const skipZ = Number(/z-index:\s*(\d+)/.exec(skip)?.[1]);
  const barZ = Number(
    /z-index:\s*(\d+)/.exec(sliceBetween(TOKENS_CSS_CODE, '.rb-nav--mobile {', '}'))?.[1]
  );
  assert.ok(skipZ > barZ, `skip link z-index ${skipZ} must clear the mobile bar ${barZ}`);

  // Fixed positioning is not clipped by ancestor overflow, and no shell
  // ancestor declares any (test 26). The target is unchanged.
  assert.match(renderShell('/'), new RegExp(`<a class="rb-skip-link" href="#${MAIN_LANDMARK_ID}">`));
});

test('32. LoadingSkeleton normalises an unusable line count', () => {
  const bars = (html: string) => (html.match(/rb-skeleton__bar/g) ?? []).length;

  // Ordinary values are untouched.
  assert.equal(bars(renderToStaticMarkup(h(LoadingSkeleton, { lines: 5 }))), 5);
  assert.equal(bars(renderToStaticMarkup(h(LoadingSkeleton, null))), DEFAULT_SKELETON_LINES);
  assert.equal(bars(renderToStaticMarkup(h(LoadingSkeleton, { lines: 3.7 }))), 3);

  // Zero or negative still shows a loading state rather than nothing.
  assert.equal(bars(renderToStaticMarkup(h(LoadingSkeleton, { lines: 0 }))), 1);
  assert.equal(bars(renderToStaticMarkup(h(LoadingSkeleton, { lines: -4 }))), 1);

  // A count derived from data can be non-finite even where the type says
  // `number`; without normalisation that renders an empty container, which
  // reads as a blank region rather than as loading.
  for (const unusable of [NaN, Infinity, -Infinity]) {
    const html = renderToStaticMarkup(h(LoadingSkeleton, { lines: unusable }));
    assert.equal(bars(html), DEFAULT_SKELETON_LINES, `lines=${unusable} must fall back`);
    assert.match(html, /role="status"/, 'the loading state is still announced');
  }
});

/* ============ 33-34. production route resolution and active contrast ====== */

test('33. resolveActivePathname covers the production detection path', () => {
  // Every behavioural active-route test supplies an explicit override, and
  // `usePathname()` yields null outside a router context — so without this
  // pure seam, code that ignored the detected value would still pass the whole
  // suite while dropping aria-current on every real page.

  // 1. undefined override defers to the detected path.
  assert.equal(resolveActivePathname(undefined, '/leaderboard'), '/leaderboard');
  assert.equal(resolveActivePathname(undefined, null), null);

  // 2. a string override wins over the detected path.
  assert.equal(resolveActivePathname('/results-audit', '/leaderboard'), '/results-audit');
  assert.equal(resolveActivePathname('/', '/leaderboard'), '/');

  // 3. an explicit null is a deliberate "nothing active", not a fallback.
  assert.equal(resolveActivePathname(null, '/leaderboard'), null);

  // 4. the component actually consumes the hook result through the resolver.
  assert.match(NAV_SRC, /const detected = usePathname\(\);/);
  assert.match(NAV_SRC, /resolveActivePathname\(pathname, detected\)/);
  assert.equal(
    /const current = pathname\b/.test(NAV_SRC),
    false,
    'the detected route must not be bypassed'
  );
});

test('33b. resolved routes match exactly, by descendant, query and trailing slash', () => {
  // The resolver feeds the matcher; this is the pair the pages actually rely on.
  const activeFor = (detected: string | null) =>
    PRIMARY_DESTINATIONS.filter((d) =>
      isNavDestinationActive(resolveActivePathname(undefined, detected), d.href)
    ).map((d) => d.href);

  assert.deepEqual(activeFor('/'), ['/']);
  assert.deepEqual(activeFor('/how-it-works'), ['/how-it-works']);
  assert.deepEqual(activeFor('/how-it-works/detail'), ['/how-it-works'], 'descendant');
  assert.deepEqual(activeFor('/leaderboard/'), ['/leaderboard'], 'trailing slash');
  assert.deepEqual(activeFor('/results-audit?date=2026-07-28'), ['/results-audit'], 'query');
  assert.deepEqual(activeFor('/results-audit#top'), ['/results-audit'], 'hash');
  assert.deepEqual(activeFor('/leaderboards'), [], 'no false prefix match');
  assert.deepEqual(activeFor(null), [], 'unknown route activates nothing');

  // Overview never prefix-matches another route.
  for (const detected of ['/how-it-works', '/leaderboard', '/results-audit']) {
    assert.equal(activeFor(detected).includes('/'), false, `Overview active on ${detected}`);
  }
});

/** Parses an `rgba()`/`rgb()` token into channels plus alpha. */
function parseRgba(value: string): { r: number; g: number; b: number; a: number } {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/.exec(value);
  assert.ok(match, `expected an rgba() colour, got: ${value}`);
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** Flattens a translucent overlay onto an opaque #rrggbb base. */
function compositeOver(overlay: string, baseHex: string): string {
  const top = parseRgba(overlay);
  const base = [1, 3, 5].map((i) => parseInt(baseHex.slice(i, i + 2), 16));
  const mixed = [top.r, top.g, top.b].map((channel, i) =>
    Math.round(top.a * channel + (1 - top.a) * base[i])
  );
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

test('34. the active mobile divider clears 3:1 over the composited selected fill', () => {
  const active = sliceBetween(
    TOKENS_CSS_CODE,
    ".rb-nav--mobile .rb-nav__link[aria-current='page'] {",
    '}'
  );

  // The divider on the active item is darkened deliberately: the translucent
  // selected fill lifts the surface luminance and drops --rb-border-strong
  // below 3:1 on this one edge.
  assert.match(active, /border-left-color:\s*var\(--rb-text-muted\)/);

  // The other selected-state indicators are unchanged: accent rail, fill, and
  // — from the shared rule — underline and weight, so the current destination
  // is never signalled by colour alone.
  assert.match(active, /border-top-color:\s*var\(--rb-accent-analytical\)/);
  assert.match(active, /background:\s*var\(--rb-state-selected\)/);
  const shared = sliceBetween(TOKENS_CSS_CODE, ".rb-nav__link[aria-current='page'] {", '}');
  assert.match(shared, /text-decoration:\s*underline/);
  assert.match(shared, /font-weight:\s*700/);
  assert.match(shared, /box-shadow:\s*var\(--rb-shadow-inset\)/);

  // Computed, not asserted from memory: composite the selected fill over the
  // bar surface, then measure the divider against that.
  for (const [scheme, tokens] of [
    ['light', lightTokens()],
    ['dark', darkTokens()],
  ] as const) {
    const fill = tokens['--rb-state-selected'];
    assert.ok(parseRgba(fill).a < 1, `${scheme} selected fill must be translucent`);

    const composited = compositeOver(fill, tokens['--rb-surface-raised']);
    const ratio = contrast(tokens['--rb-text-muted'], composited);
    assert.ok(
      ratio >= 3,
      `${scheme} active divider is ${ratio.toFixed(2)}:1 on ${composited} — below 3:1`
    );

    // And the untreated token really would have failed here — which is why the
    // override exists. If this ever stops being true, the override is dead code.
    const untreated = contrast(tokens['--rb-border-strong'], composited);
    assert.ok(
      untreated < ratio,
      `${scheme}: the override must improve on --rb-border-strong (${untreated.toFixed(2)}:1)`
    );
  }
});

/* ===================== 29. no runtime dependency was added ================= */

test('29. no runtime dependency is added by this slice', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@supabase/supabase-js',
    'next',
    'react',
    'react-dom',
  ]);
  // The tokens file is hand-written CSS: no framework, no icon or font import.
  assert.equal(/@import|@tailwind|tailwind|bootstrap|fonts\.googleapis/i.test(TOKENS_CSS), false);
  assert.equal(/url\(/.test(TOKENS_CSS), false, 'no remote asset is referenced');
  // The system font stack means no font dependency.
  assert.match(TOKENS_CSS, /--rb-font-system:\s*\n?\s*system-ui/);
});

/* ============ slice boundary: the shell is not wired into production ======= */

test('slice 1 wires only the tokens stylesheet; the shell is not yet mounted', () => {
  const layout = readFileSync('src/app/layout.tsx', 'utf8');
  assert.match(layout, /import '@\/styles\/tokens\.css';/);
  // Mounting AppShell here would nest <main> inside every page's own <main>.
  assert.equal(/AppShell/.test(layout), false, 'shell adoption happens in slice 2');

  // The existing dashboard is untouched by this slice.
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.equal(/AppShell|UiPrimitives|tokens\.css/.test(page), false);
});
