/**
 * Unit tests for the shadow-only GenAI commentary layer
 * (src/lib/genaiShadowCommentary.ts).
 *
 * No network, no LLM: a fake injected generator drives the orchestrator. These
 * lock the guardrails that keep the layer informational and non-betting — the
 * anti-fabrication number check, the forbidden-phrase check, the per-kind
 * preconditions, and the invariant that EVERY artifact is model_active:false /
 * review_status:'pending'. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommentaryPrompt,
  validateCommentaryResponse,
  groundedNumbersFromContext,
  findUngroundedNumbers,
  findForbiddenPhrases,
  commentaryPrecondition,
  generateShadowCommentary,
  unconfiguredCommentaryGenerator,
  PROMPT_VERSION,
  type CommentaryContext,
  type CommentaryGenerator,
  type CommentaryPrompt,
} from '../src/lib/genaiShadowCommentary';

/** A grounded context fixture (model pick Bravo, favourite Alpha, a disagreement). */
function context(): CommentaryContext {
  return {
    race: { course: 'Ascot', raceName: 'Test Stakes', offTime: '2026-06-18T14:30:00Z', fieldSize: 9 },
    modelPick: {
      runnerId: 'B', horseName: 'Bravo', odds: 3.0, modelProb: 0.62, marketProb: 0.54,
      edge: 0.08, ev: 0.12, confidenceLabel: 'Medium',
    },
    marketFavourite: {
      runnerId: 'A', horseName: 'Alpha', odds: 2.5, modelProb: 0.5, marketProb: 0.55,
      edge: -0.05, ev: 0, confidenceLabel: null,
    },
    runQuality: 'OK',
    dataQualityFlags: [],
    consensus: { strength: 'STRONG', type: 'VALUE', detail: '7 of 9 weighted tipsters support Bravo' },
    narratives: {
      attractive: ['Trainer in strong recent form — 9 from 30 (30%) over 14d'],
      caution: ['Lightly raced — only 2 career runs; form is less exposed'],
    },
    disagreement: { modelTopHorse: 'Bravo', marketTopHorse: 'Alpha', agree: false, edge: 0.08 },
  };
}

/** A fake generator returning a fixed string. */
function fakeGenerator(text: string): CommentaryGenerator {
  return { name: 'fake', version: 't', async generate(_p: CommentaryPrompt) { return text; } };
}

test('grounded numbers: context figures are allowed; invented ones are flagged', () => {
  const grounded = groundedNumbersFromContext(context());
  // From the context: 62% prob, 8% edge, 3.0 odds, 9 runners, "7 of 9".
  assert.equal(findUngroundedNumbers('62% with an 8% edge at 3.0 in a 9-runner field, 7 of 9', grounded).length, 0);
  // 75 is not in the context.
  assert.deepEqual(findUngroundedNumbers('a 75% chance', grounded), ['75%']);
});

test('forbidden phrases: betting + prediction language is detected', () => {
  assert.ok(findForbiddenPhrases('You should back this one').length > 0);
  assert.ok(findForbiddenPhrases('a £10 stake looks fair').length > 0);
  assert.ok(findForbiddenPhrases('this one will win easily').length > 0);
  assert.ok(findForbiddenPhrases('a nailed on banker').length > 0);
  assert.equal(findForbiddenPhrases('The model rates Bravo on value grounds.').length, 0);
});

test('validate: clean grounded prose passes; forbidden / ungrounded / empty fail', () => {
  const ctx = context();
  const clean =
    'The model prefers Bravo at 3.0 (62% vs a 54% market view, an 8% edge) in a 9-runner field. ' +
    '(AI shadow note — not betting advice.)';
  assert.equal(validateCommentaryResponse('race_summary', ctx, clean).ok, true);

  assert.equal(validateCommentaryResponse('race_summary', ctx, '   ').ok, false);
  assert.equal(
    validateCommentaryResponse('race_summary', ctx, 'Bravo has a 90% chance.').ok,
    false, // 90 ungrounded
  );
  assert.equal(
    validateCommentaryResponse('race_summary', ctx, 'Bet on Bravo at 3.0.').ok,
    false, // forbidden "bet on"
  );
});

test('validate: over-length prose is rejected', () => {
  const ctx = context();
  const long = 'Bravo looks fair on the figures. '.repeat(40); // > 600 chars, no numbers
  assert.equal(validateCommentaryResponse('race_summary', ctx, long).ok, false);
});

