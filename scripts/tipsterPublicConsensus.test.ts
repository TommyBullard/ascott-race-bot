/**
 * Tests for the RESEARCH-ONLY public-source tipster consensus (Task 6).
 *
 * Proves: per-race/per-runner grouping; public-mention counting; syndication
 * de-duplication (one tipster across two source labels counts once + is flagged);
 * PR-family flagging; model-pick / market-favourite agreement; deterministic
 * ordering + render; and that neither the lib nor the CLI introduces scraping,
 * network, DB writes, model-maths, staking, or betting code.
 *
 * The "runs over a manual-review CSV" test below reads a committed SYNTHETIC
 * fixture (scripts/fixtures/tipster-public-consensus-sample.csv) — invented
 * races/runners/sources/tipsters, no secrets, no personal data, no real
 * opinions. It replaces the real, machine-local, git-ignored manual-review
 * sheet (`data/*.csv`) so the suite is reproducible on a fresh clone. It
 * preserves the original shape (>=5 races, >=20 rows, at least one syndicated
 * tipster across two source labels).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildPublicConsensusReport,
  renderPublicConsensusMarkdown,
  raceKey,
  CONSENSUS_RESEARCH_NOTE,
  type RaceConsensus,
} from '../src/lib/tipsterPublicConsensus';
import { MANUAL_REVIEW_COLUMNS, parseManualReviewCsv, type ManualReviewRow } from '../src/lib/tipsterManualReview';

function row(overrides: Partial<ManualReviewRow>): ManualReviewRow {
  const base = {} as ManualReviewRow;
  for (const col of MANUAL_REVIEW_COLUMNS) base[col] = '';
  base.date = '2026-06-20';
  base.course = 'Ascot';
  base.review_status = 'pending';
  base.model_active_eligible = 'false';
  base.licence_status = 'public_allowed';
  return { ...base, ...overrides };
}

function findRace(report: ReturnType<typeof buildPublicConsensusReport>, time: string): RaceConsensus {
  const race = report.races.find((r) => r.race_time === time);
  assert.ok(race, `race ${time} present`);
  return race;
}

test('groups by race and runner, counts distinct public mentions', () => {
  const rows = [
    row({ race_time: '14:30', race_name: 'Norfolk', runner_name: 'Carry The Flag', source_label: 'OLBG', tipster_name: 'OLBG consensus' }),
    row({ race_time: '14:30', race_name: 'Norfolk', runner_name: 'Carry The Flag', source_label: 'Freetips', tipster_name: 'Harry Wilson' }),
    row({ race_time: '14:30', race_name: 'Norfolk', runner_name: 'Star Prospect', source_label: 'Freetips', tipster_name: 'Paul Kealy' }),
  ];
  const report = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows });
  assert.equal(report.race_count, 1);
  const race = findRace(report, '14:30');
  assert.equal(race.runners.length, 2);
  // Carry The Flag has two distinct tipsters -> 2 mentions; top of the race.
  assert.equal(race.top_public_runner, 'Carry The Flag');
  assert.equal(race.runners[0].public_mention_count, 2);
  assert.equal(race.runners[1].public_mention_count, 1);
});

test('syndication: same tipster across two source labels counts once + flagged', () => {
  const rows = [
    row({ race_time: '15:05', race_name: 'Hardwicke', runner_name: 'Goliath', source_label: 'Freetips Day 5', tipster_name: 'Jon Vine' }),
    row({ race_time: '15:05', race_name: 'Hardwicke', runner_name: 'Goliath', source_label: 'RacingInsider Day 5', tipster_name: 'Jon Vine' }),
  ];
  const report = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows });
  const race = findRace(report, '15:05');
  const goliath = race.runners[0];
  assert.equal(goliath.raw_row_count, 2);
  assert.equal(goliath.public_mention_count, 1, 'Jon Vine counted once across two labels');
  assert.equal(goliath.syndication_duplicate, true);
  assert.ok(race.warnings.some((w) => /syndicat/i.test(w)));
});

test('PR-family rows are flagged', () => {
  const rows = [
    row({ race_time: '16:20', race_name: 'Jersey', runner_name: 'Catullus', source_label: 'PR A', tipster_name: 'A', correlation_group: 'PR_family' }),
  ];
  const report = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows });
  const race = findRace(report, '16:20');
  assert.equal(race.runners[0].pr_family, true);
  assert.ok(race.warnings.some((w) => /PR-family/i.test(w)));
});

test('agreement vs model pick and market favourite', () => {
  const rows = [
    row({ race_time: '17:00', race_name: 'Wokingham', runner_name: 'Binhareer', source_label: 'OLBG', tipster_name: 'OLBG' }),
    row({ race_time: '17:00', race_name: 'Wokingham', runner_name: 'Royal Zabeel', source_label: 'Freetips', tipster_name: 'Paul Kealy' }),
  ];
  const context = {
    [raceKey('17:00', 'Wokingham')]: { modelPickHorse: 'Royal Zabeel', marketFavouriteHorse: 'Binhareer' },
  };
  const report = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows, context });
  const race = findRace(report, '17:00');
  const binhareer = race.runners.find((r) => r.runner_name === 'Binhareer')!;
  const zabeel = race.runners.find((r) => r.runner_name === 'Royal Zabeel')!;
  assert.equal(binhareer.matches_market_favourite, true);
  assert.equal(binhareer.matches_model_pick, false);
  assert.equal(binhareer.agreement, '= market favourite');
  assert.equal(zabeel.matches_model_pick, true);
  assert.equal(zabeel.agreement, '= model pick');
});

test('no context -> agreement is unknown ("—")', () => {
  const rows = [row({ race_time: '14:30', race_name: 'Norfolk', runner_name: 'Carry The Flag', source_label: 'OLBG', tipster_name: 'OLBG' })];
  const report = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows });
  const race = findRace(report, '14:30');
  assert.equal(race.runners[0].matches_model_pick, null);
  assert.equal(race.runners[0].agreement, '—');
});

test('report is research-only and deterministic', () => {
  const rows = [
    row({ race_time: '15:40', race_name: 'Jubilee', runner_name: 'Satono Reve', source_label: 'OLBG', tipster_name: 'OLBG' }),
    row({ race_time: '14:30', race_name: 'Norfolk', runner_name: 'Carry The Flag', source_label: 'OLBG', tipster_name: 'OLBG' }),
  ];
  const a = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows });
  const b = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows });
  assert.equal(a.research_only, true);
  assert.deepEqual(a, b);
  // races sorted by off time
  assert.equal(a.races[0].race_time, '14:30');
  assert.equal(a.races[1].race_time, '15:40');
  const md = renderPublicConsensusMarkdown(a);
  assert.ok(md.includes('RESEARCH ONLY'));
  assert.ok(md.includes(CONSENSUS_RESEARCH_NOTE));
});

test('runs over a manual-review CSV (synthetic fixture, same shape as a real day)', () => {
  const csv = readFileSync('scripts/fixtures/tipster-public-consensus-sample.csv', 'utf8');
  const rows = parseManualReviewCsv(csv);
  const report = buildPublicConsensusReport({ date: '2026-06-20', course: 'Ascot', generatedAt: 'T', rows });
  assert.ok(report.race_count >= 5);
  assert.ok(report.total_rows >= 20);
  // Jon Vine appears on both Freetips Sample and RacingInsider Sample -> at
  // least one syndication flag.
  assert.ok(report.races.some((r) => r.runners.some((x) => x.syndication_duplicate)));
});

test('source: lib is pure (no network/scraping/DB/fs)', () => {
  const src = readFileSync('src/lib/tipsterPublicConsensus.ts', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(/cheerio|puppeteer|playwright|jsdom|axios/i.test(src), false);
  assert.equal(/supabaseAdmin/.test(src), false);
  assert.equal(/node:fs/.test(src), false);
  assert.equal(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(src), false);
  assert.equal(/placeOrder|placeBet|submitOrder/.test(src), false);
});

test('source: CLI is read-only (no writes/scraping/betting)', () => {
  const src = readFileSync('scripts/tipsterPublicConsensus.ts', 'utf8');
  assert.equal(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(src), false);
  assert.equal(/cheerio|puppeteer|playwright|jsdom|axios/i.test(src), false);
  assert.equal(/placeOrder|placeBet|submitOrder/.test(src), false);
  // best-effort read-only DB enrichment uses select-only helpers
  assert.ok(/fetchRaceCard|fetchRaceIdsForMeeting/.test(src));
});

test('this suite no longer depends on the git-ignored, machine-local manual-review CSV', () => {
  const thisFile = fileURLToPath(import.meta.url);
  const src = readFileSync(thisFile, 'utf8');
  // The real operational sheet is intentionally git-ignored (data/*.csv) and
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
