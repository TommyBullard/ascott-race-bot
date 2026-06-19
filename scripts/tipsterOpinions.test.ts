/**
 * Tests for the compliant tipster-OPINION ingestion layer.
 *
 * Proves: no scraping (policy + no network), unknown licence can never be
 * model-active, the extractor cannot fabricate (evidence + grounding required),
 * the Jon Vine strategy profile is synthetic/blocked without evidence, approved
 * eligible opinions convert to the importer's selection CSV, only model-active
 * rows are emitted (so only affected races get support), and nothing touches the
 * model/staking/recommendation engines or places a bet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractOpinions,
  reviewOpinions,
  classifyOpinion,
  buildApprovedSelectionCsv,
  isGroundedInSource,
  looksDisallowed,
  matchSourceProfile,
  parseOpinionRows,
  serializeOpinionCsv,
  toOpinionRow,
  type TipsterOpinionRow,
  type TipsterNotesFile,
} from '../src/lib/tipsterOpinions';
import { normalizeHorseName } from '../src/lib/raceSync';

function opinion(over: Partial<TipsterOpinionRow> = {}): TipsterOpinionRow {
  return {
    date: '2026-06-19',
    course: 'Ascot',
    race_name: 'Albany Stakes',
    off_time: '13:30',
    source_label: 'operator manual note',
    tipster_name: 'Operator',
    runner_name: 'Sun Goddess',
    opinion_type: 'selection',
    confidence: 'medium',
    evidence_excerpt: 'Sun Goddess looks well treated here',
    source_url: '',
    licence_status: 'manual',
    notes: '',
    review_status: 'approved',
    model_active_eligible: true,
    ...over,
  };
}

const MATCHED = new Set([normalizeHorseName('Sun Goddess')]);

/* -------------------------------------------------------------------------- */
/* Source policy / no scraping                                                */
/* -------------------------------------------------------------------------- */

test('no scraping: paywalled / logged-in / scraped sources are flagged disallowed', () => {
  assert.equal(looksDisallowed(opinion({ notes: 'scraped from members area' })), true);
  assert.equal(looksDisallowed(opinion({ source_url: 'https://example.com/subscriber/area' })), true);
  assert.equal(looksDisallowed(opinion({ source_label: 'paywall article' })), true);
  assert.equal(looksDisallowed(opinion({ notes: 'operator note' })), false);
});

test('Racing Post is allowed only as a licensed/manual-excerpt source (never a scraper)', () => {
  const p = matchSourceProfile('Racing Post tips', 'RP');
  assert.ok(p);
  assert.equal(p!.allowedModelActive, true);
  assert.equal(p!.synthetic, false);
  // ...but a scraped Racing Post row is still blocked by the disallowed-source gate.
  const c = classifyOpinion(opinion({ source_label: 'Racing Post', notes: 'scraped article' }), true);
  assert.equal(c.modelActive, false);
});

/* -------------------------------------------------------------------------- */
/* Eligibility gate                                                           */
/* -------------------------------------------------------------------------- */

test('unknown licence can never become model-active (even when approved)', () => {
  const c = classifyOpinion(opinion({ licence_status: 'unknown', review_status: 'approved' }), true);
  assert.equal(c.licenceAllowed, false);
  assert.equal(c.modelActive, false);
  assert.ok(c.blockReasons.some((r) => /licence/.test(r)));
});

test('a matched, approved, manual selection with evidence IS model-active', () => {
  const c = classifyOpinion(opinion(), true);
  assert.equal(c.eligible, true);
  assert.equal(c.modelActive, true);
});

test('model_active_eligible=false blocks even an approved, eligible, matched selection', () => {
  const c = classifyOpinion(opinion({ model_active_eligible: false }), true);
  assert.equal(c.eligible, true); // structurally eligible...
  assert.equal(c.modelActive, false); // ...but the explicit flag gates it
  assert.ok(c.blockReasons.some((r) => /model_active_eligible/.test(r)));
});

