/**
 * Tests for the selected-course producer ownership integration
 * (src/lib/producerOwnership.ts + the pipeline:day / pipeline:watch wiring) —
 * Nationwide rebuild Phase 7A.2b Step 2.
 *
 * Proves, with fake claim clients and fake timers (no DB, no network, no real
 * intervals): acquisition happens before any provider/model dependency can
 * run; every refusal/unavailable/uncertain/malformed path yields ZERO provider
 * calls; one owner id per process; the 60s heartbeat cannot overlap itself and
 * verifies owner + GENERATION on every beat; confirmed loss / generation
 * mismatch / repeated uncertainty permanently stop belief (no mid-cycle
 * reclaim, ever); the guarded deps block racecards/odds/model after loss —
 * including through the REAL `runPipelineCommitCycle` composition; release is
 * owner-scoped, ordered stop-heartbeat-then-release, and a failed release
 * never restarts work; events carry only the allowed secret-free fields; and —
 * by source scan — the scripts wire acquisition BEFORE the cycle, require
 * --course in commit mode, never mention the nationwide scope, and the shared
 * cycle/lock/results/supervisor files remain untouched by this integration.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COURSE_REQUIRED_MESSAGE,
  OwnershipLostError,
  PRODUCER_EVENT_ALLOWED_FIELDS,
  PRODUCER_HEARTBEAT_INTERVAL_MS,
  acquireProducerOwnership,
  buildProducerEvent,
  createHeartbeatController,
  describeAcquireFailure,
  describeStopReason,
  guardPipelineDeps,
  ownerPrefix,
  releaseProducerOwnership,
  type OwnershipState,
  type ProducerOwnershipDeps,
  type ProducerOwnershipEvent,
} from '../src/lib/producerOwnership';
import { runPipelineCommitCycle, type PipelineRunnerDeps } from '../src/lib/raceDayPipelineRunner';
import type { AcquireOutcome, HeartbeatOutcome, ReleaseOutcome } from '../src/lib/producerClaim';

const DATE = '2026-07-17';

/* ------------------------------- fakes -------------------------------------- */

interface FakeLog {
  events: Array<{ event: ProducerOwnershipEvent; details: Record<string, unknown> }>;
}

interface FakeTimer {
  cb: (() => void) | null;
  ms: number | null;
  stopped: number;
  fire: () => void;
}

function makeFakes(over: {
  acquire?: () => Promise<AcquireOutcome> | AcquireOutcome;
  heartbeat?: () => Promise<HeartbeatOutcome> | HeartbeatOutcome;
  release?: () => Promise<ReleaseOutcome> | ReleaseOutcome;
  owner?: string;
} = {}): {
  deps: ProducerOwnershipDeps;
  log: FakeLog;
  timer: FakeTimer;
  calls: { acquire: number; heartbeat: number; release: number };
} {
  const log: FakeLog = { events: [] };
  const timer: FakeTimer = {
    cb: null,
    ms: null,
    stopped: 0,
    fire() {
      this.cb?.();
    },
  };
  const calls = { acquire: 0, heartbeat: 0, release: 0 };
  const okAcquire: AcquireOutcome = {
    ok: true,
    acquired: true,
    stoleExpired: false,
    generation: 1,
    currentOwnerId: over.owner ?? 'owner-fixed',
    currentScope: 'course:newmarket',
    currentExpiresAt: '2026-07-17T14:04:00.000Z',
  };
  const okHeartbeat: HeartbeatOutcome = { ok: true, renewed: true, generation: 1, expiresAt: '2026-07-17T14:05:00.000Z' };
  const okRelease: ReleaseOutcome = { ok: true, released: true };
  const deps: ProducerOwnershipDeps = {
    acquire: async () => {
      calls.acquire += 1;
      return over.acquire ? over.acquire() : okAcquire;
    },
    heartbeat: async () => {
      calls.heartbeat += 1;
      return over.heartbeat ? over.heartbeat() : okHeartbeat;
    },
    release: async () => {
      calls.release += 1;
      return over.release ? over.release() : okRelease;
    },
    newOwner: () => over.owner ?? 'owner-fixed',
    hostname: () => 'test-host',
    pid: () => 4321,
    log: (event, details) => log.events.push({ event, details: details as Record<string, unknown> }),
    startTimer: (cb, ms) => {
      timer.cb = cb;
      timer.ms = ms;
      return 'handle';
    },
    stopTimer: () => {
      timer.stopped += 1;
      timer.cb = null;
    },
  };
  return { deps, log, timer, calls };
}

