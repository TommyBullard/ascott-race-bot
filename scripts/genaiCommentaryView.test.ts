/**
 * Tests for the read-only dashboard GenAI commentary selector + safety scans of
 * the panel and the generate CLI.
 *
 * Proves: only APPROVED candidate commentary is surfaced (pending/rejected never
 * shown as fact), the panel has no write controls, and the generate CLI is
 * offline + dry-run by default with no betting/placement and no model imports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  selectApprovedCommentary,
  buildGenaiCommentaryView,
  GENAI_SHADOW_DISCLAIMER,
  GENAI_EMPTY_MESSAGE,
  type GenaiCommentaryRow,
} from '../src/lib/genaiCommentaryView';

function row(over: Partial<GenaiCommentaryRow>): GenaiCommentaryRow {
  return {
    kind: 'race_summary',
    commentary_text: 'A grounded shadow note. (AI shadow note — not betting advice.)',
    prompt_version: 'genai-commentary-v1',
    generator_name: 'openai:live',
    generated_at: '2026-06-19T10:00:00Z',
    status: 'candidate',
    review_status: 'approved',
    ...over,
  };
}

test('selector: surfaces ONLY approved candidate rows with prose', () => {
  const items = selectApprovedCommentary([row({})]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'race_summary');
  assert.equal(items[0].generatorName, 'openai:live');
  assert.equal(items[0].promptVersion, 'genai-commentary-v1');
});

test('selector: NEVER surfaces pending commentary (not shown as fact)', () => {
  assert.deepEqual(selectApprovedCommentary([row({ review_status: 'pending' })]), []);
});

test('selector: NEVER surfaces rejected commentary (status or review_status)', () => {
  assert.deepEqual(selectApprovedCommentary([row({ status: 'rejected' })]), []);
  assert.deepEqual(selectApprovedCommentary([row({ review_status: 'rejected' })]), []);
});

test('selector: drops approved rows with empty/blank/null text', () => {
  assert.deepEqual(selectApprovedCommentary([row({ commentary_text: '' })]), []);
  assert.deepEqual(selectApprovedCommentary([row({ commentary_text: '   ' })]), []);
  assert.deepEqual(selectApprovedCommentary([row({ commentary_text: null })]), []);
});

test('selector: null/undefined/non-array input is safe', () => {
  assert.deepEqual(selectApprovedCommentary(null), []);
  assert.deepEqual(selectApprovedCommentary(undefined), []);
  // @ts-expect-error intentional malformed input
  assert.deepEqual(selectApprovedCommentary('nope'), []);
});

test('view: hasAny + disclaimer + emptyMessage wiring', () => {
  const empty = buildGenaiCommentaryView([row({ review_status: 'pending' })]);
  assert.equal(empty.hasAny, false);
  assert.equal(empty.disclaimer, GENAI_SHADOW_DISCLAIMER);
  assert.equal(empty.emptyMessage, GENAI_EMPTY_MESSAGE);

  const full = buildGenaiCommentaryView([row({})]);
  assert.equal(full.hasAny, true);
  assert.equal(full.items.length, 1);
  assert.equal(full.emptyMessage, GENAI_EMPTY_MESSAGE);
});

test('constants: disclaimer + empty message are launch-safe wording', () => {
  assert.match(GENAI_SHADOW_DISCLAIMER, /not betting advice/i);
  assert.match(GENAI_EMPTY_MESSAGE, /no reviewed/i);
});

/* -------------------------------------------------------------------------- */
/* Source scans — panel + generate CLI safety                                 */
/* -------------------------------------------------------------------------- */

const PANEL_SRC = readFileSync('src/components/GenaiCommentaryPanel.tsx', 'utf8');
const CLI_SRC = readFileSync('scripts/genaiGenerateCommentary.ts', 'utf8');

test('panel: read-only — no write controls, no fetch, renders disclaimer + empty-state message', () => {
  // Require real JSX usage (onClick=, <button) so prose like "no buttons" in the
  // component's own doc comment is not a false positive.
  assert.doesNotMatch(PANEL_SRC, /<button|onClick=|<form|<input|method:\s*['"]POST|NEXT_PUBLIC/);
  assert.doesNotMatch(PANEL_SRC, /placeOrder|placeBet|submitOrder/);
  assert.doesNotMatch(PANEL_SRC, /fetch\(|supabaseAdmin/); // no data fetching in the component
  assert.match(PANEL_SRC, /view\.emptyMessage/); // shows the empty-state message when nothing is approved
  assert.match(PANEL_SRC, /view\.disclaimer/); // renders the mandatory disclaimer constant
});

test('cli: offline + dry-run by default; no betting; no model/staking/recommendation imports', () => {
  // Writes are gated behind --commit (default false) and OpenAI behind --live.
  assert.match(CLI_SRC, /commit:\s*false/);
  assert.match(CLI_SRC, /live:\s*false/);
  // No bet placement / auto-betting.
  assert.doesNotMatch(CLI_SRC, /placeOrder|placeBet|submitOrder|sendOrder/);
  // Never imports or touches the decision engines.
  assert.doesNotMatch(CLI_SRC, /bettingEngine|modelProbabilities|runModelForRace|kellyStake|scoreRaceRunners/);
  // model_active is always stored false.
  assert.match(CLI_SRC, /model_active:\s*false/);
  assert.match(CLI_SRC, /review_status:\s*'pending'/);
  // Never prints the key VALUE (naming the variable in help text is fine).
  assert.doesNotMatch(CLI_SRC, /console\.\w+\([^)]*process\.env\.OPENAI_API_KEY/);
});

test('shadow-only: pipeline + dashboard read never touch the model/staking/recommendation engines', () => {
  const pipeline = readFileSync('src/lib/genaiShadowCommentary.ts', 'utf8');
  // The shadow layer reads already-computed model output but never imports or
  // touches the decision engines, and every artifact it stamps is model_active:false.
  assert.doesNotMatch(pipeline, /bettingEngine|modelProbabilities|runModelForRace|kellyStake|scoreRaceRunners/);
  assert.match(pipeline, /model_active:\s*false/);
  assert.match(pipeline, /review_status:\s*'pending'/);

  const raceData = readFileSync('src/lib/raceData.ts', 'utf8');
  // The dashboard read is review-gated (approved + candidate only)...
  assert.match(raceData, /'review_status',\s*'approved'/);
  assert.match(raceData, /'status',\s*'candidate'/);
  // ...and the commentary is attached to the card as display data only — never
  // fed into a probability/EV/stake/recommendation computation.
  assert.match(raceData, /card\.genaiCommentary\s*=/);
});