test('PR family is capped to ONE representative vote (never three independent votes)', () => {
  const matched = new Set([normalizeHorseName('Precise')]);
  const rows = [
    opinion({ tipster_name: 'The Profit Rocket', source_label: 'The Profit Rocket', runner_name: 'Precise' }),
    opinion({ tipster_name: 'UNDERDOG Racing Tips', source_label: 'UNDERDOG Racing Tips', runner_name: 'Precise' }),
    opinion({ tipster_name: 'ACTIVE Betting Hub', source_label: 'ACTIVE Betting Hub', runner_name: 'Precise' }),
  ];
  const report = reviewOpinions(rows, matched);
  assert.equal(report.approvedModelActive, 1); // only the family representative counts
  assert.ok(report.correlationCapped >= 2);
  assert.ok(report.correlationWarnings.some((w) => /PR family/.test(w)));
  const active = report.perRow.filter((p) => p.classification.modelActive);
  assert.equal(active.length, 1);
  assert.match(active[0].row.tipster_name, /Profit Rocket/);
});

test('non-selection opinion types are context, never a backing selection', () => {
  for (const t of ['positive', 'negative', 'each_way_interest', 'danger', 'no_strong_view'] as const) {
    const c = classifyOpinion(opinion({ opinion_type: t }), true);
    assert.equal(c.modelActive, false, `${t} must not be model-active`);
  }
});

test('unmatched runner is blocked from model-active', () => {
  const c = classifyOpinion(opinion({ runner_name: 'Not A Real Runner' }), false);
  assert.equal(c.runnerMatched, false);
  assert.equal(c.modelActive, false);
});

test('Jon Vine strategy profile cannot be a real source without evidence (synthetic, blocked)', () => {
  const c = classifyOpinion(
    opinion({ source_label: 'What Would Jon Vine Do', tipster_name: 'Jon Vine Strategy', licence_status: 'manual' }),
    true,
  );
  assert.equal(c.synthetic, true);
  assert.equal(c.sourceAllowed, false);
  assert.equal(c.modelActive, false);
  assert.ok(c.blockReasons.some((r) => /synthetic/.test(r)));
});

/* -------------------------------------------------------------------------- */
/* Evidence grounding / extraction (no fabrication)                           */
/* -------------------------------------------------------------------------- */

test('grounding: an excerpt must be a verbatim substring of the source text', () => {
  assert.equal(isGroundedInSource('looks well treated', 'The horse looks well treated today.'), true);
  assert.equal(isGroundedInSource('a fabricated claim', 'The horse looks well treated today.'), false);
  assert.equal(isGroundedInSource('', 'anything'), false); // empty excerpt is never grounded
});

test('extraction requires evidence and drops ungrounded opinions (never guesses)', () => {
  const file: TipsterNotesFile = {
    notes: [
      {
        date: '2026-06-19',
        course: 'Ascot',
        source_label: 'operator',
        tipster_name: 'Op',
        licence_status: 'manual',
        source_text: 'Sun Goddess looks the pick of the fillies.',
        opinions: [
          { runner_name: 'Sun Goddess', opinion_type: 'selection', evidence_excerpt: 'Sun Goddess looks the pick of the fillies' },
          { runner_name: 'No Evidence', opinion_type: 'selection', evidence_excerpt: '' },
          { runner_name: 'Ungrounded', opinion_type: 'selection', evidence_excerpt: 'this is not in the source text' },
        ],
      },
    ],
  };
  const { rows, audit } = extractOpinions(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runner_name, 'Sun Goddess');
  assert.equal(rows[0].review_status, 'pending'); // extraction never approves
  assert.equal(audit.skipped_no_evidence, 1);
  assert.equal(audit.skipped_ungrounded, 1);
});

test('extraction forces a synthetic strategy profile to unknown licence', () => {
  const file: TipsterNotesFile = {
    notes: [
      {
        date: '2026-06-19',
        course: 'Ascot',
        source_label: 'What Would Jon Vine Do',
        tipster_name: 'Jon Vine Strategy',
        licence_status: 'manual',
        source_text: 'prefers value at bigger prices',
        opinions: [{ runner_name: 'Hopewell Rock', opinion_type: 'selection', evidence_excerpt: 'prefers value at bigger prices' }],
      },
    ],
  };
  const { rows, audit } = extractOpinions(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].licence_status, 'unknown'); // synthetic can't claim a real licence
  assert.equal(audit.synthetic_source_rows, 1);
});