function ownedState(over: Partial<OwnershipState> = {}): OwnershipState {
  return {
    raceDate: DATE,
    scope: 'course:newmarket',
    ownerId: 'owner-fixed',
    generation: 1,
    mode: 'pipeline-watch',
    believed: true,
    stopReason: null,
    ...over,
  };
}

/* ------------------------------ acquisition --------------------------------- */

test('acquire: invalid date/course is rejected BEFORE any claim RPC', async () => {
  const { deps, calls } = makeFakes();
  const badDate = await acquireProducerOwnership({ raceDate: 'not-a-date', course: 'Newmarket', mode: 'pipeline-day' }, deps);
  assert.equal(badDate.ok, false);
  assert.equal(!badDate.ok && badDate.reason, 'invalid_input');
  const noCourse = await acquireProducerOwnership({ raceDate: DATE, course: '  ', mode: 'pipeline-day' }, deps);
  assert.equal(noCourse.ok, false);
  assert.equal(!noCourse.ok && noCourse.reason, 'invalid_input');
  assert.equal(calls.acquire, 0);
});

test('acquire: scope goes through buildCourseScope — "Royal Ascot" claims course:ascot (no second rule)', async () => {
  let sentScope: string | null = null;
  const { deps } = makeFakes();
  const spied: ProducerOwnershipDeps = {
    ...deps,
    acquire: async (params) => {
      sentScope = params.scope;
      return {
        ok: true,
        acquired: true,
        stoleExpired: false,
        generation: 1,
        currentOwnerId: 'owner-fixed',
        currentScope: params.scope,
        currentExpiresAt: '2026-07-17T14:04:00.000Z',
      };
    },
  };
  const result = await acquireProducerOwnership({ raceDate: DATE, course: 'Royal Ascot', mode: 'pipeline-day' }, spied);
  assert.equal(result.ok, true);
  assert.equal(sentScope, 'course:ascot');
  assert.equal(result.ok && result.state.scope, 'course:ascot');
});

test('acquire: success yields believed state with generation; ACQUIRED event; safe metadata only', async () => {
  let sentParams: Record<string, unknown> | null = null;
  const { deps, log } = makeFakes();
  const spied: ProducerOwnershipDeps = {
    ...deps,
    acquire: async (params) => {
      sentParams = params as unknown as Record<string, unknown>;
      return {
        ok: true,
        acquired: true,
        stoleExpired: false,
        generation: 3,
        currentOwnerId: 'owner-fixed',
        currentScope: 'course:newmarket',
        currentExpiresAt: '2026-07-17T14:04:00.000Z',
      };
    },
  };
  const result = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-watch' }, spied);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.state.generation, 3);
  assert.equal(result.ok && result.state.believed, true);
  assert.equal(result.ok && result.state.stopReason, null);
  assert.equal(log.events[0]?.event, 'PRODUCER_CLAIM_ACQUIRED');
  // Metadata: hostname/pid/mode only; app_version explicitly null (never invented).
  assert.equal(sentParams!.hostname, 'test-host');
  assert.equal(sentParams!.pid, 4321);
  assert.equal(sentParams!.mode, 'pipeline-watch');
  assert.equal(sentParams!.appVersion, null);
});

test('acquire: stolen expired claim logs PRODUCER_CLAIM_STOLEN', async () => {
  const { deps, log } = makeFakes({
    acquire: () => ({
      ok: true,
      acquired: true,
      stoleExpired: true,
      generation: 2,
      currentOwnerId: 'owner-fixed',
      currentScope: 'course:newmarket',
      currentExpiresAt: '2026-07-17T14:04:00.000Z',
    }),
  });
  const result = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-watch' }, deps);
  assert.equal(result.ok, true);
  assert.equal(log.events[0]?.event, 'PRODUCER_CLAIM_STOLEN');
});

