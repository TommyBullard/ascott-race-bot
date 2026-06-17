/**
 * Unit tests for the pure tipster-audit helpers (src/lib/tipsterAudit.ts) and a
 * read-only guard for the script (scripts/tipsterAudit.ts).
 *
 * No DB, no network, no secrets: synthetic selections / race contexts exercise
 * the approved-selection aggregation, candidate counting, duplicate-runner /
 * correlation detection (unknown when no family metadata), in-day form over
 * RESULTED races only (never future), divergence tallies, the factual
 * recommendations, and the deterministic Markdown. Source scans prove the audit
 * performs no DB writes and calls no external API. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseTipsterAuditArgs,
  buildTipsterAuditPath,
  summarizeSelections,
  summarizeCandidateRows,
  detectDuplicateRunnerSelections,
  computeInDayForm,
  summarizeDivergence,
  buildAuditRecommendations,
  renderTipsterAuditMarkdown,
  type AuditSelection,
  type AuditRaceContext,
  type AuditTipsterEvidence,
  type TipsterAuditReport,
} from '../src/lib/tipsterAudit';

function sel(over: Partial<AuditSelection> = {}): AuditSelection {
  return {
    race_id: 'r1',
    runner_id: 'h1',
    runner_name: 'Horse 1',
    off_time: '2026-06-16T13:30:00.000Z',
    race_name: 'Race 1',
    tipster_id: 't1',
    tipster_name: 'Tipster A',
    source_label: 'src-a',
    correlation_group: null,
    finish_pos: null,
    has_result: false,
    ...over,
  };
}

function ctx(over: Partial<AuditRaceContext> = {}): AuditRaceContext {
  return {
    race_id: 'r1',
    off_time: '2026-06-16T13:30:00.000Z',
    race_name: 'Race 1',
    winner_name: null,
    has_result: false,
    model_pick_name: null,
    tipster_consensus_name: null,
    tipster_alignment_label: null,
    ...over,
  };
}

function report(over: Partial<TipsterAuditReport> = {}): TipsterAuditReport {
  return {
    date: '2026-06-16',
    course: 'Ascot',
    generatedAt: '2026-06-16T20:00:00.000Z',
    selections: [],
    raceContexts: [],
    candidates: { pending: null, approved: null, rejected: null, source_labels: [] },
    evidence: [],
    ...over,
  };
}

/* --------------------------- args + path ---------------------------------- */

test('parseTipsterAuditArgs: date/course; invalid date undefined; blank course ignored', () => {
  const a = parseTipsterAuditArgs(['--date', '2026-06-16', '--course', 'Ascot']);
  assert.equal(a.date, '2026-06-16');
  assert.equal(a.course, 'Ascot');
  assert.equal(parseTipsterAuditArgs(['--date', 'bad']).date, undefined);
  assert.equal(parseTipsterAuditArgs(['--date', '2026-06-16', '--course', '  ']).course, undefined);
});

test('buildTipsterAuditPath: slug + no course', () => {
  assert.equal(buildTipsterAuditPath('2026-06-16', 'Ascot'), 'reports/tipster-audit-2026-06-16-ascot.md');
  assert.equal(buildTipsterAuditPath('2026-06-16', 'Royal Ascot'), 'reports/tipster-audit-2026-06-16-royal-ascot.md');
  assert.equal(buildTipsterAuditPath('2026-06-16'), 'reports/tipster-audit-2026-06-16.md');
});

/* ------------------------- approved selections ---------------------------- */

test('summarizeSelections: aggregates by source / tipster / race', () => {
  const selections = [
    sel({ race_id: 'r1', source_label: 'src-a', tipster_name: 'A' }),
    sel({ race_id: 'r1', runner_id: 'h2', runner_name: 'Horse 2', source_label: 'src-a', tipster_name: 'B' }),
    sel({ race_id: 'r2', race_name: 'Race 2', source_label: 'src-b', tipster_name: 'A' }),
  ];
  const s = summarizeSelections(selections);
  assert.equal(s.total, 3);
  assert.equal(s.races_covered, 2);
  assert.deepEqual(s.by_source, [{ label: 'src-a', count: 2 }, { label: 'src-b', count: 1 }]);
  assert.deepEqual(s.by_tipster, [{ label: 'A', count: 2 }, { label: 'B', count: 1 }]);
  assert.deepEqual(s.by_race, [{ label: 'Race 1', count: 2 }, { label: 'Race 2', count: 1 }]);
});

test('summarizeSelections: blank source/tipster count as unknown', () => {
  const s = summarizeSelections([sel({ source_label: null, tipster_name: null })]);
  assert.equal(s.unknown_source, 1);
  assert.equal(s.unknown_tipster, 1);
  assert.equal(s.by_source[0].label, '(unknown source)');
  assert.equal(s.by_tipster[0].label, '(unknown tipster)');
});

