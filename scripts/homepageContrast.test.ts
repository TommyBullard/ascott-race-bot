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

/**
 * A single entry of the module-level `styles` object, bounded to itself.
 *
 * Searching for `<key>: {` and closing on the first `} as CSSProperties,` after
 * it keeps each entry separate. The keys are distinguishable by case: `panel:`
 * never matches `perfPanel:` or `explanationPanel:`, and `card:` never matches
 * `cardList:`.
 */
function styleBlock(key: string): string {
  const at = PAGE_CODE.indexOf(`${key}: {`);
  assert.notEqual(at, -1, `styles.${key} must exist`);
  const end = PAGE_CODE.indexOf('} as CSSProperties,', at);
  assert.ok(end > at, `styles.${key} must be a bounded block`);
  return PAGE_CODE.slice(at, end);
}

/**
 * One CSS rule body from `tokens.css`, bounded to itself.
 *
 * Rules in this stylesheet are written one selector per block with the closing
 * brace at column 0, so the first `\n}` after the opening is the rule's own.
 */
function cssRule(selector: string): string {
  const start = TOKENS_CSS.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} must be defined in tokens.css`);
  const end = TOKENS_CSS.indexOf('\n}', start);
  assert.ok(end > start, `${selector} must be a bounded rule`);
  return TOKENS_CSS.slice(start, end + 2);
}

/** The containment surface, as the page actually declares it. */
const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';

/**
 * The legacy primary foreground. `styles.page` is the ORIGINAL anchor: every
 * light child surface inherited this value from it until slice 3D.4a made that
 * inheritance explicit on five of them.
 */
const LEGACY_PRIMARY_FOREGROUND = "color: '#1f2328'";

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

test('5. the styles.page block itself still declares the legacy dark foreground', () => {
  /*
   * BOUNDED ON PURPOSE. This assertion used to match `color: '#1f2328'` across
   * the whole page source. That was unambiguous while the literal appeared
   * twice, but slice 3D.4a added it to five summary/status surfaces — seven
   * occurrences in total — so a page-wide match would now be satisfied by any
   * of them even if `styles.page` had lost its own foreground entirely.
   *
   * `styles.page` is the anchor the other five reproduce, so it is checked
   * inside its own block, together with the two other properties that define
   * the compatibility frame.
   *
   * `#1f2328` is what every remaining hard-coded light child surface still
   * inherits. Migrating it to a dark-aware token WITHOUT migrating those
   * surfaces is precisely the unsafe half-migration the containment prevents.
   */
  const page = styleBlock('page');
  assert.ok(
    page.includes(LEGACY_PRIMARY_FOREGROUND),
    'styles.page keeps its legacy foreground'
  );
  assert.ok(
    page.includes('background: LEGACY_LIGHT_PAGE_SURFACE'),
    'styles.page keeps the named containment surface'
  );
  assert.ok(page.includes('maxWidth: 820'), 'styles.page keeps its container width');
});