test('acquire: a live different owner refuses with the holder identity (prefix only)', async () => {
  const { deps, log } = makeFakes({
    acquire: () => ({
      ok: true,
      acquired: false,
      stoleExpired: false,
      generation: 5,
      currentOwnerId: 'somebody-else-very-long-owner-id',
      currentScope: 'course:ascot',
      currentExpiresAt: '2026-07-17T14:04:00.000Z',
    }),
  });
  const result = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-day' }, deps);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'refused');
  if (!result.ok && result.reason === 'refused') {
    assert.equal(result.holderOwnerPrefix, 'somebody'); // 8-char prefix, never the full id
    assert.equal(result.holderScope, 'course:ascot');
  }
  assert.equal(log.events[0]?.event, 'PRODUCER_CLAIM_REFUSED');
});

test('acquire: mechanism unavailable and transient-then-still-failing map to unavailable/uncertain; transient retried exactly once', async () => {
  const unavailable = makeFakes({
    acquire: () => ({ ok: false, failure: { kind: 'mechanism_unavailable', message: 'missing' } }),
  });
  const r1 = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-day' }, unavailable.deps);
  assert.equal(!r1.ok && r1.reason, 'unavailable');
  assert.equal(unavailable.calls.acquire, 1); // unavailable is NOT retried

  const transient = makeFakes({
    acquire: () => ({ ok: false, failure: { kind: 'transient_uncertain', message: 'blip' } }),
  });
  const r2 = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-day' }, transient.deps);
  assert.equal(!r2.ok && r2.reason, 'uncertain');
  assert.equal(transient.calls.acquire, 2); // exactly one retry, never more
});

test('acquire: transient blip that succeeds on the single retry acquires cleanly', async () => {
  let attempt = 0;
  const { deps } = makeFakes({
    acquire: () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, failure: { kind: 'transient_uncertain', message: 'blip' } };
      return {
        ok: true,
        acquired: true,
        stoleExpired: false,
        generation: 1,
        currentOwnerId: 'owner-fixed',
        currentScope: 'course:newmarket',
        currentExpiresAt: '2026-07-17T14:04:00.000Z',
      };
    },
  });
  const result = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-day' }, deps);
  assert.equal(result.ok, true);
  assert.equal(attempt, 2);
});

test('describeAcquireFailure / describeStopReason: exit codes follow the claim-CLI convention (1 invalid, 2 fail-closed, 3 held/lost)', () => {
  assert.equal(describeAcquireFailure({ ok: false, reason: 'invalid_input', message: 'x' }).exitCode, 1);
  assert.equal(describeAcquireFailure({ ok: false, reason: 'unavailable', message: 'x' }).exitCode, 2);
  assert.equal(describeAcquireFailure({ ok: false, reason: 'uncertain', message: 'x' }).exitCode, 2);
  assert.equal(
    describeAcquireFailure({ ok: false, reason: 'refused', holderOwnerPrefix: 'abcd1234', holderScope: 'course:x', holderExpiresAt: 't' }).exitCode,
    3,
  );
  assert.equal(describeStopReason('lost').exitCode, 3);
  assert.equal(describeStopReason('uncertain').exitCode, 2);
  assert.equal(describeStopReason('unavailable').exitCode, 2);
});

/* ------------------------------- heartbeat ---------------------------------- */

test('heartbeat: interval is exactly 60s and the timer starts only via start()', () => {
  const { deps, timer } = makeFakes();
  const controller = createHeartbeatController(ownedState(), deps);
  assert.equal(timer.cb, null); // not started on construction
  controller.start();
  assert.equal(timer.ms, PRODUCER_HEARTBEAT_INTERVAL_MS);
  assert.equal(PRODUCER_HEARTBEAT_INTERVAL_MS, 60_000);
  controller.stop();
  assert.equal(timer.stopped, 1);
});

test('heartbeat: renewal with matching generation keeps belief; RENEWED logged', async () => {
  const state = ownedState({ generation: 4 });
  const { deps, log } = makeFakes({ heartbeat: () => ({ ok: true, renewed: true, generation: 4, expiresAt: 't' }) });
  const controller = createHeartbeatController(state, deps);
  assert.equal(await controller.beatNow(), true);
  assert.equal(state.believed, true);
  assert.equal(state.stopReason, null);
  assert.equal(log.events.at(-1)?.event, 'PRODUCER_HEARTBEAT_RENEWED');
});