/* ----------------------------- candidates --------------------------------- */

test('summarizeCandidateRows: counts pending/approved/rejected + distinct source labels', () => {
  const rows = [
    { status: 'pending', source_label: 'src-a' },
    { status: 'pending', source_label: 'src-b' },
    { status: 'approved', source_label: 'src-a' },
    { status: 'rejected', source_label: null },
    { status: 'weird', source_label: 'src-c' }, // unknown status -> not counted as any state
  ];
  const s = summarizeCandidateRows(rows);
  assert.equal(s.pending, 2);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.deepEqual(s.source_labels, ['src-a', 'src-b', 'src-c']);
});

/* ---------------------- correlation / de-duplication ---------------------- */

test('detectDuplicateRunnerSelections: same runner from multiple distinct sources is flagged', () => {
  const selections = [
    sel({ race_id: 'r1', runner_id: 'h1', source_label: 'src-a', tipster_name: 'A' }),
    sel({ race_id: 'r1', runner_id: 'h1', source_label: 'src-b', tipster_name: 'B' }),
    sel({ race_id: 'r1', runner_id: 'h2', runner_name: 'Horse 2', source_label: 'src-a', tipster_name: 'A' }),
  ];
  const dups = detectDuplicateRunnerSelections(selections);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].runner_id, 'h1');
  assert.deepEqual(dups[0].sources, ['src-a', 'src-b']);
  assert.deepEqual(dups[0].tipsters, ['A', 'B']);
});

test('detectDuplicateRunnerSelections: same runner from the SAME source is not a double-count', () => {
  const selections = [
    sel({ runner_id: 'h1', source_label: 'src-a', tipster_name: 'A' }),
    sel({ runner_id: 'h1', source_label: 'src-a', tipster_name: 'B' }),
  ];
  assert.deepEqual(detectDuplicateRunnerSelections(selections), []);
});

test('detectDuplicateRunnerSelections: missing correlation group reports "unknown"', () => {
  const dups = detectDuplicateRunnerSelections([
    sel({ runner_id: 'h1', source_label: 'src-a', correlation_group: null }),
    sel({ runner_id: 'h1', source_label: 'src-b', correlation_group: null }),
  ]);
  assert.deepEqual(dups[0].correlation_groups, ['unknown']);
});

test('detectDuplicateRunnerSelections: present correlation groups are reported', () => {
  const dups = detectDuplicateRunnerSelections([
    sel({ runner_id: 'h1', source_label: 'src-a', correlation_group: 'fam-1' }),
    sel({ runner_id: 'h1', source_label: 'src-b', correlation_group: 'fam-1' }),
  ]);
  assert.deepEqual(dups[0].correlation_groups, ['fam-1']);
});

/* ------------------------------ in-day form ------------------------------- */

test('computeInDayForm: tallies per-tipster over RESULTED races only', () => {
  const selections = [
    sel({ tipster_name: 'A', has_result: true, finish_pos: 1 }), // won
    sel({ tipster_name: 'A', race_id: 'r2', has_result: true, finish_pos: 3 }), // placed
    sel({ tipster_name: 'A', race_id: 'r3', has_result: true, finish_pos: 6 }), // lost
    sel({ tipster_name: 'B', race_id: 'r4', has_result: true, finish_pos: 1 }), // won
  ];
  const form = computeInDayForm(selections);
  assert.deepEqual(form.find((f) => f.tipster === 'A'), { tipster: 'A', settled: 3, won: 1, placed: 1, lost: 1 });
  assert.deepEqual(form.find((f) => f.tipster === 'B'), { tipster: 'B', settled: 1, won: 1, placed: 0, lost: 0 });
});

test('computeInDayForm: future / unresulted races are excluded (never used)', () => {
  const selections = [
    sel({ tipster_name: 'A', has_result: true, finish_pos: 1 }),
    sel({ tipster_name: 'A', race_id: 'r2', has_result: false, finish_pos: null }), // future -> excluded
  ];
  const a = computeInDayForm(selections).find((f) => f.tipster === 'A')!;
  assert.equal(a.settled, 1);
  assert.equal(a.won, 1);
});

/* ------------------------------ divergence -------------------------------- */

test('summarizeDivergence: counts ALIGNED / DIVERGENT / NO_TIPSTER_CONSENSUS / other', () => {
  const contexts = [
    ctx({ tipster_alignment_label: 'ALIGNED' }),
    ctx({ race_id: 'r2', tipster_alignment_label: 'DIVERGENT' }),
    ctx({ race_id: 'r3', tipster_alignment_label: 'NO_TIPSTER_CONSENSUS' }),
    ctx({ race_id: 'r4', tipster_alignment_label: 'PARTIALLY_ALIGNED' }),
    ctx({ race_id: 'r5', tipster_alignment_label: null }),
  ];
  const d = summarizeDivergence(contexts);
  assert.equal(d.aligned, 1);
  assert.equal(d.divergent, 1);
  assert.equal(d.no_consensus, 1);
  assert.equal(d.other, 2); // PARTIALLY_ALIGNED + null
});

