/**
 * Unit tests for the shadow-only GenAI race-commentary layer
 * (src/lib/genaiCommentaryPrompt.ts + src/lib/genaiClient.ts).
 *
 * No network, no real LLM: a deterministic STUB client drives the orchestrator,
 * and the live client is exercised with an INJECTED fake fetch + a SYNTHETIC key
 * only. These lock the task's rules: the prompt is deterministic, unknowns are
 * surfaced, a missing OPENAI_API_KEY fails safely, the mocked LLM result flows
 * through, the model/staking/recommendation engines never import the GenAI layer,
 * and the output carries no betting-advice / guarantee language and no secrets.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildRaceCommentaryPrompt,
  validateRaceCommentary,
  generateRaceCommentary,
  renderRaceCommentarySection,
  renderCommentaryReport,
  buildNoEvidenceReport,
  collectUnknowns,
  groundedNumbersForInput,
  COMMENTARY_PROMPT_VERSION,
  COMMENTARY_MAX_CHARS,
  SHADOW_FOOTER,
  NO_EVIDENCE_HEADLINE,
  type RaceCommentaryInput,
  type CommentaryEvidence,
  type CommentaryReportInput,
} from '../src/lib/genaiCommentaryPrompt';
import {
  stubGenaiClient,
  unconfiguredGenaiClient,
  createLiveCommentaryClient,
  resolveCommentaryClient,
  GenaiClientError,
  type GenaiPrompt,
} from '../src/lib/genaiClient';
import { GenAiKeyMissingError } from '../src/lib/genaiEnvPreflight';
import { FORBIDDEN_PHRASES } from '../src/lib/genaiShadowCommentary';

/** A synthetic, obviously-fake key — NOT a real secret. */
const FAKE_KEY = 'sk-FAKE-not-a-real-secret-0000';

/** A fully-populated race input; override only what a test needs. */
function baseInput(over: Partial<RaceCommentaryInput> = {}): RaceCommentaryInput {
  return {
    raceId: 'r1',
    course: 'Ascot',
    raceName: 'Test Stakes',
    offTime: '2026-06-18T14:30:00Z',
    fieldSize: 9,
    raceState: 'result',
    settled: true,
    hasModelRun: true,
    modelPick: {
      horseName: 'Bravo',
      odds: 3.0,
      modelProb: 0.62,
      marketProb: 0.54,
      edge: 0.08,
      ev: 0.12,
      confidenceLabel: 'Medium',
      isFavourite: false,
      stakeSuppressed: false,
    },
    marketFavourite: {
      horseName: 'Alpha',
      odds: 2.5,
      modelProb: 0.5,
      marketProb: 0.55,
      edge: -0.05,
      ev: 0,
      confidenceLabel: null,
    },
    winValue: { horseName: 'Bravo', odds: 3.0, ev: 0.12 },
    eachWay: { horseName: 'Charlie', odds: 9.0 },
    runQuality: 'OK',
    dataQualityShortSummary: 'OK',
    dataQualitySummary: [],
    tipsterConsensusShortSummary: 'No tipster consensus',
    tipsterAlignmentLabel: 'NO_TIPSTER_CONSENSUS',
    reviewedNotes: [{ reference: 'Ground easy after overnight rain.', topic: 'going' }],
    notesScope: 'meeting',
    ...over,
  };
}

function evidence(over: Partial<CommentaryEvidence> = {}): CommentaryEvidence {
  return {
    sourceDocumentId: 'doc-1',
    sourceLabel: 'Operator notes',
    sourceType: 'operator_observation',
    licenceStatus: 'manual',
    noteRaceName: null,
    excerpt: 'Ground easy after overnight rain.',
    notes: [{ reference: 'Ground easy after overnight rain.', topic: 'going' }],
    dateMatchesCommand: true,
    courseMatchesCommand: true,
    noteRaceDate: '2026-06-18',
    ...over,
  };
}