/* -------------------------------------------------------------------------- */
/* Review + conversion to the importer's selection CSV                        */
/* -------------------------------------------------------------------------- */

test('approved eligible opinions convert to the importer selection CSV', () => {
  const report = reviewOpinions([opinion()], MATCHED);
  assert.equal(report.matched, 1);
  assert.equal(report.approvedModelActive, 1);
  const csv = buildApprovedSelectionCsv(report);
  assert.match(csv, /^meeting_date,course,off_time,horse_name,tipster_name,raw_affiliation,source_label/);
  assert.match(csv, /2026-06-19,Ascot,13:30,Sun Goddess,Operator/);
});

test('only model-active rows reach the selection CSV (affected races only)', () => {
  const rows = [
    opinion({ runner_name: 'Sun Goddess', review_status: 'approved' }), // model-active
    opinion({ runner_name: 'Sun Goddess', review_status: 'pending' }), // not approved -> excluded
    opinion({ runner_name: 'Sun Goddess', opinion_type: 'danger', review_status: 'approved' }), // context -> excluded
    opinion({ runner_name: 'Sun Goddess', licence_status: 'unknown', review_status: 'approved' }), // unknown -> excluded
  ];
  const report = reviewOpinions(rows, MATCHED);
  assert.equal(report.approvedModelActive, 1);
  const csv = buildApprovedSelectionCsv(report);
  const dataLines = csv.trim().split('\n').slice(1);
  assert.equal(dataLines.length, 1); // exactly one model-active selection emitted
});

test('CSV round-trips (parse ∘ serialize is stable)', () => {
  const rows = [opinion(), opinion({ runner_name: 'Venetian Sun', opinion_type: 'danger' })];
  const parsed = parseOpinionRows(serializeOpinionCsv(rows));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].runner_name, 'Sun Goddess');
  assert.equal(parsed[1].opinion_type, 'danger');
});

test('toOpinionRow defaults unknowns rather than guessing', () => {
  const r = toOpinionRow({ runner_name: 'X', opinion_type: 'weird', confidence: 'meh', licence_status: 'mystery', review_status: 'maybe' });
  assert.equal(r.opinion_type, 'no_strong_view');
  assert.equal(r.confidence, 'unknown');
  assert.equal(r.licence_status, 'unknown');
  assert.equal(r.review_status, 'pending');
});

/* -------------------------------------------------------------------------- */
/* Safety scans — no engines, no betting, no network in the lib + CLIs        */
/* -------------------------------------------------------------------------- */

test('lib changes no model/staking/recommendation math and does no I/O', () => {
  const src = readFileSync('src/lib/tipsterOpinions.ts', 'utf8');
  assert.doesNotMatch(src, /bettingEngine|modelProbabilities|runModelForRace|kellyStake|calculateEV/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder/i);
  assert.doesNotMatch(src, /supabaseAdmin|fetch\(|api\.openai|node:fs/);
});

test('extract CLI is local-only: no DB, no network, no OpenAI, no betting', () => {
  const src = readFileSync('scripts/extractTipsterOpinions.ts', 'utf8');
  assert.doesNotMatch(src, /supabaseAdmin|fetch\(|api\.openai\.com|https?:\/\//);
  assert.doesNotMatch(src, /import[^\n]*[gG]enai|import[^\n]*[oO]penai/);
  assert.doesNotMatch(src, /placeOrder|placeBet|runModelForRace/);
  assert.match(src, /readFileSync/);
});

test('review CLI is read-only: select reads only, writes a local CSV, no model/bets', () => {
  const src = readFileSync('scripts/reviewTipsterOpinions.ts', 'utf8');
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete|rpc)\s*\(/);
  assert.doesNotMatch(src, /runModelForRace|kellyStake|bettingEngine|placeOrder|placeBet/);
  // It never executes the importer itself (the --commit command is only a printed suggestion).
  assert.doesNotMatch(src, /child_process|spawnSync|spawn\(|execSync|exec\(/);
  assert.match(src, /\.select\(/);
  assert.match(src, /writeFileSync/);
});