test('heartbeat: clean renewed:false is CONFIRMED loss — belief off, timer stopped, OWNERSHIP_LOST', async () => {
  const state = ownedState();
  const { deps, log, timer } = makeFakes({ heartbeat: () => ({ ok: true, renewed: false }) });
  const controller = createHeartbeatController(state, deps);
  controller.start();
  assert.equal(await controller.beatNow(), false);
  assert.equal(state.believed, false);
  assert.equal(state.stopReason, 'lost');
  assert.equal(timer.stopped, 1);
  assert.equal(log.events.at(-1)?.event, 'PRODUCER_OWNERSHIP_LOST');
});

test('heartbeat: renewed under a DIFFERENT generation is CONFIRMED loss (fencing check)', async () => {
  const state = ownedState({ generation: 2 });
  const { deps, log } = makeFakes({ heartbeat: () => ({ ok: true, renewed: true, generation: 3, expiresAt: 't' }) });
  const controller = createHeartbeatController(state, deps);
  assert.equal(await controller.beatNow(), false);
  assert.equal(state.stopReason, 'lost');
  assert.equal(log.events.at(-1)?.event, 'PRODUCER_OWNERSHIP_LOST');
  assert.equal(log.events.at(-1)?.details.classification, 'generation_mismatch');
});

test('heartbeat: transient error retries exactly once, then uncertainty stops belief', async () => {
  const state = ownedState();
  const { deps, calls, log } = makeFakes({
    heartbeat: () => ({ ok: false, failure: { kind: 'transient_uncertain', message: 'blip' } }),
  });
  const controller = createHeartbeatController(state, deps);
  assert.equal(await controller.beatNow(), false);
  assert.equal(calls.heartbeat, 2); // one attempt + exactly one retry
  assert.equal(state.stopReason, 'uncertain');
  assert.equal(log.events.at(-1)?.event, 'PRODUCER_OWNERSHIP_UNCERTAIN');
});

test('heartbeat: mechanism unavailable stops belief with PRODUCER_CLAIM_UNAVAILABLE (no retry loop)', async () => {
  const state = ownedState();
  const { deps, calls, log } = makeFakes({
    heartbeat: () => ({ ok: false, failure: { kind: 'mechanism_unavailable', message: 'missing' } }),
  });
  const controller = createHeartbeatController(state, deps);
  assert.equal(await controller.beatNow(), false);
  assert.equal(calls.heartbeat, 1);
  assert.equal(state.stopReason, 'unavailable');
  assert.equal(log.events.at(-1)?.event, 'PRODUCER_CLAIM_UNAVAILABLE');
});

test('heartbeat: beats can never overlap — a tick during an in-flight beat shares it', async () => {
  const state = ownedState();
  let resolveBeat: ((o: HeartbeatOutcome) => void) | null = null;
  const { deps, calls, timer } = makeFakes({
    heartbeat: () => new Promise<HeartbeatOutcome>((resolve) => (resolveBeat = resolve)),
  });
  const controller = createHeartbeatController(state, deps);
  controller.start();
  const first = controller.beatNow(); // in flight, unresolved
  timer.fire(); // interval tick while in flight — must NOT start a second call
  const second = controller.beatNow(); // explicit call while in flight — shared
  assert.equal(calls.heartbeat, 1);
  resolveBeat!({ ok: true, renewed: true, generation: 1, expiresAt: 't' });
  assert.equal(await first, true);
  assert.equal(await second, true);
  controller.stop();
});

test('no reclaim ever: after confirmed loss, beats return false without an RPC and acquire is never re-invoked', async () => {
  const state = ownedState();
  const { deps, calls } = makeFakes({ heartbeat: () => ({ ok: true, renewed: false }) });
  const controller = createHeartbeatController(state, deps);
  assert.equal(await controller.beatNow(), false);
  const before = calls.heartbeat;
  assert.equal(await controller.beatNow(), false); // permanently stopped
  assert.equal(calls.heartbeat, before); // no further RPC
  assert.equal(calls.acquire, 0); // and never a reclaim
  assert.equal(state.believed, false);
});

/* ----------------------------- guarded deps --------------------------------- */

