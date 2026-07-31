/**
 * Slice 3D.1 — homepage legacy-light contrast containment.
 *
 * The dashboard is still a legacy light-only design: hard-coded light surfaces
 * (`#fff`, `#f6f8fa`, tinted banners) carrying hard-coded dark foregrounds.
 * Once it adopted AppShell it began rendering inside `.rb-app`, whose
 * background follows `--rb-bg-app` and therefore turns `#12161c` under
 * `prefers-color-scheme: dark`. Text inheriting `styles.page`'s `#1f2328` then
 * fell to ~1.15:1.
 *
 * The containment is a fixed opaque light surface on the page wrapper, so every
 * existing foreground stays on the light background it was measured against in
 * BOTH schemes. This file pins that arrangement and — just as importantly —
 * pins the invariant that makes it safe: NO dark-aware token foreground may
 * enter this page while its child surfaces are still hard-coded light.
 *
 * This is contrast containment and a transitional treatment. It is not dark-mode
 * support, not a completed token migration, and not the final visual design.
 *
 * This file reads source and CSS text only. It opens no database, calls no
 * provider, runs no model, creates no lock and settles no result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE_SRC = readFileSync('src/app/page.tsx', 'utf8');
const TOKENS_CSS = readFileSync('src/styles/tokens.css', 'utf8');

/**
 * Source with comments removed, for assertions about what the code DOES.
 * The page's own explanatory comments legitimately quote the values and token
 * names they explain, and a structural assertion must not read those as code.
 */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PAGE_CODE = codeOf(PAGE_SRC);

/**
 * The comment-stripped body of a top-level function in `page.tsx`, bounded to
 * that function alone.
 *
 * Two surfaces this file must check are produced by functions rather than by
 * entries in the `styles` object, so a page-wide match would let a colour
 * declared anywhere else satisfy the contract. Searching for the name WITH its
 * opening parenthesis keeps `liveBarStyle` distinct from `liveDotStyle`, and
 * closing on a newline followed by a column-0 brace ends at the function's own
 * closing brace — every brace inside these bodies is indented.
 */
function functionBody(name: string): string {
  const start = PAGE_CODE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist in page.tsx`);
  const end = PAGE_CODE.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} must have a bounded body`);
  return PAGE_CODE.slice(start, end + 2);
}

/* ========================================================================== *
 * WCAG 2.1 contrast — same methodology as scripts/appShell.test.ts
 * ========================================================================== */

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

/** WCAG AA floor for normal-sized body text. */
const AA_NORMAL_TEXT = 4.5;

/**
 * Reads a custom property from the FIRST `:root` block — the light scheme.
 * The dark scheme is a later `:root` nested inside a media query, so slicing at
 * the media query keeps the two apart.
 */
function lightToken(name: string): string {
  const darkAt = TOKENS_CSS.indexOf('@media (prefers-color-scheme: dark)');
  assert.notEqual(darkAt, -1, 'a dark scheme must be defined');
  const lightBlock = TOKENS_CSS.slice(0, darkAt);
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(lightBlock);
  assert.ok(match, `${name} must be defined in the light :root block`);
  return match[1].toLowerCase();
}

/** Reads a custom property from the dark-scheme block. */
function darkToken(name: string): string {
  const darkAt = TOKENS_CSS.indexOf('@media (prefers-color-scheme: dark)');
  assert.notEqual(darkAt, -1, 'a dark scheme must be defined');
  const darkBlock = TOKENS_CSS.slice(darkAt);
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(darkBlock);
  assert.ok(match, `${name} must be defined in the dark scheme`);
  return match[1].toLowerCase();
}

/** The containment surface, as the page actually declares it. */
const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';

/* ========================================================================== *
 * 1-3. the containment surface and its relationship to the token
 * ========================================================================== */

test('1. LEGACY_LIGHT_PAGE_SURFACE exists and is the expected fixed literal', () => {
  assert.match(
    PAGE_CODE,
    /const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';/,
    'the containment surface must be a named module-level constant'
  );
});

test('2. the LIGHT --rb-bg-app token is #e7ebf1', () => {
  assert.equal(lightToken('--rb-bg-app'), LEGACY_LIGHT_PAGE_SURFACE);
});

test('3. the constant matches the light --rb-bg-app value (drift detector)', () => {
  /*
   * The constant is deliberately a FIXED literal and does not track the token
   * at runtime — it has to stay light when the token goes dark. This assertion
   * exists so the two cannot silently diverge: if the design system ever
   * restyles its light application background, this fails and the containment
   * surface is re-decided deliberately rather than drifting out of alignment.
   */
  assert.equal(
    LEGACY_LIGHT_PAGE_SURFACE,
    lightToken('--rb-bg-app'),
    'containment surface has drifted from the light --rb-bg-app value'
  );
});

