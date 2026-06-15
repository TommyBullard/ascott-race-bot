/**
 * Unit tests for the pure Bearer-token authorization helper (src/lib/auth.ts).
 *
 * No network or route runtime: these assert the CRON_SECRET gating convention
 * shared by the cron routes and POST /api/run-model — OPEN when the secret is
 * unset (local/dev), and an exact `Bearer <secret>` required when it is set.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAuthorized } from '../src/lib/auth';

test('isAuthorized: CRON_SECRET unset -> open (local/dev convention)', () => {
  assert.equal(isAuthorized(null, undefined), true);
  assert.equal(isAuthorized('Bearer anything', undefined), true);
  // An empty-string secret is treated as "unset", matching the cron routes,
  // which guard on a truthy CRON_SECRET.
  assert.equal(isAuthorized(null, ''), true);
});

test('isAuthorized: CRON_SECRET set + missing Authorization header -> reject', () => {
  assert.equal(isAuthorized(null, 'topsecret'), false);
  assert.equal(isAuthorized(undefined, 'topsecret'), false);
});

test('isAuthorized: CRON_SECRET set + wrong Bearer token -> reject', () => {
  assert.equal(isAuthorized('Bearer wrong', 'topsecret'), false);
  // Missing the "Bearer " scheme prefix.
  assert.equal(isAuthorized('topsecret', 'topsecret'), false);
  // The scheme is case-sensitive.
  assert.equal(isAuthorized('bearer topsecret', 'topsecret'), false);
  // No leakage via a substring/partial match.
  assert.equal(isAuthorized('Bearer topsecret-extra', 'topsecret'), false);
});

test('isAuthorized: CRON_SECRET set + correct Bearer token -> allow', () => {
  assert.equal(isAuthorized('Bearer topsecret', 'topsecret'), true);
});
