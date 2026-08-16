/**
 * RACECARDS-ONLY COMMIT RUNNER — safety guards.
 *
 * This is the only write path in the Programme 0 controlled-ingestion plan, so
 * the properties that keep it narrow must be provable rather than assumed:
 *
 *   1. Two independent latches, no defaults, no arbitrary date.
 *   2. A FRESH suitability count happens before any claim and any route call.
 *   3. Ownership comes from the established mechanism and header builder.
 *   4. Exactly ONE route is reachable, and it is the racecards route.
 *   5. The CLI writes no application table itself.
 *   6. Nothing is ever retried; an ambiguous outcome says so.
 *
 * Everything below runs on stubs. No server, database or provider is contacted,
 * and the runner is never executed as a process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COMMIT_EXIT,
  PROHIBITED_ROUTE_PATHS,
  PROHIBITED_STAGES,
  RACECARDS_COMMIT_MODE,
  RACECARDS_ROUTE_PATH,
  ROUTE_ALLOWED_WRITE_TABLES,
  acquireRacecardsCommitOwnership,
  buildRacecardsRouteUrl,
  commitExitCode,
  isCommitDay,
  projectRacecardsSummary,
  renderCommitOutcome,
  renderCommitScope,
  resolveCommitDate,
  routeWasInvoked,
  runRacecardsCommit,
  type CommitDay,
  type CronCallOutcome,
  type RacecardsCommitDeps,
  type RacecardsCommitReadSeam,
} from '../src/lib/racecardsCommitRunner';
import { OwnershipPropagationError } from '../src/lib/ownershipPropagation';
import { buildOwnershipHeader } from '../src/lib/ownershipPropagation';
import { OWNERSHIP_CONTEXT_HEADER, parseOwnershipContext } from '../src/lib/ownershipContext';
import type { OwnershipStopReason, ProducerOwnershipDeps } from '../src/lib/producerOwnership';
import { parseRacecardsCommitArgs } from './racecardsCommit';

const LIB_PATH = 'src/lib/racecardsCommitRunner.ts';
const CLI_PATH = 'scripts/racecardsCommit.ts';

/**
 * Reads a source file with line endings NORMALISED to `\n`.
 *
 * Load-bearing on Windows: this repository is checked out with
 * `core.autocrlf=true`, so git stores LF but writes CRLF into the worktree. A
 * structural assertion that looks for a literal `\n}\n` therefore silently
 * matches nothing once a file has been committed and checked out again — the
 * parse yields an empty result and the test passes or fails for the wrong
 * reason. Normalising once, here, makes every assertion below independent of
 * how the file happens to be checked out.
 */
function readSource(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}
const LIB = () => readSource(LIB_PATH);
const CLI = () => readSource(CLI_PATH);

/** Source with comments removed, so prose promising an absence cannot fail a scan. */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const LIB_CODE = () => codeOf(LIB());
const CLI_CODE = () => codeOf(CLI());

/**
 * Executable source with the DECLARATIVE safety lists removed.
 *
 * `PROHIBITED_ROUTE_PATHS` and `PROHIBITED_STAGES` exist precisely to name the
 * things this runner must never do, so their own contents would otherwise trip
 * every "no odds / no tipster / no recommendation path" scan below. Stripping
 * the two declarations leaves only code that could actually CALL something.
 */
function machineryOf(src: string): string {
  return codeOf(src).replace(
    /export const (?:PROHIBITED_ROUTE_PATHS|PROHIBITED_STAGES)[^=]*=\s*\[[^\]]*\];/g,
    ' ',
  );
}
const LIB_MACHINERY = () => machineryOf(LIB());
const CLI_MACHINERY = () => machineryOf(CLI());

const NOW = new Date('2026-08-16T12:00:00Z');
const DATE = '2026-08-17';
const ORIGIN = 'http://localhost:3000';

/**
 * The EXACT reviewed dependency set of each file (review finding L-2).
 *
 * This is a handoff, not a convenience: adding any import to either file fails
 * test 20 until this list is updated, which forces the new dependency through
 * review. Everything here was checked against the write boundary — none of it
 * can reach odds, model, recommendation, lock, result, settlement, training,
 * tipster or ML machinery.
 */
const EXPECTED_IMPORTS: Record<string, readonly string[]> = {
  [LIB_PATH]: [
    './cronDate', // resolveCronMeetingDate — the route's own date rule
    './ownershipPropagation', // OwnershipPropagationError + context source type
    './producerClaim', // ALL_UK_IRE_SCOPE, TTL default, validators, outcome types
    './producerOwnership', // the generic ownership deps, events and descriptions
    './raceDayPipeline', // buildUrl only (pure string builder)
    './racecardsDryRun', // redactPreviewDetail only (pure redactor)
  ],
  [CLI_PATH]: [
    '../src/lib/producerOwnership', // defaultProducerOwnershipDeps
    '../src/lib/producerPreflight', // validateBaseUrl
    '../src/lib/raceDayPipelineRunner', // createCallCron
    '../src/lib/racecardsCommitRunner', // this tranche's library
    '../src/lib/racecardsDryRun', // redactPreviewDetail
    '../src/lib/supabaseAdmin', // the SELECT-only suitability count
    'node:url', // fileURLToPath, for the entrypoint guard
  ],
};

/* -------------------------------------------------------------------------- *
 * Stubs
 * -------------------------------------------------------------------------- */

interface Recorder {
  calls: string[];
  urls: string[];
  headers: Record<string, string>[];
}

function recorder(): Recorder {
  return { calls: [], urls: [], headers: [] };
}