/* ========================================================================== *
 * 4-6. styles.page keeps its existing geometry and gains only a background
 * ========================================================================== */

test('4. styles.page uses the named containment surface as its background', () => {
  assert.match(
    PAGE_CODE,
    /background: LEGACY_LIGHT_PAGE_SURFACE,/,
    'the wrapper must be opaque, via the named constant rather than a literal'
  );
});

test('5. styles.page still declares its legacy dark foreground', () => {
  /*
   * `#1f2328` is what every hard-coded light child surface inherits. Migrating
   * it to a dark-aware token WITHOUT migrating those surfaces is precisely the
   * unsafe half-migration this tranche exists to avoid.
   */
  assert.match(PAGE_CODE, /color: '#1f2328',/, 'styles.page keeps its legacy foreground');
});

test('6. styles.page still declares maxWidth: 820', () => {
  // Also pinned by appShellAdoption test 29a; restated here so a change to the
  // page frame fails in the tranche that owns the page frame.
  assert.match(PAGE_CODE, /maxWidth: 820,/);
});

/* ========================================================================== *
 * 7. the invariant that makes the containment safe
 * ========================================================================== */

test('7. no dark-aware token foreground exists anywhere in the homepage', () => {
  /*
   * TEMPORARY COMPATIBILITY INVARIANT — READ BEFORE CHANGING.
   *
   * Every `--rb-text-*`, `--rb-status-*` and `--rb-accent-*` token flips to a
   * LIGHT value in the dark scheme. This page still renders hard-coded light
   * child surfaces, so any such foreground would land light-on-light there:
   * `--rb-text-primary` on `#fff` is ~1.13:1, `--rb-text-secondary` ~1.80:1,
   * `--rb-text-muted` ~2.96:1, `--rb-status-positive` ~2.30:1.
   *
   * SCOPE: this prohibits a foreground token LITERAL in `page.tsx` — a colour
   * this page applies to text while owning no matching surface.
   *
   * It does NOT prohibit token-driven primitives. Since slice 3D.2 the message
   * states render via `UiPrimitives`, whose `rb-state` / `rb-skeleton` classes
   * carry a paired surface AND foreground together in `tokens.css`. Those never
   * inherit `styles.page`'s legacy `#1f2328` and never rely on the containment
   * surface, so the failure mode above cannot occur — which is exactly why they
   * were authorised while this assertion stands.
   *
   * This assertion MUST be deliberately superseded — not silently re-anchored
   * or weakened — by the later tranche that begins PAIRED regional
   * foreground/surface migration of the page's OWN inline styles. At that point
   * it should be narrowed to the regions still unmigrated, never simply deleted
   * while legacy light surfaces remain.
   */
  for (const forbidden of ['var(--rb-text-', 'var(--rb-status-', 'var(--rb-accent-']) {
    assert.equal(
      PAGE_SRC.includes(forbidden),
      false,
      `${forbidden} must not appear while hard-coded light child surfaces remain`
    );
  }
});

/* ========================================================================== *
 * 8-12. page-surface muted text, without disturbing panel-contained muted text
 * ========================================================================== */

test('8. styles.muted is unchanged', () => {
  assert.match(PAGE_CODE, /muted: \{\s*color: '#656d76',\s*\} as CSSProperties,/);
});

