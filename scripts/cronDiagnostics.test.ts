/**
 * Unit tests for the pure cron error diagnostics (src/lib/cronDiagnostics.ts).
 *
 * No DB, no network, no env reads: synthetic error messages exercise the hint
 * selection, the diagnostic builder, and the log formatter — and assert that
 * hints are static (never echo a value). Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cronErrorHint,
  buildCronErrorDiagnostic,
  formatCronErrorLog,
} from '../src/lib/cronDiagnostics';

test('cronErrorHint: Racing API messages -> Racing API guidance', () => {
  assert.match(
    cronErrorHint('Missing environment variable: RACING_API_USER') ?? '',
    /RACING_API_USER \/ RACING_API_KEY/,
  );
  assert.match(
    cronErrorHint('Racing API 401 Unauthorized for /racecards/standard') ?? '',
    /RACING_API_USER \/ RACING_API_KEY/,
  );
});

test('cronErrorHint: Betfair messages -> Betfair guidance', () => {
  assert.match(
    cronErrorHint('Missing Betfair env var(s): BETFAIR_APP_KEY, BETFAIR_USERNAME') ?? '',
    /BETFAIR_\*/,
  );
  assert.match(cronErrorHint('Betfair cert login returned non-JSON') ?? '', /BETFAIR_\*/);
});

test('cronErrorHint: Supabase env -> Supabase guidance', () => {
  assert.match(
    cronErrorHint('Missing environment variable: SUPABASE_URL') ?? '',
    /SUPABASE_URL \/ SUPABASE_SERVICE_ROLE_KEY/,
  );
});

test('cronErrorHint: generic missing-env and schema messages', () => {
  assert.match(
    cronErrorHint('Missing environment variable: SOMETHING_ELSE') ?? '',
    /\.env\.example/,
  );
  assert.match(
    cronErrorHint('races insert failed: relation "public.races" does not exist') ?? '',
    /npm run check:db/,
  );
});

test('cronErrorHint: unrelated message -> null', () => {
  assert.equal(cronErrorHint('some unrelated failure'), null);
  assert.equal(cronErrorHint(''), null);
});

test('cronErrorHint: never echoes a value (static strings only)', () => {
  // Even if a value-looking token appears in the message, the hint must not
  // contain it — hints are fixed constants.
  const hint = cronErrorHint('Missing environment variable: RACING_API_USER=supersecret');
  assert.ok(hint && !hint.includes('supersecret'));
});

test('buildCronErrorDiagnostic: extracts message from Error and non-Error', () => {
  const a = buildCronErrorDiagnostic('cron/racecards', new Error('Missing environment variable: RACING_API_USER'));
  assert.equal(a.job, 'cron/racecards');
  assert.equal(a.message, 'Missing environment variable: RACING_API_USER');
  assert.ok(a.hint);

  const b = buildCronErrorDiagnostic('cron/odds', 'plain string failure');
  assert.equal(b.job, 'cron/odds');
  assert.equal(b.message, 'plain string failure');
  assert.equal(b.hint, null);
});

test('formatCronErrorLog: includes job + message, and hint only when present', () => {
  const withHint = formatCronErrorLog({
    job: 'cron/odds',
    message: 'Missing Betfair env var(s): BETFAIR_APP_KEY',
    hint: 'Check the BETFAIR_* credentials.',
  });
  assert.match(withHint, /\[cron\/odds\] failed: Missing Betfair env var\(s\)/);
  assert.match(withHint, /hint: Check the BETFAIR_\* credentials\./);

  const noHint = formatCronErrorLog({ job: 'cron/results', message: 'boom', hint: null });
  assert.equal(noHint, '[cron/results] failed: boom');
});
