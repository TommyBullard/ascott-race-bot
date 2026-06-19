/**
 * Unit tests for the READ-ONLY "Proof of Update" dashboard panel
 * (src/lib/proofPanel.ts) plus read-only source-scan guards on the pure helper,
 * the presentational component, and the page wiring.
 *
 * The view-model is pure + deterministic, so no DOM / network / DB is needed. The
 * scans lock the task's rules: the panel never writes the DB, exposes no commit
 * button or write control, carries no betting-placement language, and renders
 * "unknown" / "not available" for missing data without crashing.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildProofPanelView,
  deriveResultsBlocked,
  resolveProofReportPath,
  PROOF_PANEL_DISCLAIMERS,
  RESULTS_BLOCKED_STANDARD,
  type ProofPanelInput,
  type ProofPanelRaceInput,
  type ProofPanelView,
} from '../src/lib/proofPanel';

const NOW = Date.parse('2026-06-18T14:30:00Z');

function raceInput(over: Partial<ProofPanelRaceInput> = {}): ProofPanelRaceInput {
  return {
    offTime: '2026-06-18T14:30:00Z',
    fieldSize: 12,
    latestOddsSnapshotTime: '2026-06-18T14:25:00Z',
    latestModelRunTime: '2026-06-18T14:26:00Z',
    hasModelRun: true,
    status: 'result',
    finishPosAvailable: true,
    ...over,
  };
}

function fullInput(over: Partial<ProofPanelInput> = {}): ProofPanelInput {
  return {
    date: '2026-06-18',
    course: 'Ascot',
    now: NOW,
    races: [raceInput()],
    runnersCount: 12,
    resultsSource: 'csv',
    resultsBlockedReason: null,
    trainingCapture: { available: true, count: 84 },
    genai: { status: 'generated' },
    proofReportPath: 'reports/proof-day-2026-06-18-ascot.md',
    ...over,
  };
}

const rowFor = (view: ProofPanelView, label: string) => view.rows.find((r) => r.label === label);

/* --------------------------- full proof data ------------------------------ */

test('panel renders with full proof data', () => {
  const view = buildProofPanelView(fullInput());
  assert.equal(view.title, 'Proof of update');
  assert.equal(rowFor(view, 'Racecards loaded')?.value, 'yes');
  assert.equal(rowFor(view, 'Races')?.value, '1');
  assert.equal(rowFor(view, 'Runners')?.value, '12');
  assert.equal(rowFor(view, 'Odds last updated')?.tone, 'ok'); // 5m old < 10m stale
  assert.match(rowFor(view, 'Model last updated')?.value ?? '', /ago|now/);
  assert.equal(rowFor(view, 'T-minus capture')?.value, '1/1 pre-off captured');
  assert.equal(rowFor(view, 'Results')?.value, '1/1 settled');
  assert.match(rowFor(view, 'Results source')?.value ?? '', /csv/);
  assert.equal(rowFor(view, 'Results blocked')?.value, 'none');
  assert.equal(rowFor(view, 'Training capture')?.value, '84 rows');
  assert.match(rowFor(view, 'GenAI commentary')?.value ?? '', /generated.*shadow-only/);
  assert.equal(rowFor(view, 'Proof report')?.value, 'reports/proof-day-2026-06-18-ascot.md');
  assert.deepEqual(view.disclaimers, [...PROOF_PANEL_DISCLAIMERS]);
});

/* --------------------------- tables missing ------------------------------- */

test('panel renders when new audit tables are missing (graceful, no crash)', () => {
  const view = buildProofPanelView(
    fullInput({ trainingCapture: { available: false, count: null } }),
  );
  assert.match(rowFor(view, 'Training capture')?.value ?? '', /table missing/);
  assert.equal(rowFor(view, 'Training capture')?.tone, 'warn');

  // Undefined audit signals degrade to "not available" / "unknown".
  const sparse = buildProofPanelView({
    date: '2026-06-18',
    course: 'Ascot',
    now: NOW,
    races: [raceInput({ latestOddsSnapshotTime: null, latestModelRunTime: null, hasModelRun: false })],
    runnersCount: null,
  });
  assert.equal(rowFor(sparse, 'Training capture')?.value, 'not available');
  assert.equal(rowFor(sparse, 'Runners')?.value, 'unknown');
  assert.equal(rowFor(sparse, 'Odds last updated')?.value, 'unknown');
  assert.match(rowFor(sparse, 'GenAI commentary')?.value ?? '', /not configured/);
});