/** Ownership deps that record every claim operation and never touch a database. */
function fakeOwnership(
  rec: Recorder,
  options: {
    acquire?: 'ok' | 'refused' | 'unavailable' | 'uncertain';
    heartbeat?: 'renewed' | 'lost' | 'unavailable';
    releaseThrows?: boolean;
  } = {},
): ProducerOwnershipDeps {
  return {
    async acquire(params) {
      rec.calls.push(`acquire(${params.raceDate},${params.scope},${params.mode})`);
      if (options.acquire === 'refused') {
        return {
          ok: true,
          acquired: false,
          generation: 4,
          currentOwnerId: 'other-owner-9999-aaaa',
          currentScope: 'course:ascot',
          currentExpiresAt: '2026-08-17T00:04:00.000Z',
          stoleExpired: false,
        } as never;
      }
      if (options.acquire === 'unavailable') {
        return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'no such function' } } as never;
      }
      if (options.acquire === 'uncertain') {
        return { ok: false, failure: { kind: 'transient_uncertain', message: 'indeterminate' } } as never;
      }
      return {
        ok: true,
        acquired: true,
        generation: 7,
        currentOwnerId: 'runner-owner-1234-bbbb',
        currentScope: params.scope,
        currentExpiresAt: '2026-08-17T00:04:00.000Z',
        stoleExpired: false,
      } as never;
    },
    async heartbeat(params) {
      rec.calls.push(`heartbeat(${params.raceDate})`);
      if (options.heartbeat === 'lost') return { ok: true, renewed: false, generation: 8, expiresAt: null } as never;
      if (options.heartbeat === 'unavailable') {
        return { ok: false, failure: { kind: 'mechanism_unavailable', message: 'gone' } } as never;
      }
      return { ok: true, renewed: true, generation: 7, expiresAt: '2026-08-17T00:08:00.000Z' } as never;
    },
    async release(params) {
      rec.calls.push(`release(${params.raceDate})`);
      if (options.releaseThrows) throw new Error('release exploded');
      return { ok: true, released: true } as never;
    },
    newOwner: () => 'runner-owner-1234-bbbb',
    hostname: () => 'test-host',
    pid: () => 4242,
    log: (event) => rec.calls.push(`log(${event})`),
    startTimer: () => {
      rec.calls.push('startTimer');
      return 'timer';
    },
    stopTimer: () => rec.calls.push('stopTimer'),
  };
}

function fakeReads(rec: Recorder, count: number | (() => never)): RacecardsCommitReadSeam {
  return {
    async countRacesForDate(date) {
      rec.calls.push(`countRacesForDate(${date})`);
      if (typeof count === 'function') return count();
      return count;
    },
  };
}

/** A call-cron factory that records the URL and the headers the real builder would send. */
function fakeCallCron(
  rec: Recorder,
  behaviour: { result?: CronCallOutcome; throws?: unknown } = {},
): RacecardsCommitDeps['makeCallCron'] {
  return (getSource) => async (url: string) => {
    rec.urls.push(url);
    const source = getSource();
    const built = buildOwnershipHeader(source);
    if (!built.ok) throw new OwnershipPropagationError(built.reason);
    rec.headers.push({ [OWNERSHIP_CONTEXT_HEADER]: built.header });
    rec.calls.push(`callCron(${url})`);
    if (behaviour.throws !== undefined) throw behaviour.throws;
    return behaviour.result ?? { ok: true, body: OK_BODY };
  };
}

const OK_BODY = {
  ok: true,
  day: 'tomorrow',
  cardsFetched: 25,
  racesInserted: 25,
  racesExisting: 0,
  runnersInserted: 217,
  skipped: 0,
  tier: 'basic',
};

function deps(rec: Recorder, overrides: Partial<RacecardsCommitDeps> = {}): RacecardsCommitDeps {
  return {
    reads: fakeReads(rec, 0),
    ownership: fakeOwnership(rec),
    makeCallCron: fakeCallCron(rec),
    now: NOW,
    log: () => {},
    ...overrides,
  };
}

/* ========================================================================== *
 * 1-7. Argument contract
 * ========================================================================== */

test('1. exactly today and tomorrow are accepted as --day', () => {
  const ok = parseRacecardsCommitArgs(['--day', 'tomorrow', '--commit', '--confirm-racecards-only', '--base-url', ORIGIN]);
  assert.equal(ok.day, 'tomorrow');
  assert.equal(ok.error, null);
  assert.equal(parseRacecardsCommitArgs(['--day', 'today']).day, 'today');

  for (const bad of ['Today', 'TOMORROW', ' today', 'yesterday', '']) {
    const parsed = parseRacecardsCommitArgs(['--day', bad]);
    assert.equal(parsed.day, null, `--day "${bad}" must not resolve`);
    assert.ok(parsed.error);
  }
  assert.equal(isCommitDay('today'), true);
  assert.equal(isCommitDay('2026-08-17'), false);
});

test('2. a missing day is never defaulted', () => {
  const parsed = parseRacecardsCommitArgs(['--commit', '--confirm-racecards-only', '--base-url', ORIGIN]);
  assert.equal(parsed.day, null);
  // The CLI treats absence as a usage error rather than choosing a day.
  assert.match(CLI(), /missing required argument\(s\)/);
  assert.match(CLI(), /if \(!args\.day\) missing\.push\('--day today\|tomorrow'\)/);
});

test('3. arbitrary dates, ranges and course parameters are rejected', () => {
  for (const bad of [
    ['--day', '2026-08-17'],
    ['--date', '2026-08-17'],
    ['--day', '2026-08-17..2026-08-18'],
    ['--course', 'Ascot'],
    ['--from', '2026-08-17'],
  ]) {
    const parsed = parseRacecardsCommitArgs(bad);
    assert.ok(parsed.error, `${bad.join(' ')} must be rejected`);
    assert.equal(parsed.day, null);
  }
});

test('4. --commit is required and never defaulted', () => {
  assert.equal(parseRacecardsCommitArgs(['--day', 'today']).commit, false);
  assert.equal(parseRacecardsCommitArgs(['--day', 'today', '--commit']).commit, true);
  assert.match(CLI(), /if \(!args\.commit\) missing\.push\('--commit'\)/);
  // A dry-run flag is explicitly redirected, never silently accepted.
  assert.match(parseRacecardsCommitArgs(['--dry-run']).error ?? '', /racecards:dry-run/);
});

test('5. the second latch --confirm-racecards-only is required', () => {
  assert.equal(parseRacecardsCommitArgs(['--day', 'today', '--commit']).confirmRacecardsOnly, false);
  const both = parseRacecardsCommitArgs(['--day', 'today', '--commit', '--confirm-racecards-only']);
  assert.equal(both.confirmRacecardsOnly, true);
  assert.match(CLI(), /if \(!args\.confirmRacecardsOnly\) missing\.push\('--confirm-racecards-only'\)/);
});

