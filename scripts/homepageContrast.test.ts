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
 * The five NESTED race-card panels, added as inputs by evidence part 2b-ii.
 *
 * They render inside `RaceCardView`'s token-paired surface but own their styles
 * in their own files, so the pairing invariant this suite exists to protect can
 * only be checked by reading them.
 */
const NESTED_PANELS = [
  'SettlementStatusPanel',
  'RaceIntelligencePanel',
  'RaceExplanationPanel',
  'GenaiCommentaryPanel',
  'MlShadowComparisonPanel',
] as const;

/**
 * Comment-stripped, for the same reason `PAGE_CODE` is: these files legitimately
 * NAME the literals they retired (`#faf5ff`, `#8c959f`) while explaining why,
 * and a structural assertion must not read documentation as code.
 */
const NESTED_SRC: Record<(typeof NESTED_PANELS)[number], string> = Object.fromEntries(
  NESTED_PANELS.map((n) => [n, codeOf(readFileSync(`src/components/${n}.tsx`, 'utf8'))])
) as Record<(typeof NESTED_PANELS)[number], string>;

/**
 * Every brace-balanced `name: { ... }` style entry in a component source, at any
 * nesting depth. Bounded per entry, so a `background` on a NEIGHBOURING style
 * can never be read as pairing the entry under test — the distinction the whole
 * migration turns on.
 */
function styleEntries(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  for (const m of src.matchAll(/(\w+): \{/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    for (let j = open; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push({ name: m[1], body: src.slice(open, j + 1) });
          break;
        }
      }
    }
  }
  return out;
}

/** The four self-contained branches `badgeStyle` returns, in source order. */
const ML_BADGE_BRANCHES = [
  'all_agree',
  'ml_differs_from_both',
  'unknown',
  'default',
] as const;

/**
 * The object literals RETURNED from `MlShadowComparisonPanel`'s `badgeStyle`.
 *
 * `styleEntries` deliberately matches `name: {`, which is the shape of every
 * entry in a `styles` object — but these four branches are written as
 * `return { ...styles.badge, color: …, background: … }` and so carry no key to
 * match on. They were therefore invisible to the pairing and contrast checks
 * even though they are exactly the kind of self-contained chip those checks
 * exist to protect. This reads them directly.
 *
 * SCOPED DELIBERATELY to `badgeStyle`'s own body, not to every `return {` in
 * the file: `SettlementStatusPanel` also returns a style object, but it builds
 * one from `c.bg` / `c.color` palette variables rather than literals, and a
 * broader parser would start reasoning about returns that declare no colour at
 * all. Comment-stripped input keeps prose out of the match.
 *
 * The branch NAME comes from the guard that selects it, so a failure message
 * says which chip broke rather than just "branch 3".
 */