test('a null input renders safely (no crash, not available)', () => {
  const view = buildProofPanelView(null);
  assert.equal(view.rows.length >= 1, true);
  assert.equal(view.rows[0].value, 'not available');
  assert.deepEqual(view.disclaimers, [...PROOF_PANEL_DISCLAIMERS]);
});

/* --------------------------- results blocked ------------------------------ */

test('results blocked message renders (explicit + heuristic CSV fallback)', () => {
  const explicit = buildProofPanelView(fullInput({ resultsBlockedReason: RESULTS_BLOCKED_STANDARD }));
  assert.equal(rowFor(explicit, 'Results blocked')?.value, RESULTS_BLOCKED_STANDARD);
  assert.equal(rowFor(explicit, 'Results blocked')?.tone, 'warn');

  // Heuristic: a past-off race that is not settled suggests the CSV fallback.
  const pending = buildProofPanelView(
    fullInput({
      resultsBlockedReason: undefined,
      now: Date.parse('2026-06-18T20:00:00Z'),
      races: [raceInput({ status: null, finishPosAvailable: false })],
    }),
  );
  assert.match(rowFor(pending, 'Results blocked')?.value ?? '', /manual CSV fallback required/);
});

test('deriveResultsBlocked + resolveProofReportPath precedence', () => {
  assert.equal(deriveResultsBlocked(fullInput({ resultsBlockedReason: 'X' })), 'X');
  assert.equal(deriveResultsBlocked(fullInput({ resultsBlockedReason: null })), null);
  // No explicit reason + all settled => no block.
  assert.equal(deriveResultsBlocked(fullInput({ resultsBlockedReason: undefined })), null);
  // Explicit path wins; else derived from date+course; else null.
  assert.equal(resolveProofReportPath(fullInput({ proofReportPath: 'x.md' })), 'x.md');
  assert.equal(resolveProofReportPath(fullInput({ proofReportPath: undefined })), 'reports/proof-day-2026-06-18-ascot.md');
  assert.equal(resolveProofReportPath(fullInput({ proofReportPath: undefined, date: null })), null);
});

/* --------------------------- GenAI unavailable ---------------------------- */

test('GenAI unavailable renders (not configured / no reviewed notes), always shadow-only', () => {
  const none = buildProofPanelView(fullInput({ genai: undefined }));
  assert.match(rowFor(none, 'GenAI commentary')?.value ?? '', /not configured \(shadow-only\)/);
  const noNotes = buildProofPanelView(fullInput({ genai: { status: 'no_reviewed_notes' } }));
  assert.match(rowFor(noNotes, 'GenAI commentary')?.value ?? '', /no reviewed notes \(shadow-only\)/);
});

/* ----------------------------- deterministic ------------------------------ */

test('buildProofPanelView is deterministic for the same input', () => {
  assert.deepEqual(buildProofPanelView(fullInput()), buildProofPanelView(fullInput()));
});

/* ---------------------- no betting language in the view ------------------- */

test('the view carries no betting-placement / prediction language and no commit flag', () => {
  const view = buildProofPanelView(fullInput());
  const text = [view.title, ...view.rows.map((r) => `${r.label} ${r.value}`), ...view.disclaimers].join(' ');
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/i.test(text), false);
  assert.equal(/\bback this\b|\bbet on\b|\bwill win\b|\bnailed on\b|\beach[-\s]way bet\b/i.test(text), false);
  assert.equal(/--commit/.test(text), false);
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the proof-panel helper is pure: no DB, fs, env, network, engines, or placement', () => {
  const lib = readFileSync('src/lib/proofPanel.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/node:fs|require\(['"]fs/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|runModelForRace/.test(lib), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(lib), false);
  assert.equal(/--commit/.test(lib), false);
});

test('the panel component is presentational: no fetch/DB, no write controls, no commit, no placement', () => {
  const cmp = readFileSync('src/components/ProofOfUpdatePanel.tsx', 'utf8');
  assert.equal(/\bfetch\s*\(/.test(cmp), false);
  assert.equal(/supabaseAdmin|\.(insert|update|upsert|delete|rpc)\s*\(/.test(cmp), false);
  assert.equal(/<button|onClick|<input|<form/.test(cmp), false);
  assert.equal(/--commit/.test(cmp), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(cmp), false);
});

test('the dashboard wires the read-only proof panel', () => {
  const page = readFileSync('src/app/page.tsx', 'utf8');
  assert.match(page, /buildProofPanelView/);
  assert.match(page, /<ProofOfUpdatePanel view=\{proofPanelView\} \/>/);
});