test('6. unknown flags, stray arguments and conflicting repeats are rejected', () => {
  assert.match(parseRacecardsCommitArgs(['--day', 'today', '--force']).error ?? '', /unknown flag/);
  assert.match(parseRacecardsCommitArgs(['--day', 'today', 'extra']).error ?? '', /unexpected argument/);
  assert.match(
    parseRacecardsCommitArgs(['--day', 'today', '--day', 'tomorrow']).error ?? '',
    /conflicting values/,
  );
  assert.match(
    parseRacecardsCommitArgs(['--base-url', ORIGIN, '--base-url', 'http://other:9']).error ?? '',
    /conflicting values/,
  );
  // A repeat with the SAME value is harmless and accepted.
  assert.equal(parseRacecardsCommitArgs(['--day', 'today', '--day', 'today']).error, null);
});

test('7. a non-HTTP or credential-bearing base URL is rejected', () => {
  for (const bad of ['not-a-url', 'ftp://host/x', 'file:///etc', 'http://user:pw@host/']) {
    const parsed = parseRacecardsCommitArgs(['--base-url', bad]);
    assert.ok(parsed.error, `${bad} must be rejected`);
    assert.equal(parsed.baseUrl, null);
  }
  // A valid URL is reduced to its origin (path and query stripped).
  assert.equal(parseRacecardsCommitArgs(['--base-url', 'https://host:8443/some/path']).baseUrl, 'https://host:8443');
});

test('8. invalid arguments reach no claim, no route, no provider and no database', () => {
  const cli = CLI();
  const mainStart = cli.indexOf('async function main()');
  const body = cli.slice(mainStart);
  const usageExit = body.indexOf('process.exitCode = COMMIT_EXIT.usage');
  const runAt = body.indexOf('runRacecardsCommit(');
  assert.ok(usageExit > 0 && runAt > usageExit, 'usage refusal precedes the runner');
  // The parser itself is pure.
  const parserStart = cli.indexOf('export function parseRacecardsCommitArgs');
  const parserEnd = cli.indexOf('export const supabaseCommitReadSeam');
  assert.doesNotMatch(cli.slice(parserStart, parserEnd), /supabaseAdmin|createCallCron|await|async/);
});

/* ========================================================================== *
 * 9-12. Fresh empty-date gate
 * ========================================================================== */

test('9. the fresh count runs BEFORE the claim and before any route', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit('tomorrow', ORIGIN, deps(rec));
  assert.equal(outcome.kind, 'committed');
  const countAt = rec.calls.findIndex((c) => c.startsWith('countRacesForDate'));
  const acquireAt = rec.calls.findIndex((c) => c.startsWith('acquire('));
  const routeAt = rec.calls.findIndex((c) => c.startsWith('callCron('));
  assert.ok(countAt >= 0 && acquireAt > countAt, 'count precedes the claim');
  assert.ok(routeAt > acquireAt, 'the route follows the claim');
  assert.equal(rec.calls[0], `countRacesForDate(${DATE})`);
});

test('10. a non-empty date stops with exit 3, no claim and no route', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit('tomorrow', ORIGIN, deps(rec, { reads: fakeReads(rec, 12) }));
  assert.equal(outcome.kind, 'not_suitable');
  assert.equal(commitExitCode(outcome), COMMIT_EXIT.stopped_safely);
  assert.equal(commitExitCode(outcome), 3);
  assert.deepEqual(rec.calls, [`countRacesForDate(${DATE})`], 'nothing beyond the count happened');
  assert.deepEqual(rec.urls, [], 'no route was invoked');
  assert.ok(!rec.calls.some((c) => c.startsWith('acquire(')), 'no claim was acquired');

  const out = renderCommitOutcome(outcome).join('\n');
  assert.match(out, /DATE NO LONGER SUITABLE/);
  assert.match(out, /No producer claim was acquired and no route was invoked\. Nothing was written\./);
  assert.equal(routeWasInvoked(outcome), false);
});

test('11. a failed suitability read stops before the claim and is not treated as empty', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(rec, {
      reads: fakeReads(rec, () => {
        throw new Error('races count failed: 42501 permission denied');
      }),
    }),
  );
  assert.equal(outcome.kind, 'suitability_read_failed');
  assert.equal(commitExitCode(outcome), COMMIT_EXIT.mechanism);
  assert.deepEqual(rec.urls, []);
  assert.ok(!rec.calls.some((c) => c.startsWith('acquire(')));
});

test('12. the resolved date uses the same rule the route uses', () => {
  assert.equal(resolveCommitDate('tomorrow', NOW), DATE);
  assert.equal(resolveCommitDate('today', NOW), '2026-08-16');
});

/* ========================================================================== *
 * 13-17. Ownership
 * ========================================================================== */

test('13. the claim is acquired for the resolved date, nationwide scope, own mode', async () => {
  const rec = recorder();
  await runRacecardsCommit('tomorrow', ORIGIN, deps(rec));
  assert.ok(
    rec.calls.includes(`acquire(${DATE},all-uk-ire,racecards-only-commit)`),
    `expected a nationwide-scope acquire, saw: ${rec.calls.join(' | ')}`,
  );
  assert.equal(RACECARDS_COMMIT_MODE, 'racecards-only-commit');
  // No course scope can ever be requested: there is no course parameter at all.
  assert.doesNotMatch(LIB_CODE(), /buildCourseScope|course:/);
});

test('14. the established ownership helpers are used, not reimplemented primitives', () => {
  const lib = LIB();
  // Generic pieces are imported from the committed ownership modules.
  assert.match(lib, /from '\.\/producerOwnership'/);
  assert.match(lib, /from '\.\/producerClaim'/);
  assert.match(lib, /describeAcquireFailure/);
  assert.match(lib, /describeStopReason/);
  assert.match(lib, /ownerPrefix/);
  assert.match(lib, /ALL_UK_IRE_SCOPE/);
  assert.match(lib, /PRODUCER_CLAIM_DEFAULT_TTL_SECONDS/);
  // The claim RPCs are never called directly — only through the deps abstraction.
  assert.doesNotMatch(LIB_CODE(), /try_acquire_producer_claim|heartbeat_producer_claim|release_producer_claim/);
  assert.doesNotMatch(LIB_CODE(), /supabaseAdmin/);
  // The CLI supplies the real deps.
  assert.match(CLI(), /defaultProducerOwnershipDeps\(\)/);
});

