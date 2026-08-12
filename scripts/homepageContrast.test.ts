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
 * Every entry of the MODULE-LEVEL `styles` object in page.tsx, bounded to itself.
 *
 * Deliberately NOT the file-wide `name: {` scan `styleEntries` uses for the
 * component sources. page.tsx also holds function-local palette objects
 * (`tagStyle`, `statusBadgeStyle`, `countdownStyle`) whose branches are keyed
 * `pos:` / `neutral:` and pair a colour with a `bg:` rather than a
 * `background:`. A file-wide scan would read those self-contained chips as
 * unpaired foregrounds. Slicing the `styles` object first, and requiring the
 * two-space indentation of a top-level entry, keeps this to the entries it
 * claims to describe.
 */
function pageStyleEntries(): Array<{ name: string; body: string }> {
  const at = PAGE_CODE.indexOf('const styles = {');
  assert.notEqual(at, -1, 'page.tsx must declare a module-level styles object');
  const end = PAGE_CODE.indexOf('\n};', at);
  assert.ok(end > at, 'the styles object must be bounded');
  const block = PAGE_CODE.slice(at, end);

  const out: Array<{ name: string; body: string }> = [];
  for (const m of block.matchAll(/^ {2}(\w+): \{$/gm)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    for (let j = open; j < block.length; j += 1) {
      if (block[j] === '{') depth += 1;
      else if (block[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push({ name: m[1], body: block.slice(open, j + 1) });
          break;
        }
      }
    }
  }
  assert.ok(out.length > 20, 'the styles object must parse into its entries');
  return out;
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
   * left in evidence-migration part 1; `styles.panel` (the tipster panels) left
   * in the tipster tranche, which DELETED it rather than re-anchoring it.
   * `liveBarStyle` is the only remaining holder of the anchor, and it is
   * self-contained (it declares its own background), so it is safe where it is.
   */
  assert.ok(
    functionBody('liveBarStyle').includes(LEGACY_PRIMARY_FOREGROUND),
    'liveBarStyle must declare the same foreground as styles.page'
  );

  // The migrated regions must NOT reacquire a legacy foreground.
  for (const key of ['accuracyBar', 'perfPanel', 'tipsterPanel'] as const) {
    assert.equal(
      styleBlock(key).includes(LEGACY_PRIMARY_FOREGROUND),
      false,
      `styles.${key} is paired via rb-evidence-panel and must not re-declare the legacy colour`
    );
  }

  /*
   * `styles.panel` is gone, not merely unanchored. Test 22 owns the tipster
   * panels' positive pairing; asserting the key's absence here is what stops
   * the legacy surface returning under its old name.
   */
  assert.equal(
    /(^|\s)panel: \{/.test(PAGE_CODE),
    false,
    'the legacy tipster panel surface must not return'
  );

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

test('8. styles.muted is RETIRED, with no legacy replacement', () => {
  /*
   * SUPERSEDES "styles.muted is unchanged".
   *
   * The key existed to give the page a muted tier on hard-coded light surfaces.
   * The tipster panels were its last two consumers; once they took
   * `rb-evidence-panel`, `#656d76` fell to 3.15:1 there in the dark scheme, so
   * the key was deleted outright rather than shrunk again.
   */
  assert.equal(
    /(^|\s)muted: \{/.test(PAGE_CODE),
    false,
    'the styles.muted definition must be gone, not merely unused'
  );
  assert.equal(
    /styles\.muted(?![A-Za-z0-9_])/.test(PAGE_CODE),
    false,
    'and no call site may reference it'
  );

  /*
   * No legacy muted key may be reintroduced under another name: a colour-only
   * entry holding a hard-coded foreground is the exact shape that was retired.
   * Bounded per entry, so a colour beside a `background` in a self-contained
   * palette is not mistaken for one.
   */
  for (const { name, body } of pageStyleEntries()) {
    if (/background:/.test(body)) continue;
    assert.equal(
      /color: '#[0-9a-fA-F]{6}'/.test(body),
      false,
      `styles.${name} declares a hard-coded foreground with no surface of its own`
    );
  }

  /*
   * `#656d76` itself is NOT globally removed, and must not be asserted away:
   * `countdownStyle` and `liveBarStyle` still use it, both SELF-CONTAINED (each
   * declares its own background), which is why they are safe and out of scope.
   * Pinning the count stops a new unpaired consumer appearing unnoticed.
   */
  const remaining = [...PAGE_CODE.matchAll(/#656d76/g)];
  assert.equal(remaining.length, 3, 'exactly the countdown neutral chip and LiveModeBar x2');
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

test('12. RETIRED — the styles.muted count contract reached zero', () => {
  /*
   * SUPERSEDES the count contract, which stepped 14 -> 12 -> 10 -> 9 -> 2 as
   * each regime migrated. The tipster tranche took the final two, so a count
   * assertion here could now only ever read zero — a contract that cannot fail
   * is worse than none, so the number is gone and the RETIREMENT is what is
   * asserted (test 8 owns the definition; this owns the consumers).
   *
   * What remains is the inverse guard, which is the part worth keeping: no
   * region may reacquire a legacy muted style.
   */
  assert.equal(
    /styles\.muted(?![A-Za-z0-9_])/.test(PAGE_CODE),
    false,
    'no region may reintroduce the retired legacy muted style'
  );

  // Every region that ever held one now uses the token-backed class instead.
  for (const region of [
    'AccuracyBar',
    'PerformancePanel',
    'NextRacePanel',
    'RunnerLine',
    'LockedDecisionPanel',
    'RaceCardView',
    'TipsterStatusPanel',
    'InFormPanel',
  ] as const) {
    assert.ok(
      functionBody(region).includes('rb-evidence-muted'),
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

test('14c. the race-day nav secondary links clear AA on the containment surface', () => {
  /*
   * SUPERSEDES THE KNOWN-SHORTFALL EXEMPTION.
   *
   * This test used to record `#0969da` at ~4.34:1 on the containment surface as
   * a bounded, deliberately-unfixed shortfall, with an upper bound that would
   * fail the moment the navigation tranche corrected it. That has now happened:
   * the links are `#0550ae`, which reaches ~6.35:1 on the same surface. The
   * exemption — the ~4.3 floor, the `< 4.5` bound and the "known shortfall"
   * framing — is DELETED rather than retained, and what replaces it is a
   * permanent passing contract.
   *
   * `#cf222e` was removed from the old list earlier and is not reinstated here:
   * slice 3D.2 replaced the inline error paragraph with `ErrorState`, so the
   * failing TEXT pair no longer exists. No known-shortfall entry remains, which
   * is why this test no longer maintains a list at all.
   *
   * A LEGACY DARKENING, NOT `rb-inline-link`. Asserted below, because the token
   * class would be actively wrong here while the containment stands.
   */

  /* --- the foreground, parsed from the production style ------------------- */

  const navAt = PAGE_CODE.indexOf('const raceDaySecondaryLinkStyle');
  assert.notEqual(navAt, -1, 'raceDaySecondaryLinkStyle must exist');
  const navLink = PAGE_CODE.slice(navAt, PAGE_CODE.indexOf('};', navAt));

  const navFg = /color: '(#[0-9a-fA-F]{6})'/.exec(navLink);
  assert.ok(navFg, 'the link style must declare a foreground');
  assert.equal(navFg[1], '#0550ae', 'the corrected legacy darkening');
  assert.equal(
    navLink.includes('#0969da'),
    false,
    'the superseded value must not remain in this style'
  );

  /*
   * The OTHER `#0969da` on the page belongs to `countdownStyle`, which is
   * self-contained (`#ddf4ff` fill) and is not this link. Pinning it here stops
   * an unrelated occurrence either satisfying or defeating this contract.
   */
  assert.ok(
    functionBody('countdownStyle').includes("color: '#0969da'"),
    'the countdown chip keeps its own separate legacy colour'
  );

  /* --- the surface, parsed from the ACTIVE containment application -------- */

  /*
   * Read from `styles.page` rather than restated: the links inherit whatever
   * that wrapper actually paints, so if the containment were removed or
   * repointed this measurement would follow it instead of silently passing
   * against a stale literal.
   */
  const page = styleBlock('page');
  assert.ok(
    page.includes('background: LEGACY_LIGHT_PAGE_SURFACE'),
    'the containment must still be applied to the page wrapper'
  );
  const surfaceLiteral = /const LEGACY_LIGHT_PAGE_SURFACE = '(#[0-9a-fA-F]{6})';/.exec(PAGE_CODE);
  assert.ok(surfaceLiteral, 'the containment constant must still be declared');
  assert.equal(surfaceLiteral[1], LEGACY_LIGHT_PAGE_SURFACE, 'and unchanged by this tranche');

  /* --- the measurement ---------------------------------------------------- */

  const ratio = contrast(navFg[1], surfaceLiteral[1]);
  assert.ok(
    ratio >= AA_NORMAL_TEXT,
    `race-day nav secondary links: ${navFg[1]} on ${surfaceLiteral[1]} is ${ratio.toFixed(2)}:1`
  );
  assert.ok(
    Math.abs(ratio - 6.35) < 0.05,
    `expected ~6.35:1, measured ${ratio.toFixed(2)}:1`
  );

  /* --- the token class stays out until the containment goes --------------- */

  const inlineLink = /color: var\((--rb-[a-z-]+)\)/.exec(cssRule('.rb-inline-link'));
  assert.ok(inlineLink, '.rb-inline-link must declare a token foreground');
  const wouldBe = contrast(darkToken(inlineLink[1]), surfaceLiteral[1]);
  assert.ok(
    wouldBe < AA_NORMAL_TEXT,
    `rb-inline-link must remain unusable here: its dark value is ${wouldBe.toFixed(2)}:1 on the fixed light surface`
  );
  assert.equal(
    /rb-inline-link/.test(functionBody('RaceDayNav')),
    false,
    'so neither call site may adopt it while the containment stands'
  );
});

test('14d. the corrected nav links keep their structure, wording and destinations', () => {
  /*
   * This tranche changed ONE declaration. Everything else about the two links
   * is pinned here so a colour correction cannot quietly become a nav change.
   */
  const nav = functionBody('RaceDayNav');
  const navAt = PAGE_CODE.indexOf('const raceDaySecondaryLinkStyle');
  const navLink = PAGE_CODE.slice(navAt, PAGE_CODE.indexOf('};', navAt));

  // Exactly two consumers, and the element types are unchanged.
  assert.equal(
    [...nav.matchAll(/style=\{raceDaySecondaryLinkStyle\}/g)].length,
    2,
    'exactly the previous-day anchor and the audit Link'
  );
  assert.match(
    nav,
    /<a href=\{nav\.previousDay\.href\} style=\{raceDaySecondaryLinkStyle\}>/,
    'the previous-day link stays a full-document anchor'
  );
  assert.match(
    nav,
    /<Link href=\{nav\.audit\.href\} prefetch=\{false\} style=\{raceDaySecondaryLinkStyle\}>/,
    'the audit link stays a prefetch-disabled Link'
  );

  // Labels come from the view builder, not from literals introduced here.
  for (const label of ['{nav.previousDay.label}', '{nav.audit.label}']) {
    assert.ok(nav.includes(label), `${label} must still be rendered from the nav view`);
  }

  /*
   * DECORATION UNCHANGED. These links declare `textDecoration: 'none'` and have
   * never been underlined — no global anchor rule exists, and the only
   * underline rules in tokens.css belong to `.rb-skip-link`,
   * `.rb-nav__link[aria-current]` and `.rb-inline-link`, none of which applies
   * here. Asserting the value it actually has is what stops this tranche
   * silently adding or removing a decoration.
   */
  assert.ok(
    navLink.includes("textDecoration: 'none'"),
    'the decoration is carried over exactly as it was'
  );
  assert.ok(navLink.includes('fontSize: 13'), 'and the size is unchanged');

  // No state styling was introduced: an inline style cannot express one, and no
  // rule was added for these links either.
  for (const state of [':hover', ':focus', ':active']) {
    assert.equal(
      TOKENS_CSS.includes(`.rb-race-day${state}`),
      false,
      `no ${state} treatment was invented for these links`
    );
  }
  assert.equal(
    /\.rb-[a-z_-]*(race-day|nav-secondary)/.test(TOKENS_CSS),
    false,
    'no new class was added for this correction'
  );

  /* --- the regions this tranche deliberately did NOT touch ---------------- */

  assert.ok(
    nav.includes("color: '#1f2328'"),
    'the RaceDayNav root keeps its legacy foreground — out of scope'
  );
  assert.ok(
    PAGE_CODE.includes("color: '#57606a'"),
    'the intro paragraph keeps its legacy foreground — out of scope'
  );
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
   * THE OBJECT-STYLE MEMBERS OF THIS SET ARE NOW EMPTY.
   *
   * `accuracyBar` and `perfPanel` left in evidence-migration part 1; `panel`
   * (the tipster panels) left in the tipster tranche, which deleted it. Test 18
   * owns the first migration and test 22 the second.
   *
   * Coverage has MOVED, not lapsed. The inverse guard below is the part worth
   * keeping, and it is strictly broader than the inventory it replaces: NO
   * entry in the styles object may hold a hard-coded light surface. That is
   * what a returning legacy island would look like.
   */
  for (const { name, body } of pageStyleEntries()) {
    for (const legacySurface of ["background: '#fff'", "background: '#ffffff'"]) {
      assert.equal(
        body.includes(legacySurface),
        false,
        `styles.${name} must not declare the legacy white surface`
      );
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
   * SUPERSEDED AGAIN BY THE TIPSTER TRANCHE. This block previously asserted
   * that `roiColor`, `EV_POSITIVE_COLOR` and `EV_NEGATIVE_COLOR` SURVIVED,
   * because `InFormPanel` genuinely still consumed them. The tipster panels
   * were that last consumer, so the same rule — a constant lives exactly as
   * long as a real consumer does — now requires the opposite assertion.
   *
   * `src/app/leaderboard/page.tsx` declares its own separate `roiColor`. It is
   * a different module on a different route and is deliberately untouched, so
   * these assertions are scoped to page.tsx and must never be widened to the
   * whole repository.
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
  assert.equal(
    /function roiColor\(/.test(PAGE_CODE),
    false,
    'roiColor lost its last consumer in the tipster tranche and must not linger'
  );
  for (const constant of ['EV_POSITIVE_COLOR', 'EV_NEGATIVE_COLOR'] as const) {
    assert.equal(
      new RegExp(`${constant}(?![A-Za-z0-9_])`).test(PAGE_CODE),
      false,
      `${constant} died with roiColor and must not linger`
    );
  }
  // Its token-backed successor exists and is the shape the others already have.
  assert.match(PAGE_CODE, /function roiClassTipster\(/, 'roiClassTipster replaces it');

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

  /*
   * REVIEW OBSERVATION O1 (PR #13). This pair was previously computed from two
   * literals restated in the test, which could never fail. Both halves are now
   * PARSED OUT of the production style block, so the ratio tracks the source:
   * change either colour and the measurement changes with it. The intended
   * values are still pinned separately, immediately below.
   */
  const cmd = styleBlock('nextActionCmd');
  const cmdBg = /background: '(#[0-9a-fA-F]{6})'/.exec(cmd);
  const cmdFg = /color: '(#[0-9a-fA-F]{6})'/.exec(cmd);
  assert.ok(cmdBg, 'the command block must declare its own surface');
  assert.ok(cmdFg, 'and its own foreground');
  assert.equal(cmdBg[1], '#0d1117', 'command block keeps its own dark surface');
  assert.equal(cmdFg[1], '#e6edf3', 'and its own paired light foreground');
  assert.ok(
    contrast(cmdFg[1], cmdBg[1]) >= AA_NORMAL_TEXT,
    `the command block must clear AA on its own self-contained terms; got ${contrast(cmdFg[1], cmdBg[1]).toFixed(2)}:1`
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
  /*
   * REVIEW OBSERVATION O2 (PR #13). The previous pattern was
   * `/\.rb-[a-z-]*(cmd|command|next-action)/`, whose `[a-z-]*` cannot cross a
   * BEM `__` separator, so `.rb-status-frame__cmd` slipped straight through.
   * `[a-z_-]*` closes that. The segment is still anchored to an `rb-` class
   * selector and the name fragments are unchanged, so unrelated classes are not
   * caught — `.rb-command-centre` would be, and deliberately so; nothing of
   * that name exists or should.
   */
  const BESPOKE_LABEL_CLASS = /\.rb-[a-z_-]*(cmd|command|next-action)/;
  for (const wouldBeBespoke of [
    '.rb-evidence-cmd {',
    '.rb-evidence-command {',
    '.rb-next-action-label {',
    '.rb-status-frame__cmd {',
    '.rb-status-frame__command {',
    '.rb-status-frame__next-action {',
  ]) {
    assert.ok(
      BESPOKE_LABEL_CLASS.test(wouldBeBespoke),
      `the guard must catch ${wouldBeBespoke.trim()}`
    );
  }
  // ...and must not fire on the classes this page legitimately uses.
  for (const legitimate of ['.rb-evidence-muted {', '.rb-status-frame__label {', '.rb-ev--neutral {']) {
    assert.equal(
      BESPOKE_LABEL_CLASS.test(legitimate),
      false,
      `the guard must not overmatch ${legitimate.trim()}`
    );
  }
  assert.equal(
    BESPOKE_LABEL_CLASS.test(TOKENS_CSS),
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

  /* --- 11. the legacy muted style stays retired --------------------------- */

  /*
   * SUPERSEDED BY THE TIPSTER TRANCHE. This block asserted that the two
   * `styles.muted` holdouts remained tipster-owned; that tranche migrated both
   * and deleted the key, so the contract inverts. Tests 8 and 12 own the
   * retirement in full — what matters here is only that this widget did not
   * acquire the legacy style on its way past.
   */
  assert.equal(
    widget.includes('styles.muted'),
    false,
    'the widget must not borrow the retired legacy muted style'
  );
  for (const tipster of ['TipsterStatusPanel', 'InFormPanel'] as const) {
    assert.ok(
      functionBody(tipster).includes('rb-evidence-muted'),
      `${tipster} takes the token-backed muted class`
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

  /* --- 13. the navigation links are not this widget's business ------------ */

  /*
   * REVIEW OBSERVATION O1 (PR #13), second half: the nav foreground is PARSED
   * from `raceDaySecondaryLinkStyle` rather than restated, so the measurement
   * follows the source.
   *
   * SUPERSEDED IN PART BY THE NAV-CONTRAST TRANCHE. This block used to assert
   * the link was still `#0969da` and still BELOW AA — a scope guard proving the
   * NextAction tranche had not strayed into navigation. A later tranche has now
   * legitimately corrected that colour, so the "still failing" expectation is
   * gone; keeping it would have blocked the very fix it was written to defer.
   *
   * What remains is the part that still belongs here: this widget must not own
   * or influence the nav link, and the link must be readable. Test 14c owns the
   * exact value and the measured ratio.
   */
  const navLinkAt = PAGE_CODE.indexOf('const raceDaySecondaryLinkStyle');
  assert.notEqual(navLinkAt, -1, 'raceDaySecondaryLinkStyle must exist');
  const navLink = PAGE_CODE.slice(navLinkAt, PAGE_CODE.indexOf('};', navLinkAt));
  const navFg = /color: '(#[0-9a-fA-F]{6})'/.exec(navLink);
  assert.ok(navFg, 'the nav link must declare a foreground');
  assert.ok(
    contrast(navFg[1], LEGACY_LIGHT_PAGE_SURFACE) >= AA_NORMAL_TEXT,
    `the nav link must be readable on the containment surface; got ${contrast(navFg[1], LEGACY_LIGHT_PAGE_SURFACE).toFixed(2)}:1`
  );
  assert.equal(
    widget.includes('raceDaySecondaryLinkStyle'),
    false,
    'NextActionWidget must not reach into the navigation link style'
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

test('22. the tipster panels are a paired token region (tipster tranche)', () => {
  /*
   * THE DEFECT THIS CLOSES.
   *
   * `TipsterStatusPanel` and `InFormPanel` were the LAST region on this page
   * running a hard-coded `#fff` surface with hard-coded dark text — an opaque
   * white island once the shell went dark. They shared every legacy key
   * (`panel`, `panelTitle`, `muted`, `tipsterStat`), so neither could move
   * alone without forking those keys or half-migrating its sibling. This
   * tranche moves both in one change.
   *
   * Section D measures, from the production rules, that every token role clears
   * AA on the new surface AND that each legacy value they carried would fail
   * there in the dark scheme — which is what makes the atomicity necessary
   * rather than merely tidy.
   */

  const status = functionBody('TipsterStatusPanel');
  const inForm = functionBody('InFormPanel');
  const PANELS = [
    ['TipsterStatusPanel', status],
    ['InFormPanel', inForm],
  ] as const;

  /* --- A. both roots take the paired surface, in the same change ---------- */

  for (const [name, body] of PANELS) {
    assert.match(
      body,
      /<section className="rb-evidence-panel" style=\{styles\.tipsterPanel\}>/,
      `${name} root must take the paired token surface`
    );
    assert.equal(
      /styles\.panel(?![A-Za-z0-9_])/.test(body),
      false,
      `${name} must not keep the retired legacy panel surface`
    );
  }

  /*
   * The root style is GEOMETRY ONLY. A background or foreground here would
   * either fight the class or strand a colour on it — the precise failure this
   * programme exists to prevent.
   */
  const rootStyle = styleBlock('tipsterPanel');
  assert.equal(/background:/.test(rootStyle), false, 'the root takes its surface from the class');
  assert.equal(/\bcolor:/.test(rootStyle), false, 'and its foreground from the class');
  for (const geometry of ['padding: 16', 'marginBottom: 16']) {
    assert.ok(rootStyle.includes(geometry), `the root must keep ${geometry}`);
  }

  /* --- B. every text role takes the class matching its old tier ----------- */

  // The two former `styles.muted` sites.
  assert.match(
    status,
    /<div key=\{line\} className="rb-evidence-muted">/,
    'the status lines take the token muted class'
  );
  assert.match(
    inForm,
    /<span className="rb-evidence-muted">/,
    'the empty-state hint takes the token muted class'
  );

  // Titles and the pick column were `#424a53` — the secondary tier.
  for (const [name, body] of PANELS) {
    assert.match(
      body,
      /<div className="rb-evidence-secondary" style=\{styles\.tipsterPanelTitle\}>/,
      `${name} title takes the token secondary class`
    );
  }
  assert.match(
    inForm,
    /<span className="rb-evidence-secondary" style=\{styles\.tipsterPickCell\}>/,
    "the pick column takes the token secondary class"
  );

  // The streak stat was `#656d76` — the muted tier — and keeps its structure.
  assert.match(
    inForm,
    /<span className="rb-evidence-muted" style=\{styles\.tipsterStatCell\}>/,
    'the streak stat takes the token muted class'
  );

  /*
   * The status chip stays a FILLED pill and stays COMPLETELY paired: a token
   * surface inline, a token foreground at the call site. Half of that pairing
   * on its own would strand the other half in one scheme or the other.
   */
  const chip = styleBlock('tipsterStatusChip');
  assert.match(chip, /background: 'var\(--rb-surface-[a-z]+\)'/, 'the chip keeps a token fill');
  assert.equal(/\bcolor: '#/.test(chip), false, 'and holds no legacy foreground');
  assert.equal(
    (status.match(/className="rb-evidence-secondary" style=\{styles\.tipsterStatusChip\}/g) ?? [])
      .length,
    4,
    'all four status chips carry the paired foreground class'
  );
  for (const geometry of ['fontSize: 12', 'fontWeight: 600', 'borderRadius: 999', "padding: '2px 10px'"]) {
    assert.ok(chip.includes(geometry), `the chip must keep ${geometry}`);
  }

  /*
   * The row separator follows the surface. A BORDER token is permitted inline
   * in this file; the legacy `#f0f3f6` hairline is gone.
   */
  const row = styleBlock('tipsterRowLine');
  assert.match(row, /borderTop: '1px solid var\(--rb-border\)'/, 'the row rule is token-backed');
  assert.equal(/#[0-9a-fA-F]{6}/.test(row), false, 'and holds no legacy literal');
  for (const geometry of ["gap: 12", "padding: '6px 0'", 'fontSize: 13']) {
    assert.ok(row.includes(geometry), `the row must keep ${geometry}`);
  }

  /* --- C. the ROI helper preserves the retired branch conditions ---------- */

  /*
   * `roiColor` returned `EV_POSITIVE_COLOR` / `EV_NEGATIVE_COLOR` / `#656d76`
   * from these exact three branches. Only the RETURNED VALUE changes here — the
   * conditions are asserted verbatim, including operand order, the `!== null`
   * guard and the strict comparisons, so a threshold or null-handling change
   * cannot slip through as a repaint. Non-finite input keeps falling through to
   * neutral, because neither comparison holds for NaN.
   */
  const roi = functionBody('roiClassTipster');
  const branches = [...roi.matchAll(/if \(([^)]*)\) \{\s*return '([a-z-]+)';/g)].map((m) => [
    m[1],
    m[2],
  ]);
  assert.deepEqual(
    branches,
    [
      ['roi !== null && roi > 0', 'rb-ev--positive'],
      ['roi !== null && roi < 0', 'rb-ev--negative'],
    ],
    'the positive and negative branches must be the retired conditions verbatim'
  );
  // CRLF-tolerant: this file is stored with Windows line endings.
  assert.match(
    roi,
    /\r?\n {2}return 'rb-ev--neutral';\r?\n\}/,
    'null / zero / non-finite fall through to neutral, outside both guards'
  );
  assert.equal(
    (roi.match(/return /g) ?? []).length,
    3,
    'exactly three outcomes, as before — no fourth case was introduced'
  );
  assert.equal(/#[0-9a-fA-F]{6}/.test(roi), false, 'the helper holds no legacy literal');

  // Both ROI figures are classed by it, and their formatting is untouched.
  for (const field of ['recentRoi30d', 'longRunRoi']) {
    assert.ok(
      inForm.includes(`className={roiClassTipster(t.${field})}`),
      `${field} takes its semantic from the class helper`
    );
    assert.ok(inForm.includes(`formatRoi(t.${field})`), `${field} keeps its existing formatting`);
  }
  assert.equal(
    /color: roi/.test(inForm),
    false,
    'no inline ROI colour may survive alongside the class'
  );

  /* --- D. measured contrast, derived from the production rules ------------ */

  const panelRule = cssRule('.rb-evidence-panel');
  const surfaceToken = /background: var\((--rb-[a-z-]+)\)/.exec(panelRule);
  assert.ok(surfaceToken, '.rb-evidence-panel must declare a token background');

  const ROLES = [
    ['primary (inherited body text)', '.rb-evidence-panel', /color: var\((--rb-[a-z-]+)\)/],
    ['secondary (titles, pick, chips)', '.rb-evidence-secondary', /color: var\((--rb-[a-z-]+)\)/],
    ['muted (status lines, streak)', '.rb-evidence-muted', /color: var\((--rb-[a-z-]+)\)/],
    ['ROI positive', '.rb-ev--positive', /color: var\((--rb-[a-z-]+)\)/],
    ['ROI negative', '.rb-ev--negative', /color: var\((--rb-[a-z-]+)\)/],
    ['ROI neutral', '.rb-ev--neutral', /color: var\((--rb-[a-z-]+)\)/],
  ] as const;

  for (const [role, selector, pattern] of ROLES) {
    const token = pattern.exec(cssRule(selector));
    assert.ok(token, `${selector} must declare a token foreground`);
    for (const scheme of ['light', 'dark'] as const) {
      const read = scheme === 'light' ? lightToken : darkToken;
      const ratio = contrast(read(token[1]), read(surfaceToken[1]));
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${role} (${scheme}) is ${ratio.toFixed(2)}:1 on ${surfaceToken[1]}`
      );
    }
  }

  /*
   * The chip sits on its own recessed token, so it is measured against that
   * surface rather than the panel's — the pair that actually renders.
   */
  const chipSurface = /background: 'var\((--rb-[a-z-]+)\)'/.exec(chip);
  assert.ok(chipSurface, 'the chip must declare a token surface');
  const chipFg = /color: var\((--rb-[a-z-]+)\)/.exec(cssRule('.rb-evidence-secondary'));
  for (const scheme of ['light', 'dark'] as const) {
    const read = scheme === 'light' ? lightToken : darkToken;
    const ratio = contrast(read(chipFg![1]), read(chipSurface[1]));
    assert.ok(ratio >= AA_NORMAL_TEXT, `status chip (${scheme}) is ${ratio.toFixed(2)}:1`);
  }

  /*
   * WHY THE MIGRATION HAD TO BE ATOMIC. Every legacy foreground these panels
   * carried fails on the surface they now take, in the dark scheme. Keeping any
   * one of them while moving the surface would have produced exactly the
   * half-migration this suite exists to catch.
   *
   * The row separator is deliberately NOT in this list: it is a decorative
   * hairline, not a meaningful non-text boundary, so no 3:1 floor is claimed
   * for it.
   */
  const darkSurface = darkToken(surfaceToken[1]);
  for (const [legacy, what] of [
    ['#656d76', 'legacy muted (status lines, stats)'],
    ['#424a53', 'legacy secondary (titles, pick, chip text)'],
    ['#1a7f37', 'legacy EV_POSITIVE_COLOR (ROI)'],
    ['#cf222e', 'legacy EV_NEGATIVE_COLOR (ROI)'],
  ] as const) {
    const ratio = contrast(legacy, darkSurface);
    assert.ok(
      ratio < AA_NORMAL_TEXT,
      `${what}: expected ${legacy} to fail on ${darkSurface}, but it was ${ratio.toFixed(2)}:1`
    );
  }

  /* --- E. retirement, and no new class ------------------------------------ */

  for (const key of [
    'muted',
    'panel',
    'panelTitle',
    'tipsterStat',
    'tipsterPick',
    'tipsterRow',
    'tipsterStatusCount',
  ]) {
    assert.equal(
      new RegExp(`styles\\.${key}(?![A-Za-z0-9_])`).test(PAGE_CODE),
      false,
      `styles.${key} must have no consumer left`
    );
    assert.equal(
      new RegExp(`(^|\\s)${key}: \\{`).test(PAGE_CODE),
      false,
      `styles.${key} must not linger as a dead definition`
    );
  }
  for (const helper of ['roiColor', 'EV_POSITIVE_COLOR', 'EV_NEGATIVE_COLOR']) {
    assert.equal(
      new RegExp(`${helper}(?![A-Za-z0-9_])`).test(PAGE_CODE),
      false,
      `${helper} must be gone from page.tsx`
    );
  }

  /*
   * Every class these panels use must ALREADY exist in tokens.css: this tranche
   * defines none. The stylesheet is asserted unchanged in spirit by requiring
   * each name to resolve to a real rule.
   */
  const used = [
    ...new Set(
      [status, inForm].flatMap((body) => [
        ...[...body.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/ +/)),
      ])
    ),
  ];
  assert.ok(used.length >= 3, 'the panels must actually use token classes');
  for (const cls of [...used, 'rb-ev--positive', 'rb-ev--negative', 'rb-ev--neutral']) {
    assert.match(
      TOKENS_CSS,
      new RegExp(`\\.${cls} \\{`),
      `${cls} must already exist in tokens.css — this tranche defines none`
    );
  }
  assert.equal(
    /\.rb-[a-z_-]*tipster/.test(TOKENS_CSS),
    false,
    'no bespoke tipster class was invented'
  );

  // The page-wide invariant: no dark-aware text/status/accent literal enters here.
  for (const forbidden of ['var(--rb-text-', 'var(--rb-status-', 'var(--rb-accent-']) {
    assert.equal(PAGE_SRC.includes(forbidden), false, `${forbidden} must not appear in page.tsx`);
  }

  /* --- F. behaviour freeze ------------------------------------------------ */

  for (const endpoint of ['/api/tipsters/in-form', '/api/tipsters/status']) {
    assert.ok(PAGE_CODE.includes(endpoint), `${endpoint} must be unchanged`);
  }
  for (const [name, body] of PANELS) {
    assert.match(
      body,
      /=== null\) \{\s*return null;\s*\}/,
      `${name} must keep its conditional null rendering`
    );
    for (const write of ['fetch(', 'useEffect', 'useState', 'onClick', 'method:']) {
      assert.equal(
        body.includes(write),
        false,
        `${name} is presentational and read-only; it must not contain ${write}`
      );
    }
  }

  /* --- G. the prior tranches are undisturbed ------------------------------ */

  assert.match(
    PAGE_CODE,
    /const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';/,
    'the containment surface remains active — the page frame is still legacy'
  );
  assert.ok(
    styleBlock('page').includes('background: LEGACY_LIGHT_PAGE_SURFACE'),
    'and is still applied to the page wrapper'
  );
  for (const cls of [
    'rb-evidence-card',
    'rb-status-frame--official',
    'rb-status-frame__label',
  ]) {
    assert.ok(PAGE_CODE.includes(cls), `${cls} must remain in use`);
  }
  assert.match(
    functionBody('NextActionWidget'),
    /<span className="rb-evidence-muted" style=\{styles\.nextActionCmdLabel\}>/,
    'the PR #13 command-label fix is undisturbed'
  );
});

/* ========================================================================== *
 * 23-23b. the two operational panels (TOP-LEVEL PANELS, PART 1)
 *
 * `CommandCentrePanel` and `DecisionConsolePanel` are IMPORTED components that
 * each owned a module-local `#fff` surface with hard-coded dark text — opaque
 * white islands once the shell went dark. They are the first two of the five
 * remaining top-level panels; the other three follow in part 2.
 *
 * Read from their own files for the same reason the nested panels are: the
 * pairing invariant this suite protects cannot be checked from page.tsx, which
 * this tranche deliberately does not touch at all.
 * ========================================================================== */

const PART1_PANELS = ['CommandCentrePanel', 'DecisionConsolePanel'] as const;

/** Comment-stripped, so prose naming a retired literal cannot satisfy a check. */
const PART1_SRC: Record<(typeof PART1_PANELS)[number], string> = Object.fromEntries(
  PART1_PANELS.map((n) => [n, codeOf(readFileSync(`src/components/${n}.tsx`, 'utf8'))])
) as Record<(typeof PART1_PANELS)[number], string>;

/** One named style entry of a component source, bounded to itself. */
function entryOf(name: (typeof PART1_PANELS)[number], key: string): string {
  const found = styleEntries(PART1_SRC[name]).find((e) => e.name === key);
  assert.ok(found, `${name}.${key} must exist as a bounded style entry`);
  return found.body;
}

/** The four priorities, in the order the console declares them. */
const CONSOLE_PRIORITIES = ['next_action', 'warning', 'monitor', 'good'] as const;

/** Legacy literals both panels must no longer contain, bounded so `#fff` never matches `#fff8c5`. */
const PART1_RETIRED = ['#fff', '#1f2328', '#d0d7de', '#57606a', '#656d76', '#8c959f', '#eaeef2'];

test('23. the two operational panels are a paired token region (top-level part 1)', () => {
  /* --- A. both roots take the paired surface, in the same change ---------- */

  for (const name of PART1_PANELS) {
    assert.match(
      PART1_SRC[name],
      /<section className="rb-evidence-panel" style=\{styles\.panel\}/,
      `${name} root must take the paired token surface`
    );

    /*
     * The root style is GEOMETRY ONLY. A background, foreground, border or
     * radius here would either fight the class or strand half of the pair on
     * it. `borderRadius` is included deliberately: `--rb-radius-card` is 10px,
     * so the class reproduces the legacy value and a duplicate would be drift
     * waiting to happen.
     */
    const root = entryOf(name, 'panel');
    assert.equal(/background:/.test(root), false, `${name} takes its surface from the class`);
    assert.equal(/\bcolor:/.test(root), false, `${name} takes its foreground from the class`);
    assert.equal(/border/i.test(root), false, `${name} takes its border and radius from the class`);
    for (const geometry of ["padding: '10px 14px'", "margin: '12px 0 4px'"]) {
      assert.ok(root.includes(geometry), `${name} root must keep ${geometry}`);
    }
  }

  /* --- B. every text role takes the token matching its old tier ----------- */

  const ROLES = [
    ['CommandCentrePanel', 'title', '--rb-text-secondary'],
    ['CommandCentrePanel', 'reasons', '--rb-text-muted'],
    ['CommandCentrePanel', 'rowLabel', '--rb-text-muted'],
    ['CommandCentrePanel', 'statLabel', '--rb-text-muted'],
    ['CommandCentrePanel', 'warn', '--rb-status-warning'],
    ['CommandCentrePanel', 'bad', '--rb-status-failure'],
    ['CommandCentrePanel', 'ok', '--rb-status-positive'],
    ['DecisionConsolePanel', 'title', '--rb-text-secondary'],
    ['DecisionConsolePanel', 'counts', '--rb-text-muted'],
    ['DecisionConsolePanel', 'reason', '--rb-text-muted'],
    ['DecisionConsolePanel', 'countdown', '--rb-accent-analytical'],
    ['DecisionConsolePanel', 'moreSummary', '--rb-text-muted'],
    ['DecisionConsolePanel', 'empty', '--rb-text-muted'],
  ] as const;

  for (const [name, key, token] of ROLES) {
    assert.ok(
      entryOf(name, key).includes(`color: 'var(${token})'`),
      `${name}.${key} must take ${token}`
    );
  }

  /*
   * Structure carried alongside those colours is unchanged — a repaint must not
   * quietly restyle. The tone weights differ (700 vs 600) and are pinned apart.
   */
  for (const [name, key, geometry] of [
    ['CommandCentrePanel', 'rowLabel', 'width: 52'],
    ['CommandCentrePanel', 'rowLabel', 'flexShrink: 0'],
    ['CommandCentrePanel', 'rowLabel', 'fontSize: 10'],
    ['CommandCentrePanel', 'statLabel', 'marginRight: 4'],
    ['CommandCentrePanel', 'warn', 'fontWeight: 700'],
    ['CommandCentrePanel', 'bad', 'fontWeight: 700'],
    ['CommandCentrePanel', 'ok', 'fontWeight: 600'],
    ['DecisionConsolePanel', 'moreSummary', "cursor: 'pointer'"],
    ['DecisionConsolePanel', 'countdown', "whiteSpace: 'nowrap'"],
    ['DecisionConsolePanel', 'raceName', 'fontWeight: 600'],
  ] as const) {
    assert.ok(entryOf(name, key).includes(geometry), `${name}.${key} must keep ${geometry}`);
  }

  /*
   * The row separator follows the surface: a fixed near-white hairline on a
   * dark token panel reads as a bright seam. Decorative — no 3:1 floor claimed.
   */
  const row = entryOf('DecisionConsolePanel', 'row');
  assert.ok(
    row.includes("borderTop: '1px dashed var(--rb-border)'"),
    'the console row rule must be token-backed'
  );
  assert.equal(/#[0-9a-fA-F]{6}/.test(row), false, 'and hold no legacy literal');

  /* --- C. the counts row is no longer a chip colour without its fill ------ */

  /*
   * THE DEFECT THIS CLOSES.
   *
   * The four count spans reused `CHIP_PALETTE[p].color` as BARE TEXT on the
   * panel surface — a chip foreground with no fill behind it. On the token
   * panel those literals fall to 2.18-3.40:1 in the dark scheme (section D of
   * test 23b). A SEPARATE map now owns that role, so the chip pair and the
   * bare-text role cannot be confused for one another again.
   */
  const console_ = PART1_SRC.DecisionConsolePanel;
  assert.equal(
    /color: CHIP_PALETTE\.\w+\.color/.test(console_),
    false,
    'no chip foreground may be used as bare text on the panel surface'
  );

  const mapBody = /const CONSOLE_COUNT_COLOR: Record<ConsolePriority, string> = \{([^}]*)\}/.exec(
    console_
  );
  assert.ok(mapBody, 'CONSOLE_COUNT_COLOR must exist as a bounded map');

  /*
   * Parsed BY NAME and in source order, not counted: a count alone would still
   * pass if one priority were renamed and another duplicated. This map is a
   * flat string record, so `styleEntries` cannot see it — the same blind spot
   * `badgeStyleBranches` exists to close for the ML panel's returned branches.
   */
  assert.deepEqual(
    [...mapBody[1].matchAll(/(\w+): '(var\(--rb-[a-z-]+\))'/g)].map((m) => [m[1], m[2]]),
    [
      ['next_action', 'var(--rb-accent-analytical)'],
      ['warning', 'var(--rb-status-failure)'],
      ['monitor', 'var(--rb-status-warning)'],
      ['good', 'var(--rb-status-positive)'],
    ],
    'every priority must map to a dark-aware token, in declaration order'
  );

  for (const priority of CONSOLE_PRIORITIES) {
    assert.ok(
      console_.includes(`color: CONSOLE_COUNT_COLOR.${priority}`),
      `the ${priority} count must consume the token map`
    );
  }

  /* --- D. the pairing invariant, checked per style entry ------------------ */

  for (const name of PART1_PANELS) {
    const entries = styleEntries(PART1_SRC[name]);
    for (const entry of entries) {
      const fg = /color: '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      if (fg) {
        assert.ok(
          /(background|bg): '#[0-9a-fA-F]{6}'/.test(entry.body),
          `${name}.${entry.name} keeps the legacy foreground ${fg[1]} without its own background`
        );
      }
      if (/(background|bg): '#[0-9a-fA-F]{6}'/.test(entry.body)) {
        assert.equal(
          /color: 'var\(--rb-/.test(entry.body),
          false,
          `${name}.${entry.name} puts a dark-aware token colour on a fixed light background`
        );
      }
    }

    /*
     * GUARDS THE PARSER ITSELF. Every hex literal left in the file must sit
     * inside an entry the loops above actually read. If a colour ever moves
     * into a shape `styleEntries` cannot see — a returned object literal, a
     * flat string map — this fails instead of the sweep silently shrinking.
     */
    const total = [...PART1_SRC[name].matchAll(/#[0-9a-fA-F]{6}/g)].length;
    const covered = entries.reduce(
      (n, e) => n + [...e.body.matchAll(/#[0-9a-fA-F]{6}/g)].length,
      0
    );
    assert.equal(
      covered,
      total,
      `${name} has ${total - covered} hex literal(s) outside any parsed style entry`
    );
    assert.ok(total > 0, `${name} must still declare its self-contained chips`);
  }

  /* --- E. the chips are retained, complete, and named --------------------- */

  const badges = styleEntries(PART1_SRC.CommandCentrePanel).filter((e) =>
    ['green', 'amber', 'red'].includes(e.name)
  );
  assert.deepEqual(
    badges.map((b) => b.name),
    ['green', 'amber', 'red'],
    'all three health badges must be parsed, in source order'
  );
  const chips = styleEntries(PART1_SRC.DecisionConsolePanel).filter((e) =>
    (CONSOLE_PRIORITIES as readonly string[]).includes(e.name)
  );
  assert.deepEqual(
    chips.map((c) => c.name),
    [...CONSOLE_PRIORITIES],
    'all four priority chips must be parsed, in source order'
  );
  for (const chip of [...badges, ...chips]) {
    assert.match(chip.body, /color: '#[0-9a-fA-F]{6}'/, `${chip.name} must keep its foreground`);
    assert.match(chip.body, /bg: '#[0-9a-fA-F]{6}'/, `${chip.name} must keep its own fill`);
    assert.match(chip.body, /border: '#[0-9a-fA-F]{6}'/, `${chip.name} must keep its own edge`);
  }
  // The badge word is the non-colour signal and must survive the repaint.
  for (const label of ['GREEN', 'AMBER', 'RED']) {
    assert.ok(
      PART1_SRC.CommandCentrePanel.includes(`label: '${label}'`),
      `the ${label} badge must keep its text label`
    );
  }

  /* --- F. retirement ------------------------------------------------------ */

  for (const name of PART1_PANELS) {
    for (const legacy of PART1_RETIRED) {
      assert.equal(
        new RegExp(`${legacy}(?![0-9a-fA-F])`).test(PART1_SRC[name]),
        false,
        `${name} must no longer declare ${legacy}`
      );
    }
  }

  /* --- G. no new class, and none invented --------------------------------- */

  const used = [
    ...new Set(
      PART1_PANELS.flatMap((n) =>
        [...PART1_SRC[n].matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/ +/))
      )
    ),
  ];
  assert.deepEqual(used, ['rb-evidence-panel'], 'exactly the one existing paired class is used');
  assert.match(TOKENS_CSS, /\.rb-evidence-panel \{/, 'and it must already exist in tokens.css');
  assert.equal(
    /\.rb-[a-z_-]*(command|console|centre|priority)/.test(TOKENS_CSS),
    false,
    'no bespoke class was invented for these panels'
  );

  /* --- H. behaviour freeze ------------------------------------------------ */

  for (const name of PART1_PANELS) {
    for (const write of ['fetch(', 'useEffect', 'useState', 'onClick', 'onSubmit', 'method:', '--commit', '/api/']) {
      assert.equal(
        PART1_SRC[name].includes(write),
        false,
        `${name} is presentational and read-only; it must not contain ${write}`
      );
    }
  }
  for (const [name, aria] of [
    ['CommandCentrePanel', 'Race-day command centre'],
    ['DecisionConsolePanel', 'Race-day decision console'],
  ] as const) {
    assert.ok(PART1_SRC[name].includes(`aria-label="${aria}"`), `${name} keeps its aria-label`);
  }
  assert.match(console_, /CONSOLE_VISIBLE_ROWS = 3/, 'the top-three contract is unchanged');
  assert.match(console_, /<details>/, 'the remaining rows still collapse natively');
  assert.ok(
    console_.includes('No races in scope — nothing needs attention.'),
    'the empty-state wording is unchanged'
  );
  assert.ok(console_.includes("item.race_name ?? '(unknown race)'"), 'the name fallback is unchanged');
  assert.ok(
    console_.includes('item.countdown !== null && item.countdown !== item.reason'),
    'the countdown suppression rule is unchanged'
  );
  assert.ok(
    PART1_SRC.CommandCentrePanel.includes('badgeReasons.length > 0'),
    'the reasons guard is unchanged'
  );

  /* --- I. this tranche touches neither page.tsx nor tokens.css ------------ */

  for (const name of PART1_PANELS) {
    assert.match(
      PAGE_CODE,
      new RegExp(`<${name} view=\\{\\w+\\} />`),
      `${name} must still be rendered from page.tsx with no style prop`
    );
  }

  /* --- J. the prior tranches are undisturbed ------------------------------ */

  assert.match(
    PAGE_CODE,
    /const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';/,
    'the containment surface remains active — the page frame is still legacy'
  );
  assert.ok(
    styleBlock('page').includes('background: LEGACY_LIGHT_PAGE_SURFACE'),
    'and is still applied to the page wrapper'
  );
  for (const forbidden of ['var(--rb-text-', 'var(--rb-status-', 'var(--rb-accent-']) {
    assert.equal(
      PAGE_SRC.includes(forbidden),
      false,
      `${forbidden} must still not appear in page.tsx — this tranche does not touch it`
    );
  }
  assert.match(
    functionBody('TipsterStatusPanel'),
    /<section className="rb-evidence-panel" style=\{styles\.tipsterPanel\}>/,
    'the PR #14 tipster migration is undisturbed'
  );
  assert.ok(
    functionBody('RaceDayNav').includes('raceDaySecondaryLinkStyle'),
    'the PR #15 nav links still take their corrected style'
  );
  assert.match(
    PAGE_CODE,
    /const raceDaySecondaryLinkStyle: CSSProperties = \{[^}]*color: '#0550ae'/,
    'and the PR #15 contrast correction itself is undisturbed'
  );
});

test('23b. every part-1 panel foreground clears AA on the surface it now takes', () => {
  /*
   * The surface is DERIVED from `.rb-evidence-panel`, the class both roots
   * actually carry, so a future raised/elevated change fails here rather than
   * shipping. Token-level calculation; it reads no computed style.
   */
  const rule = cssRule('.rb-evidence-panel');
  const bg = /background: var\((--rb-surface-[a-z-]+)\)/.exec(rule);
  assert.ok(bg, '.rb-evidence-panel must declare a var(--rb-surface-*) background');
  const surface = { light: lightToken(bg[1]), dark: darkToken(bg[1]) };

  /* --- A. every token these two files use, collected FROM SOURCE ---------- */

  const used = new Set<string>();
  for (const name of PART1_PANELS) {
    for (const m of PART1_SRC[name].matchAll(/'var\((--rb-[a-z-]+)\)'/g)) used.add(m[1]);
  }
  /*
   * `--rb-border` is a decorative hairline, not text. It is deliberately
   * excluded from the AA sweep and no 3:1 floor is claimed for it.
   */
  used.delete('--rb-border');
  assert.ok(
    used.size >= 5,
    `expected several token text roles, found ${[...used].sort().join(', ')}`
  );

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

  /* --- B. the self-contained chips, on their OWN fills -------------------- */

  let chipsMeasured = 0;
  for (const name of PART1_PANELS) {
    for (const entry of styleEntries(PART1_SRC[name])) {
      const fg = /color: '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      const fill = /bg: '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      if (!fg || !fill) continue;
      chipsMeasured += 1;
      const ratio = contrast(fg[1], fill[1]);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${name}.${entry.name} chip is ${ratio.toFixed(2)}:1 (${fg[1]} on ${fill[1]})`
      );
    }
  }
  assert.equal(chipsMeasured, 7, 'three health badges and four priority chips must be measured');

  /* --- C. #8c959f was ALREADY FAILING, in the light scheme ---------------- */

  /*
   * Not part of the atomicity list below, because it is the one legacy value
   * here that would have PASSED on the dark token surface (5.45:1). It failed
   * on the surface it actually had: 10px is normal text, so the 4.5:1 floor
   * applied, and it measured 3.04:1 on `#fff`. Part 2b-ii resolved the same
   * literal in RaceIntelligencePanel the same way; recording it as a fixed
   * pre-existing defect stops it being mistaken for a change this tranche made.
   */
  const wasFailing = contrast('#8c959f', '#ffffff');
  assert.ok(
    wasFailing < AA_NORMAL_TEXT,
    `#8c959f was expected to fail on white, but measured ${wasFailing.toFixed(2)}:1`
  );
  assert.equal(
    PART1_SRC.CommandCentrePanel.includes('#8c959f'),
    false,
    'the faint tier folded into --rb-text-muted; the failing literal must be gone'
  );

  /* --- D. why the migration had to be atomic ------------------------------ */

  /*
   * Every legacy foreground these two panels carried as BARE TEXT fails on the
   * surface they now take, in the dark scheme. Moving the root without them —
   * or them without the root — produces exactly the half-migration this suite
   * exists to catch. The chip fills are absent from this list on purpose: they
   * are self-contained and the surface cannot reach them.
   */
  const darkSurface = darkToken(bg[1]);
  for (const [legacy, what] of [
    ['#1f2328', 'legacy root foreground'],
    ['#57606a', 'legacy titles, reasons, counts, reason'],
    ['#656d76', 'legacy stat label, summary, empty state'],
    ['#0550ae', 'legacy countdown and NEXT ACTION count'],
    ['#cf222e', 'legacy bad tone and WARNING count'],
    ['#1a7f37', 'legacy ok tone and GOOD count'],
    ['#9a6700', 'legacy warn tone and MONITOR count'],
  ] as const) {
    const ratio = contrast(legacy, darkSurface);
    assert.ok(
      ratio < AA_NORMAL_TEXT,
      `${what}: expected ${legacy} to fail on ${darkSurface}, but it was ${ratio.toFixed(2)}:1`
    );
  }
});

/* ========================================================================== *
 * 24-24b. proof, timeline and place audit (TOP-LEVEL PANELS, PART 2)
 *
 * The last three of the five top-level panels. Each owned a `#fff` root with
 * hard-coded dark text, and TWO of them owned a SECOND fixed-light surface as
 * well — the proof rows and the place-audit cells, both `#f6f8fa`.
 *
 * That inner surface is what makes this tranche different from part 1. A root
 * can be migrated and still leave a bright well inside it holding inherited
 * light text; on the dark scheme that pairing measures 1.06:1, which is worse
 * than not migrating the root at all. So surface and foreground move together
 * at BOTH levels here, and the text on an inner surface is measured against
 * the INNER surface — not against the panel behind it.
 * ========================================================================== */

const PART2_PANELS = [
  'ProofOfUpdatePanel',
  'RaceTimelinePanel',
  'PlaceAuditPanel',
] as const;

type Part2Panel = (typeof PART2_PANELS)[number];

/** Comment-stripped, so prose naming a retired literal cannot satisfy a check. */
const PART2_SRC: Record<Part2Panel, string> = Object.fromEntries(
  PART2_PANELS.map((n) => [n, codeOf(readFileSync(`src/components/${n}.tsx`, 'utf8'))])
) as Record<Part2Panel, string>;

/** One named style entry of a part-2 component source, bounded to itself. */
function part2Entry(name: Part2Panel, key: string): string {
  const found = styleEntries(PART2_SRC[name]).find((e) => e.name === key);
  assert.ok(found, `${name}.${key} must exist as a bounded style entry`);
  return found.body;
}

/**
 * Retired literals, PER COMPONENT — deliberately not one shared list.
 *
 * `#d0d7de`, `#424a53`, `#f6f8fa` and `#9a6700` are retired from some of these
 * files while being legitimately RETAINED by others inside a self-contained
 * badge: the timeline's neutral pill is `#424a53` on `#f6f8fa` with a
 * `#d0d7de` edge. A single shared list would have to drop exactly the literals
 * most worth checking, so each file states its own.
 */
const PART2_RETIRED: Record<Part2Panel, readonly string[]> = {
  ProofOfUpdatePanel: [
    '#fff',
    '#1f2328',
    '#d0d7de',
    '#f6f8fa',
    '#424a53',
    '#57606a',
    '#1a7f37',
    '#9a6700',
  ],
  RaceTimelinePanel: ['#fff', '#1f2328', '#656d76', '#eaeef2'],
  PlaceAuditPanel: [
    '#fff',
    '#1f2328',
    '#d0d7de',
    '#f6f8fa',
    '#eaeef2',
    '#424a53',
    '#656d76',
  ],
};

/**
 * Exactly how many fixed colours each file may still declare.
 *
 * Pinned as a NUMBER, not as "> 0": the proof panel legitimately ends with
 * ZERO, so a `> 0` floor would be false there and a `>= 0` floor would be
 * vacuous everywhere. The timeline keeps four badge tones plus a warning chip
 * (5 x 3 = 15); the place audit keeps a marker badge and a pending notice
 * (2 x 3 = 6).
 */
const PART2_FIXED_COLOUR_COUNT: Record<Part2Panel, number> = {
  ProofOfUpdatePanel: 0,
  RaceTimelinePanel: 15,
  PlaceAuditPanel: 6,
};

/** The self-contained chips each file retains, by style-entry name. */
const PART2_CHIPS: Record<Part2Panel, readonly string[]> = {
  ProofOfUpdatePanel: [],
  RaceTimelinePanel: ['pos', 'neg', 'warn', 'neutral', 'warnChip'],
  PlaceAuditPanel: ['markerBadge', 'pending'],
};

test('24. proof, timeline and place audit are a paired token region (top-level part 2)', () => {
  /* --- A. all three roots take the paired surface, in the same change ----- */

  for (const name of PART2_PANELS) {
    assert.match(
      PART2_SRC[name],
      /<section\s+className="rb-evidence-panel"/,
      `${name} root must take the paired token surface`
    );

    /*
     * The root style is GEOMETRY ONLY. A background, foreground, border or
     * radius here would either fight the class or strand half of the pair on
     * it. `borderRadius` is included deliberately: `--rb-radius-card` is 10px,
     * so the class reproduces the legacy value and a duplicate would be drift
     * waiting to happen.
     */
    const root = part2Entry(name, 'panel');
    assert.equal(/background:/.test(root), false, `${name} takes its surface from the class`);
    assert.equal(/\bcolor:/.test(root), false, `${name} takes its foreground from the class`);
    assert.equal(/border/i.test(root), false, `${name} takes its border and radius from the class`);
    for (const geometry of ['padding: 16', "fontFamily: 'system-ui", 'marginBottom: 16']) {
      assert.ok(root.includes(geometry), `${name} root must keep ${geometry}`);
    }
  }

  /*
   * STYLE-PROP MERGING IS PART OF THE CONTRACT, and the two panels that accept
   * a `style` prop merge it DIFFERENTLY — one unconditionally, one only when
   * the prop is present. Both forms are pinned exactly as written, because
   * "adds a className" must not quietly become "rewrites how the override
   * composes". The timeline takes no `style` prop at all and must not grow one.
   */
  assert.match(
    PART2_SRC.ProofOfUpdatePanel,
    /style=\{\{ \.\.\.styles\.panel, \.\.\.style \}\}/,
    'the proof panel still merges its style prop over the container'
  );
  assert.match(
    PART2_SRC.PlaceAuditPanel,
    /style=\{style \? \{ \.\.\.styles\.panel, \.\.\.style \} : styles\.panel\}/,
    'the place-audit panel still merges its style prop conditionally'
  );
  assert.match(
    PART2_SRC.RaceTimelinePanel,
    /<section className="rb-evidence-panel" style=\{styles\.panel\}>/,
    'the timeline root is unchanged apart from the class'
  );
  assert.equal(
    /style\?: CSSProperties/.test(PART2_SRC.RaceTimelinePanel),
    false,
    'the timeline must not have gained a style prop'
  );

  /* --- B. every text role takes the token matching its old tier ----------- */

  const ROLES = [
    ['ProofOfUpdatePanel', 'label', '--rb-text-secondary'],
    ['ProofOfUpdatePanel', 'disclaimer', '--rb-text-muted'],
    ['RaceTimelinePanel', 'note', '--rb-text-muted'],
    ['RaceTimelinePanel', 'metaRow', '--rb-text-muted'],
    ['RaceTimelinePanel', 'empty', '--rb-text-muted'],
    ['RaceTimelinePanel', 'stale', '--rb-status-warning'],
    ['PlaceAuditPanel', 'markerRow', '--rb-text-secondary'],
    ['PlaceAuditPanel', 'cellLabel', '--rb-text-muted'],
    ['PlaceAuditPanel', 'disclaimers', '--rb-text-muted'],
  ] as const;

  for (const [name, key, token] of ROLES) {
    assert.ok(
      part2Entry(name, key).includes(`color: 'var(${token})'`),
      `${name}.${key} must take ${token}`
    );
  }

  /* Structure carried alongside those colours is unchanged. */
  for (const [name, key, geometry] of [
    ['ProofOfUpdatePanel', 'label', 'fontWeight: 600'],
    ['ProofOfUpdatePanel', 'disclaimer', 'lineHeight: 1.5'],
    ['RaceTimelinePanel', 'stale', 'fontWeight: 700'],
    ['RaceTimelinePanel', 'note', 'fontSize: 12'],
    ['PlaceAuditPanel', 'cellLabel', 'marginBottom: 2'],
    ['PlaceAuditPanel', 'disclaimers', 'paddingLeft: 18'],
  ] as const) {
    assert.ok(part2Entry(name, key).includes(geometry), `${name}.${key} must keep ${geometry}`);
  }

  /* --- C. the INNER surfaces moved with the outer one --------------------- */

  /*
   * THE DEFECT THIS TRANCHE CLOSES BEYOND PART 1.
   *
   * The proof rows and the place-audit cells are surfaces in their own right.
   * Migrating only the root would leave a fixed near-white well holding the
   * root's inherited token foreground — 1.06:1 in the dark scheme (section D
   * of test 24b). Both take the recessed token, and the place cell's edge
   * follows too, because a fixed near-white border on a dark tile is the same
   * bright-seam defect as a fixed row rule.
   */
  const proofRow = part2Entry('ProofOfUpdatePanel', 'row');
  assert.ok(
    proofRow.includes("background: 'var(--rb-surface-inset)'"),
    'the proof rows must take the recessed token surface'
  );
  assert.equal(/#[0-9a-fA-F]{6}/.test(proofRow), false, 'and hold no fixed colour');

  const placeCell = part2Entry('PlaceAuditPanel', 'cell');
  assert.ok(
    placeCell.includes("background: 'var(--rb-surface-inset)'"),
    'the place-audit cells must take the recessed token surface'
  );
  assert.ok(
    placeCell.includes("border: '1px solid var(--rb-border)'"),
    'and their edge must follow the surface too'
  );
  assert.equal(/#[0-9a-fA-F]{6}/.test(placeCell), false, 'and hold no fixed colour');

  /*
   * The timeline has NO inner surface — its rows are separated by a rule, not
   * a fill. That rule is decorative: no 3:1 non-text floor is claimed for it.
   */
  const timelineRow = part2Entry('RaceTimelinePanel', 'row');
  assert.ok(
    timelineRow.includes("borderTop: '1px dashed var(--rb-border)'"),
    'the timeline row rule must be token-backed'
  );
  assert.equal(/#[0-9a-fA-F]{6}/.test(timelineRow), false, 'and hold no legacy literal');

  /* --- D. TONE_COLOR: a flat map, parsed by name -------------------------- */

  /*
   * `styleEntries` matches `name: {`, so a FLAT STRING RECORD is invisible to
   * it — the same blind spot `badgeStyleBranches` exists to close for the ML
   * panel and `CONSOLE_COUNT_COLOR` for the decision console. Parsed BY NAME
   * and in source order, not counted: a count alone would still pass if one
   * tone were renamed and another duplicated.
   */
  const proof = PART2_SRC.ProofOfUpdatePanel;
  const toneBody = /const TONE_COLOR: Record<ProofTone, string> = \{([^}]*)\}/.exec(proof);
  assert.ok(toneBody, 'TONE_COLOR must exist as a bounded map');
  assert.deepEqual(
    [...toneBody[1].matchAll(/(\w+): '(var\(--rb-[a-z-]+\))'/g)].map((m) => [m[1], m[2]]),
    [
      ['ok', 'var(--rb-status-positive)'],
      ['warn', 'var(--rb-status-warning)'],
      ['neutral', 'var(--rb-text-muted)'],
    ],
    'every proof tone must map to a dark-aware token, in declaration order'
  );

  /*
   * IT MUST NOT BECOME A CHIP PALETTE. These three are BARE TEXT on the inset
   * row; the row owns the fill. Giving each tone its own background would turn
   * a table of evidence into a row of pills and change what the panel is.
   */
  assert.equal(
    /(background|bg):/.test(toneBody[1]),
    false,
    'TONE_COLOR is a foreground-only map and must not grow a fill'
  );
  assert.ok(
    proof.includes('color: TONE_COLOR[r.tone]'),
    'the proof values must consume TONE_COLOR'
  );

  /* --- E. the pairing invariant, checked per style entry ------------------ */

  for (const name of PART2_PANELS) {
    const entries = styleEntries(PART2_SRC[name]);
    for (const entry of entries) {
      const fg = /color: '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      if (fg) {
        assert.ok(
          /(background|bg): '#[0-9a-fA-F]{6}'/.test(entry.body),
          `${name}.${entry.name} keeps the legacy foreground ${fg[1]} without its own background`
        );
      }
      if (/(background|bg): '#[0-9a-fA-F]{6}'/.test(entry.body)) {
        assert.equal(
          /color: 'var\(--rb-/.test(entry.body),
          false,
          `${name}.${entry.name} puts a dark-aware token colour on a fixed light background`
        );
      }
    }

    /*
     * GUARDS THE PARSER ITSELF. Every hex literal left in the file must sit
     * inside an entry the loop above actually reads, and the total is pinned
     * per file. If a colour ever moves into a shape `styleEntries` cannot see
     * — a returned object literal, a flat string map — this fails instead of
     * the sweep silently shrinking.
     */
    const total = [...PART2_SRC[name].matchAll(/#[0-9a-fA-F]{6}/g)].length;
    const covered = entries.reduce(
      (n, e) => n + [...e.body.matchAll(/#[0-9a-fA-F]{6}/g)].length,
      0
    );
    assert.equal(
      covered,
      total,
      `${name} has ${total - covered} hex literal(s) outside any parsed style entry`
    );
    assert.equal(
      total,
      PART2_FIXED_COLOUR_COUNT[name],
      `${name} must declare exactly ${PART2_FIXED_COLOUR_COUNT[name]} fixed colour(s)`
    );
  }

  /* The proof panel is the one file here that ends with no fixed colour at all. */
  assert.equal(
    /#[0-9a-fA-F]{6}/.test(PART2_SRC.ProofOfUpdatePanel),
    false,
    'ProofOfUpdatePanel retains no fixed colour: it has no self-contained chip'
  );

  /* --- F. the retained chips are complete, named and in source order ------ */

  for (const name of PART2_PANELS) {
    const expected = PART2_CHIPS[name];
    const chips = styleEntries(PART2_SRC[name]).filter((e) => expected.includes(e.name));
    assert.deepEqual(
      chips.map((c) => c.name),
      [...expected],
      `${name} must parse exactly its self-contained chips, in source order`
    );
    for (const chip of chips) {
      assert.match(
        chip.body,
        /color: '#[0-9a-fA-F]{6}'/,
        `${name}.${chip.name} must keep its foreground`
      );
      assert.match(
        chip.body,
        /(background|bg): '#[0-9a-fA-F]{6}'/,
        `${name}.${chip.name} must keep its own fill`
      );
      assert.match(
        chip.body,
        /border: '(1px solid )?#[0-9a-fA-F]{6}'/,
        `${name}.${chip.name} must keep its own edge`
      );
    }
  }

  /*
   * The timeline palette must stay in the NAMED-ENTRY form. Rewritten as four
   * `return {…}` branches it would become invisible to `styleEntries`, exactly
   * as the ML panel's `badgeStyle` was — and only the hex-coverage guard above
   * would catch it, so this states the requirement directly.
   */
  assert.match(
    PART2_SRC.RaceTimelinePanel,
    /const palette: Record<StatusTone, \{ bg: string; border: string; color: string \}> = \{/,
    'the timeline badge palette must remain a named-entry record'
  );

  /* --- G. retirement, per component --------------------------------------- */

  for (const name of PART2_PANELS) {
    for (const legacy of PART2_RETIRED[name]) {
      assert.equal(
        new RegExp(`${legacy}(?![0-9a-fA-F])`).test(PART2_SRC[name]),
        false,
        `${name} must no longer declare ${legacy}`
      );
    }
  }

  /*
   * AND THE LISTS MUST BE GENUINELY DIFFERENT, not three copies of one list.
   *
   * These three literals are RETIRED from the proof and place panels but
   * legitimately RETAINED by the timeline's self-contained neutral pill. If a
   * future edit collapsed the per-component lists into one shared list, either
   * the timeline would fail the retirement check for a colour it is entitled
   * to keep, or the shared list would have to drop these three and stop
   * checking them anywhere. This pins both halves of that distinction.
   */
  for (const retained of ['#d0d7de', '#424a53', '#f6f8fa']) {
    assert.ok(
      PART2_SRC.RaceTimelinePanel.includes(retained),
      `${retained} must still be RETAINED by the timeline's self-contained neutral pill`
    );
    assert.equal(
      PART2_RETIRED.RaceTimelinePanel.includes(retained),
      false,
      `${retained} must not be on the timeline's retirement list — it is legitimately retained`
    );
  }

  /* --- H. no new class, and none invented --------------------------------- */

  const used = [
    ...new Set(
      PART2_PANELS.flatMap((n) =>
        [...PART2_SRC[n].matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/ +/))
      )
    ),
  ];
  assert.deepEqual(used, ['rb-evidence-panel'], 'exactly the one existing paired class is used');
  assert.match(TOKENS_CSS, /\.rb-evidence-panel \{/, 'and it must already exist in tokens.css');
  assert.equal(
    /\.rb-[a-z_-]*(proof|timeline|place|audit)/.test(TOKENS_CSS),
    false,
    'no bespoke class was invented for these panels'
  );

  /* --- I. behaviour freeze ------------------------------------------------ */

  for (const name of PART2_PANELS) {
    for (const write of ['fetch(', 'useEffect', 'useState', 'onSubmit', 'method:', '/api/']) {
      assert.equal(
        PART2_SRC[name].includes(write),
        false,
        `${name} is presentational and read-only; it must not contain ${write}`
      );
    }
  }

  /* Headings and aria semantics. */
  for (const [name, heading] of [
    ['ProofOfUpdatePanel', '<h2 style={styles.heading}>{view.title}</h2>'],
    ['RaceTimelinePanel', '<h2 style={styles.heading}>Race-day timeline</h2>'],
    ['PlaceAuditPanel', '<h2 style={styles.heading}>Place / each-way audit (research)</h2>'],
  ] as const) {
    assert.ok(PART2_SRC[name].includes(heading), `${name} keeps its h2 exactly`);
  }
  for (const [name, aria] of [
    ['ProofOfUpdatePanel', 'Proof of update (read-only)'],
    ['PlaceAuditPanel', 'Place / each-way audit (research)'],
  ] as const) {
    assert.ok(PART2_SRC[name].includes(`aria-label="${aria}"`), `${name} keeps its aria-label`);
  }
  /* The timeline is named by its visible h2 and must NOT gain an aria-label. */
  assert.equal(
    /aria-label/.test(PART2_SRC.RaceTimelinePanel),
    false,
    'the timeline stays named by its visible heading'
  );

  /* Conditional states: every branch that decides what is rendered. */
  assert.ok(
    PART2_SRC.PlaceAuditPanel.includes('if (view.raceCount === 0) return null;'),
    'the empty-day condition is unchanged'
  );
  assert.ok(
    PART2_SRC.PlaceAuditPanel.includes(
      'const val = (n: number): string => (settled ? String(n) : DASH);'
    ),
    'the settled/pending value rule is unchanged'
  );
  assert.ok(PART2_SRC.PlaceAuditPanel.includes('{!settled && ('), 'the pending notice is unchanged');
  assert.ok(
    PART2_SRC.RaceTimelinePanel.includes('entries.length === 0 ?'),
    'the timeline empty condition is unchanged'
  );
  assert.ok(
    PART2_SRC.RaceTimelinePanel.includes('No races.'),
    'the timeline empty-state wording is unchanged'
  );
  assert.ok(
    PART2_SRC.RaceTimelinePanel.includes('result.label !== DASH &&'),
    'the result-badge condition is unchanged'
  );
  for (const [name, mapping] of [
    ['ProofOfUpdatePanel', 'view.rows.map'],
    ['ProofOfUpdatePanel', 'view.disclaimers.map'],
    ['RaceTimelinePanel', 'entry.warnings.map'],
    ['PlaceAuditPanel', 'view.warnings.map'],
  ] as const) {
    assert.ok(PART2_SRC[name].includes(mapping), `${name} must still map ${mapping}`);
  }
  assert.ok(
    PART2_SRC.RaceTimelinePanel.includes(
      'LOCK_TONE_TO_STATUS[LOCK_STATUS_TONE[entry.lockStatus]]'
    ),
    'the lock-status tone mapping is unchanged'
  );

  /* --- J. page.tsx still wires all three, and prior tranches hold --------- */

  for (const wiring of [
    '<ProofOfUpdatePanel view={proofPanelView} />',
    '<RaceTimelinePanel entries={timeline} nowMs={nowMs} />',
    '<PlaceAuditPanel view={placeAuditView} />',
  ]) {
    assert.ok(PAGE_CODE.includes(wiring), `page.tsx must still render ${wiring}`);
  }

  assert.match(
    PAGE_CODE,
    /const LEGACY_LIGHT_PAGE_SURFACE = '#e7ebf1';/,
    'the containment surface remains active — the page frame is still legacy'
  );
  assert.ok(
    styleBlock('page').includes('background: LEGACY_LIGHT_PAGE_SURFACE'),
    'and is still applied to the page wrapper'
  );
  for (const forbidden of ['var(--rb-text-', 'var(--rb-status-', 'var(--rb-accent-']) {
    assert.equal(
      PAGE_SRC.includes(forbidden),
      false,
      `${forbidden} must still not appear in page.tsx — this tranche does not touch it`
    );
  }
  /* PR A (part 1) is undisturbed. */
  for (const name of PART1_PANELS) {
    assert.match(
      PART1_SRC[name],
      /<section className="rb-evidence-panel" style=\{styles\.panel\}/,
      `the PR #16 ${name} migration is undisturbed`
    );
  }
  assert.match(
    functionBody('TipsterStatusPanel'),
    /<section className="rb-evidence-panel" style=\{styles\.tipsterPanel\}>/,
    'the PR #14 tipster migration is undisturbed'
  );
  assert.match(
    PAGE_CODE,
    /const raceDaySecondaryLinkStyle: CSSProperties = \{[^}]*color: '#0550ae'/,
    'and the PR #15 contrast correction is undisturbed'
  );
});

test('24b. every part-2 panel foreground clears AA on the surface it now sits on', () => {
  /*
   * BOTH surfaces are DERIVED, not assumed. The raised surface comes from
   * `.rb-evidence-panel`, the class all three roots carry. The recessed one
   * comes from the components' OWN declarations, so if the proof rows or the
   * place cells were ever repointed at a different token this test follows
   * them rather than silently measuring the wrong pair.
   */
  const rule = cssRule('.rb-evidence-panel');
  const rootBg = /background: var\((--rb-surface-[a-z-]+)\)/.exec(rule);
  assert.ok(rootBg, '.rb-evidence-panel must declare a var(--rb-surface-*) background');

  const insetNames = new Set(
    (['ProofOfUpdatePanel', 'PlaceAuditPanel'] as const).map((n) => {
      const m = /background: 'var\((--rb-surface-[a-z-]+)\)'/.exec(PART2_SRC[n]);
      assert.ok(m, `${n} must declare a var(--rb-surface-*) inner surface`);
      return m[1];
    })
  );
  assert.equal(insetNames.size, 1, 'both inner surfaces must use the SAME recessed token');
  const insetName = [...insetNames][0];
  assert.equal(insetName, '--rb-surface-inset', 'the inner surface is the recessed token');

  const raised = { light: lightToken(rootBg[1]), dark: darkToken(rootBg[1]) };
  const inset = { light: lightToken(insetName), dark: darkToken(insetName) };

  /* --- A. every token these three files use, collected FROM SOURCE -------- */

  /*
   * Deliberately NOT anchored to a quote on both sides. A token inside a
   * COMPOUND value — `'1px dashed var(--rb-border)'` — would escape a
   * fully-quoted match, and the point of this sweep is that nothing escapes
   * it. The two non-text tokens are then removed BY NAME, and each removal is
   * asserted to have actually removed something, so an exclusion can never
   * quietly become a no-op that hides a real text role.
   */
  const used = new Set<string>();
  for (const name of PART2_PANELS) {
    for (const m of PART2_SRC[name].matchAll(/var\((--rb-[a-z-]+)\)/g)) used.add(m[1]);
  }

  for (const structural of ['--rb-border', insetName]) {
    assert.ok(used.has(structural), `${structural} must be present before it is excluded`);
    used.delete(structural);
  }

  assert.ok(
    used.size >= 4,
    `expected several token text roles, found ${[...used].sort().join(', ')}`
  );

  /*
   * Every remaining token is TEXT, and these files put text on BOTH surfaces,
   * so each must clear AA on both. Requiring both is stricter than mapping
   * each role to one surface, and it can never under-measure.
   */
  for (const token of [...used].sort()) {
    for (const [surfaceName, surface] of [
      [rootBg[1], raised],
      [insetName, inset],
    ] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        const fg = scheme === 'light' ? lightToken(token) : darkToken(token);
        const ratio = contrast(fg, surface[scheme]);
        assert.ok(
          ratio >= AA_NORMAL_TEXT,
          `${token} on ${surfaceName} (${scheme}) is ${ratio.toFixed(2)}:1`
        );
      }
    }
  }

  /* --- B. the exact pairs, pinned ---------------------------------------- */

  /*
   * Computed, not estimated. Pinned to 0.05 so a token nudge that still
   * technically clears AA cannot silently change what the evidence says.
   */
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(
      Math.abs(actual - expected) < 0.05,
      `${what} expected ~${expected}:1, measured ${actual.toFixed(2)}:1`
    );

  for (const [token, l, d] of [
    ['--rb-text-primary', 15.88, 14.61],
    ['--rb-text-secondary', 8.42, 9.2],
    ['--rb-text-muted', 5.45, 5.6],
    ['--rb-status-warning', 6.02, 7.36],
  ] as const) {
    near(contrast(lightToken(token), raised.light), l, `${token} on the raised surface (light)`);
    near(contrast(darkToken(token), raised.dark), d, `${token} on the raised surface (dark)`);
  }

  for (const [token, l, d] of [
    ['--rb-text-primary', 13.91, 16.58],
    ['--rb-text-secondary', 7.38, 10.44],
    ['--rb-text-muted', 4.78, 6.35],
    ['--rb-status-positive', 5.23, 8.18],
    ['--rb-status-warning', 5.28, 8.35],
  ] as const) {
    near(contrast(lightToken(token), inset.light), l, `${token} on the recessed surface (light)`);
    near(contrast(darkToken(token), inset.dark), d, `${token} on the recessed surface (dark)`);
  }

  /*
   * THE TIGHTEST PAIR IN THE WHOLE TRANCHE, pinned on its own.
   *
   * Muted text on the recessed surface in the LIGHT scheme is 4.78:1 — it
   * clears the 4.5:1 floor with the least headroom of any role here, and it is
   * the pairing that both the place-audit cell labels and the proof `neutral`
   * tone land on. Any future darkening of the recessed token, or lightening of
   * the muted token, breaks this before it breaks anything else, so it gets a
   * named assertion rather than riding on the sweep above.
   */
  const tightest = contrast(lightToken('--rb-text-muted'), inset.light);
  near(tightest, 4.78, 'muted text on the recessed surface (light) — the tightest pair');
  assert.ok(
    tightest >= AA_NORMAL_TEXT,
    `the tightest pair must still clear AA, measured ${tightest.toFixed(2)}:1`
  );

  /* --- C. the self-contained chips, on their OWN fills -------------------- */

  let chipsMeasured = 0;
  for (const name of PART2_PANELS) {
    for (const entry of styleEntries(PART2_SRC[name])) {
      const fg = /color: '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      const fill = /(?:background|bg): '(#[0-9a-fA-F]{6})'/.exec(entry.body);
      if (!fg || !fill) continue;
      chipsMeasured += 1;
      const ratio = contrast(fg[1], fill[1]);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${name}.${entry.name} chip is ${ratio.toFixed(2)}:1 (${fg[1]} on ${fill[1]})`
      );
    }
  }
  assert.equal(
    chipsMeasured,
    Object.values(PART2_CHIPS).reduce((n, c) => n + c.length, 0),
    'every retained chip must be measured, and no more than those'
  );
  assert.equal(chipsMeasured, 7, 'five timeline chips and two place-audit chips');

  /* --- D. why the migration had to be atomic, at BOTH levels -------------- */

  /*
   * Every legacy foreground these three panels carried as bare text fails on
   * the surface it now sits on, in the dark scheme. The chip fills are absent
   * from this list on purpose: they are self-contained and the surface cannot
   * reach them.
   */
  for (const [legacy, surface, where, what] of [
    ['#1f2328', raised.dark, 'raised', 'legacy root foreground'],
    ['#656d76', raised.dark, 'raised', 'legacy timeline note, meta row and empty state'],
    ['#9a6700', raised.dark, 'raised', 'legacy timeline stale marker'],
    ['#57606a', raised.dark, 'raised', 'legacy proof disclaimer'],
    ['#424a53', inset.dark, 'recessed', 'legacy proof row label'],
    ['#656d76', inset.dark, 'recessed', 'legacy place-audit cell label'],
    ['#1a7f37', inset.dark, 'recessed', 'legacy proof ok tone'],
    ['#9a6700', inset.dark, 'recessed', 'legacy proof warn tone'],
    ['#57606a', inset.dark, 'recessed', 'legacy proof neutral tone'],
  ] as const) {
    const ratio = contrast(legacy, surface);
    assert.ok(
      ratio < AA_NORMAL_TEXT,
      `${what}: expected ${legacy} to fail on the ${where} surface (${surface}), but it was ${ratio.toFixed(2)}:1`
    );
  }

  /*
   * AND THE INNER SURFACE ITSELF. This is what part 2 adds over part 1: had
   * the roots migrated while the proof rows and place cells kept `#f6f8fa`,
   * that fixed near-white well would have held the root's inherited
   * DARK-SCHEME foreground at close to 1:1 — a worse result than never
   * migrating the root at all.
   */
  const strandedWell = contrast(darkToken('--rb-text-primary'), '#f6f8fa');
  assert.ok(
    strandedWell < 1.5,
    `a retained #f6f8fa well would have held dark-scheme primary text at ${strandedWell.toFixed(2)}:1`
  );
});