test('9-11. the message states render via primitives, and pageMuted is gone (slice 3D.2)', () => {
  /*
   * SUPERSEDES the slice 3D.1 contracts that required `styles.pageMuted` to be
   * `#59626f` and to have exactly two call sites.
   *
   * `pageMuted` existed solely because `styles.muted`'s `#656d76` reached only
   * ~4.39:1 against the containment surface at those two sites. Slice 3D.2
   * moved both states onto `LoadingSkeleton` and `EmptyState`, which bring their
   * own paired surface and foreground, so no page-owned foreground sits on the
   * containment surface there at all and the style key became dead code.
   *
   * The twelve panel-contained `styles.muted` uses are untouched — see test 12.
   */
  assert.match(PAGE_CODE, /<LoadingSkeleton lines=\{4\} label="Loading recommendations" \/>/);
  assert.match(PAGE_CODE, /<EmptyState title="No races yet" level=\{2\}>/);
  assert.match(PAGE_CODE, /<ErrorState\s+title="Recommendations unavailable"/);

  assert.equal(/styles\.pageMuted/.test(PAGE_CODE), false, 'the dead style key is removed');
  assert.equal(/#59626f/.test(PAGE_SRC), false, 'and its literal no longer appears');

  // The superseded bare paragraphs are gone.
  assert.equal(/<p style=\{styles\.muted\}>Loading recommendations…/.test(PAGE_CODE), false);
  assert.equal(
    /<p style=\{styles\.muted\}>No races available for this day yet\./.test(PAGE_CODE),
    false
  );
});

test('12. exactly twelve styles.muted uses remain after the two page-level states move', () => {
  /*
   * SCOPE OF THIS ASSERTION. It proves the COUNT and therefore non-migration:
   * `styles.muted` had fourteen uses; the two direct page-surface states moved
   * away (to `pageMuted` in slice 3D.1, then onto the message-state primitives
   * in 3D.2), and twelve are still present. A blanket literal replacement would
   * have emptied this count and broken all twelve in the dark scheme, so the
   * number is the guard.
   *
   * It does NOT independently establish each one's containing surface. That
   * those twelve sit inside `#fff` or `#f6f8fa` panels — where `#656d76`
   * already clears 4.5:1 (5.25:1 on white, 4.93:1 on `#f6f8fa`) — was
   * confirmed by inspection when the tranche was written, not by this test.
   */
  const remaining = [...PAGE_CODE.matchAll(/styles\.muted/g)];
  assert.equal(remaining.length, 12, 'exactly the twelve panel-contained uses remain');
});

/* ========================================================================== *
 * 13. the removal condition is recorded
 * ========================================================================== */

test('13. the temporary removal condition is documented at the constant', () => {
  const at = PAGE_SRC.indexOf('const LEGACY_LIGHT_PAGE_SURFACE');
  assert.notEqual(at, -1, 'the constant must exist');
  // The doc block sits immediately above the declaration.
  const docBlock = PAGE_SRC.slice(Math.max(0, at - 2600), at);
  assert.match(docBlock, /REMOVAL CONDITION/, 'a removal condition must be stated');
  assert.match(docBlock, /TEMPORARY|TRANSITIONAL/, 'the measure must be marked temporary');
  assert.match(
    docBlock,
    /paired|PAIRED/,
    'the removal condition must name paired foreground/surface migration'
  );
});

/* ========================================================================== *
 * 14-15. measured contrast
 * ========================================================================== */

test('14. the migrated page-surface foregrounds clear 4.5:1 on the containment surface', () => {
  /*
   * `#59626f` was dropped from this table by slice 3D.2: `styles.pageMuted` no
   * longer exists, because the two states that used it now render via
   * primitives that own their surface as well as their foreground.
   */
  const pairs: [string, string][] = [
    ['#1f2328', 'inherited page text (h1, nav prompt)'],
    ['#57606a', 'intro paragraph'],
  ];
  for (const [fg, what] of pairs) {
    const ratio = contrast(fg, LEGACY_LIGHT_PAGE_SURFACE);
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `${what}: ${fg} on ${LEGACY_LIGHT_PAGE_SURFACE} is ${ratio.toFixed(2)}:1`
    );
  }
});

test('14c. KNOWN SHORTFALL — one legacy foreground remains just below AA', () => {
  /*
   * NOT FIXED IN THIS TRANCHE, AND DELIBERATELY SO.
   *
   * `#0969da` (race-day nav secondary links) lands at ~4.34:1 on the containment
   * surface — short of the 4.5:1 normal-text floor. It is a PRE-EXISTING legacy
   * value, and containment strictly IMPROVED it (from ~3.50:1 in the uncontained
   * dark scheme), so it is not a regression; it simply is not yet over the line.
   * Changing a link colour is a palette decision belonging to the NAVIGATION
   * visual tranche, which owns that region and its surface together.
   *
   * `#cf222e` WAS on this list and has been REMOVED — resolved, not merely
   * moved. Slice 3D.2 replaced the inline error paragraph with `ErrorState`,
   * whose text is `--rb-text-primary` / `--rb-text-secondary` on
   * `--rb-surface-raised` (both proven >= 4.5:1 in each scheme by
   * appShell.test.ts 18/18c). The failure colour now appears only as a border,
   * where it also clears 4.5:1 — far above the 3:1 non-text floor. The failing
   * TEXT pair no longer exists.
   *
   * `#cf222e` itself is NOT globally removed: `EV_NEGATIVE_COLOR` still colours
   * EV, profit/loss and ROI figures, all of which sit inside white or `#f6f8fa`
   * panels rather than on the containment surface.
   *
   * Pinning the measured value means it cannot silently WORSEN, and the upper
   * bound makes this test fail — prompting its own deletion — once the
   * navigation tranche legitimately fixes it.
   */
  for (const [fg, what, floor] of [
    ['#0969da', 'race-day nav secondary links', 4.3],
  ] as const) {
    const ratio = contrast(fg, LEGACY_LIGHT_PAGE_SURFACE);
    assert.ok(ratio >= floor, `${what} regressed: ${fg} is now ${ratio.toFixed(2)}:1`);
    assert.ok(
      ratio < AA_NORMAL_TEXT,
      `${what} now clears AA at ${ratio.toFixed(2)}:1 — remove it from this known-shortfall list`
    );
    // Containment must never make a pair worse than the dark scheme it replaced.
    assert.ok(
      ratio > contrast(fg, darkToken('--rb-bg-app')),
      `${what}: containment must improve on the uncontained dark pairing`
    );
  }
});

