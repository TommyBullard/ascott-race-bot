/**
 * Tests for the OpenAI-backed shadow-commentary generator adapter.
 *
 * Proves: the OpenAI client is MOCKED (no live call), a missing key fails closed,
 * generated text runs the guardrails (forbidden phrases + ungrounded numbers
 * rejected), and every artifact is shadow-only (model_active=false, pending).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  generateShadowCommentary,
  type CommentaryContext,
} from '../src/lib/genaiShadowCommentary';
import { stubGenaiClient, GenaiClientError } from '../src/lib/genaiClient';
import {
  createOpenAiShadowGenerator,
  resolveOpenAiShadowGenerator,
} from '../src/lib/openAiShadowGenerator';

const CONTEXT: CommentaryContext = {
  race: { course: 'Ascot', raceName: 'Test Stakes', offTime: null, fieldSize: 8 },
  modelPick: {
    runnerId: 'r1', horseName: 'Alpha', odds: 5, modelProb: 0.2, marketProb: 0.18,
    edge: 0.02, ev: 0.05, confidenceLabel: 'Low',
  },
  marketFavourite: {
    runnerId: 'r2', horseName: 'Beta', odds: 2.5, modelProb: 0.35, marketProb: 0.4,
    edge: -0.05, ev: -0.1, confidenceLabel: null,
  },
  runQuality: 'OK',
  dataQualityFlags: [],
  consensus: null,
  narratives: { attractive: [], caution: [] },
  disagreement: { modelTopHorse: 'Alpha', marketTopHorse: 'Beta', agree: false, edge: 0.02 },
};

const CLEAN_NOTE = 'The model pick and the market favourite differ here. (AI shadow note — not betting advice.)';

test('adapter: mocked client produces a shadow CANDIDATE (model_active=false, pending)', async () => {
  const generator = createOpenAiShadowGenerator(stubGenaiClient(CLEAN_NOTE));
  const artifact = await generateShadowCommentary(generator, { kind: 'race_summary', context: CONTEXT });
  assert.equal(artifact.status, 'candidate');
  assert.equal(artifact.model_active, false);
  assert.equal(artifact.review_status, 'pending');
  assert.equal(artifact.text, CLEAN_NOTE);
});

test('adapter: forbidden betting phrase is REJECTED (never a candidate)', async () => {
  const generator = createOpenAiShadowGenerator(stubGenaiClient('You should bet on the favourite to win.'));
  const artifact = await generateShadowCommentary(generator, { kind: 'race_summary', context: CONTEXT });
  assert.equal(artifact.status, 'rejected');
  assert.equal(artifact.model_active, false);
  assert.equal(artifact.review_status, 'pending');
  assert.equal(artifact.text, null);
  assert.ok(artifact.problems.some((p) => /forbidden phrase/i.test(p)));
});

test('adapter: ungrounded number is REJECTED', async () => {
  const generator = createOpenAiShadowGenerator(stubGenaiClient('The pick has a 73% chance of glory.'));
  const artifact = await generateShadowCommentary(generator, { kind: 'race_summary', context: CONTEXT });
  assert.equal(artifact.status, 'rejected');
  assert.ok(artifact.problems.some((p) => /ungrounded number/i.test(p)));
});

test('adapter: a generator error is contained as a rejected artifact (never throws to caller)', async () => {
  const throwing = createOpenAiShadowGenerator(
    stubGenaiClient(() => {
      throw new Error('boom');
    }),
  );
  const artifact = await generateShadowCommentary(throwing, { kind: 'race_summary', context: CONTEXT });
  assert.equal(artifact.status, 'rejected');
  assert.equal(artifact.model_active, false);
  assert.equal(artifact.review_status, 'pending');
});

test('resolve: offline mode does not call the API and never builds a calling client', () => {
  const resolved = resolveOpenAiShadowGenerator({ live: false });
  assert.equal(resolved.mode, 'offline');
  assert.equal(resolved.willCallApi, false);
});

test('resolve: live WITHOUT a key fails closed (value-free error, no client built)', () => {
  assert.throws(
    () => resolveOpenAiShadowGenerator({ live: true, env: {} }),
    (err: unknown) => {
      // The error must not contain a key value (there is none) and must be typed.
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

test('resolve: live WITH a key uses the INJECTED fetch (no real network) and returns text', async () => {
  let called = 0;
  const fakeFetch = (async () => {
    called += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: CLEAN_NOTE } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const resolved = resolveOpenAiShadowGenerator({
    live: true,
    env: { OPENAI_API_KEY: 'fake-test-key-not-real' },
    fetchImpl: fakeFetch,
  });
  assert.equal(resolved.mode, 'live');
  assert.equal(resolved.willCallApi, true);

  const artifact = await generateShadowCommentary(resolved.generator, {
    kind: 'race_summary',
    context: CONTEXT,
  });
  assert.equal(called, 1); // the injected fake transport was used — not the network
  assert.equal(artifact.status, 'candidate');
  // The key must never appear in the produced artifact.
  assert.ok(!JSON.stringify(artifact).includes('fake-test-key-not-real'));
});

/* -------------------------------------------------------------------------- */
/* Source scans                                                               */
/* -------------------------------------------------------------------------- */

test('source: adapter has no direct network call and no model/staking imports', () => {
  const src = readFileSync('src/lib/openAiShadowGenerator.ts', 'utf8');
  // It delegates to genaiClient; it must not itself fetch OpenAI or import engines.
  assert.doesNotMatch(src, /api\.openai\.com|fetch\(/);
  assert.doesNotMatch(src, /bettingEngine|modelProbabilities|runModelForRace|kellyStake/);
  assert.doesNotMatch(src, /placeOrder|placeBet|submitOrder/);
});
