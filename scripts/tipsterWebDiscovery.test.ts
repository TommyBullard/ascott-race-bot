/**
 * Tests for the public tipster DISCOVERY compliance planner.
 *
 * Proves subscription walls (Racing Post / Tipstrr / Betting Gods / Tipsters
 * Empire) are hard-BLOCKED and never fetchable, public sources require operator
 * confirmation, excerpts are truncated to short attributable snippets (never full
 * articles), the synthetic "Jon Vine" strategy is shadow-only, and that neither
 * the lib nor the CLI performs network I/O, touches the model, or places a bet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_EXCERPT_CHARS,
  SUBSCRIPTION_WALL_HOSTS,
  PUBLIC_SEED_SOURCES,
  extractHost,
  isSubscriptionWall,
  classifySource,
  truncateExcerpt,
  buildDiscoveryPlan,
} from '../src/lib/tipsterWebDiscovery';

const WALLS = [
  'https://www.racingpost.com/tips/',
  'https://members.racingpost.co.uk/x',
  'http://tipstrr.com/sport/horse-racing',
  'https://www.bettinggods.com/free-tips/',
  'https://tipstersempire.com/horse-racing',
  'tipsters-empire.co.uk/tips',
];

const PUBLIC = [
  'https://www.olbg.com/betting-tips/Horse_Racing/1',
  'https://www.horseracing.net/tips/royal-ascot',
  'https://www.freetips.com/horse-racing/',
];

test('every named subscription wall is blocked (any scheme/subdomain/path)', () => {
  for (const url of WALLS) {
    assert.equal(isSubscriptionWall(url), true, `should block ${url}`);
    const c = classifySource(url);
    assert.equal(c.decision, 'blocked_wall', url);
    assert.equal(c.permitted, false, url);
  }
});

test('public sources are not walls and need operator confirmation (no auto-fetch)', () => {
  for (const url of PUBLIC) {
    assert.equal(isSubscriptionWall(url), false, url);
    const c = classifySource(url);
    assert.equal(c.decision, 'needs_operator_confirmation', url);
    assert.equal(c.permitted, true, url);
  }
});

test('empty URL classifies as no_url and is not permitted', () => {
  const c = classifySource('   ');
  assert.equal(c.decision, 'no_url');
  assert.equal(c.permitted, false);
});

test('extractHost parses scheme URLs and bare hosts, lowercased', () => {
  assert.equal(extractHost('https://WWW.OLBG.com/tips'), 'www.olbg.com');
  assert.equal(extractHost('racingpost.com/tips'), 'racingpost.com');
  assert.equal(extractHost(''), '');
});

test('buildDiscoveryPlan counts blocked walls and permitted sources', () => {
  const plan = buildDiscoveryPlan([...WALLS, ...PUBLIC]);
  assert.equal(plan.blockedWalls, WALLS.length);
  assert.equal(plan.permitted, PUBLIC.length);
  assert.equal(plan.classified.length, WALLS.length + PUBLIC.length);
});

test('truncateExcerpt enforces a short, attributable snippet (never a full article)', () => {
  const long = 'word '.repeat(200); // ~1000 chars
  const out = truncateExcerpt(long);
  assert.ok(out.length <= MAX_EXCERPT_CHARS + 1, `excerpt too long: ${out.length}`);
  assert.ok(MAX_EXCERPT_CHARS <= 280, 'excerpt budget must stay short');
  // Short text is preserved and whitespace-collapsed.
  assert.equal(truncateExcerpt('  fancies   Field   Of Gold  '), 'fancies Field Of Gold');
});

test('seed sources: synthetic Jon Vine strategy is shadow-only and never ingestible', () => {
  const synth = PUBLIC_SEED_SOURCES.find((s) => /Jon Vine Do/i.test(s.label))!;
  assert.equal(synth.access_class, 'synthetic_shadow_only');
  assert.equal(synth.ingestible, false);
  // A real public Jon Vine page (evidenced picks) is a separate, ingestible source.
  const realJv = PUBLIC_SEED_SOURCES.find((s) => /Jon Vine public/i.test(s.label))!;
  assert.equal(realJv.ingestible, true);
});

test('no subscription-wall host leaks into the public seed list', () => {
  for (const s of PUBLIC_SEED_SOURCES) {
    for (const wall of SUBSCRIPTION_WALL_HOSTS) {
      assert.equal(s.label.toLowerCase().includes(wall), false, `${s.label} vs ${wall}`);
    }
  }
});

test('discovery lib performs NO network I/O and no engine/betting/model work', () => {
  const src = readFileSync('src/lib/tipsterWebDiscovery.ts', 'utf8');
  assert.doesNotMatch(src, /fetch\(|axios|node-fetch|XMLHttpRequest|node:https?\b|require\('https?'\)/);
  assert.doesNotMatch(src, /supabaseAdmin|node:fs|readFileSync|writeFileSync/);
  assert.doesNotMatch(src, /bettingEngine|kellyStake|runModelForRace|modelProbabilities|calculateEV/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder|sendOrder/i);
});

test('discover-web CLI never fetches the web and never places a bet', () => {
  const cli = readFileSync('scripts/discoverTipsterWeb.ts', 'utf8');
  // No network primitives (reads LOCAL files only).
  assert.doesNotMatch(cli, /fetch\(|axios|node-fetch|XMLHttpRequest|puppeteer|playwright/);
  // No model / staking / betting.
  assert.doesNotMatch(cli, /runModelForRace|bettingEngine|kellyStake|modelProbabilities/);
  assert.doesNotMatch(cli, /placeOrder|placeBet|submitOrder|sendOrder/i);
  // Emits review-gated rows only.
  assert.match(cli, /pending/);
});
