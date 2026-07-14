/**
 * Tests for the compliant tipster SOURCE REGISTRY.
 *
 * Proves the strict-PDF core pool is present, access classes gate auto-
 * acquisition (paid/login can never be scraped), the PR correlation family maps
 * + caps to one representative, the seed carries names+structure with NO
 * fabricated numbers, and the lib does no I/O and touches no engine/betting code.
 *
 * The on-disk-registry test below reads a committed SYNTHETIC fixture
 * (scripts/fixtures/tipster-source-registry-sample.csv) — a minimal registry
 * CSV containing only the already-public CORE_ACTIVE_POOL names (no invented
 * evidence numbers, no personal data). It replaces the real, machine-local,
 * git-ignored operational registry file (`data/*.csv`) so the suite is
 * reproducible on a fresh clone without that file present, while still
 * exercising the disk-read + parse path the original test covered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CORE_ACTIVE_POOL,
  WATCHLIST,
  PR_FAMILY,
  CORRELATION_GROUPS,
  SOURCE_ACCESS_CLASSES,
  correlationGroupOf,
  correlationMemberOf,
  isFamilyRepresentative,
  accessClassAllowsAutoAcquire,
  isPaidOrLoginClass,
  buildRegistrySeedRows,
  parseRegistryCsv,
  serializeRegistryCsv,
  registryRowCurrentSelectionEligible,
} from '../src/lib/tipsterSourceRegistry';

const CORE = [
  'the king of horses', 'On Target Tips', 'LIVE FOR RACING', 'PRO EACHWAY MORNING',
  'The Profit Rocket', 'Knottlast', 'iontheball', 'ryanwe', 'UncleFiddler', 'Edwinp',
];

test('core active pool matches the strict-PDF names exactly', () => {
  assert.deepEqual([...CORE_ACTIVE_POOL], CORE);
});

test('seed registry contains every core-pool name + the synthetic Jon Vine profile', () => {
  const rows = buildRegistrySeedRows();
  const labels = new Set(rows.map((r) => r.source_label));
  for (const name of CORE) assert.ok(labels.has(name), `missing ${name}`);
  assert.ok([...labels].some((l) => /Jon Vine/i.test(l)));
  // The synthetic "What Would Jon Vine Do" profile is synthetic_shadow_only.
  const jv = rows.find((r) => r.source_label === 'What Would Jon Vine Do')!;
  assert.equal(jv.source_access_class, 'synthetic_shadow_only');
});

test('seed carries NO fabricated evidence numbers (ROI/strike/sample blank)', () => {
  for (const r of buildRegistrySeedRows()) {
    assert.equal(r.long_run_roi, '');
    assert.equal(r.recent_roi, '');
    assert.equal(r.sample_size, '');
    assert.equal(r.strike_rate, '');
    assert.equal(r.model_weight, '');
  }
});

test('named subscription walls are paid_login (never auto-acquirable)', () => {
  const rows = buildRegistrySeedRows();
  for (const name of ['Racing Post', 'Tipstrr', 'Betting Gods', 'Tipsters Empire']) {
    const r = rows.find((x) => x.source_label === name);
    assert.ok(r, `missing watchlist source ${name}`);
    assert.equal(r!.source_access_class, 'paid_login');
    assert.equal(accessClassAllowsAutoAcquire(r!.source_access_class), false);
    assert.equal(isPaidOrLoginClass(r!.source_access_class), true);
  }
  assert.ok(WATCHLIST.includes('Racing Post'));
});

test('access classes: only public_free / media_public can be auto-acquired', () => {
  for (const cls of SOURCE_ACCESS_CLASSES) {
    const allowed = accessClassAllowsAutoAcquire(cls);
    assert.equal(allowed, cls === 'public_free' || cls === 'media_public');
  }
});

test('PR family maps + caps to the representative', () => {
  assert.equal(PR_FAMILY.representative, 'The Profit Rocket');
  assert.equal(CORRELATION_GROUPS.length >= 1, true);
  for (const m of ['The Profit Rocket', 'UNDERDOG Racing Tips', 'ACTIVE Betting Hub']) {
    assert.equal(correlationGroupOf(m)?.group, 'PR family');
    assert.equal(correlationMemberOf(m), m);
  }
  assert.equal(isFamilyRepresentative('The Profit Rocket'), true);
  assert.equal(isFamilyRepresentative('UNDERDOG Racing Tips'), false);
  assert.equal(correlationGroupOf('Some Unrelated Tipster'), null);
});

test('registry CSV round-trips', () => {
  const rows = buildRegistrySeedRows();
  const parsed = parseRegistryCsv(serializeRegistryCsv(rows));
  assert.equal(parsed.length, rows.length);
  assert.equal(parsed[0].source_label, rows[0].source_label);
  assert.equal(parsed[0].source_access_class, rows[0].source_access_class);
});

test('current-selection eligibility: synthetic + non-approved are never eligible', () => {
  const rows = buildRegistrySeedRows();
  const jv = rows.find((r) => /Jon Vine/i.test(r.source_label))!;
  assert.equal(registryRowCurrentSelectionEligible(jv), false); // synthetic
  const core = rows.find((r) => r.source_label === 'On Target Tips')!;
  assert.equal(registryRowCurrentSelectionEligible(core), false); // pending
  assert.equal(registryRowCurrentSelectionEligible({ ...core, review_status: 'approved' }), true);
});

test('a seeded registry CSV file exists and parses to the core pool', () => {
  const text = readFileSync('scripts/fixtures/tipster-source-registry-sample.csv', 'utf8');
  const rows = parseRegistryCsv(text);
  const labels = new Set(rows.map((r) => r.source_label));
  for (const name of CORE) assert.ok(labels.has(name), `registry CSV missing ${name}`);
});

test('registry lib does no I/O and touches no engine/betting code', () => {
  const src = readFileSync('src/lib/tipsterSourceRegistry.ts', 'utf8');
  assert.doesNotMatch(src, /supabaseAdmin|fetch\(|api\.openai|https?:\/\/|node:fs/);
  assert.doesNotMatch(src, /bettingEngine|kellyStake|runModelForRace|modelProbabilities|calculateEV/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder/i);
});

test('this suite no longer depends on the git-ignored, machine-local registry CSV', () => {
  const thisFile = fileURLToPath(import.meta.url);
  const src = readFileSync(thisFile, 'utf8');
  // The real operational registry is intentionally git-ignored (data/*.csv) and
  // unavailable on a fresh clone; the suite must run entirely off the
  // committed synthetic fixture above. Check the actual file-read calls (not
  // this file's own explanatory prose) never target an ignored data/*.csv path.
  const readCalls = [...src.matchAll(/readFileSync\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const path of readCalls) {
    assert.ok(
      !/^data\/.*\.csv$/.test(path) || /\.example\.csv$/.test(path),
      `test reads a git-ignored data/*.csv path: ${path}`,
    );
  }
});