test('15. the ownership header is built by the established helper, never hand-crafted', async () => {
  const rec = recorder();
  await runRacecardsCommit('tomorrow', ORIGIN, deps(rec));
  assert.equal(rec.headers.length, 1, 'exactly one context-bearing call');

  const raw = rec.headers[0][OWNERSHIP_CONTEXT_HEADER];
  const parsed = parseOwnershipContext(raw);
  assert.equal(parsed.kind, 'valid');
  if (parsed.kind !== 'valid') return;
  assert.equal(parsed.context.date, DATE, 'the context date is the route-resolved date');
  assert.equal(parsed.context.scope, 'all-uk-ire');
  assert.equal(parsed.context.generation, 7);
  assert.equal(parsed.context.v, 1);

  // Neither file constructs the header name or JSON itself.
  for (const code of [LIB_CODE(), CLI_CODE()]) {
    assert.doesNotMatch(code, /x-producer-ownership/);
    assert.doesNotMatch(code, /serializeOwnershipContext|JSON\.stringify\(\s*\{\s*v:/);
  }
  // The CLI hands the REAL createCallCron to the runner.
  assert.match(CLI(), /createCallCron\(getSource\)/);
  assert.match(CLI(), /from '\.\.\/src\/lib\/raceDayPipelineRunner'/);
});

test('16. a live claim held elsewhere fails closed with no route call', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(rec, { ownership: fakeOwnership(rec, { acquire: 'refused' }) }),
  );
  assert.equal(outcome.kind, 'ownership_refused');
  assert.equal(commitExitCode(outcome), 3);
  assert.deepEqual(rec.urls, [], 'no route call after a refusal');
  const out = renderCommitOutcome(outcome).join('\n');
  assert.match(out, /OWNERSHIP NOT ESTABLISHED/);
  assert.match(out, /No route was invoked\. Nothing was written\./);
  // A full owner id is never surfaced.
  assert.ok(!out.includes('other-owner-9999-aaaa'));

  // A mechanism failure is a distinct, non-zero, non-3 exit.
  const rec2 = recorder();
  const unavailable = await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(rec2, { ownership: fakeOwnership(rec2, { acquire: 'unavailable' }) }),
  );
  assert.equal(unavailable.kind, 'ownership_refused');
  assert.equal(commitExitCode(unavailable), 2);
  assert.deepEqual(rec2.urls, []);
});

test('17. ownership lost at the pre-route beat stops before the route, and the claim is released', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(rec, { ownership: fakeOwnership(rec, { heartbeat: 'lost' }) }),
  );
  assert.equal(outcome.kind, 'ownership_lost');
  assert.equal(commitExitCode(outcome), 3);
  assert.deepEqual(rec.urls, [], 'the route is never reached after a confirmed loss');
  assert.ok(rec.calls.includes(`release(${DATE})`), 'the claim is still released');
  assert.equal(routeWasInvoked(outcome), false);
});

/* ========================================================================== *
 * 18-23. Route allowlist
 * ========================================================================== */

test('18. exactly one route call occurs, on the racecards path', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit('tomorrow', ORIGIN, deps(rec));
  assert.equal(outcome.kind, 'committed');
  assert.equal(rec.urls.length, 1, 'exactly one route call');
  assert.equal(rec.urls[0], `${ORIGIN}/api/cron/racecards?day=tomorrow`);
  assert.equal(buildRacecardsRouteUrl(ORIGIN, 'today'), `${ORIGIN}/api/cron/racecards?day=today`);
  // A trailing slash on the origin cannot produce a doubled path.
  assert.equal(buildRacecardsRouteUrl(`${ORIGIN}/`, 'today'), `${ORIGIN}/api/cron/racecards?day=today`);
  assert.equal(RACECARDS_ROUTE_PATH, '/api/cron/racecards');
});

test('19. no prohibited route path exists anywhere in either file', () => {
  for (const [path, code] of [
    [LIB_PATH, LIB_MACHINERY()],
    [CLI_PATH, CLI_MACHINERY()],
  ] as const) {
    for (const forbidden of PROHIBITED_ROUTE_PATHS) {
      assert.ok(!code.includes(forbidden), `${path} must not reference ${forbidden}`);
    }
    // No other cron path may be constructed at all.
    const cronPaths = [...code.matchAll(/'\/api\/[a-z/-]*'/g)].map((m) => m[0]);
    for (const found of cronPaths) {
      assert.equal(found, `'${RACECARDS_ROUTE_PATH}'`, `${path} builds an unexpected path ${found}`);
    }
  }
  // The stripping helper must not be doing the work for us: the constant really
  // is present in the file, as declarative data.
  assert.ok(LIB().includes('/api/cron/odds'), 'the prohibited list is declared in the library');
  // The prohibited list itself lives only in the exported constant (data, not a call).
  assert.deepEqual(
    [...PROHIBITED_ROUTE_PATHS].sort(),
    [
      '/api/cron/model',
      '/api/cron/odds',
      '/api/cron/results',
      '/api/cron/tipster-discovery',
      '/api/cron/training-capture',
      '/api/run-model',
      '/api/settle',
    ],
  );
});

