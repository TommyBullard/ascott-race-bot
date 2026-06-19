/**
 * Unit tests for the GenAI (OpenAI) environment preflight
 * (src/lib/genaiEnvPreflight.ts) and its safety invariants.
 *
 * SECURITY: these tests use FAKE, synthetic env records only — never real
 * secrets — assert on presence booleans / variable names (never values), and
 * make NO network or OpenAI calls. Source scans prove that the model, staking,
 * EV, ranking, recommendation and no-bet code never imports OpenAI directly.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OPENAI_API_KEY_VAR,
  GENAI_SHADOW_NOTE,
  isOpenAiKeyPresent,
  summarizeGenAiEnv,
  requireOpenAiApiKey,
  GenAiKeyMissingError,
} from '../src/lib/genaiEnvPreflight';
import { summarizeEnvPresence, ENV_VAR_SPECS } from '../src/lib/envPreflight';

/** A synthetic, obviously-fake key string — NOT a real secret. */
const FAKE_KEY = 'sk-FAKE-not-a-real-secret-0000';

/** All required vars present, GenAI key absent — the normal-operation case. */
const REQUIRED_ONLY: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  RACING_API_USER: 'fake-user',
  RACING_API_KEY: 'fake-racing-key',
};

/* --------------------------- optional in preflight ------------------------ */

test('OPENAI_API_KEY is registered as an OPTIONAL var in the env preflight specs', () => {
  const spec = ENV_VAR_SPECS.find((s) => s.name === OPENAI_API_KEY_VAR);
  assert.ok(spec, 'OPENAI_API_KEY should be present in ENV_VAR_SPECS');
  assert.equal(spec?.required, false, 'OPENAI_API_KEY must be optional');
  assert.equal(spec?.group, 'GenAI');
});

test('app works without OPENAI_API_KEY: required vars present -> preflight ok, key only missing-optional', () => {
  const summary = summarizeEnvPresence(REQUIRED_ONLY);
  // The core pipeline preflight passes without the GenAI key.
  assert.equal(summary.ok, true);
  assert.equal(summary.missingRequired.length, 0);
  // The key is reported as a missing OPTIONAL var, never a required one.
  assert.ok(summary.missingOptional.includes(OPENAI_API_KEY_VAR));
  assert.equal(summary.missingRequired.includes(OPENAI_API_KEY_VAR), false);
});

/* --------------------------- presence summary ----------------------------- */

test('isOpenAiKeyPresent: only a non-empty trimmed value counts as present', () => {
  assert.equal(isOpenAiKeyPresent({ OPENAI_API_KEY: FAKE_KEY }), true);
  assert.equal(isOpenAiKeyPresent({ OPENAI_API_KEY: '   ' }), false);
  assert.equal(isOpenAiKeyPresent({ OPENAI_API_KEY: '' }), false);
  assert.equal(isOpenAiKeyPresent({}), false);
});

test('summarizeGenAiEnv: reports present / missing, and is always optional + not-used-by-default', () => {
  const present = summarizeGenAiEnv({ OPENAI_API_KEY: FAKE_KEY });
  assert.equal(present.key, 'OPENAI_API_KEY');
  assert.equal(present.present, true);
  assert.equal(present.status, 'present');
  assert.equal(present.requiredForApp, false);
  assert.equal(present.usedByDefault, false);
  assert.equal(present.note, GENAI_SHADOW_NOTE);

  const missing = summarizeGenAiEnv({});
  assert.equal(missing.present, false);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.requiredForApp, false);
  assert.equal(missing.usedByDefault, false);
});

test('summarizeGenAiEnv: NEVER serialises the secret value (name + booleans only)', () => {
  const status = summarizeGenAiEnv({ OPENAI_API_KEY: FAKE_KEY });
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(FAKE_KEY), false);
  // The status exposes a presence boolean, not the value, and has no `value` key.
  assert.equal('value' in status, false);
  // The reassurance note states it is shadow-only / not used by default.
  assert.match(status.note, /shadow-only/i);
  assert.match(status.note, /explicitly run/i);
});