function fakePipelineDeps(): {
  deps: PipelineRunnerDeps;
  calls: { cron: string[]; races: string[]; rows: number };
} {
  const calls = { cron: [] as string[], races: [] as string[], rows: 0 };
  return {
    calls,
    deps: {
      callCron: async (url) => {
        calls.cron.push(url);
        return { ok: true, body: { ok: true } };
      },
      fetchRaceRows: async () => {
        calls.rows += 1;
        return [
          { id: 'race-1', course: 'Newmarket', off_time: '2099-01-01T14:00:00.000Z', race_name: null, status: null },
          { id: 'race-2', course: 'Newmarket', off_time: '2099-01-01T14:30:00.000Z', race_name: null, status: null },
        ];
      },
      runOneRace: async (raceId) => {
        calls.races.push(raceId);
        return { scored: 5, recommended: 1 };
      },
      log: () => {},
      errorLog: () => {},
    },
  };
}

test('guarded deps: while believed, calls pass through; after loss, they throw BEFORE the underlying dep', async () => {
  const state = ownedState();
  const { deps, calls } = fakePipelineDeps();
  const guarded = guardPipelineDeps(deps, state);

  await guarded.callCron('http://x/api/cron/odds?date=2026-07-17');
  await guarded.runOneRace('race-1');
  assert.equal(calls.cron.length, 1);
  assert.equal(calls.races.length, 1);

  state.believed = false;
  state.stopReason = 'lost';
  await assert.rejects(() => guarded.callCron('http://x/api/cron/odds'), OwnershipLostError);
  await assert.rejects(() => Promise.resolve(guarded.runOneRace('race-2')), OwnershipLostError);
  assert.equal(calls.cron.length, 1); // underlying never reached
  assert.equal(calls.races.length, 1);
});

test('composition (real cycle): loss AFTER racecards blocks odds AND the whole model stage', async () => {
  const state = ownedState();
  const { deps, calls } = fakePipelineDeps();
  // Simulate ownership loss detected right after the racecards call completes.
  const flipping: PipelineRunnerDeps = {
    ...deps,
    callCron: async (url) => {
      const result = await deps.callCron(url);
      if (url.includes('racecards')) {
        state.believed = false;
        state.stopReason = 'lost';
      }
      return result;
    },
  };
  const guarded = guardPipelineDeps(flipping, state);
  const result = await runPipelineCommitCycle(guarded, {
    date: new Date().toISOString().slice(0, 10), // today → racecards URL is built
    baseUrl: 'http://localhost:3000',
    allowStale: false,
    now: new Date(),
  });
  assert.equal(calls.cron.filter((u) => u.includes('racecards')).length, 1);
  assert.equal(calls.cron.filter((u) => u.includes('odds')).length, 0); // odds gate refused
  assert.equal(result.odds, 'failed');
  assert.equal(result.modelRan, false); // failed odds blocks the model stage entirely
  assert.equal(calls.races.length, 0); // zero model writes
  assert.equal(state.stopReason, 'lost'); // the script's post-cycle check then stops the process
});

test('composition (real cycle): loss AFTER odds blocks every per-race model run (zero writes)', async () => {
  const state = ownedState();
  const { deps, calls } = fakePipelineDeps();
  const flipping: PipelineRunnerDeps = {
    ...deps,
    callCron: async (url) => {
      const result = await deps.callCron(url);
      if (url.includes('odds')) {
        state.believed = false;
        state.stopReason = 'lost';
      }
      return result;
    },
  };
  const guarded = guardPipelineDeps(flipping, state);
  const result = await runPipelineCommitCycle(guarded, {
    date: '2026-07-20', // not "today" relative to the injected now → racecards skipped; odds still called
    baseUrl: 'http://localhost:3000',
    allowStale: false,
    now: new Date('2026-07-17T10:00:00.000Z'),
  });
  assert.equal(calls.cron.filter((u) => u.includes('odds')).length, 1);
  assert.equal(result.modelRan, true); // odds succeeded, so the model stage starts…
  assert.equal(calls.races.length, 0); // …but every per-race gate refuses: ZERO model runs
  assert.equal(result.summary.failures, 2); // both races honestly recorded as failed
  assert.equal(result.summary.model_races_run, 0);
});

test('guarded deps: fetchRaceRows passes through ungated (read-only SELECT)', async () => {
  const state = ownedState({ believed: false, stopReason: 'lost' });
  const { deps, calls } = fakePipelineDeps();
  const guarded = guardPipelineDeps(deps, state);
  const rows = await guarded.fetchRaceRows('2026-07-17');
  assert.equal(rows.length, 2);
  assert.equal(calls.rows, 1);
});