/** Clean, grounded prose that passes the guardrails. */
const CLEAN_PROSE =
  'The model prefers Bravo at 3.0 (a 62% model view) over the 2.5 market favourite Alpha ' +
  'in a 9-runner field. (AI shadow note - not betting advice.)';

/* ------------------------------ prompt deterministic ---------------------- */

test('buildRaceCommentaryPrompt is deterministic and versioned', () => {
  const input = baseInput();
  const p1 = buildRaceCommentaryPrompt(input);
  const p2 = buildRaceCommentaryPrompt(input);
  assert.deepEqual(p1, p2);
  assert.equal(p1.promptVersion, COMMENTARY_PROMPT_VERSION);
  assert.equal(p1.maxChars, COMMENTARY_MAX_CHARS);
  // The user payload separates the four provenances.
  for (const key of ['modelDerived', 'marketDerived', 'sourceNoteDerived', 'unknown']) {
    assert.ok(p1.user.includes(key), key);
  }
  // The system contract states the hard rules.
  assert.match(p1.system, /GROUNDING ONLY/);
  assert.match(p1.system, /NO PREDICTION/);
  assert.match(p1.system, /NO BETTING ADVICE/);
});

/* ------------------------------ unknowns handled -------------------------- */

test('collectUnknowns surfaces every missing fact; a full input has few', () => {
  const sparse = baseInput({
    hasModelRun: false,
    modelPick: null,
    marketFavourite: null,
    fieldSize: null,
    runQuality: null,
    tipsterConsensusShortSummary: null,
    reviewedNotes: [],
    notesScope: 'none',
  });
  const unknowns = collectUnknowns(sparse);
  assert.ok(unknowns.some((u) => /No model run/i.test(u)));
  assert.ok(unknowns.some((u) => /No model pick/i.test(u)));
  assert.ok(unknowns.some((u) => /No priced market favourite/i.test(u)));
  assert.ok(unknowns.some((u) => /Field size unknown/i.test(u)));
  assert.ok(unknowns.some((u) => /No reviewed source-note evidence/i.test(u)));

  // A populated input records no unknowns.
  assert.deepEqual(collectUnknowns(baseInput()), []);
});

test('render surfaces unknowns + the four provenance tags', () => {
  const section = renderRaceCommentarySection(baseInput()).join('\n');
  assert.match(section, /\[model\]/);
  assert.match(section, /\[market\]/);
  assert.match(section, /\[note\]/);
  // A sparse race shows the [unknown] tag for missing evidence.
  const sparse = renderRaceCommentarySection(
    baseInput({ reviewedNotes: [], notesScope: 'none' }),
  ).join('\n');
  assert.match(sparse, /\[unknown\]/);
  assert.match(sparse, /Unknowns:/);
});

/* -------------------- missing OPENAI_API_KEY fails safely ----------------- */

test('resolveCommentaryClient: offline never calls; live without key fails safely', () => {
  const offline = resolveCommentaryClient({ live: false, env: {} });
  assert.equal(offline.willCallApi, false);
  assert.equal(offline.mode, 'offline');

  // Live mode with no key throws a value-free GenAiKeyMissingError (fail-closed).
  assert.throws(() => resolveCommentaryClient({ live: true, env: {} }), GenAiKeyMissingError);
});

test('the unconfigured client refuses to run (off by default)', async () => {
  await assert.rejects(() => unconfiguredGenaiClient().complete({ system: 's', user: 'u' }), GenaiClientError);
});