test('20. no odds, model, ML, result, settlement or tipster machinery is imported', () => {
  for (const [path, src] of [
    [LIB_PATH, LIB()],
    [CLI_PATH, CLI()],
  ] as const) {
    // (a) The dependency set is an EXACT ALLOWLIST, not a denylist of forbidden
    // words (review finding L-2). A denylist only catches modules whose NAME
    // happens to mention a forbidden subsystem — `./liveSync` owns
    // `syncOddsFromBetfair` and would have slipped through. Any new import,
    // however innocuous its name, now fails here and must be reviewed.
    // Parsed from comment-stripped code, so a commented-out import can neither
    // satisfy nor break the assertion, and order is never significant.
    const specifiers = [...new Set([...codeOf(src).matchAll(/from '([^']+)'/g)].map((m) => m[1]))];
    assert.deepEqual(
      specifiers.sort(),
      [...EXPECTED_IMPORTS[path]].sort(),
      `${path} dependency set changed — a new import must be reviewed before it lands`,
    );

    // (b) No machinery identifier is referenced in executable code.
    const code = machineryOf(src);
    assert.doesNotMatch(code, /syncOddsFromBetfair|betfairExchange|runModelForRace|modelDayRun/);
    assert.doesNotMatch(code, /runPipelineCommitCycle|runModelForMeetingRaces|scoreRaceRunners/);
    assert.doesNotMatch(code, /lockTMinus|captureTMinus|autoResults|importResults|settleTodayResults/);
    assert.doesNotMatch(code, /mlCapture|trainShadow|predictShadow|genai/i);
    // (c) ...and neither word ever appears in a CALL position.
    assert.doesNotMatch(code, /\b\w*(?:tipster|recommendation)\w*\s*\(/i, `${path} calls forbidden machinery`);
  }
});

test('21. the runner performs no direct table write of any kind', () => {
  for (const [path, code] of [
    [LIB_PATH, LIB_CODE()],
    [CLI_PATH, CLI_CODE()],
  ] as const) {
    assert.doesNotMatch(code, /\.insert\s*\(/, `${path} must not insert`);
    assert.doesNotMatch(code, /\.update\s*\(/, `${path} must not update`);
    assert.doesNotMatch(code, /\.upsert\s*\(/, `${path} must not upsert`);
    assert.doesNotMatch(code, /\.delete\s*\(/, `${path} must not delete`);
    assert.doesNotMatch(code, /\.rpc\s*\(/, `${path} must not call an rpc directly`);
    assert.doesNotMatch(code, /\.storage\b/, `${path} must not touch storage`);
    assert.doesNotMatch(code, /writeFileSync|mkdirSync|appendFileSync/, `${path} must not write a file`);
  }
  // The CLI's only Supabase use is the single suitability count.
  const supabaseCalls = [...CLI().matchAll(/supabaseAdmin\s*\n?\s*\.from\(([^)]*)\)\s*\n?\s*\.(\w+)/g)];
  assert.equal(supabaseCalls.length, 1, 'exactly one Supabase chain');
  assert.equal(supabaseCalls[0][1], "'races'");
  assert.equal(supabaseCalls[0][2], 'select');
  // The library never touches the database client at all.
  assert.doesNotMatch(LIB_CODE(), /supabaseAdmin/);
});

test('22. the three write categories are declared distinctly', () => {
  assert.deepEqual([...ROUTE_ALLOWED_WRITE_TABLES], ['races', 'runners', 'cron_runs']);
  const scope = renderCommitScope({ day: 'tomorrow', date: DATE, origin: ORIGIN }).join('\n');
  // route-owned writes
  assert.match(scope, /Route may write {6}: races, runners, cron_runs/);
  // direct CLI writes
  assert.match(scope, /This CLI writes {6}: nothing directly/);
  // claim writes, only through the abstraction
  assert.match(scope, /only the producer claim row, via the claim abstraction/);
});

test('23. the read seam exposes exactly one read method and no mutation', () => {
  const src = LIB();
  const start = src.indexOf('export interface RacecardsCommitReadSeam');
  const block = src.slice(start);
  const seam = block.slice(0, block.indexOf('\n}\n') + 2);
  const methods = [...seam.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(methods, ['countRacesForDate']);
  assert.doesNotMatch(methods[0], /insert|update|upsert|delete|write|persist|commit|acquire|release/i);
});

/* ========================================================================== *
 * 24-27. Scope declaration and termination
 * ========================================================================== */

test('24. the proposed scope is declared before any write', () => {
  const lines = renderCommitScope({ day: 'tomorrow', date: DATE, origin: ORIGIN });
  const text = lines.join('\n');
  assert.equal(lines[0], 'RACECARDS-ONLY COMMIT');
  assert.match(text, /Day scope {12}: tomorrow/);
  assert.match(text, /Resolved date \(UTC\) {2}: 2026-08-17/);
  assert.match(text, /Route \(exactly one\) {2}: \/api\/cron\/racecards\?day=tomorrow/);
  assert.match(text, /Producer claim scope : all-uk-ire/);
  for (const stage of PROHIBITED_STAGES) assert.ok(text.includes(stage), `must declare "${stage}"`);
  assert.deepEqual(
    [...PROHIBITED_STAGES],
    ['no odds', 'no model', 'no recommendation', 'no lock', 'no result', 'no settlement', 'no training capture'],
  );
  // The destination-date limitation is stated honestly.
  assert.match(text, /provider payload can still/);
  assert.match(text, /route remains authoritative/);
  assert.match(text, /Post-write\s+verification must confirm/);

  // L-1: the SELECT-only gate is named as the next action, and the banner does
  // NOT imply the count guarantees the date stays empty.
  assert.match(text, /Next action {10}: a SELECT-only count of stored races for the resolved date/);
  assert.match(text, /claim and the single route call happen ONLY if that count\s+is zero/);
  assert.match(text, /cannot\s+guarantee the date is still empty when the route runs/);

  // ...and the CLI prints it before invoking the runner.
  const cli = CLI();
  assert.ok(cli.indexOf('renderCommitScope(') < cli.indexOf('runRacecardsCommit('));
});

test('25. a successful response terminates without another stage', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit('tomorrow', ORIGIN, deps(rec));
  assert.equal(outcome.kind, 'committed');
  assert.equal(rec.urls.length, 1);
  assert.deepEqual(outcome.kind === 'committed' ? outcome.summary : null, {
    cardsFetched: 25,
    racesInserted: 25,
    racesExisting: 0,
    runnersInserted: 217,
    skipped: 0,
    tier: 'basic',
  });
  const out = renderCommitOutcome(outcome).join('\n');
  assert.match(out, /No further stage was run/);
  assert.match(out, /Odds, model, recommendations, locks, results and/);
  assert.match(out, /Verify with SELECT-only queries/);
  // An ordinary success carries NO ownership warning and prints none.
  assert.equal(outcome.kind === 'committed' ? outcome.ownershipWarning : 'unset', null);
  assert.doesNotMatch(out, /OWNERSHIP WARNING/);
  // The claim is released after success.
  assert.ok(rec.calls.includes(`release(${DATE})`));
});

test('26. a route failure does not trigger any second route call', async () => {
  for (const behaviour of [
    { result: { ok: false, body: { ok: false } } as CronCallOutcome },
    { result: { ok: true, body: null } as CronCallOutcome },
  ]) {
    const rec = recorder();
    const outcome = await runRacecardsCommit('tomorrow', ORIGIN, deps(rec, { makeCallCron: fakeCallCron(rec, behaviour) }));
    assert.ok(outcome.kind === 'route_failed' || outcome.kind === 'route_malformed');
    assert.equal(commitExitCode(outcome), COMMIT_EXIT.route_failed);
    assert.equal(rec.urls.length, 1, 'still exactly one call — no retry, no next stage');
    assert.ok(rec.calls.includes(`release(${DATE})`), 'the claim is released on failure');
    const out = renderCommitOutcome(outcome).join('\n');
    assert.match(out, /NOTHING WAS RETRIED/);
  }
});

test('27. the projection reads only known counters and never the raw body', () => {
  const hostile = {
    ok: true,
    cardsFetched: 3,
    racesInserted: '25',
    tier: 'premium',
    secret: 'sbp_0123456789abcdef',
    course: 'Fixtureton',
    race_id: 'rac_11110000',
  };
  const projected = projectRacecardsSummary(hostile);
  assert.deepEqual(projected, {
    cardsFetched: 3,
    racesInserted: null, // a string is not a count
    racesExisting: null,
    runnersInserted: null,
    skipped: null,
    tier: null, // an unknown tier is dropped
  });
  const json = JSON.stringify(projected);
  for (const leak of ['sbp_0123456789abcdef', 'Fixtureton', 'rac_11110000', 'premium']) {
    assert.ok(!json.includes(leak));
  }
  assert.deepEqual(projectRacecardsSummary(null), {
    cardsFetched: null,
    racesInserted: null,
    racesExisting: null,
    runnersInserted: null,
    skipped: null,
    tier: null,
  });
});

/* ========================================================================== *
 * 28-31. No retries, ambiguity, redaction
 * ========================================================================== */

test('28. a network throw after the request is AMBIGUOUS and is never retried', async () => {
  const rec = recorder();
  const outcome = await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(rec, { makeCallCron: fakeCallCron(rec, { throws: new Error('socket hang up') }) }),
  );
  assert.equal(outcome.kind, 'ambiguous');
  assert.equal(commitExitCode(outcome), COMMIT_EXIT.ambiguous);
  assert.equal(commitExitCode(outcome), 5);
  assert.equal(rec.urls.length, 1, 'exactly one attempt — never a retry');
  assert.equal(routeWasInvoked(outcome), true);
  assert.ok(rec.calls.includes(`release(${DATE})`), 'the claim is released even when ambiguous');

  const out = renderCommitOutcome(outcome).join('\n');
  assert.match(out, /AMBIGUOUS OUTCOME/);
  assert.match(out, /THIS WAS NOT RETRIED/);
  assert.match(out, /could duplicate work/);
  assert.match(out, /SELECT-only queries before re-running/);

  // No retry construct exists in the source at all.
  for (const code of [LIB_CODE(), CLI_CODE()]) {
    assert.doesNotMatch(code, /for\s*\(\s*let\s+attempt|maxRetries|retryDelay|\bwhile\s*\(\s*true\s*\)/);
  }
});

test('29. a propagation refusal is an ownership stop, NOT an ambiguity', async () => {
  const rec = recorder();
  // A source that is no longer believed makes buildOwnershipHeader fail, which
  // createCallCron turns into a local refusal BEFORE any fetch.
  const makeCallCron: RacecardsCommitDeps['makeCallCron'] = (getSource) => async (url) => {
    rec.urls.push(url);
    const source = getSource();
    const built = buildOwnershipHeader(source ? { ...source, believed: false } : undefined);
    if (!built.ok) throw new OwnershipPropagationError(built.reason);
    return { ok: true, body: OK_BODY };
  };
  const outcome = await runRacecardsCommit('tomorrow', ORIGIN, deps(rec, { makeCallCron }));
  assert.equal(outcome.kind, 'ownership_lost', 'nothing was sent, so this is not ambiguous');
  assert.equal(commitExitCode(outcome), COMMIT_EXIT.stopped_safely);
  const out = renderCommitOutcome(outcome).join('\n');
  assert.match(out, /refused locally before it/);
  assert.match(out, /The route was not invoked\. Nothing was written\./);
});

test('30. failure detail is redacted and no token or identifier is printed', async () => {
  const hostile = new Error(
    'connect failed https://user:pw@abc.supabase.co/rest/v1/races ' +
      'Authorization: Bearer sk-live-abcdef1234567890 ' +
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.cGF5bG9hZA.c2ln ' +
      'sbp_0123456789abcdef race rac_11110000 horse hrs_33330000 ' +
      `${'padding-'.repeat(60)}`,
  );
  const rec = recorder();
  const outcome = await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(rec, { makeCallCron: fakeCallCron(rec, { throws: hostile }) }),
  );
  assert.equal(outcome.kind, 'ambiguous');
  const out = renderCommitOutcome(outcome).join('\n');
  for (const leak of [
    'https://',
    'abc.supabase.co',
    'user:pw',
    'Bearer',
    'sk-live-abcdef1234567890',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'sbp_0123456789abcdef',
    'rac_11110000',
    'hrs_33330000',
  ]) {
    assert.ok(!out.includes(leak), `redacted output must not contain "${leak}"`);
  }
  assert.doesNotMatch(out, /\b(rac|crs|hrs|trn|jck)_/);
  assert.ok(out.length < 1200, 'the detail is truncated, not dumped');

  // No ownership token, owner id or raw error may be printed anywhere.
  for (const code of [LIB_CODE(), CLI_CODE()]) {
    assert.doesNotMatch(code, /console\.(log|error)\([^)]*\bownerId\b/);
    assert.doesNotMatch(code, /\.stack/);
    assert.doesNotMatch(code, /String\(\s*err\s*\)/);
    assert.doesNotMatch(code, /console\.(log|error)\([^)]*process\.env/);
  }
  // Every error the CLI prints goes through the redactor.
  assert.match(CLI(), /redactPreviewDetail\(err\)/);
});

test('31. exit codes are distinct and cover every outcome kind', () => {
  assert.deepEqual(COMMIT_EXIT, {
    committed: 0,
    usage: 1,
    mechanism: 2,
    stopped_safely: 3,
    route_failed: 4,
    ambiguous: 5,
  });
  const seen = new Map<string, number>();
  for (const outcome of [
    { kind: 'committed', date: DATE, summary: projectRacecardsSummary({}), ownershipWarning: null },
    { kind: 'committed', date: DATE, summary: projectRacecardsSummary({}), ownershipWarning: 'lost' },
    { kind: 'not_suitable', date: DATE, existingRaces: 1 },
    { kind: 'suitability_read_failed', date: DATE, detail: 'x' },
    { kind: 'ownership_refused', date: DATE, message: 'x', exitCode: 3 },
    { kind: 'ownership_lost', date: DATE, message: 'x', exitCode: 3 },
    { kind: 'route_failed', date: DATE, detail: 'x' },
    { kind: 'route_malformed', date: DATE, detail: 'x' },
    { kind: 'ambiguous', date: DATE, detail: 'x' },
    { kind: 'unclassified', date: DATE, detail: 'x' },
  ] as const) {
    const code = commitExitCode(outcome);
    seen.set(outcome.kind, code);
    // Every rendered outcome is non-empty and identifier-free.
    assert.ok(renderCommitOutcome(outcome).length > 0);
  }
  assert.equal(seen.get('committed'), 0);
  assert.equal(seen.get('not_suitable'), 3);
  assert.equal(seen.get('ambiguous'), 5);
  assert.equal(seen.get('route_failed'), 4);
  assert.equal(seen.get('unclassified'), 2);
});

/* ========================================================================== *
 * 32-34. Release semantics and behaviour preservation
 * ========================================================================== */

test('32. the claim is released on every path, and a failing release never throws', async () => {
  const success = recorder();
  await runRacecardsCommit('tomorrow', ORIGIN, deps(success));
  assert.ok(success.calls.includes(`release(${DATE})`));

  const failed = recorder();
  await runRacecardsCommit('tomorrow', ORIGIN, deps(failed, {
    makeCallCron: fakeCallCron(failed, { result: { ok: false, body: {} } }),
  }));
  assert.ok(failed.calls.includes(`release(${DATE})`));

  // A release that throws is swallowed and logged, never propagated.
  const throwing = recorder();
  const outcome = await runRacecardsCommit('tomorrow', ORIGIN, deps(throwing, {
    ownership: fakeOwnership(throwing, { releaseThrows: true }),
  }));
  assert.equal(outcome.kind, 'committed', 'a failed release must not corrupt the outcome');
  assert.ok(throwing.calls.includes('log(PRODUCER_CLAIM_RELEASE_FAILED)'));

  // The heartbeat is stopped before the release, on every path.
  assert.ok(success.calls.indexOf('stopTimer') < success.calls.indexOf(`release(${DATE})`));
});

test('33. route, pipeline, ownership and dry-run implementations are unchanged', () => {
  const route = readFileSync('src/app/api/cron/racecards/route.ts', 'utf8');
  const authAt = route.indexOf('requireCronSecret(');
  const ownershipAt = route.indexOf('enforceRouteOwnership(');
  const syncAt = route.indexOf('syncRacecards({');
  assert.ok(authAt > 0 && ownershipAt > authAt && syncAt > ownershipAt);
  assert.doesNotMatch(route, /racecardsCommit/);

  for (const file of [
    'src/lib/producerOwnership.ts',
    'src/lib/nationwideOwnership.ts',
    'src/lib/ownershipContext.ts',
    'src/lib/ownershipPropagation.ts',
    'src/lib/routeOwnershipGuard.ts',
    'src/lib/raceDayPipeline.ts',
    'src/lib/raceDayPipelineRunner.ts',
    'src/lib/liveSync.ts',
    'src/lib/raceSync.ts',
    'src/lib/racecardsDryRun.ts',
    'scripts/racecardsDryRun.ts',
  ]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /racecardsCommit/, `${file} must not reference the runner`);
  }

  // The narrow PipelineMode union was NOT widened to fit this runner.
  assert.match(
    readFileSync('src/lib/producerOwnership.ts', 'utf8'),
    /export type PipelineMode = 'pipeline-day' \| 'pipeline-watch';/,
  );
  assert.match(
    readFileSync('src/lib/nationwideOwnership.ts', 'utf8'),
    /export type NationwideMode = 'nationwide-stored-dry-run' \| 'nationwide-live-provider-dry-run';/,
  );
});

test('34. the command and test registrations are correct and additive', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['racecards:commit'], 'tsx scripts/racecardsCommit.ts');
  // Existing commands are untouched.
  assert.equal(pkg.scripts['racecards:dry-run'], 'tsx scripts/racecardsDryRun.ts');
  assert.equal(pkg.scripts['pipeline:day'], 'tsx scripts/runRaceDayPipeline.ts');
  assert.equal(pkg.scripts['nationwide:dry-run'], 'tsx scripts/nationwideDryRun.ts');

  const tests = readFileSync('scripts/tests.ts', 'utf8');
  assert.match(tests, /import '\.\/racecardsCommit\.test';/);
  assert.match(tests, /import '\.\/racecardsDryRun\.test';/);
  assert.match(tests, /import '\.\/producerOwnership\.test';/);
});

/* ========================================================================== *
 * 35-36. M-1 (mid-flight ownership loss) and L-3 (no release without acquire)
 * ========================================================================== */

/**
 * A route caller that records an ownership change WHILE the request is in
 * flight, exactly as the 60s heartbeat would: the header is built from the
 * still-believed state first (as the real `createCallCron` does), and only then
 * does the state flip. No real timer is scheduled and nothing waits.
 */
function callCronLosingOwnership(
  rec: Recorder,
  reason: OwnershipStopReason,
): RacecardsCommitDeps['makeCallCron'] {
  return (getSource) => async (url: string) => {
    rec.urls.push(url);
    const source = getSource();
    const built = buildOwnershipHeader(source);
    if (!built.ok) throw new OwnershipPropagationError(built.reason);
    rec.headers.push({ [OWNERSHIP_CONTEXT_HEADER]: built.header });
    // The heartbeat fires mid-request and permanently stops belief.
    const live = source as unknown as { believed: boolean; stopReason: OwnershipStopReason | null };
    live.believed = false;
    live.stopReason = reason;
    rec.calls.push(`callCron(${url})`);
    return { ok: true, body: OK_BODY };
  };
}

test('35. M-1: a mid-flight ownership loss is reported without changing the result', async () => {
  for (const reason of ['lost', 'uncertain', 'unavailable'] as const) {
    const rec = recorder();
    const outcome = await runRacecardsCommit(
      'tomorrow',
      ORIGIN,
      deps(rec, { makeCallCron: callCronLosingOwnership(rec, reason) }),
    );

    // The primary result is NOT replaced: the route returned success.
    assert.equal(outcome.kind, 'committed', `${reason}: must stay committed`);
    if (outcome.kind !== 'committed') return;
    assert.equal(outcome.ownershipWarning, reason);
    // ...and the exit code is unchanged by the warning.
    assert.equal(commitExitCode(outcome), COMMIT_EXIT.committed);
    assert.equal(commitExitCode(outcome), 0);
    // The original route summary survives intact.
    assert.deepEqual(outcome.summary, {
      cardsFetched: 25,
      racesInserted: 25,
      racesExisting: 0,
      runnersInserted: 217,
      skipped: 0,
      tier: 'basic',
    });

    // Exactly one route call; no retry; no reacquisition; release still happens.
    assert.equal(rec.urls.length, 1, `${reason}: exactly one route call`);
    assert.equal(rec.calls.filter((c) => c.startsWith('callCron(')).length, 1);
    assert.equal(rec.calls.filter((c) => c.startsWith('acquire(')).length, 1, `${reason}: no reacquisition`);
    assert.ok(rec.calls.includes(`release(${DATE})`), `${reason}: release still occurs`);

    // The operator is told all four required things, and nothing more.
    const out = renderCommitOutcome(outcome).join('\n');
    assert.match(out, /RACECARDS COMMIT COMPLETE/);
    assert.match(out, new RegExp(`OWNERSHIP WARNING: ownership became ${reason} DURING the request`));
    assert.match(out, /racecards route returned success/);
    assert.match(out, /Nothing was\s+retried and no claim was reacquired/);
    assert.match(out, /verify that no\s+concurrent producer also wrote to this date/);
    // It must never claim exclusive ownership was held throughout.
    assert.match(out, /Exclusive ownership was NOT held for the whole request/);

    // The warning is a bare classification: no owner id, token or generation.
    for (const secret of ['runner-owner-1234-bbbb', 'runner-owner', 'generation', '7']) {
      assert.ok(!String(outcome.ownershipWarning).includes(secret));
    }
    assert.ok(!out.includes('runner-owner-1234-bbbb'), `${reason}: no owner id in output`);
    assert.doesNotMatch(out, /generation/i, `${reason}: no generation in output`);
    assert.doesNotMatch(out, /Bearer|x-producer-ownership|eyJ/, `${reason}: no token in output`);
  }

  // The warning type is the existing closed union — it cannot carry anything else.
  const warnings: OwnershipStopReason[] = ['lost', 'uncertain', 'unavailable'];
  assert.equal(warnings.length, 3);
});

test('36. L-3: a failed acquisition starts no heartbeat, calls no route and releases nothing', async () => {
  // A live claim held by someone else.
  const refused = recorder();
  const refusedOutcome = await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(refused, { ownership: fakeOwnership(refused, { acquire: 'refused' }) }),
  );
  assert.equal(refusedOutcome.kind, 'ownership_refused');
  assert.deepEqual(refused.calls, [
    `countRacesForDate(${DATE})`,
    `acquire(${DATE},all-uk-ire,racecards-only-commit)`,
    'log(PRODUCER_CLAIM_REFUSED)',
  ]);
  assert.deepEqual(refused.urls, []);
  assert.ok(!refused.calls.includes('startTimer'), 'no heartbeat may start');
  assert.ok(!refused.calls.some((c) => c.startsWith('release(')), 'nothing to release');
  assert.ok(!refused.calls.includes('stopTimer'));

  // A mechanism failure: same shape, no retry (mechanism_unavailable is terminal).
  const unavailable = recorder();
  await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(unavailable, { ownership: fakeOwnership(unavailable, { acquire: 'unavailable' }) }),
  );
  assert.deepEqual(unavailable.calls, [
    `countRacesForDate(${DATE})`,
    `acquire(${DATE},all-uk-ire,racecards-only-commit)`,
    'log(PRODUCER_CLAIM_UNAVAILABLE)',
  ]);
  assert.deepEqual(unavailable.urls, []);
  assert.ok(!unavailable.calls.some((c) => c.startsWith('release(')));

  // Transient uncertainty retries EXACTLY once, then stops — still no release.
  const uncertain = recorder();
  await runRacecardsCommit(
    'tomorrow',
    ORIGIN,
    deps(uncertain, { ownership: fakeOwnership(uncertain, { acquire: 'uncertain' }) }),
  );
  assert.deepEqual(uncertain.calls, [
    `countRacesForDate(${DATE})`,
    `acquire(${DATE},all-uk-ire,racecards-only-commit)`,
    `acquire(${DATE},all-uk-ire,racecards-only-commit)`,
    'log(PRODUCER_OWNERSHIP_UNCERTAIN)',
  ]);
  assert.deepEqual(uncertain.urls, []);
  assert.ok(!uncertain.calls.some((c) => c.startsWith('release(')));
  assert.ok(!uncertain.calls.includes('startTimer'));

  // And an unsuitable date never even reaches the acquire.
  const unsuitable = recorder();
  await runRacecardsCommit('tomorrow', ORIGIN, deps(unsuitable, { reads: fakeReads(unsuitable, 3) }));
  assert.deepEqual(unsuitable.calls, [`countRacesForDate(${DATE})`]);
});