/* -------------------------------- release ----------------------------------- */

test('release: stops the heartbeat BEFORE the owner-scoped release (recorded order)', async () => {
  const order: string[] = [];
  const state = ownedState();
  const { deps, timer } = makeFakes({
    release: () => {
      order.push('release');
      return { ok: true, released: true };
    },
  });
  const stopRecordingDeps: ProducerOwnershipDeps = {
    ...deps,
    stopTimer: (h) => {
      order.push('stop');
      deps.stopTimer(h);
    },
  };
  const controller = createHeartbeatController(state, stopRecordingDeps);
  controller.start();
  await releaseProducerOwnership(state, controller, stopRecordingDeps);
  assert.deepEqual(order, ['stop', 'release']);
  assert.equal(timer.stopped, 1);
});

test('release: logs RELEASED (released vs not_held) and RELEASE_FAILED without throwing or restarting work', async () => {
  const state = ownedState();

  const released = makeFakes({ release: () => ({ ok: true, released: true }) });
  await releaseProducerOwnership(state, null, released.deps);
  assert.equal(released.log.events.at(-1)?.event, 'PRODUCER_CLAIM_RELEASED');
  assert.equal(released.log.events.at(-1)?.details.classification, 'released');

  const notHeld = makeFakes({ release: () => ({ ok: true, released: false }) });
  await releaseProducerOwnership(state, null, notHeld.deps);
  assert.equal(notHeld.log.events.at(-1)?.details.classification, 'not_held');

  const failed = makeFakes({ release: () => ({ ok: false, failure: { kind: 'transient_uncertain', message: 'x' } }) });
  await releaseProducerOwnership(state, null, failed.deps); // must not throw
  assert.equal(failed.log.events.at(-1)?.event, 'PRODUCER_CLAIM_RELEASE_FAILED');
  assert.equal(failed.calls.acquire, 0); // never re-acquires after a failed release
});

/* ------------------------------ owner identity ------------------------------- */

test('owner identity: one id per acquisition; separate acquisitions get separate ids; prefix is 8 chars', async () => {
  let counter = 0;
  const base = makeFakes();
  const deps: ProducerOwnershipDeps = {
    ...base.deps,
    newOwner: () => `owner-${++counter}-${'x'.repeat(30)}`,
    acquire: async (params) => ({
      ok: true,
      acquired: true,
      stoleExpired: false,
      generation: 1,
      currentOwnerId: params.ownerId,
      currentScope: params.scope,
      currentExpiresAt: 't',
    }),
  };
  const a = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-watch' }, deps);
  const b = await acquireProducerOwnership({ raceDate: DATE, course: 'Newmarket', mode: 'pipeline-watch' }, deps);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.ok && a.state.ownerId, b.ok && b.state.ownerId);
  assert.equal(ownerPrefix('abcdefghijk'), 'abcdefgh');
});

/* ------------------------------ event safety --------------------------------- */

test('events: buildProducerEvent emits ONLY the allowed fields (+event/ts); forbidden keys are dropped', () => {
  const built = buildProducerEvent('PRODUCER_CLAIM_ACQUIRED', {
    race_date: DATE,
    scope: 'course:newmarket',
    owner_prefix: 'abcd1234',
    generation: 1,
    classification: 'acquired',
    expires_at: 't',
    mode: 'pipeline-day',
    stage: 'acquire',
    // Forbidden/foreign keys — must all be dropped:
    owner_id: 'full-owner-id-must-not-appear',
    authorization: 'Bearer abc',
    CRON_SECRET: 'nope',
    command: 'npm run pipeline:day --commit',
    path: 'C:/Users/someone',
  });
  const keys = Object.keys(built).sort();
  const allowed = new Set<string>([...PRODUCER_EVENT_ALLOWED_FIELDS, 'event', 'ts']);
  for (const k of keys) assert.ok(allowed.has(k), `unexpected event key: ${k}`);
  const json = JSON.stringify(built);
  assert.equal(json.includes('full-owner-id'), false);
  assert.equal(json.includes('Bearer'), false);
  assert.equal(json.includes('CRON_SECRET'), false);
});

/* --------------------------- script wiring (source scans) -------------------- */
// These scans check actual imports, call ORDER, and argument handling — not
// prose mentions (docstrings legitimately describe the ownership behaviour).