test('summarizeGenAiEnv: does not mutate its input', () => {
  const env = { OPENAI_API_KEY: FAKE_KEY };
  const snapshot = JSON.parse(JSON.stringify(env));
  summarizeGenAiEnv(env);
  assert.deepEqual(env, snapshot);
});

/* ----------------- GenAI commands fail safely if missing ------------------ */

test('requireOpenAiApiKey: throws a value-free GenAiKeyMissingError when the key is missing', () => {
  assert.throws(
    () => requireOpenAiApiKey({}),
    (err: unknown) => {
      assert.ok(err instanceof GenAiKeyMissingError);
      assert.ok(err instanceof Error);
      const message = (err as Error).message;
      // Names the variable + points at .env.local, but carries no secret value.
      assert.match(message, /OPENAI_API_KEY/);
      assert.match(message, /\.env\.local/);
      return true;
    },
  );
});

test('requireOpenAiApiKey: a blank/whitespace value still fails safely (treated as missing)', () => {
  assert.throws(() => requireOpenAiApiKey({ OPENAI_API_KEY: '   ' }), GenAiKeyMissingError);
  assert.throws(() => requireOpenAiApiKey({ OPENAI_API_KEY: '' }), GenAiKeyMissingError);
});

test('requireOpenAiApiKey: returns the trimmed key when explicitly present (for an explicit GenAI run)', () => {
  assert.equal(requireOpenAiApiKey({ OPENAI_API_KEY: FAKE_KEY }), FAKE_KEY);
  assert.equal(requireOpenAiApiKey({ OPENAI_API_KEY: `  ${FAKE_KEY}  ` }), FAKE_KEY);
});

test('the missing-key error message never embeds a value (no secret can be in a not-set error)', () => {
  const message = new GenAiKeyMissingError().message;
  assert.equal(message.includes(FAKE_KEY), false);
  assert.equal(message.includes('sk-'), false);
});

/* --------------- purity / secret-safety source scan (module) -------------- */

test('the GenAI env-preflight module is pure: no console, no I/O, no network, no OpenAI SDK call', () => {
  const src = readFileSync('src/lib/genaiEnvPreflight.ts', 'utf8');
  // Pure: it takes env in as a parameter and never reads process.env, fs, or net.
  assert.equal(/console\./.test(src), false);
  assert.equal(/process\.env/.test(src), false);
  assert.equal(/node:fs/.test(src), false);
  assert.equal(/\bfetch\s*\(/.test(src), false);
  // It does NOT itself call an OpenAI/network SDK (it only gates the key).
  assert.equal(/from\s+['"]openai['"]/i.test(src), false);
  assert.equal(/require\(\s*['"]openai['"]\s*\)/i.test(src), false);
});

test('the check:env script reports presence only and never reads out the value', () => {
  const src = readFileSync('scripts/checkEnv.ts', 'utf8');
  // It logs the shared reassurance note (presence-only) but never the key value.
  assert.match(src, /summarizeGenAiEnv/);
  // No DB / network / OpenAI calls from the preflight CLI.
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(/from\s+['"]openai['"]/i.test(src), false);
  assert.equal(/supabaseAdmin/.test(src), false);
});

/* ----- no model / staking / recommendation code imports OpenAI directly --- */

test('no model / staking / EV / ranking / recommendation / no-bet code imports OpenAI or GenAI', () => {
  // The decision engines must stay completely decoupled from any GenAI layer:
  // GenAI is shadow-only and must never reach the model/staking/recommendation
  // path, so none of these files may import OpenAI or the GenAI modules.
  const engineFiles = [
    'src/lib/bettingEngine.ts', // EV, kellyStake, no-bet-at-EV<=0
    'src/lib/modelProbabilities.ts', // calculateModelProbabilities
    'src/lib/runModelForRace.ts', // scoreRaceRunners + orchestration + selection
    'src/lib/raceData.ts', // recommendations reader
    'src/lib/modelStakeSuppression.ts', // staking suppression
    'src/lib/modelDataQuality.ts', // data-quality / no-bet adjustments
  ];
  for (const file of engineFiles) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/openai/i.test(src), false, `${file} must not reference OpenAI`);
    assert.equal(
      /genaiShadowCommentary|genaiEnvPreflight/.test(src),
      false,
      `${file} must not import a GenAI module`,
    );
  }
});