test('preconditions: each kind requires its supporting facts', () => {
  const ctx = context();
  assert.equal(commentaryPrecondition('race_summary', ctx).ok, true);
  assert.equal(commentaryPrecondition('trainer_note', ctx).ok, true); // trainer narrative present
  assert.equal(commentaryPrecondition('narrative_risk', ctx).ok, true); // caution present
  assert.equal(commentaryPrecondition('confidence_commentary', ctx).ok, true); // runQuality present
  assert.equal(commentaryPrecondition('disagreement_reason', ctx).ok, true); // agree:false

  // No disagreement -> disagreement_reason precondition fails.
  const agreeCtx: CommentaryContext = {
    ...ctx,
    disagreement: { modelTopHorse: 'Bravo', marketTopHorse: 'Bravo', agree: true, edge: 0 },
  };
  assert.equal(commentaryPrecondition('disagreement_reason', agreeCtx).ok, false);

  // No trainer narrative -> trainer_note precondition fails.
  const noTrainer: CommentaryContext = { ...ctx, narratives: { attractive: [], caution: [] } };
  assert.equal(commentaryPrecondition('trainer_note', noTrainer).ok, false);
});

test('buildCommentaryPrompt: stamps the version, length budget, and grounding contract', () => {
  const p = buildCommentaryPrompt('race_summary', context());
  assert.equal(p.promptVersion, PROMPT_VERSION);
  assert.ok(p.maxChars > 0);
  assert.match(p.system, /GROUNDING ONLY/);
  assert.match(p.system, /NO BETTING ADVICE/);
  assert.match(p.user, /CONTEXT/);
});

test('unconfigured generator refuses to run (off by default)', async () => {
  await assert.rejects(() => unconfiguredCommentaryGenerator().generate(buildCommentaryPrompt('race_summary', context())));
});

test('generateShadowCommentary: clean generation -> candidate; always shadow + pending', async () => {
  const ctx = context();
  const clean =
    'The model prefers Bravo at 3.0 (62% vs 54%, an 8% edge) in a 9-runner field. ' +
    '(AI shadow note — not betting advice.)';
  const art = await generateShadowCommentary(fakeGenerator(clean), { kind: 'race_summary', context: ctx });
  assert.equal(art.status, 'candidate');
  assert.equal(art.text, clean);
  assert.equal(art.model_active, false);
  assert.equal(art.review_status, 'pending');
  assert.equal(art.prompt_version, PROMPT_VERSION);
});

test('generateShadowCommentary: ungrounded / forbidden / precondition -> rejected (text null)', async () => {
  const ctx = context();

  const ungrounded = await generateShadowCommentary(
    fakeGenerator('Bravo has a 99% chance of victory.'),
    { kind: 'race_summary', context: ctx },
  );
  assert.equal(ungrounded.status, 'rejected');
  assert.equal(ungrounded.text, null);
  assert.equal(ungrounded.model_active, false);
  assert.ok(ungrounded.problems.some((p) => p.includes('ungrounded number')));

  const forbidden = await generateShadowCommentary(
    fakeGenerator('You should stake two points on Bravo.'),
    { kind: 'race_summary', context: ctx },
  );
  assert.equal(forbidden.status, 'rejected');
  assert.ok(forbidden.problems.some((p) => p.includes('forbidden phrase')));

  // Precondition failure never even calls the generator.
  let called = false;
  const spy: CommentaryGenerator = {
    name: 'spy', version: 't',
    async generate() { called = true; return 'x'; },
  };
  const agreeCtx: CommentaryContext = {
    ...ctx,
    disagreement: { modelTopHorse: 'Bravo', marketTopHorse: 'Bravo', agree: true, edge: 0 },
  };
  const noDisagree = await generateShadowCommentary(spy, { kind: 'disagreement_reason', context: agreeCtx });
  assert.equal(noDisagree.status, 'rejected');
  assert.equal(called, false);
});

test('generateShadowCommentary: a throwing generator is contained as a rejected artifact', async () => {
  const art = await generateShadowCommentary(unconfiguredCommentaryGenerator(), {
    kind: 'race_summary',
    context: context(),
  });
  assert.equal(art.status, 'rejected');
  assert.equal(art.model_active, false);
  assert.ok(art.problems.some((p) => p.includes('generator error')));
});
