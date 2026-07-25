/**
 * Unit tests for the FAIL-CLOSED cron-secret helper (src/lib/auth.ts) —
 * Phase 7A route-hardening, Step A.
 *
 * No network and no route runtime: these assert the pure rules shared by every
 * write-capable route. The old fail-OPEN convention (an unset `CRON_SECRET`
 * meaning "allow everyone") is gone and is regression-tested here: a missing or
 * blank secret must REFUSE, never open the endpoint.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeCronAuthFailure,
  requireCronSecret,
  type CronAuthResult,
} from '../src/lib/auth';

const SECRET = 'topsecret-value';

test('requireCronSecret: MISSING CRON_SECRET fails closed (never open)', () => {
  assert.equal(requireCronSecret(null, undefined), 'not_configured');
  assert.equal(requireCronSecret('Bearer anything', undefined), 'not_configured');
  assert.equal(requireCronSecret(`Bearer ${SECRET}`, undefined), 'not_configured');
  assert.equal(requireCronSecret(null, null), 'not_configured');
});

test('requireCronSecret: BLANK / whitespace-only CRON_SECRET fails closed', () => {
  for (const blank of ['', ' ', '\t', '\n', '   ']) {
    assert.equal(requireCronSecret(null, blank), 'not_configured', `blank ${JSON.stringify(blank)}`);
    assert.equal(
      requireCronSecret(`Bearer ${blank}`, blank),
      'not_configured',
      `blank echoed back ${JSON.stringify(blank)}`,
    );
  }
});

test('requireCronSecret: configured secret + missing Authorization header -> reject', () => {
  assert.equal(requireCronSecret(null, SECRET), 'unauthorized');
  assert.equal(requireCronSecret(undefined, SECRET), 'unauthorized');
  assert.equal(requireCronSecret('', SECRET), 'unauthorized');
});

test('requireCronSecret: configured secret + incorrect token -> reject', () => {
  assert.equal(requireCronSecret('Bearer wrong', SECRET), 'unauthorized');
  // Missing the "Bearer " scheme prefix.
  assert.equal(requireCronSecret(SECRET, SECRET), 'unauthorized');
  // The scheme is case-sensitive.
  assert.equal(requireCronSecret(`bearer ${SECRET}`, SECRET), 'unauthorized');
  // No prefix / substring match.
  assert.equal(requireCronSecret(`Bearer ${SECRET}-extra`, SECRET), 'unauthorized');
  assert.equal(requireCronSecret(`Bearer ${SECRET.slice(0, 5)}`, SECRET), 'unauthorized');
  // No surrounding whitespace tolerance.
  assert.equal(requireCronSecret(` Bearer ${SECRET}`, SECRET), 'unauthorized');
  assert.equal(requireCronSecret(`Bearer ${SECRET} `, SECRET), 'unauthorized');
});

test('requireCronSecret: configured secret + correct token -> authorized', () => {
  assert.equal(requireCronSecret(`Bearer ${SECRET}`, SECRET), 'authorized');
});

test('requireCronSecret: only the three documented outcomes are reachable', () => {
  const outcomes = new Set<CronAuthResult>();
  outcomes.add(requireCronSecret(null, undefined));
  outcomes.add(requireCronSecret('Bearer wrong', SECRET));
  outcomes.add(requireCronSecret(`Bearer ${SECRET}`, SECRET));
  assert.deepEqual([...outcomes].sort(), ['authorized', 'not_configured', 'unauthorized']);
});

test('describeCronAuthFailure: unauthorized -> generic 401 with no server log', () => {
  const refusal = describeCronAuthFailure('unauthorized');
  assert.equal(refusal.status, 401);
  assert.deepEqual(refusal.body, { error: 'Unauthorized' });
  assert.equal(refusal.logLine, null);
});

test('describeCronAuthFailure: not_configured -> generic 503 plus an operator log', () => {
  const refusal = describeCronAuthFailure('not_configured');
  assert.equal(refusal.status, 503);
  assert.deepEqual(refusal.body, { error: 'Endpoint unavailable' });
  assert.ok(typeof refusal.logLine === 'string' && refusal.logLine.includes('CRON_AUTH_NOT_CONFIGURED'));
});

test('describeCronAuthFailure: refusal bodies disclose nothing', () => {
  for (const result of ['unauthorized', 'not_configured'] as const) {
    const refusal = describeCronAuthFailure(result);
    const serialized = JSON.stringify(refusal.body);
    // No secret value, no env var name, no command, no owner id, no schema hint.
    assert.doesNotMatch(serialized, /CRON_SECRET|SUPABASE|SERVICE_ROLE|BETFAIR|RACING_API/i);
    assert.doesNotMatch(serialized, /npm run|Bearer|owner|race_id|runner|settle/i);
    // A one-line, human-readable message and nothing else.
    assert.deepEqual(Object.keys(refusal.body), ['error']);
  }
});

test('describeCronAuthFailure: structurally cannot receive or echo the secret', () => {
  // It takes exactly one argument — the refusal enum. The secret value is never
  // in scope, so no future edit can leak it through this path.
  assert.equal(describeCronAuthFailure.length, 1);
  const logLine = describeCronAuthFailure('not_configured').logLine ?? '';
  assert.ok(!logLine.includes(SECRET));
  // The log names the VARIABLE (so an operator can fix it) but carries no value.
  assert.match(logLine, /CRON_SECRET is not set/);
});

test('the fail-open helper is gone (no caller can reach the old convention)', async () => {
  const mod = (await import('../src/lib/auth')) as Record<string, unknown>;
  assert.equal('isAuthorized' in mod, false);
  assert.deepEqual(Object.keys(mod).sort(), ['describeCronAuthFailure', 'requireCronSecret']);
});