test('the live client fails closed (no fetch) when the key is missing', async () => {
  let fetchCalls = 0;
  const fakeFetch = (async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  const client = createLiveCommentaryClient({ env: {}, fetchImpl: fakeFetch });
  await assert.rejects(() => client.complete({ system: 's', user: 'u' }), GenAiKeyMissingError);
  assert.equal(fetchCalls, 0, 'must not call fetch when the key is missing');
});

/* ------------------- mocked LLM returns stored commentary ----------------- */

test('mocked LLM result flows through generateRaceCommentary (candidate, pending, not model-active)', async () => {
  const client = stubGenaiClient(CLEAN_PROSE);
  const result = await generateRaceCommentary(client, baseInput());
  assert.equal(result.status, 'candidate');
  assert.equal(result.text, CLEAN_PROSE);
  assert.equal(result.model_active, false);
  assert.equal(result.review_status, 'pending');
  assert.deepEqual(result.problems, []);
});

test('the live client uses an injected fetch (no real OpenAI) and returns the content', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: CLEAN_PROSE } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const client = createLiveCommentaryClient({ env: { OPENAI_API_KEY: FAKE_KEY }, fetchImpl: fakeFetch });
  const out = await client.complete({ system: 's', user: 'u' });
  assert.equal(out, CLEAN_PROSE);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  // The key is carried only in the Authorization header (in-memory, never logged).
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${FAKE_KEY}`);
});

test('a guardrail failure yields a rejected result (forbidden phrase / ungrounded number)', async () => {
  const forbidden = await generateRaceCommentary(stubGenaiClient('You should back this one to win.'), baseInput());
  assert.equal(forbidden.status, 'rejected');
  assert.ok(forbidden.problems.length > 0);
  assert.equal(forbidden.text, null);

  const ungrounded = await generateRaceCommentary(stubGenaiClient('Bravo has a 91% chance.'), baseInput());
  assert.equal(ungrounded.status, 'rejected');
  assert.ok(ungrounded.problems.some((p) => /ungrounded number/i.test(p)));
});

test('validateRaceCommentary: clean grounded prose passes; empty + over-length fail', () => {
  assert.equal(validateRaceCommentary(baseInput(), CLEAN_PROSE).ok, true);
  assert.equal(validateRaceCommentary(baseInput(), '   ').ok, false);
  assert.equal(validateRaceCommentary(baseInput(), 'x'.repeat(COMMENTARY_MAX_CHARS + 1)).ok, false);
  // Grounded set includes the model + market figures.
  const grounded = groundedNumbersForInput(baseInput());
  assert.ok(grounded.has('62') && grounded.has('3') && grounded.has('2.5'));
});

/* --------------------------- no invented evidence ------------------------- */

test('renderCommentaryReport with no evidence => no-evidence report, never invents commentary', () => {
  const report: CommentaryReportInput = {
    date: '2026-06-18',
    course: 'Ascot',
    evidence: null,
    races: [baseInput(), baseInput({ raceId: 'r2' })],
    mode: 'offline',
    liveCallMade: false,
  };
  const md = renderCommentaryReport(report);
  assert.ok(md.includes(NO_EVIDENCE_HEADLINE));
  assert.equal(/\[model\] Model pick:/.test(md), false); // no per-race commentary invented
  assert.match(md, /Stored races found for this meeting: 2/);

  const direct = buildNoEvidenceReport({ date: '2026-06-18', course: 'Ascot', raceCount: 0 });
  assert.ok(direct.includes(NO_EVIDENCE_HEADLINE));
});

test('a full report renders per-race sections, evidence, and the shadow footer', () => {
  const report: CommentaryReportInput = {
    date: '2026-06-18',
    course: 'Ascot',
    evidence: evidence(),
    races: [baseInput()],
    mode: 'offline',
    liveCallMade: false,
  };
  const md = renderCommentaryReport(report);
  assert.match(md, /## Reviewed source evidence/);
  assert.match(md, /## Races/);
  assert.match(md, /\[model\] Model pick: Bravo/);
  assert.ok(md.includes(SHADOW_FOOTER));
});

test('mismatched note date / course raise explicit warnings in the report', () => {
  const md = renderCommentaryReport({
    date: '2026-06-18',
    course: 'Ascot',
    evidence: evidence({ dateMatchesCommand: false, noteRaceDate: '2026-06-17' }),
    races: [baseInput()],
    mode: 'offline',
    liveCallMade: false,
  });
  assert.match(md, /WARNING: the supplied note is dated 2026-06-17/);
});

/* --------------------- no betting-advice / guarantee language -------------- */

test('the deterministic output contains no betting-advice / prediction / guarantee phrasing', () => {
  const md = renderCommentaryReport({
    date: '2026-06-18',
    course: 'Ascot',
    evidence: evidence(),
    races: [baseInput(), baseInput({ raceId: 'r2', modelPick: null, hasModelRun: true })],
    mode: 'offline',
    liveCallMade: false,
  });
  for (const re of FORBIDDEN_PHRASES) {
    assert.equal(re.test(md), false, `forbidden phrase matched: ${re}`);
  }
  // No-evidence report is likewise clean.
  const none = buildNoEvidenceReport({ date: '2026-06-18', course: 'Ascot', raceCount: 3 });
  for (const re of FORBIDDEN_PHRASES) assert.equal(re.test(none), false, `forbidden in no-evidence: ${re}`);
  // Explicit guarantee/certainty check.
  assert.equal(/\bguarantee|\bcertaint|\bsure thing\b/i.test(md), false);
});

/* ------------------------ no secrets logged (source scans) ---------------- */

test('the GenAI client never logs the API key (used only in the Authorization header)', () => {
  const src = readFileSync('src/lib/genaiClient.ts', 'utf8');
  // The key flows ONLY into the Authorization header.
  assert.match(src, /Bearer \$\{apiKey\}/);
  // It is never passed to a console call.
  assert.equal(/console\.\w+\([^)]*apiKey/.test(src), false);
  // The key is read fail-closed via the env preflight gate.
  assert.match(src, /requireOpenAiApiKey/);
});

test('the commentary CLI never prints the key and is read-only (no DB writes / no commit)', () => {
  const cli = readFileSync('scripts/genaiCommentary.ts', 'utf8');
  // It never reads the key VALUE (it passes the whole env to the resolver, which
  // gates it via requireOpenAiApiKey). Naming the var in help text is fine.
  assert.equal(/process\.env\.OPENAI_API_KEY/.test(cli), false);
  assert.equal(/console\.\w+\([^)]*apiKey/.test(cli), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  assert.equal(/--commit/.test(cli), false);
  assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(cli), false);
});

/* ----------- no model / staking / recommendation imports changed ---------- */

test('the decision engines never import the GenAI commentary layer', () => {
  const engineFiles = [
    'src/lib/bettingEngine.ts',
    'src/lib/modelProbabilities.ts',
    'src/lib/runModelForRace.ts',
    'src/lib/raceData.ts',
    'src/lib/modelStakeSuppression.ts',
    'src/lib/modelDataQuality.ts',
  ];
  for (const file of engineFiles) {
    const src = readFileSync(file, 'utf8');
    assert.equal(
      /genaiCommentaryPrompt|genaiClient|genaiShadowCommentary/.test(src),
      false,
      `${file} must not import the GenAI layer`,
    );
    assert.equal(/openai/i.test(src), false, `${file} must not reference OpenAI`);
  }
});

test('the GenAI commentary modules do not import the model/staking/recommendation engines', () => {
  for (const file of ['src/lib/genaiCommentaryPrompt.ts', 'src/lib/genaiClient.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.equal(
      /bettingEngine|modelProbabilities|kellyStake|scoreRaceRunners|runModelForRace/.test(src),
      false,
      `${file} must not import a decision engine`,
    );
    assert.equal(/placeOrder|placeBet|submitOrder|sendOrder/.test(src), false, `${file} placement`);
  }
});

/* ------------------------------ prompt is inert --------------------------- */

test('buildRaceCommentaryPrompt performs no generation (returns text only)', () => {
  const prompt: GenaiPrompt = buildRaceCommentaryPrompt(baseInput());
  assert.equal(typeof prompt.system, 'string');
  assert.equal(typeof prompt.user, 'string');
});