/* ---------------------------- recommendations ----------------------------- */

test('buildAuditRecommendations: factual double-count + proof + candidates; no betting advice', () => {
  const dups = detectDuplicateRunnerSelections([
    sel({ runner_id: 'h1', source_label: 'src-a' }),
    sel({ runner_id: 'h1', source_label: 'src-b' }),
  ]);
  const evidence: AuditTipsterEvidence[] = [
    { tipster_id: 't1', tipster_name: 'A', sample_size: null, roi: null, ae: null, strike_rate: null, reliability: null, as_of_date: null },
  ];
  const recs = buildAuditRecommendations(dups, evidence, { pending: 2, approved: 0, rejected: 0, source_labels: [] });
  assert.ok(recs.some((r) => /double-count/i.test(r)));
  assert.ok(recs.some((r) => /proof review/i.test(r)));
  assert.ok(recs.some((r) => /pending review/i.test(r)));
  assert.ok(recs.some((r) => /not betting advice/i.test(r) && /no predictive-edge/i.test(r)));
});

/* ----------------------------- markdown render ---------------------------- */

test('renderTipsterAuditMarkdown: deterministic and shadow-labelled with all sections', () => {
  const r = report({ selections: [sel()], raceContexts: [ctx({ tipster_alignment_label: 'NO_TIPSTER_CONSENSUS' })] });
  assert.equal(renderTipsterAuditMarkdown(r), renderTipsterAuditMarkdown(r));
  const md = renderTipsterAuditMarkdown(r);
  assert.match(md, /# Tipster intelligence audit \u2014 2026-06-16/);
  assert.match(md, /NOT model-active/);
  assert.match(md, /## 1\. Approved selections/);
  assert.match(md, /## 2\. Candidates/);
  assert.match(md, /## 3\. Correlation \/ de-duplication/);
  assert.match(md, /## 5\. In-day form/);
  assert.match(md, /## 6\. Divergence analysis/);
  assert.match(md, /## 7\. Recommendations/);
});

test('render: missing candidate counts and empty evidence render as em dash', () => {
  const md = renderTipsterAuditMarkdown(report());
  assert.match(md, /- Pending: \u2014/);
  assert.match(md, /- Source labels: \u2014/);
  assert.match(md, /no recorded tipster evidence/);
});

test('render: evidence with missing metrics shows em dash cells (proof + recent form always —)', () => {
  const evidence: AuditTipsterEvidence[] = [
    { tipster_id: 't1', tipster_name: 'A', sample_size: 50, roi: null, ae: null, strike_rate: null, reliability: null, as_of_date: null },
  ];
  const md = renderTipsterAuditMarkdown(report({ evidence }));
  assert.match(md, /\| A \| 50 \| \u2014 \| \u2014 \| \u2014 \| \u2014 \| \u2014 \| \u2014 \|/);
});

test('render: a duplicate runner surfaces the double-count warning', () => {
  const selections = [
    sel({ runner_id: 'h1', source_label: 'src-a' }),
    sel({ runner_id: 'h1', source_label: 'src-b' }),
  ];
  const md = renderTipsterAuditMarkdown(report({ selections }));
  assert.match(md, /possible double-count/);
  assert.match(md, /do not double-count them/);
  assert.match(md, /correlation group unknown/);
});

/* ----------------------- read-only / no-API guards ------------------------ */

test('no DB writes: the audit script issues only reads (no insert/update/upsert/delete/rpc)', () => {
  const src = readFileSync('scripts/tipsterAudit.ts', 'utf8');
  assert.equal(/\.insert\s*\(/.test(src), false);
  assert.equal(/\.update\s*\(/.test(src), false);
  assert.equal(/\.upsert\s*\(/.test(src), false);
  assert.equal(/\.delete\s*\(/.test(src), false);
  assert.equal(/\.rpc\s*\(/.test(src), false);
});

test('no external API: the audit script calls no Racing API / Betfair / fetch', () => {
  const src = readFileSync('scripts/tipsterAudit.ts', 'utf8');
  assert.equal(/\bfetch\s*\(|createRacingApiClient|getResults|BetfairClient|axios/.test(src), false);
});

test('no DB / no network / no env: the pure module is self-contained', () => {
  const lib = readFileSync('src/lib/tipsterAudit.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs/.test(lib), false);
  assert.equal(/\bfetch\s*\(|process\.env/.test(lib), false);
});