const DAY_SRC = () => readFileSync('scripts/runRaceDayPipeline.ts', 'utf8');
const WATCH_SRC = () => readFileSync('scripts/runRaceDayPipelineWatch.ts', 'utf8');

test('wiring: both scripts import the ownership controller and acquire BEFORE running the cycle', () => {
  for (const src of [DAY_SRC(), WATCH_SRC()]) {
    assert.match(src, /from '\.\.\/src\/lib\/producerOwnership'/);
    const acquireIdx = src.indexOf('await acquireProducerOwnership(');
    const cycleIdx = src.indexOf('runPipelineCommitCycle(deps');
    assert.ok(acquireIdx > 0 && cycleIdx > 0 && acquireIdx < cycleIdx, 'acquire must precede the cycle');
    // The deps handed to the cycle are the GUARDED ones.
    assert.match(src, /guardPipelineDeps\(/);
    // Release lives in a finally block.
    assert.match(src, /finally\s*\{[\s\S]*releaseProducerOwnership\(/);
  }
});

test('wiring: commit mode requires --course in both scripts (the shared refusal message)', () => {
  for (const src of [DAY_SRC(), WATCH_SRC()]) {
    assert.match(src, /if \(!args\.course\)\s*\{[\s\S]{0,200}COURSE_REQUIRED_MESSAGE/);
  }
});

test('wiring: the nationwide scope literal never appears in the pipeline scripts or the ownership module', () => {
  for (const file of ['scripts/runRaceDayPipeline.ts', 'scripts/runRaceDayPipelineWatch.ts', 'src/lib/producerOwnership.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.equal(src.includes("'all-uk-ire'"), false, `${file} must never claim the nationwide scope`);
  }
});

test('wiring: watch reverifies before later cycles and holds the claim between cycles (no release inside the loop)', () => {
  const src = WATCH_SRC();
  assert.match(src, /if \(completed > 0\) await heartbeat\.beatNow\(\);/);
  // releaseProducerOwnership appears exactly once — in the finally, not per cycle.
  assert.equal(src.match(/releaseProducerOwnership\(/g)?.length, 1);
});

test('boundary: the shared cycle, model-day loop, and model runner remain untouched by ownership', () => {
  for (const file of ['src/lib/raceDayPipelineRunner.ts', 'src/lib/modelDayRun.ts', 'src/lib/runModelForRace.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/producerOwnership|producer_run_claims|producerClaim/i.test(src), false, `${file} must stay ownership-free`);
  }
});

test('boundary: the claim-EXEMPT watchers (locks/results) contain no claim vocabulary', () => {
  // Since Step 4 the launcher legitimately runs producer:preflight and the
  // pipeline wrapper prints producer:claim-check STATUS guidance — but the
  // lock and results watchers must stay entirely claim-free (exempt by policy).
  for (const file of ['race-day-local/watch-locks.bat', 'race-day-local/watch-results.bat']) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/producer|claim-check|owner-id/i.test(src), false, `${file} must not reference the claim`);
  }
  // The launcher and pipeline wrapper may MENTION the diagnostics, but must
  // never invoke a mutating claim operation.
  for (const file of ['race-day-local/start-race-day.bat', 'race-day-local/watch-pipeline.bat']) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/--op (claim|heartbeat|release)/.test(src), false, `${file} must never invoke a mutating claim op`);
  }
});

test('safety: producerOwnership.ts never imports a provider client, the model, or another producer script', () => {
  const src = readFileSync('src/lib/producerOwnership.ts', 'utf8');
  assert.equal(/from\s+['"][^'"]*\/(racingApi|betfairExchange|lockTMinus|autoResults|runModelForRace|liveSync)['"]/.test(src), false);
  // Its only runtime imports are node:os + the Step 1 claim module (the
  // raceDayPipelineRunner import is type-only, erased at compile time).
  assert.match(src, /import type \{ PipelineRunnerDeps \} from '\.\/raceDayPipelineRunner';/);
  // No --commit vocabulary and no direct DB table access of its own.
  assert.equal(/args\.commit|===\s*'--commit'|case '--commit'/.test(src), false);
  assert.equal(/\.(insert|update|upsert|delete)\s*\(/.test(src), false);
});
