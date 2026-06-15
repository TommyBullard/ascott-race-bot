/**
 * Unit tests for the pure env preflight summary (src/lib/envPreflight.ts).
 *
 * SECURITY: these tests use FAKE, synthetic env records only — never real
 * secrets — and assert on presence booleans / variable names, never values.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isEnvValuePresent,
  summarizeEnvPresence,
  ENV_VAR_SPECS,
  type EnvVarSpec,
} from '../src/lib/envPreflight';

test('isEnvValuePresent: only a non-empty trimmed string counts as present', () => {
  assert.equal(isEnvValuePresent('x'), true);
  assert.equal(isEnvValuePresent('  value  '), true);
  assert.equal(isEnvValuePresent(''), false);
  assert.equal(isEnvValuePresent('   '), false);
  assert.equal(isEnvValuePresent(undefined), false);
  assert.equal(isEnvValuePresent(null), false);
});

const SPECS: readonly EnvVarSpec[] = [
  { name: 'REQ_A', group: 'G1', required: true },
  { name: 'REQ_B', group: 'G1', required: true },
  { name: 'OPT_C', group: 'G2', required: false },
];

test('summarizeEnvPresence: all required present -> ok, blanks treated as missing', () => {
  const summary = summarizeEnvPresence(
    { REQ_A: 'a', REQ_B: 'b', OPT_C: '   ' }, // OPT_C blank
    SPECS,
  );
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.missingRequired, []);
  assert.deepEqual(summary.missingOptional, ['OPT_C']);
  assert.equal(summary.presentCount, 2);
});

test('summarizeEnvPresence: a missing required var flips ok=false', () => {
  const summary = summarizeEnvPresence({ REQ_A: 'a', OPT_C: 'c' }, SPECS);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.missingRequired, ['REQ_B']);
  assert.deepEqual(summary.missingOptional, []);
  assert.equal(summary.presentCount, 2);
});

test('summarizeEnvPresence: empty env -> all missing, ok=false', () => {
  const summary = summarizeEnvPresence({}, SPECS);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.missingRequired, ['REQ_A', 'REQ_B']);
  assert.deepEqual(summary.missingOptional, ['OPT_C']);
  assert.equal(summary.presentCount, 0);
});

test('summarizeEnvPresence: results never carry values, only presence booleans', () => {
  const summary = summarizeEnvPresence({ REQ_A: 'super-secret', REQ_B: 'b' }, SPECS);
  const serialized = JSON.stringify(summary);
  // The verdict must expose presence, not the secret value itself.
  assert.equal(serialized.includes('super-secret'), false);
  const a = summary.results.find((r) => r.name === 'REQ_A');
  assert.equal(a?.present, true);
  assert.equal('value' in (a ?? {}), false);
});

test('summarizeEnvPresence: defaults to the real ENV_VAR_SPECS and is null-safe', () => {
  // No second arg -> uses ENV_VAR_SPECS. An empty env reports every var missing
  // without throwing.
  const summary = summarizeEnvPresence({});
  assert.equal(summary.results.length, ENV_VAR_SPECS.length);
  assert.equal(summary.presentCount, 0);
  // The four documented required vars must be flagged as missing.
  for (const name of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'RACING_API_USER',
    'RACING_API_KEY',
  ]) {
    assert.ok(summary.missingRequired.includes(name), `${name} should be required`);
  }
});

test('summarizeEnvPresence: does not mutate its inputs', () => {
  const env = { REQ_A: 'a', REQ_B: 'b', OPT_C: 'c' };
  const envSnapshot = JSON.parse(JSON.stringify(env));
  const specsSnapshot = JSON.parse(JSON.stringify(SPECS));
  summarizeEnvPresence(env, SPECS);
  assert.deepEqual(env, envSnapshot);
  assert.deepEqual(SPECS, specsSnapshot);
});