test('5b. the remaining explicit foregrounds reproduce the styles.page anchor', () => {
  /*
   * SOURCE-LEVEL EQUIVALENCE, NOT A COMPUTED-STYLE COMPARISON.
   *
   * Before slice 3D.4a these five surfaces declared no `color` and inherited
   * their primary foreground from `styles.page`. 3D.4a makes that inheritance
   * explicit. Asserting each bounded block against the SAME constant that
   * `styles.page` uses is what proves the explicit declarations reproduce the
   * previously inherited value rather than merely happening to look similar —
   * repeating the literal independently in six places would prove nothing.
   *
   * A later paired visual migration must update each region deliberately. It
   * must not change this shared legacy anchor as a side effect: doing so would
   * silently desynchronise the five regions from the frame they were derived
   * from, and this test is what makes that fail.
   *
   * This is a source contract. It does not compare browser-computed styles.
   */
  const page = styleBlock('page');
  assert.ok(page.includes(LEGACY_PRIMARY_FOREGROUND), 'the anchor must hold first');

  /*
   * The set SHRINKS as regions migrate — that is the shape of the programme.
   * `nextActionStyle` left in slice 3D phase 1; `accuracyBar` and `perfPanel`
   * left in evidence-migration part 1. Each now owns a paired token surface,
   * so there is no legacy foreground left to reconcile for them. `styles.panel`
   * (the tipster panels) is the only object-style entry still on the anchor.
   */
  assert.ok(
    styleBlock('panel').includes(LEGACY_PRIMARY_FOREGROUND),
    'styles.panel must declare the same foreground as styles.page'
  );
  assert.ok(
    functionBody('liveBarStyle').includes(LEGACY_PRIMARY_FOREGROUND),
    'liveBarStyle must declare the same foreground as styles.page'
  );

  // The migrated regions must NOT reacquire a legacy foreground.
  for (const key of ['accuracyBar', 'perfPanel'] as const) {
    assert.equal(
      styleBlock(key).includes(LEGACY_PRIMARY_FOREGROUND),
      false,
      `styles.${key} is paired via rb-evidence-panel and must not re-declare the legacy colour`
    );
  }

  assert.equal(
    /function nextActionStyle\(/.test(PAGE_CODE),
    false,
    'nextActionStyle was superseded by the rb-status-frame classes'
  );
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
  assert.equal(remaining.length, 10, 'exactly the ten remaining legacy uses');
});

test('12b. the styles.muted fork moved exactly the two summary-surface sites', () => {
  /*
   * WHY THE FORK EXISTS.
   *
   * `styles.muted` (`#656d76`) is safe on the legacy `#fff` tipster panels but
   * NOT on a migrated token surface. Conversely `--rb-text-muted` resolves to
   * `#8d97a5` in dark, which on the retained legacy white tipster surface is
   * ~2.96:1 — below the 4.5:1 floor. The two colours therefore cannot serve
   * both regimes, and a blanket replacement would break the tipster panels.
   *
   * Evidence-migration part 1 moved exactly the TWO sites that now sit on
   * `rb-evidence-panel` (AccuracyBar's and PerformancePanel's zero-state
   * messages). The other ten stay legacy: eight in the race-card regions that
   * part 2 migrates, and two in the tipster panels that wait for their own
   * tranche.
   */
  assert.equal(
    [...PAGE_CODE.matchAll(/styles\.muted/g)].length,
    10,
    'ten legacy uses remain'
  );

  // The migrated summary surfaces no longer reference the legacy muted style.
  for (const region of ['AccuracyBar', 'PerformancePanel'] as const) {
    const body = functionBody(region);
    assert.equal(
      body.includes('styles.muted'),
      false,
      `${region} must not use the legacy muted style on its token surface`
    );
    assert.ok(
      body.includes('rb-evidence-muted'),
      `${region} must use the token-backed muted class`
    );
  }
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

/*
 * SLICE 3D.4a SPLIT THE FORMER SEVEN-SURFACE SET.
 *
 * Until 3D.4a, seven surfaces declared a light or tinted background and NO
 * `color`, so their descendants inherited `styles.page`'s `#1f2328`. That
 * inheritance is what made them the safety-critical set: flipping any of them
 * to a dark-aware token surface while the foreground stayed `#1f2328` produces
 * dark-on-dark, the inverse of the defect the containment surface fixes.
 *
 * 3D.4a made the FIVE summary/status surfaces explicitly self-contained by
 * declaring the very foreground they already inherited. It is a
 * zero-computed-colour-change enabling tranche:
 *
 *   - it makes inheritance EXPLICIT, nothing more;
 *   - every computed colour, background, border and geometry is preserved;
 *   - it does NOT migrate these surfaces to tokens;
 *   - it prepares each region for a later PAIRED foreground/surface migration,
 *     which can now change a surface without stranding an inherited colour.
 *
 * Two surfaces remain inheriting and are deliberately deferred to the tranches
 * that own them: `styles.card` (race cards) and `styles.nextRace` (Next Race).
 *
 * Still out of scope entirely: surfaces that already declared their own
 * foreground (`safetyBannerStyle`, `favBadge`, `freshStale`,
 * `tipsterStatusCount`, the Beta badge, `raceDayPrimaryButtonStyle`,
 * `nextActionCmd`) and the imported panel components.
 */

test('16a. the remaining legacy summary/status surfaces are explicitly self-contained', () => {
  /*
   * `accuracyBar` and `perfPanel` LEFT this set in evidence-migration part 1 —
   * they now own paired token surfaces via `rb-evidence-panel`. Test 18 owns
   * that migration. `styles.panel` (tipster) is the only object-style surface
   * still legacy and self-contained.
   */
  for (const [key, background] of [['panel', "'#fff'"]] as const) {
    const block = styleBlock(key);

    // Background and border survive verbatim — this tranche changed no colour.
    assert.ok(
      block.includes(`background: ${background}`),
      `styles.${key} must still declare its legacy background ${background}`
    );
    assert.ok(
      block.includes("border: '1px solid #d0d7de'"),
      `styles.${key} must still declare its legacy border`
    );

    // ...and it now owns the foreground it previously inherited.
    assert.ok(
      block.includes(LEGACY_PRIMARY_FOREGROUND),
      `styles.${key} must declare the explicit legacy foreground`
    );

    // No token foreground was smuggled in alongside it.
    for (const forbidden of ['var(--rb-text-', 'var(--rb-status-', 'var(--rb-accent-']) {
      assert.equal(block.includes(forbidden), false, `styles.${key} must not use ${forbidden}`);
    }
  }

  /*
   * The two function-generated surfaces, each bounded to its own body. Every
   * branch and tone is pinned: a partial change that converted only one would
   * still strand an inherited `#1f2328` on the others.
   */
  const liveBar = functionBody('liveBarStyle');
  assert.ok(
    liveBar.includes("background: scoped ? '#eafff1' : '#f6f8fa'"),
    'liveBarStyle must retain both legacy background branches'
  );
  assert.ok(
    liveBar.includes("border: `1px solid ${scoped ? '#aceebb' : '#d0d7de'}`"),
    'liveBarStyle must retain both legacy border branches'
  );
  assert.ok(
    liveBar.includes(LEGACY_PRIMARY_FOREGROUND),
    'liveBarStyle must declare the explicit legacy foreground'
  );

  /*
   * `nextActionStyle` left this set in slice 3D phase 1 — its region migrated
   * to the paired `rb-status-frame` classes, so it is no longer a legacy
   * self-contained surface. Test 17 owns that migration; test 16a now covers
   * FOUR legacy surfaces, not five.
   */
  for (const forbidden of ['var(--rb-text-', 'var(--rb-status-', 'var(--rb-accent-']) {
    assert.equal(
      liveBar.includes(forbidden),
      false,
      `liveBarStyle must not use ${forbidden}`
    );
  }

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

test('16b. two legacy surfaces still inherit the page foreground (deferred)', () => {
  /*
   * `styles.card` and `styles.nextRace` are INTENTIONALLY left inheriting.
   * They belong to the race-card and Next Race tranches, which own their
   * regions' text as well as their surfaces and can therefore migrate the pair
   * together. Until then they must keep both properties: the legacy background,
   * and no foreground of their own.
   */
  for (const [key, background] of [
    ['card', "'#fff'"],
    ['nextRace', "'#fff'"],
  ] as const) {
    const block = styleBlock(key);
    assert.ok(
      block.includes(`background: ${background}`),
      `styles.${key} must still declare its legacy background ${background}`
    );
    assert.equal(
      /\bcolor:/.test(block),
      false,
      `styles.${key} still inherits — its tranche has not run yet`
    );
  }
});

test('18. the summary surfaces are paired token regions (evidence migration part 1)', () => {
  /*
   * PART 1 SCOPE: AccuracyBar and PerformancePanel only. Both now sit on
   * `rb-evidence-panel`, which declares a token surface AND a token foreground,
   * so nothing inside inherits a colour that might not match it.
   *
   * The race-card regions are deliberately NOT migrated here and keep
   * `evColorStyle`, `CONFIDENCE_COLORS` and `componentColor` on their legacy
   * `#fff` surface. Two semantic helpers therefore coexist ON PURPOSE. That is
   * not a partial pairing: each helper is used exclusively inside a region that
   * owns a matching surface regime, so neither ever puts a dark-aware token
   * colour on a legacy light surface (~2.30:1) nor a legacy colour on a token
   * surface (~2.92:1). Part 2 retires the legacy pair.
   */
  const panel = cssRule('.rb-evidence-panel');
  assert.match(panel, /background: var\(--rb-surface-[a-z]+\)/, 'token surface');
  assert.match(panel, /color: var\(--rb-text-primary\)/, 'paired token foreground');

  /*
   * Only the classes part 1 actually renders. A `.rb-evidence-secondary` was
   * drafted and removed: no production consumer existed, and asserting an
   * unused class here would have implied a wiring that was not there.
   */
  for (const [cls, token] of [
    ['.rb-evidence-muted', '--rb-text-muted'],
    ['.rb-ev--positive', '--rb-status-positive'],
    ['.rb-ev--negative', '--rb-status-failure'],
    ['.rb-ev--neutral', '--rb-text-secondary'],
  ] as const) {
    assert.match(cssRule(cls), new RegExp(`color: var\\(${token}\\)`), `${cls} uses ${token}`);
  }

  // Every class this tranche defines must have a production consumer.
  for (const cls of [
    'rb-evidence-panel',
    'rb-evidence-muted',
    'rb-ev--positive',
    'rb-ev--negative',
    'rb-ev--neutral',
  ]) {
    assert.ok(PAGE_CODE.includes(cls), `${cls} must be used by page.tsx, not shipped unused`);
  }

  // Both regions carry the paired class on their root.
  for (const region of ['AccuracyBar', 'PerformancePanel'] as const) {
    assert.ok(
      functionBody(region).includes('className="rb-evidence-panel"'),
      `${region} root is a paired token surface`
    );
  }

  /*
   * The region-owned helpers are token-backed and contain no legacy literal.
   * `profitColor` is gone — all four of its call sites were inside part 1.
   */
  for (const helper of ['profitClass', 'evClassSummary'] as const) {
    const body = functionBody(helper);
    assert.match(body, /rb-ev--positive/);
    assert.match(body, /rb-ev--negative/);
    assert.match(body, /rb-ev--neutral/, 'zero / unknown is neutral, never a status colour');
    assert.equal(/#[0-9a-fA-F]{6}/.test(body), false, `${helper} holds no legacy literal`);
  }
  assert.equal(/function profitColor\(/.test(PAGE_CODE), false, 'profitColor is retired');

  /*
   * The legacy semantic helpers survive UNCHANGED for the race-card regions,
   * and `roiColor` stays legacy for the out-of-scope InFormPanel.
   */
  for (const helper of ['evColorStyle', 'roiColor'] as const) {
    assert.match(PAGE_CODE, new RegExp(`function ${helper}\\(`), `${helper} still exists`);
  }
  assert.match(PAGE_CODE, /const CONFIDENCE_COLORS/, 'race-card confidence map unchanged');
  assert.match(PAGE_CODE, /function componentColor\(/, 'componentColor unchanged');
  assert.match(PAGE_CODE, /const EV_POSITIVE_COLOR = '#1a7f37';/);
  assert.match(PAGE_CODE, /const EV_NEGATIVE_COLOR = '#cf222e';/);

  /*
   * Classes that must NOT ship yet. The first three belong to part 2.
   * `.rb-evidence-secondary` is here for a different reason: it was drafted for
   * this tranche and removed because nothing consumes it. If part 2 genuinely
   * needs a secondary-text role it should reintroduce the class together with
   * its first consumer, and delete this entry — not inherit a dead rule.
   */
  for (const notYet of [
    '.rb-evidence-card',
    '.rb-conf--',
    '.rb-status-frame--official',
    '.rb-evidence-secondary',
  ]) {
    assert.equal(
      TOKENS_CSS.includes(notYet),
      false,
      `${notYet} must not ship without a production consumer`
    );
  }
});

test('18b. the migrated summary pairs clear AA on the surface production uses', () => {
  /*
   * The surface token is DERIVED from `.rb-evidence-panel`'s actual CSS
   * contract rather than named here, so contrast is measured against the
   * surface production really renders. Hardcoding `--rb-surface-raised` would
   * keep passing if the class later moved to `--rb-surface-elevated` — a real
   * risk, since part 2 introduces a card surface on a different token. This
   * derivation makes any such raised/elevated drift fail here instead.
   *
   * This is a token-level calculation. It does not compare browser-computed
   * styles.
   */
  const panelRule = cssRule('.rb-evidence-panel');
  const backgroundDecl = /background:\s*([^;]+);/.exec(panelRule);
  assert.ok(backgroundDecl, '.rb-evidence-panel must declare a background');

  const surfaceToken = /^var\((--rb-surface-[a-z-]+)\)$/.exec(backgroundDecl[1].trim());
  assert.ok(
    surfaceToken,
    `.rb-evidence-panel background must be a var(--rb-surface-*) token, got: ${backgroundDecl[1].trim()}`
  );

  const surface = {
    light: lightToken(surfaceToken[1]),
    dark: darkToken(surfaceToken[1]),
  };

  for (const [name, tok] of [
    ['primary', '--rb-text-primary'],
    ['secondary / rb-ev--neutral', '--rb-text-secondary'],
    ['muted', '--rb-text-muted'],
    ['positive', '--rb-status-positive'],
    ['failure', '--rb-status-failure'],
    ['accent (audit link)', '--rb-accent-analytical'],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const fg = scheme === 'light' ? lightToken(tok) : darkToken(tok);
      const ratio = contrast(fg, surface[scheme]);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${name} on ${surfaceToken[1]} (${scheme}) is ${ratio.toFixed(2)}:1`
      );
    }
  }
});

test('17. the NextActionWidget frame is a paired token surface (slice 3D phase 1)', () => {
  /*
   * The frame migrated from a tinted inline palette to the `rb-status-frame`
   * classes. The class is a PAIRED surface — it declares `background` AND
   * `color` — so nothing inside inherits a foreground that might not match it.
   * That pairing is why no `var(--rb-*)` literal enters page.tsx and test 7 is
   * unaffected: the tokens live in the stylesheet, as with the message states.
   */
  const frame = cssRule('.rb-status-frame');
  assert.match(frame, /background: var\(--rb-surface-elevated\)/, 'token surface');
  assert.match(frame, /color: var\(--rb-text-primary\)/, 'paired token foreground');

  // Tone is a semantic left border, never a tinted fill, and never colour alone.
  assert.match(
    cssRule('.rb-status-frame--positive'),
    /border-left-color: var\(--rb-status-positive\)/
  );
  assert.match(
    cssRule('.rb-status-frame--warning'),
    /border-left-color: var\(--rb-status-warning\)/
  );

  // All three tone CLASSIFICATIONS survive the repaint; neutral is the base.
  const mapper = functionBody('nextActionFrameClass');
  for (const tone of ['pos', 'warn', 'neutral'] as const) {
    assert.ok(mapper.includes(`${tone}:`), `the ${tone} tone is still classified`);
  }
  assert.match(mapper, /pos: ' rb-status-frame--positive'/);
  assert.match(mapper, /warn: ' rb-status-frame--warning'/);
  assert.match(mapper, /neutral: ''/, 'neutral keeps the base frame');

  // The widget uses the paired classes for frame, label, headline and detail.
  for (const cls of [
    'rb-status-frame__label',
    'rb-status-frame__headline',
    'rb-status-frame__detail',
  ]) {
    assert.ok(PAGE_CODE.includes(cls), `NextActionWidget uses ${cls}`);
    assert.match(TOKENS_CSS, new RegExp(`\\.${cls} \\{`), `${cls} is defined`);
  }

  /*
   * THE COMMAND BLOCK IS UNTOUCHED. It keeps its own self-contained dark
   * pairing and stays an inert <code> element — no button, handler or copy
   * control. `operatorNextAction.test.ts` pins the same element independently.
   */
  const cmd = styleBlock('nextActionCmd');
  assert.ok(cmd.includes("background: '#0d1117'"), 'command block keeps its dark surface');
  assert.ok(cmd.includes("color: '#e6edf3'"), 'and its paired light foreground');
  assert.ok(cmd.includes("overflowX: 'auto'"), 'wide commands scroll, never truncate');
  assert.ok(cmd.includes("wordBreak: 'break-all'"), 'and wrap rather than overflow the page');
  assert.match(PAGE_CODE, /<code style=\{styles\.nextActionCmd\}>/, 'still an inert code element');
  assert.equal(/onClick|navigator\.clipboard|<button/.test(PAGE_CODE), false, 'no write control');
});

test('16c. the legacy primary foreground clears AA on every 3D.4a surface', () => {
  /*
   * SCOPE OF THIS ASSERTION. It calculates WCAG 2.1 contrast for the four
   * distinct legacy surfaces the five migrated definitions use, and proves each
   * foreground/background pairing clears the 4.5:1 normal-text threshold.
   *
   * It does NOT independently prove before/after computed-colour equality — it
   * has no before/after comparison and inspects no browser-computed style.
   * Source-level equality with `styles.page` is proven separately, by the
   * bounded equivalence contract in test 5b.
   */
  for (const [background, what] of [
    ['#eafff1', 'live mode (scoped) / next action positive'],
    ['#fff8c5', 'next action warning'],
    ['#f6f8fa', 'static view / accuracy bar / performance panel'],
    ['#ffffff', 'tipster panels'],
  ] as const) {
    const ratio = contrast('#1f2328', background);
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `${what}: #1f2328 on ${background} is ${ratio.toFixed(2)}:1`
    );
  }
});