test('15. the containment is demonstrably necessary (pre-fix failure)', () => {
  /*
   * Evidence of the defect being contained, NOT an accepted post-fix pair.
   * Without the opaque surface the wrapper is transparent over `.rb-app`, whose
   * dark background puts the inherited page foreground far below the floor.
   */
  const ratio = contrast('#1f2328', darkToken('--rb-bg-app'));
  assert.ok(
    ratio < AA_NORMAL_TEXT,
    `expected the uncontained pair to fail, but it was ${ratio.toFixed(2)}:1`
  );
  assert.ok(ratio < 2, `the uncontained pair should be severe; got ${ratio.toFixed(2)}:1`);
});

/* ========================================================================== *
 * 16. no unsafe half-migration of the child surfaces
 * ========================================================================== */

test('16. the seven legacy light/tinted surfaces inheriting the page foreground remain unchanged', () => {
  /*
   * SCOPE OF THIS ASSERTION. It owns exactly the surfaces that BOTH declare
   * their own light or tinted background AND declare no `color`, so their
   * descendants inherit `styles.page`'s `#1f2328`. There are seven: five
   * entries in the `styles` object, plus the two function-generated surfaces
   * checked below.
   *
   * That pairing is what makes them the safety-critical set. If a later edit
   * flips any of them to a dark-aware token surface while the inherited
   * foreground stays `#1f2328`, the result is dark-on-dark — the inverse of the
   * defect this tranche fixes. Pinning them proves the migration stayed paired:
   * this tranche changed the wrapper only.
   *
   * Deliberately NOT in scope: surfaces that declare their own foreground
   * (`safetyBannerStyle`, `favBadge`, `freshStale`, `tipsterStatusCount`, the
   * Beta badge, `raceDayPrimaryButtonStyle`, `nextActionCmd`) and the imported
   * panel components. Those cannot be broken by a change to the inherited
   * foreground, so they belong to the tranches that migrate them.
   */
  for (const [key, background] of [
    ['card', "'#fff'"],
    ['panel', "'#fff'"],
    ['nextRace', "'#fff'"],
    ['accuracyBar', "'#f6f8fa'"],
    ['perfPanel', "'#f6f8fa'"],
  ] as const) {
    const at = PAGE_CODE.indexOf(`${key}: {`);
    assert.notEqual(at, -1, `styles.${key} must exist`);
    const block = PAGE_CODE.slice(at, PAGE_CODE.indexOf('} as CSSProperties,', at));
    assert.ok(
      block.includes(`background: ${background}`),
      `styles.${key} must still declare its legacy background ${background}`
    );
    assert.equal(
      /\bcolor:/.test(block),
      false,
      `styles.${key} must not declare a foreground in this tranche — it inherits`
    );
  }

  /*
   * Surfaces 6 and 7 are produced by functions, so each is checked against its
   * own bounded body. Both branches / all three tones are pinned: a partial
   * migration that converted only one branch would still leave an inherited
   * `#1f2328` on a token surface in the other.
   */
  const liveBar = functionBody('liveBarStyle');
  assert.ok(
    liveBar.includes("background: scoped ? '#eafff1' : '#f6f8fa'"),
    'liveBarStyle must retain both legacy background branches'
  );
  assert.equal(
    /\bcolor:/.test(liveBar),
    false,
    'liveBarStyle must not declare a foreground in this tranche — it inherits'
  );

  const nextAction = functionBody('nextActionStyle');
  for (const [tone, bg] of [
    ['pos', "'#eafff1'"],
    ['warn', "'#fff8c5'"],
    ['neutral', "'#f6f8fa'"],
  ] as const) {
    assert.ok(
      nextAction.includes(`${tone}: { bg: ${bg},`),
      `nextActionStyle must retain its legacy ${tone} background ${bg}`
    );
  }
  assert.equal(
    /\bcolor:/.test(nextAction),
    false,
    'nextActionStyle must not declare a foreground in this tranche — it inherits'
  );

  /*
   * Guards the extractor itself: `liveDotStyle` sits immediately after
   * `liveBarStyle` and is a DOT, not a surface. If the bounded slice ever
   * over-ran into it, this would start matching and the liveBarStyle body would
   * no longer be what it claims to be.
   */
  assert.equal(
    liveBar.includes('function liveDotStyle'),
    false,
    'the liveBarStyle slice must not over-run into liveDotStyle'
  );
});