function badgeStyleBranches(src: string): Array<{ name: string; body: string }> {
  const at = src.indexOf('function badgeStyle(');
  assert.notEqual(at, -1, 'MlShadowComparisonPanel must still define badgeStyle');
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, 'badgeStyle must have a bounded body');
  const fn = src.slice(at, end);

  const out: Array<{ name: string; body: string }> = [];
  for (const m of fn.matchAll(/return \{/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    for (let j = open; j < fn.length; j += 1) {
      if (fn[j] === '{') depth += 1;
      else if (fn[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          // `if (badge === 'x') return {…}` names the branch; a bare
          // `return {…}` is the fall-through default.
          const guard = /badge === '(\w+)'\)\s*$/.exec(fn.slice(0, m.index!));
          out.push({ name: guard ? guard[1] : 'default', body: fn.slice(open, j + 1) });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Every self-contained chip candidate in a panel: its named style entries PLUS,
 * for the ML panel, the four returned `badgeStyle` branches. Both pairing loops
 * and the chip contrast loop read this, so a branch can never be checked by one
 * and skipped by another.
 */
function chipCandidates(name: (typeof NESTED_PANELS)[number]) {
  const entries = styleEntries(NESTED_SRC[name]);
  if (name !== 'MlShadowComparisonPanel') return entries;
  return [
    ...entries,
    ...badgeStyleBranches(NESTED_SRC[name]).map((b) => ({
      name: `badgeStyle:${b.name}`,
      body: b.body,
    })),
  ];
}

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

test('12. exactly two styles.muted uses remain, both in the legacy tipster panels', () => {
  /*
   * SCOPE OF THIS ASSERTION. It proves the COUNT and therefore non-migration:
   * `styles.muted` had fourteen uses; the two direct page-surface states moved
   * away (to `pageMuted` in slice 3D.1, then onto the message-state primitives
   * in 3D.2), the two summary surfaces followed in evidence part 1, the
   * next-race panel in part 2a, and the seven race-card-core sites in part 2b-i.
   * TWO are still present. A blanket literal replacement would have emptied
   * this count and broken both in the dark scheme, so the number is the guard.
   *
   * Both survivors sit in `TipsterStatusPanel` and `InFormPanel`, which keep
   * `styles.panel`'s legacy `#fff` surface until their own tranche. There
   * `#656d76` still clears 4.5:1 (5.25:1 on white). Test 12b owns the ownership
   * record; this test does not independently establish either site's containing
   * surface.
   *
   * This is the FLOOR for the evidence programme: no further site can move
   * until the tipster panels migrate, at which point `styles.muted` is deleted
   * outright rather than reduced again.
   */
  const remaining = [...PAGE_CODE.matchAll(/styles\.muted/g)];
  assert.equal(remaining.length, 2, 'exactly the two remaining legacy tipster uses');
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
   * CURRENT OWNERSHIP RECORD. The count steps down as each regime migrates:
   * twelve after slice 3D.2, ten after evidence part 1 (AccuracyBar's and
   * PerformancePanel's zero-state messages, which now sit on
   * `rb-evidence-panel`), nine after part 2a (NextRacePanel), and TWO after
   * part 2b-i, which moved all seven race-card-core sites — one in
   * `RunnerLine`, three in `LockedDecisionPanel` and three in `RaceCardView` —
   * onto `rb-evidence-muted`.
   *
   * The remaining two belong to `TipsterStatusPanel` and `InFormPanel`. They
   * are the LAST legacy holders and stay until the tipster tranche, which
   * deletes `styles.muted` rather than shrinking it again.
   */
  assert.equal(
    [...PAGE_CODE.matchAll(/styles\.muted/g)].length,
    2,
    'two legacy tipster uses remain'
  );

  // The migrated surfaces no longer reference the legacy muted style.
  for (const region of [
    'AccuracyBar',
    'PerformancePanel',
    'NextRacePanel',
    'RunnerLine',
    'LockedDecisionPanel',
    'RaceCardView',
  ] as const) {
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

test('16b. RETIRED — no page-surface region inherits the legacy foreground any more', () => {
  /*
   * TEST 16b IS DELIBERATELY RETIRED, NOT DELETED.
   *
   * It tracked the surfaces that still declared a legacy background AND no
   * foreground of their own, i.e. those waiting for a paired migration. The set
   * emptied as the programme ran: `styles.nextRace` left in part 2a, and
   * `styles.card` — its last member — left in part 2b-i.
   *
   * The coverage it provided has MOVED rather than lapsed: test 20 owns the
   * card's pairing positively (root on `rb-evidence-panel`, no legacy surface
   * left behind). What remains here is the inverse guard, which is the part
   * worth keeping: a region must never REACQUIRE the deferred shape. If a
   * future tranche reintroduces a hard-coded light surface with no foreground,
   * that is the exact bug this file exists to catch, and it fails here.
   */

  // `styles.card` must not have kept — or regained — a hard-coded surface.
  const card = styleBlock('card');
  assert.equal(
    /background:/.test(card),
    false,
    'styles.card must take its surface from rb-evidence-panel, not inline'
  );
  assert.equal(
    /\bcolor:/.test(card),
    false,
    'styles.card must take its foreground from rb-evidence-panel, not inline'
  );
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
   * SUPERSEDED BY PART 2b-i. This block used to assert that `evColorStyle`,
   * `CONFIDENCE_COLORS` and `componentColor` survived for the race cards. The
   * race cards were their LAST consumers, so part 2b-i deleted all three and
   * the assertion is now INVERTED: a dead helper left behind is the defect.
   *
   * `roiColor` genuinely survives — `InFormPanel` still uses it — and it is why
   * `EV_POSITIVE_COLOR` / `EV_NEGATIVE_COLOR` also survive. The planning pass
   * predicted those two constants would die with `evColorStyle`; checking the
   * source showed `roiColor` consumes them, so they stayed. That consumption is
   * asserted here so a later tranche cannot delete a constant that is still
   * live, nor keep one after its last consumer goes.
   */
  for (const dead of ['evColorStyle', 'componentColor'] as const) {
    assert.equal(
      new RegExp(`function ${dead}\\(`).test(PAGE_CODE),
      false,
      `${dead} lost its last consumer in part 2b-i and must not linger`
    );
  }
  assert.equal(
    /const CONFIDENCE_COLORS/.test(PAGE_CODE),
    false,
    'CONFIDENCE_COLORS lost its last consumer in part 2b-i'
  );
  assert.match(PAGE_CODE, /function roiColor\(/, 'roiColor still serves InFormPanel');
  assert.match(PAGE_CODE, /const EV_POSITIVE_COLOR = '#1a7f37';/);
  assert.match(PAGE_CODE, /const EV_NEGATIVE_COLOR = '#cf222e';/);
  for (const constant of ['EV_POSITIVE_COLOR', 'EV_NEGATIVE_COLOR'] as const) {
    assert.ok(
      functionBody('roiColor').includes(constant),
      `${constant} must keep its real consumer, or be deleted with it`
    );
  }

  /*
   * Classes that must NOT ship yet.
   *
   * The list has SHRUNK to one because part 2b-i shipped the others WITH real
   * consumers, which was always the condition for admitting them:
   * `.rb-status-frame--official` now frames LockedDecisionPanel;
   * `.rb-evidence-secondary` now colours the confidence-breakdown summary and
   * the alternatives rows; and `.rb-conf--unknown` became reachable because
   * `ConfidenceLevel` is `high | medium | low | unknown` and the breakdown
   * panel renders that fourth case. Test 20 pins each of those consumers.
   *
   * `.rb-evidence-nested` stays barred: part 2b-i deliberately did NOT create
   * it. The five nested panels are held on a TEMPORARY legacy pair instead (see
   * test 21); part 2b-ii decides whether a nested class is the right shape once
   * those files own token foregrounds. Shipping it now would be a dead rule
   * ahead of the region that gives it meaning.
   */
  for (const notYet of ['.rb-evidence-nested']) {
    assert.equal(
      TOKENS_CSS.includes(notYet),
      false,
      `${notYet} must not ship without a production consumer`
    );
  }
});

test('19. the next-race panel is a paired token region (evidence migration part 2a)', () => {
  /*
   * PART 2a SCOPE: NextRacePanel only. It is a top-level sibling with its own
   * `styles.nextRace` surface — not a race-card descendant — so it can own a
   * complete token regime while the race-card core stays legacy for part 2b.
   *
   * THREE semantic regimes now coexist, one per surface, and that is the whole
   * safety property: `evClassSummary` on the part 1 summary panels,
   * `evClassNextRace` here, and the legacy `evColorStyle` on the still-legacy
   * race cards. No helper crosses a regime, so none can put a dark-aware token
   * colour on a legacy light surface (~2.30:1) or a legacy colour on a token
   * surface (~2.92:1).
   */
  const card = cssRule('.rb-evidence-card');
  assert.match(card, /background: var\(--rb-surface-[a-z]+\)/, 'token surface');
  assert.match(card, /color: var\(--rb-text-primary\)/, 'paired token foreground');

  for (const [cls, token] of [
    ['.rb-conf--high', '--rb-status-positive'],
    ['.rb-conf--medium', '--rb-status-warning'],
    ['.rb-conf--low', '--rb-status-failure'],
  ] as const) {
    assert.match(cssRule(cls), new RegExp(`color: var\\(${token}\\)`), `${cls} uses ${token}`);
  }

  const nextRace = functionBody('NextRacePanel');
  assert.ok(nextRace.includes('className="rb-evidence-card"'), 'root is a paired token surface');
  assert.ok(nextRace.includes('evClassNextRace('), 'EV uses the region-owned helper');
  assert.ok(nextRace.includes('confidenceClassNextRace('), 'confidence uses the region-owned helper');
  assert.equal(nextRace.includes('styles.muted'), false, 'no legacy muted on a token surface');
  assert.ok(nextRace.includes('rb-evidence-muted'), 'muted text is token-backed');

  /*
   * The region-owned helpers are token-backed, and each is used ONLY here.
   * Two occurrences apiece: the definition plus the single call site.
   */
  for (const helper of ['evClassNextRace', 'confidenceClassNextRace'] as const) {
    assert.equal(
      [...PAGE_CODE.matchAll(new RegExp(helper, 'g'))].length,
      2,
      `${helper} is defined once and used once, inside NextRacePanel`
    );
    assert.equal(
      /#[0-9a-fA-F]{6}/.test(functionBody(helper)),
      false,
      `${helper} holds no legacy literal`
    );
  }

  /*
   * The confidence mapping is a `Record<ConfidenceLabel, string>` rather than an
   * if/else chain, and that TYPE is the contract: it is exhaustive at compile
   * time, so adding a member to `ConfidenceLabel` breaks the build until the map
   * is extended deliberately. An if/else with a default would compile and route
   * the new band silently to the failure colour, so a refactor back to that
   * shape must fail here.
   */
  const confMap = /const NEXT_RACE_CONFIDENCE_CLASSES: Record<\s*ConfidenceLabel,\s*string\s*> = \{([^}]*)\}/.exec(
    PAGE_CODE
  );
  assert.ok(
    confMap,
    'the next-race confidence map must be typed Record<ConfidenceLabel, string> so it stays exhaustive'
  );
  for (const [label, cls] of [
    ['High', 'rb-conf--high'],
    ['Medium', 'rb-conf--medium'],
    ['Low', 'rb-conf--low'],
  ] as const) {
    assert.match(confMap[1], new RegExp(`${label}: '${cls}'`), `${label} maps to ${cls}`);
  }

  /*
   * PART 2a's OWN CONTRACT IS UNCHANGED: NextRacePanel must not reach for a
   * legacy helper. What changed in part 2b-i is the other half — the race cards
   * migrated too, so `evColorStyle`, `CONFIDENCE_COLORS` and `componentColor`
   * no longer exist for this test to find. Test 18 owns their retirement; the
   * negative assertions below are what still belongs to part 2a, and they hold
   * regardless of whether the legacy helpers exist.
   */
  assert.equal(nextRace.includes('evColorStyle('), false, 'NextRacePanel uses no legacy EV helper');
  assert.equal(nextRace.includes('CONFIDENCE_COLORS'), false, 'nor a legacy confidence map');
  assert.equal(
    /#[0-9a-fA-F]{6}/.test(nextRace),
    false,
    'no legacy colour literal survives anywhere in NextRacePanel'
  );

  // Part 1 ownership is untouched by part 2a.
  for (const part1 of ['profitClass', 'evClassSummary'] as const) {
    assert.match(PAGE_CODE, new RegExp(`function ${part1}\\(`), `${part1} intact`);
  }

  // Every class part 2a defines has a production consumer.
  for (const cls of ['rb-evidence-card', 'rb-conf--high', 'rb-conf--medium', 'rb-conf--low']) {
    assert.ok(PAGE_CODE.includes(cls), `${cls} must be used by page.tsx, not shipped unused`);
  }
});

test('19b. the next-race pairs clear AA on the surface production uses', () => {
  /*
   * The surface token is DERIVED from `.rb-evidence-card`'s actual CSS
   * contract, so contrast is measured against what production renders and any
   * future raised/elevated drift fails here. Token-level calculation; it does
   * not compare browser-computed styles.
   */
  const rule = cssRule('.rb-evidence-card');
  const bg = /background:\s*([^;]+);/.exec(rule);
  assert.ok(bg, '.rb-evidence-card must declare a background');
  const tok = /^var\((--rb-surface-[a-z-]+)\)$/.exec(bg[1].trim());
  assert.ok(tok, `.rb-evidence-card background must be a var(--rb-surface-*) token, got: ${bg[1]}`);

  const surface = { light: lightToken(tok[1]), dark: darkToken(tok[1]) };

  for (const [name, t] of [
    ['primary (race time, pick name)', '--rb-text-primary'],
    ['muted (label, course, no-pick)', '--rb-text-muted'],
    ['EV positive', '--rb-status-positive'],
    ['EV negative', '--rb-status-failure'],
    ['EV neutral', '--rb-text-secondary'],
    ['confidence high', '--rb-status-positive'],
    ['confidence medium', '--rb-status-warning'],
    ['confidence low', '--rb-status-failure'],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const fg = scheme === 'light' ? lightToken(t) : darkToken(t);
      const ratio = contrast(fg, surface[scheme]);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${name} on ${tok[1]} (${scheme}) is ${ratio.toFixed(2)}:1`
      );
    }
  }
});

test('20. the race-card core is a paired token region (evidence migration part 2b-i)', () => {
  /*
   * PART 2b-i SCOPE: the race-card ROOT and every region defined in page.tsx
   * that renders inside it. This is a PERMANENT migration — contrast with test
   * 21, which pins the TEMPORARY containment holding the five nested panel
   * components until part 2b-ii.
   *
   * The card reuses `rb-evidence-panel`, the SAME class as the part 1 summary
   * panels, because both are raised evidence regions; the sticky next-race
   * panel stays on the elevated `rb-evidence-card` so it still reads as lifted
   * above them. Reuse is deliberate — a third identical surface class would be
   * a parallel palette, not a distinction.
   */
  const card = functionBody('RaceCardView');
  assert.ok(
    card.includes('className="rb-evidence-panel"'),
    'the race-card root is a paired token surface'
  );

  // The inline legacy surface is gone, not merely overridden.
  const cardStyle = styleBlock('card');
  for (const gone of ['background:', 'border:', 'borderRadius:', 'color:']) {
    assert.equal(
      cardStyle.includes(gone),
      false,
      `styles.card must not declare ${gone} — rb-evidence-panel owns it`
    );
  }
  // Geometry stays inline.
  assert.match(cardStyle, /padding: 16/, 'card padding stays inline');
  assert.match(cardStyle, /boxShadow:/, 'card shadow stays inline');

  /*
   * Region-owned semantic helpers. Each is defined once and used only inside
   * the race-card core, and each returns shared token classes rather than a
   * literal. The counts are measured against comment-stripped source, so the
   * explanatory prose above each helper cannot satisfy them.
   */
  for (const [helper, uses] of [
    ['evClassRaceCard', 4],
    ['confidenceClassRaceCard', 2],
    ['componentClassRaceCard', 3],
  ] as const) {
    assert.equal(
      [...PAGE_CODE.matchAll(new RegExp(helper, 'g'))].length,
      uses,
      `${helper} must be defined once with exactly ${uses - 1} race-card call site(s)`
    );
    assert.equal(
      /#[0-9a-fA-F]{6}/.test(functionBody(helper)),
      false,
      `${helper} holds no legacy literal`
    );
  }

  /*
   * Both confidence maps are typed `Record<...>` over a CLOSED union, so adding
   * a member fails the build instead of silently taking a fall-through colour.
   * The component map covers four levels because `ConfidenceLevel` really is
   * `high | medium | low | unknown`.
   */
  const confMap = /const RACE_CARD_CONFIDENCE_CLASSES: Record<\s*ConfidenceLabel,\s*string\s*> = \{([^}]*)\}/.exec(
    PAGE_CODE
  );
  assert.ok(confMap, 'the race-card confidence map must be an exhaustive Record');
  for (const [label, cls] of [
    ['High', 'rb-conf--high'],
    ['Medium', 'rb-conf--medium'],
    ['Low', 'rb-conf--low'],
  ] as const) {
    assert.match(confMap[1], new RegExp(`${label}: '${cls}'`), `${label} -> ${cls}`);
  }

  const compMap = /const RACE_CARD_COMPONENT_CLASSES: Record<\s*ConfidenceComponent\['level'\],\s*string\s*> = \{([^}]*)\}/.exec(
    PAGE_CODE
  );
  assert.ok(compMap, 'the component map must be an exhaustive Record over ConfidenceLevel');
  for (const [level, cls] of [
    ['high', 'rb-conf--high'],
    ['medium', 'rb-conf--medium'],
    ['low', 'rb-conf--low'],
    ['unknown', 'rb-conf--unknown'],
  ] as const) {
    assert.match(compMap[1], new RegExp(`${level}: '${cls}'`), `${level} -> ${cls}`);
  }

  /*
   * `rb-conf--unknown` maps to MUTED text, not a status colour. "Unknown" is an
   * absent signal and must not be dressed as a weak-but-present one — the same
   * reasoning that puts `.rb-ev--neutral` on secondary text.
   */
  assert.match(cssRule('.rb-conf--unknown'), /color: var\(--rb-text-muted\)/);

  /*
   * No race-card region may keep a legacy foreground on the token surface.
   * `styles.statLabel` is gone entirely: it fused a colour with a 4px margin, so
   * it could never be overridden per-region, and all six race-card sites now
   * carry the margin structurally with the colour from a class.
   */
  assert.equal(/statLabel/.test(PAGE_CODE), false, 'styles.statLabel is retired');
  for (const region of [
    'RaceCardView',
    'LockedDecisionPanel',
    'ConfidenceBreakdownPanel',
    'RunnerLine',
    'FreshnessRow',
    'RaceStatusRow',
  ] as const) {
    assert.equal(
      /#[0-9a-fA-F]{6}/.test(functionBody(region)),
      false,
      `${region} must hold no legacy colour literal on the token card`
    );
  }

  // Every class part 2b-i defines has a real production consumer.
  for (const cls of [
    'rb-status-frame--official',
    'rb-evidence-secondary',
    'rb-conf--unknown',
    'rb-evidence-header-rule',
    'rb-evidence-section-rule',
  ]) {
    assert.ok(TOKENS_CSS.includes(`.${cls}`), `${cls} must be defined`);
    assert.ok(PAGE_CODE.includes(cls), `${cls} must be consumed by page.tsx, not shipped unused`);
  }

  // Part 1 and part 2a ownership is untouched by part 2b-i.
  for (const kept of [
    'profitClass',
    'evClassSummary',
    'evClassNextRace',
    'confidenceClassNextRace',
  ] as const) {
    assert.match(PAGE_CODE, new RegExp(`function ${kept}\\(`), `${kept} intact`);
  }
  assert.match(PAGE_CODE, /position: 'sticky' as const/, 'the part 2a sticky contract is intact');
  assert.match(PAGE_CODE, /const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';/, 'containment retained');
});

test('20b. the official locked decision has structural primacy over the live diagnostic', () => {
  /*
   * The official T-minus-5 decision now carries `rb-status-frame` plus the new
   * `--official` modifier. The modifier changes the LEFT BORDER ONLY: tone is a
   * structural rule, never a tinted fill and never a second palette.
   *
   * The border REINFORCES; it never carries the meaning alone. The panel's
   * wording and its position before the live diagnostic remain the primary
   * distinction, which is what the order and label assertions below pin.
   */
  const official = cssRule('.rb-status-frame--official');
  assert.match(official, /border-left-color: var\(--rb-status-official\)/);
  const declarations = official
    .split('\n')
    .filter((l) => l.includes(':') && !l.includes('{'))
    .map((l) => l.trim());
  assert.equal(declarations.length, 1, 'the modifier changes border-left-color and nothing else');

  const locked = functionBody('LockedDecisionPanel');
  assert.ok(
    locked.includes('className="rb-status-frame rb-status-frame--official"'),
    'LockedDecisionPanel carries the official frame'
  );

  /*
   * `rb-status-frame` is itself a PAIRED surface, so the frame does not leave
   * its contents inheriting a foreground that may not match it.
   */
  const frame = cssRule('.rb-status-frame');
  assert.match(frame, /background: var\(--rb-surface-[a-z-]+\)/, 'frame declares a token surface');
  assert.match(frame, /color: var\(--rb-text-primary\)/, 'frame declares a paired foreground');

  // Every lock state and its exact wording survives.
  for (const literal of [
    'Official locked decision (T−5)',
    'OFFICIAL LOCKED NO BET',
    'OFFICIAL LOCKED PICK',
    'OFFICIAL LOCK: NO MODEL RUN AVAILABLE',
    'No model run existed at the capture target — unknown, not a no-bet.',
    'Data quality at lock:',
    'Immutable decision locked at T−5 — results never change it.',
  ]) {
    assert.ok(locked.includes(literal), `lock wording must survive verbatim: ${literal}`);
  }
  for (const state of ['locked_no_bet', 'locked_pick', 'no_run_available'] as const) {
    assert.ok(locked.includes(`'${state}'`), `${state} must remain a distinct branch`);
  }

  /*
   * `no_run_available` must never be collapsed into a no-bet: it is an unknown,
   * and CLAUDE.md treats the distinction as a safety property, not a nicety.
   */
  assert.ok(
    locked.includes('unknown, not a no-bet'),
    'no_run_available must stay distinct from locked_no_bet'
  );

  // The frame adds no interaction, role, live region or control.
  for (const forbidden of ['onClick', 'onChange', 'role=', 'aria-live', '<button', 'clipboard']) {
    assert.equal(
      locked.includes(forbidden),
      false,
      `the official frame is display-only — ${forbidden} must not appear`
    );
  }

  /*
   * EVIDENCE ORDER IS UNCHANGED. Market favourite still precedes the official
   * decision, which still precedes the live diagnostic, and the alternatives
   * still follow — all of them OUTSIDE the official frame, which is closed by
   * LockedDecisionPanel itself.
   */
  const card = functionBody('RaceCardView');
  const at = (needle: string) => {
    const i = card.indexOf(needle);
    assert.notEqual(i, -1, `RaceCardView must still render ${needle}`);
    return i;
  };
  const favourite = at('Market favourite');
  const lockedAt = at('<LockedDecisionPanel');
  const diagnostic = at('Model pick — live diagnostic (official decision above)');
  const alternatives = at('Alternatives (');
  assert.ok(favourite < lockedAt, 'market favourite stays before the official decision');
  assert.ok(lockedAt < diagnostic, 'the official decision stays before the live diagnostic');
  assert.ok(diagnostic < alternatives, 'alternatives stay after the diagnostic');

  // Neither the favourite nor the alternatives may be pulled inside the frame.
  assert.equal(
    locked.includes('Market favourite'),
    false,
    'market favourite must stay outside the official frame'
  );
  assert.equal(
    locked.includes('Alternatives ('),
    false,
    'alternatives must stay outside the official frame'
  );

  // The unlocked branch keeps its explicit diagnostic disclaimer.
  assert.ok(
    card.includes('Live/pre-off model diagnostic — not official locked decision.'),
    'the unlocked diagnostic disclaimer survives verbatim'
  );
});

test('21. the five nested panels own token-safe foregrounds (evidence part 2b-ii)', () => {
  /*
   * THE CONTAINMENT IS GONE — THIS TEST REPLACES THE ONE THAT PINNED IT.
   *
   * Part 2b-i could not migrate these five components, so it pinned a temporary
   * complete legacy pair (`LEGACY_NESTED_PANEL_SURFACE` + `_FOREGROUND`) on
   * `styles.explanationPanel`, holding every nested panel on the white surface
   * its hard-coded colours were measured against. That was debt, and this is
   * where it is paid: the panels now declare token foregrounds of their own, so
   * they inherit the paired `rb-evidence-panel` card in both schemes.
   *
   * Nothing on the race card is legacy-contained after this point.
   */
  for (const gone of ['LEGACY_NESTED_PANEL_SURFACE', 'LEGACY_NESTED_PANEL_FOREGROUND']) {
    assert.equal(
      PAGE_SRC.includes(gone),
      false,
      `${gone} was temporary containment and must not survive part 2b-ii`
    );
  }

  /*
   * `styles.explanationPanel` is spread LAST over each panel's own style, so it
   * decides what they render on. It must now be STRUCTURAL ONLY: no foreground
   * at all, and an explicit transparent background so the panels inherit the
   * card rather than owning a surface.
   */
  const panel = styleBlock('explanationPanel');
  assert.equal(/\bcolor:/.test(panel), false, 'the nested style must not impose a foreground');
  assert.match(panel, /background: 'transparent'/, 'nested panels inherit the card surface');
  assert.equal(
    /#[0-9a-fA-F]{6}/.test(panel),
    false,
    'no legacy literal may remain in the nested style'
  );

  /*
   * THE PAIRING INVARIANT, CHECKED PER STYLE ENTRY.
   *
   * A hex foreground is allowed ONLY inside an entry that also declares its own
   * background — a self-contained badge or chip, which the parent surface
   * cannot affect. An unpaired hex foreground is the dark-on-dark bug this
   * suite exists to catch; a token foreground left on a fixed light background
   * is the same bug mirrored, and the second loop catches that.
   */
  for (const name of NESTED_PANELS) {
    for (const entry of chipCandidates(name)) {
      const fg = /color: '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      if (!fg) continue;
      assert.ok(
        /(background|bg): '#[0-9a-fA-F]{6}'/.test(entry.body),
        `${name}.${entry.name} keeps the legacy foreground ${fg[1]} without its own background`
      );
    }
    for (const entry of chipCandidates(name)) {
      if (!/(background|bg): '#[0-9a-fA-F]{6}'/.test(entry.body)) continue;
      assert.equal(
        /color: 'var\(--rb-/.test(entry.body),
        false,
        `${name}.${entry.name} puts a dark-aware token colour on a fixed light background`
      );
    }
  }

  /*
   * The four `badgeStyle` branches are written as `return { … }` rather than as
   * named style entries, so they were previously invisible to the two loops
   * above. Assert they are DISCOVERED by name — a count alone would still pass
   * if one branch were renamed and another duplicated, and silence is the
   * failure mode that let them go unchecked in the first place.
   */
  const branches = badgeStyleBranches(NESTED_SRC.MlShadowComparisonPanel);
  assert.deepEqual(
    branches.map((b) => b.name),
    [...ML_BADGE_BRANCHES],
    'every badgeStyle branch must be parsed, in source order, or the pairing loops silently skip it'
  );
  for (const branch of branches) {
    assert.match(
      branch.body,
      /color: '#[0-9a-fA-F]{6}'/,
      `badgeStyle:${branch.name} must keep its own foreground`
    );
    assert.match(
      branch.body,
      /background: '#[0-9a-fA-F]{6}'/,
      `badgeStyle:${branch.name} must keep its own background`
    );
  }

  /*
   * The `#8c959f` EXEMPTION IS DELETED, not moved. Part 2b-i recorded it with a
   * floor AND a ceiling precisely so this tranche would be forced to resolve it
   * rather than inherit it. It folded into `--rb-text-muted`, which clears AA on
   * the card in both schemes (test 21b), so the literal must now be absent.
   */
  assert.equal(
    NESTED_SRC.RaceIntelligencePanel.includes('#8c959f'),
    false,
    'the faint tier folded into --rb-text-muted; the exemption must not linger'
  );

  // All five still render inside the card, each still taking the nested style.
  const card = functionBody('RaceCardView');
  for (const name of NESTED_PANELS) {
    assert.ok(card.includes(`<${name}`), `${name} must still render inside the card`);
  }
  assert.equal(
    [...card.matchAll(/style=\{styles\.explanationPanel\}/g)].length,
    5,
    'exactly the five nested panels take the shared nested style'
  );
});

test('21b. every nested-panel foreground clears AA on the card surface it now inherits', () => {
  /*
   * The surface is DERIVED from `.rb-evidence-panel`, the class the race-card
   * root actually carries, so a future raised/elevated change fails here rather
   * than shipping. Token-level calculation; it does not read computed styles.
   */
  const rule = cssRule('.rb-evidence-panel');
  const bg = /background: var\((--rb-surface-[a-z-]+)\)/.exec(rule);
  assert.ok(bg, '.rb-evidence-panel must declare a var(--rb-surface-*) background');
  const surface = { light: lightToken(bg[1]), dark: darkToken(bg[1]) };

  /*
   * Every token these five files actually reference, collected FROM SOURCE
   * rather than listed by hand — so a role added later cannot slip past this.
   */
  const used = new Set<string>();
  for (const name of NESTED_PANELS) {
    for (const m of NESTED_SRC[name].matchAll(/color: 'var\((--rb-[a-z-]+)\)'/g)) {
      used.add(m[1]);
    }
  }
  assert.ok(used.size >= 4, `expected several token roles, found ${[...used].join(', ')}`);

  for (const token of [...used].sort()) {
    for (const scheme of ['light', 'dark'] as const) {
      const fg = scheme === 'light' ? lightToken(token) : darkToken(token);
      const ratio = contrast(fg, surface[scheme]);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${token} on ${bg[1]} (${scheme}) is ${ratio.toFixed(2)}:1`
      );
    }
  }

  /*
   * The self-contained chips are measured against their OWN backgrounds, the
   * only surface that can affect them. `shadowChip` is included because part
   * 2b-ii fixed it: it shipped at 4.28:1 and now clears the floor.
   */
  let chipsMeasured = 0;
  for (const name of NESTED_PANELS) {
    for (const entry of chipCandidates(name)) {
      const fg = /color: '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      const bgHex = /(?:background|bg): '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      if (!fg || !bgHex) continue;
      chipsMeasured += 1;
      const ratio = contrast(fg[1], bgHex[1]);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${name}.${entry.name} chip is ${ratio.toFixed(2)}:1 (${fg[1]} on ${bgHex[1]})`
      );
    }
  }

  /*
   * The four `badgeStyle` branches must be measured HERE too, not only pinned
   * structurally in test 21. They are named individually rather than counted,
   * so a branch that stops being parsed fails loudly instead of quietly
   * dropping out of the contrast sweep.
   */
  const branchRatios = badgeStyleBranches(NESTED_SRC.MlShadowComparisonPanel).map((b) => {
    const fg = /color: '(#[0-9a-fA-F]{6})'/.exec(b.body);
    const bgHex = /background: '(#[0-9a-fA-F]{6})'/.exec(b.body);
    assert.ok(fg && bgHex, `badgeStyle:${b.name} must declare both a foreground and a background`);
    return { name: b.name, ratio: contrast(fg[1], bgHex[1]) };
  });
  assert.deepEqual(
    branchRatios.map((b) => b.name),
    [...ML_BADGE_BRANCHES],
    'all four badgeStyle branches must reach the contrast sweep'
  );
  for (const b of branchRatios) {
    assert.ok(
      b.ratio >= AA_NORMAL_TEXT,
      `badgeStyle:${b.name} is ${b.ratio.toFixed(2)}:1 on its own background`
    );
  }

  assert.ok(
    chipsMeasured >= 16,
    `expected every self-contained chip to be measured, only found ${chipsMeasured}`
  );
});

test('21c. the ML shadow comparison has a bounded narrow-viewport layout', () => {
  /*
   * The grid was a fixed `1fr 1fr 1fr` at every width, leaving roughly 84px per
   * column inside a 390px card. `auto-fit` + `minmax` collapses it to a single
   * column there and restores three from tablet width up, with no media query,
   * no new class, no state and no hidden evidence.
   */
  const ml = NESTED_SRC.MlShadowComparisonPanel;

  /*
   * The SHAPE must be `repeat(auto-fit, minmax(<n>px, 1fr))` and the track
   * minimum must be EXACTLY the approved 180px. Matching any `\d+px` would let
   * `0px` (never collapses), `120px` (four columns on a narrow card) or `900px`
   * (one column on desktop) pass while silently changing the layout the 16
   * Playwright combinations verified. Extracting the value gives a failure
   * message that names the offending number.
   */
  const minmax = /gridTemplateColumns: 'repeat\(auto-fit, minmax\((\d+)px, 1fr\)\)'/.exec(ml);
  assert.ok(
    minmax,
    "the ML grid must use repeat(auto-fit, minmax(<n>px, 1fr)) so it collapses on a narrow card"
  );
  assert.equal(
    minmax[1],
    '180',
    `the approved track minimum is 180px — one column at 390 and three from tablet up; found ${minmax[1]}px`
  );
  assert.ok(
    ml.includes("gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))'"),
    'the grid declaration must match the approved value exactly'
  );
  assert.equal(
    /gridTemplateColumns: '1fr 1fr 1fr'/.test(ml),
    false,
    'the fixed three-column grid must not return'
  );

  /*
   * The empty state prints `npm run ml:predict-shadow` — a long unbreakable
   * token that would otherwise overflow a single narrow column.
   */
  const empty = styleEntries(ml).find((e) => e.name === 'empty');
  assert.ok(empty, 'the ML panel must keep an empty state');
  assert.match(empty.body, /overflowWrap: 'anywhere'/, 'the code token must be able to break');

  /*
   * The ML column no longer carries the fixed `#faf5ff` tint: with token
   * foregrounds that surface gave ~1.06:1 in the dark scheme. It stays
   * distinguishable structurally instead — a stronger border against the
   * neighbouring columns, plus its accent labels and self-contained chip.
   */
  assert.equal(/#faf5ff/.test(ml), false, 'the fixed ML tint must not survive part 2b-ii');
  const mlCol = styleEntries(ml).find((e) => e.name === 'mlCol');
  assert.ok(mlCol, 'the ML column must still exist');
  assert.match(mlCol.body, /border: '1px solid var\(--rb-border-strong\)'/, 'distinct border');
  assert.equal(/background:/.test(mlCol.body), false, 'the ML column inherits the card');
});

test('20c. the race-card pairs clear AA on the surface production uses', () => {
  /*
   * The surface is DERIVED from `.rb-evidence-panel`'s actual CSS contract, so
   * contrast is measured against what the card really renders and a future
   * raised/elevated change fails here. The official frame is measured against
   * its OWN surface, which is a different token.
   *
   * Token-level calculation; it does not compare browser-computed styles.
   */
  const surfaceOf = (selector: string) => {
    const rule = cssRule(selector);
    const bg = /background:\s*var\((--rb-surface-[a-z-]+)\)/.exec(rule);
    assert.ok(bg, `${selector} must declare a var(--rb-surface-*) background`);
    return { name: bg[1], light: lightToken(bg[1]), dark: darkToken(bg[1]) };
  };

  const roles = [
    ['primary (off time, pick name, odds)', '--rb-text-primary'],
    ['secondary (breakdown, alternatives)', '--rb-text-secondary'],
    ['muted (labels, reasons, separators)', '--rb-text-muted'],
    ['EV positive', '--rb-status-positive'],
    ['EV negative', '--rb-status-failure'],
    ['EV neutral', '--rb-text-secondary'],
    ['confidence high', '--rb-status-positive'],
    ['confidence medium', '--rb-status-warning'],
    ['confidence low', '--rb-status-failure'],
    ['confidence unknown', '--rb-text-muted'],
  ] as const;

  for (const selector of ['.rb-evidence-panel', '.rb-status-frame'] as const) {
    const surface = surfaceOf(selector);
    for (const [name, token] of roles) {
      for (const scheme of ['light', 'dark'] as const) {
        const fg = scheme === 'light' ? lightToken(token) : darkToken(token);
        const ratio = contrast(fg, surface[scheme]);
        assert.ok(
          ratio >= AA_NORMAL_TEXT,
          `${name} on ${selector} ${surface.name} (${scheme}) is ${ratio.toFixed(2)}:1`
        );
      }
    }

    /*
     * The official left border is a MEANINGFUL non-text indicator, so it takes
     * the 3:1 floor rather than 4.5:1. It is reinforcement only — wording and
     * position remain the primary distinction — but it must still be visible.
     */
    for (const scheme of ['light', 'dark'] as const) {
      const border =
        scheme === 'light' ? lightToken('--rb-status-official') : darkToken('--rb-status-official');
      const ratio = contrast(border, surface[scheme]);
      assert.ok(
        ratio >= 3,
        `the official border on ${selector} (${scheme}) is ${ratio.toFixed(2)}:1`
      );
    }
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

test('17b. the next-action command LABEL is paired on the frame surface', () => {
  /*
   * THE DEFECT THIS CLOSES.
   *
   * Slice 3D phase 1 moved the NextActionWidget frame and its three descriptive
   * roles onto the paired `rb-status-frame` classes, but left the
   * suggested-command LABEL declaring the legacy `#656d76`. A paired surface
   * with an unpaired descendant is exactly the half-migration this file exists
   * to catch: the frame's fill follows `--rb-surface-elevated`, which turns
   * `#222831` in the dark scheme, where `#656d76` reaches only ~2.83:1 — below
   * the 4.5:1 normal-text floor. Test 17 pinned the frame's pairing and the
   * command block's self-containment, and this label fell between them.
   *
   * SCOPE: ONE foreground. No wording, condition, structure, spacing,
   * typography, layout or action-logic change. The sibling command block, the
   * two tipster `styles.muted` holdouts, the containment surface and the
   * navigation known-shortfall are all deliberately untouched, and are
   * re-asserted below so this tranche cannot quietly disturb them.
   */

  const widget = functionBody('NextActionWidget');
  const label = styleBlock('nextActionCmdLabel');

  /* --- 1. the label takes the token-backed muted class -------------------- */

  assert.match(
    widget,
    /<span className="rb-evidence-muted" style=\{styles\.nextActionCmdLabel\}>/,
    'the command label must take its foreground from rb-evidence-muted'
  );

  /* --- 2. the style key SURVIVES, colour-free ----------------------------- */

  /*
   * Deliberately not deleted. Unlike a colour-only key, this one carries
   * structure that a colour-only utility class does not supply, so it is kept
   * and stripped of its colour instead — which is also what guarantees no
   * inline declaration outranks the class.
   */
  for (const structural of ["display: 'block'", 'fontSize: 11', 'marginBottom: 4']) {
    assert.ok(label.includes(structural), `the label must keep ${structural}`);
  }
  assert.equal(/\bcolor:/.test(label), false, 'no inline colour may override the class');

  /* --- 3. the legacy literal has left this region ------------------------- */

  /*
   * The region is the widget body PLUS the style keys the widget itself
   * consumes — derived from the body, not listed here. Bounding it to the JSX
   * alone would be vacuous: the literal never lived in the markup, it lived in
   * the style object the markup points at. Pinning the derived set also means a
   * NEW bespoke key cannot be introduced without failing this assertion.
   */
  const consumedKeys = [...new Set([...widget.matchAll(/styles\.(\w+)/g)].map((m) => m[1]))];
  assert.deepEqual(
    [...consumedKeys].sort(),
    ['nextActionCmd', 'nextActionCmdLabel', 'nextActionCmdRow'],
    'the widget consumes exactly its three bespoke style keys'
  );
  const region = [widget, ...consumedKeys.map(styleBlock)].join('\n');
  assert.equal(
    /#656d76/.test(region),
    false,
    'the legacy muted literal must not remain anywhere in the next-action region'
  );

  /* --- 4-6. contrast, DERIVED from the rules production actually applies --- */

  /*
   * The surface is read from `.rb-status-frame` rather than hard-coded, so this
   * measurement tracks the production rule. `nextActionFrameClass` always emits
   * that base class, and both tone modifiers change the LEFT BORDER only, so
   * the fill beneath this label is identical in all three tones — asserted,
   * not assumed.
   */
  const frame = cssRule('.rb-status-frame');
  const surfaceToken = /background: var\((--rb-[a-z-]+)\)/.exec(frame);
  assert.ok(surfaceToken, '.rb-status-frame must declare a token background');

  for (const modifier of ['.rb-status-frame--positive', '.rb-status-frame--warning'] as const) {
    assert.equal(
      /background:/.test(cssRule(modifier)),
      false,
      `${modifier} must tint the border only, leaving the measured fill intact`
    );
  }

  const mutedRule = cssRule('.rb-evidence-muted');
  const fgToken = /color: var\((--rb-[a-z-]+)\)/.exec(mutedRule);
  assert.ok(fgToken, '.rb-evidence-muted must declare a token foreground');

  const EXPECTED_RATIO = { light: 5.8, dark: 5.02 } as const;
  for (const scheme of ['light', 'dark'] as const) {
    const read = scheme === 'light' ? lightToken : darkToken;
    const ratio = contrast(read(fgToken[1]), read(surfaceToken[1]));
    assert.ok(
      ratio >= AA_NORMAL_TEXT,
      `the command label (${scheme}) is ${ratio.toFixed(2)}:1 on ${surfaceToken[1]}`
    );
    assert.ok(
      Math.abs(ratio - EXPECTED_RATIO[scheme]) < 0.05,
      `expected ~${EXPECTED_RATIO[scheme]}:1 in ${scheme}, measured ${ratio.toFixed(2)}:1`
    );
  }

  /*
   * Evidence the fix was needed, computed against the SAME production surface:
   * the superseded pair must still be demonstrably below the floor.
   */
  const supersededDark = contrast('#656d76', darkToken(surfaceToken[1]));
  assert.ok(
    supersededDark < AA_NORMAL_TEXT,
    `expected the superseded pair to fail, but it was ${supersededDark.toFixed(2)}:1`
  );

  /* --- 7. the command BLOCK remains independently paired ------------------ */

  const cmd = styleBlock('nextActionCmd');
  assert.ok(cmd.includes("background: '#0d1117'"), 'command block keeps its own dark surface');
  assert.ok(cmd.includes("color: '#e6edf3'"), 'and its own paired light foreground');
  assert.ok(
    contrast('#e6edf3', '#0d1117') >= AA_NORMAL_TEXT,
    'the command block must clear AA on its own self-contained terms'
  );
  assert.match(widget, /<code style=\{styles\.nextActionCmd\}>/, 'still an inert code element');
  assert.equal(
    /className=/.test(widget.slice(widget.indexOf('<code'))),
    false,
    'no class was added to the command block — its pairing stays independent'
  );

  /* --- 8-9. wording and conditional rendering are unchanged --------------- */

  assert.ok(
    widget.includes('Suggested (read-only — run in a terminal, not from this page):'),
    'the label wording is unchanged'
  );
  assert.match(
    widget,
    /\{action\.suggestedCommand\}<\/code>/,
    'the command wording still comes from the action itself'
  );
  assert.match(
    widget,
    /\{action\.suggestedCommand && \(/,
    'the row still renders only when a command exists'
  );

  /* --- 10. no new class was introduced ------------------------------------ */

  const used = [
    ...new Set(
      [...widget.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/ +/))
    ),
  ];
  assert.ok(used.includes('rb-evidence-muted'), 'the label class must be among those used');
  for (const cls of used) {
    assert.match(
      TOKENS_CSS,
      new RegExp(`\\.${cls} \\{`),
      `${cls} must already exist in tokens.css — this tranche defines none`
    );
  }
  assert.equal(
    /\.rb-[a-z-]*(cmd|command|next-action)/.test(TOKENS_CSS),
    false,
    'no bespoke class was invented for this label'
  );

  /*
   * The reused class must stay COLOUR-ONLY. Extending a shared utility to suit
   * one call site would silently change every other consumer of it.
   */
  const mutedDecls = mutedRule
    .split('\n')
    .filter((line) => line.includes(':'))
    .map((line) => line.trim());
  assert.deepEqual(
    mutedDecls,
    ['color: var(--rb-text-muted);'],
    '.rb-evidence-muted must remain a colour-only utility'
  );

  /* --- 11. the two styles.muted holdouts remain tipster-owned ------------- */

  assert.equal(
    [...PAGE_CODE.matchAll(/styles\.muted/g)].length,
    2,
    'the tipster holdouts are untouched by this tranche'
  );
  assert.equal(
    widget.includes('styles.muted'),
    false,
    'the widget must not borrow the legacy tipster muted style'
  );
  for (const tipster of ['TipsterStatusPanel', 'InFormPanel'] as const) {
    assert.ok(
      functionBody(tipster).includes('styles.muted'),
      `${tipster} still owns a legacy muted use`
    );
  }

  /* --- 12. the containment surface remains active ------------------------- */

  assert.match(
    PAGE_CODE,
    /const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';/,
    'the containment constant remains'
  );
  assert.ok(
    styleBlock('page').includes('background: LEGACY_LIGHT_PAGE_SURFACE'),
    'and is still applied to the page wrapper'
  );

  /* --- 13. the navigation known-shortfall is untouched -------------------- */

  const navLinkAt = PAGE_CODE.indexOf('const raceDaySecondaryLinkStyle');
  assert.notEqual(navLinkAt, -1, 'raceDaySecondaryLinkStyle must exist');
  const navLink = PAGE_CODE.slice(navLinkAt, PAGE_CODE.indexOf('};', navLinkAt));
  assert.ok(navLink.includes("color: '#0969da'"), 'the nav link keeps its legacy colour');
  assert.ok(
    contrast('#0969da', LEGACY_LIGHT_PAGE_SURFACE) < AA_NORMAL_TEXT,
    'test 14c still owns this shortfall — this tranche must not have fixed it'
  );

  /* --- 14. the completed Slice 3D contracts survive ----------------------- */

  /*
   * The fix adds a CLASS, not a token literal, so test 7's invariant is
   * unaffected — restated here because that is precisely the boundary a
   * "just use the token" shortcut would have crossed.
   */
  for (const forbidden of ['var(--rb-text-', 'var(--rb-status-', 'var(--rb-accent-']) {
    assert.equal(
      PAGE_SRC.includes(forbidden),
      false,
      `${forbidden} must still not appear in page.tsx`
    );
  }
  for (const cls of [
    'rb-evidence-panel',
    'rb-evidence-card',
    'rb-evidence-secondary',
    'rb-status-frame--official',
  ]) {
    assert.ok(PAGE_CODE.includes(cls), `${cls} must remain in use`);
  }
  assert.equal(
    /LEGACY_NESTED_PANEL/.test(PAGE_SRC),
    false,
    'the retired part 2b-i containment constants must not return'
  );
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
