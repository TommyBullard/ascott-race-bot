/**
 * Tests for the direct-model-CLI foreign-claim check
 * (src/lib/directModelClaimCheck.ts) and its integration into the two direct
 * model CLIs (scripts/runModel.ts, scripts/runModelsForRaceDay.ts) —
 * Phase 7A route-hardening, B/C Slice 4a.
 *
 * Fully offline: the classifier is pure; the async wrapper uses an injected
 * status reader; the CLI flows are the exported, dependency-injected
 * `runModelCli` / `runModelDayCli` with fakes — no Supabase, no provider, no
 * model, no claim mutation. Plus source scans for the fail-closed / no-mutation
 * / boundary properties. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  assertDirectModelClaimClear,
  classifyDirectModelClaim,
  formatDirectModelRefusal,
  type DirectModelClaimDecision,
} from '../src/lib/directModelClaimCheck';
import { runModelCli, type RunModelCliDeps } from './runModel';
import { runModelDayCli, type ModelDayCliDeps, type RaceRow } from './runModelsForRaceDay';

const DATE = '2026-07-25';
const OWNER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/* -------------------------------------------------------------------------- */
/* Status-outcome fixtures (mirror producerClaim's StatusOutcome)             */
/* -------------------------------------------------------------------------- */

function statusLive(ownerId: string = OWNER): unknown {
  return {
    ok: true,
    serverNowIso: '2026-07-25T12:00:00.000Z',
    liveness: { status: 'live', remainingSeconds: 120, expiredSeconds: null },
    claim: { raceDate: DATE, scope: 'course:ascot', ownerId, generation: 2, expiresAt: '2026-07-25T12:04:00.000Z' },
  };
}
function statusLiveness(status: string): unknown {
  return { ok: true, serverNowIso: 's', liveness: { status }, claim: status === 'live' ? { ownerId: OWNER } : null };
}
function statusFail(kind: string): unknown {
  return { ok: false, failure: { kind, message: 'x' } };
}

/* -------------------------------------------------------------------------- */
/* 1-12 Classifier decision table                                             */
/* -------------------------------------------------------------------------- */

test('1. absent claim allows (unclaimed)', () => {
  assert.deepEqual(classifyDirectModelClaim(statusLiveness('absent')), { allow: true, reason: 'unclaimed' });
});

test('2. expired claim allows (without stealing)', () => {
  assert.deepEqual(classifyDirectModelClaim(statusLiveness('expired')), { allow: true, reason: 'expired' });
});

test('3. live claim refuses', () => {
  const d = classifyDirectModelClaim(statusLive());
  assert.equal(d.allow, false);
  assert.equal((d as { reason: string }).reason, 'live_claim');
});

test('4. unknown liveness refuses', () => {
  assert.deepEqual(classifyDirectModelClaim(statusLiveness('unknown')), { allow: false, reason: 'liveness_unknown' });
});

test('5. mechanism unavailable refuses', () => {
  assert.deepEqual(classifyDirectModelClaim(statusFail('mechanism_unavailable')), { allow: false, reason: 'mechanism_unavailable' });
});

test('6. permission failure refuses (arrives as mechanism_unavailable) ', () => {
  // producerClaim maps SQLSTATE 42501 / "permission denied" to mechanism_unavailable.
  assert.deepEqual(classifyDirectModelClaim(statusFail('mechanism_unavailable')), { allow: false, reason: 'mechanism_unavailable' });
});

test('7. transient uncertainty refuses', () => {
  assert.deepEqual(classifyDirectModelClaim(statusFail('transient_uncertain')), { allow: false, reason: 'transient_uncertain' });
});

test('8. invalid input refuses', () => {
  assert.deepEqual(classifyDirectModelClaim(statusFail('invalid_input')), { allow: false, reason: 'invalid_input' });
});

test('9-12. malformed / null / primitive / missing-liveness outcomes refuse', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}, { ok: 'yes' }, { ok: true }, { ok: true, liveness: {} }, statusFail('weird')]) {
    const d = classifyDirectModelClaim(bad);
    assert.equal(d.allow, false, JSON.stringify(bad));
    assert.equal((d as { reason: string }).reason, bad && (bad as { ok?: unknown }).ok === false && (bad as { failure?: { kind?: string } }).failure?.kind === 'weird' ? 'status_malformed' : (d as { reason: string }).reason);
  }
});

/* -------------------------------------------------------------------------- */
/* 13-17 Redaction / purity                                                   */
/* -------------------------------------------------------------------------- */

test('13. a live-claim decision contains no full owner id', () => {
  const d = classifyDirectModelClaim(statusLive());
  assert.doesNotMatch(JSON.stringify(d), new RegExp(OWNER));
});

test('14. owner prefix is at most eight safe characters', () => {
  const d = classifyDirectModelClaim(statusLive()) as { ownerPrefix?: string };
  assert.equal(d.ownerPrefix, '3f2504e0');
  assert.ok((d.ownerPrefix ?? '').length <= 8);
});

test('15. short / malformed owner id is NOT exposed (no prefix)', () => {
  for (const ownerId of ['short', 'exactly8', '', '  ', 'bad/\\:id-here!!']) {
    const d = classifyDirectModelClaim(statusLive(ownerId)) as { ownerPrefix?: string };
    assert.equal(d.ownerPrefix, undefined, ownerId);
  }
});

test('16. classifier never throws on any input', () => {
  for (const j of [null, undefined, 0, '', [], {}, Symbol('x') as unknown, () => 1, new Date() as unknown]) {
    assert.doesNotThrow(() => classifyDirectModelClaim(j));
  }
});

test('17. classifier module has no I/O and no claim mutation', () => {
  const s = readFileSync('src/lib/directModelClaimCheck.ts', 'utf8');
  assert.doesNotMatch(s, /\bfetch\(/);
  assert.doesNotMatch(s, /node:fs|node:child_process|node:net/);
  assert.doesNotMatch(s, /supabaseAdmin|\.from\(|\.rpc\(/);
  assert.doesNotMatch(s, /tryAcquireProducerClaim|heartbeatProducerClaim|releaseProducerClaim/);
});

/* -------------------------------------------------------------------------- */
/* 18-23 Async wrapper                                                        */
/* -------------------------------------------------------------------------- */

test('18. the wrapper calls the status reader EXACTLY once', async () => {
  let calls = 0;
  await assertDirectModelClaimClear(DATE, {
    fetchStatus: async (d) => {
      calls += 1;
      assert.equal(d, DATE);
      return statusLiveness('absent');
    },
  });
  assert.equal(calls, 1);
});

test('19-22. the wrapper never acquires / heartbeats / releases / steals (executable calls)', () => {
  const s = readFileSync('src/lib/directModelClaimCheck.ts', 'utf8');
  // Target the actual RPC/function CALL names, not prose (the docstring
  // legitimately explains it never "steals" a claim).
  for (const forbidden of [
    /tryAcquireProducerClaim\s*\(/,
    /heartbeatProducerClaim\s*\(/,
    /releaseProducerClaim\s*\(/,
    /try_acquire_producer_claim|heartbeat_producer_claim|release_producer_claim/,
  ]) {
    assert.doesNotMatch(s, forbidden);
  }
  // The only claim call it makes is the read-only status fetch.
  assert.match(s, /fetchProducerClaimStatus\s*\(/);
});

test('23. a status-reader that THROWS fails closed (refuse), never open', async () => {
  const d = await assertDirectModelClaimClear(DATE, {
    fetchStatus: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(d.allow, false);
});

/* -------------------------------------------------------------------------- */
/* 24-35 run:model integration (exported runModelCli, injected deps)          */
/* -------------------------------------------------------------------------- */

interface RunModelSpy {
  order: string[];
  deps: RunModelCliDeps;
}

function runModelSpy(over: Partial<RunModelCliDeps> = {}): RunModelSpy {
  const order: string[] = [];
  const deps: RunModelCliDeps = {
    resolveMeetingDate: async () => {
      order.push('resolve');
      return DATE;
    },
    assertClaimClear: async () => {
      order.push('check');
      return { allow: true, reason: 'unclaimed' };
    },
    runModel: async () => {
      order.push('model');
      return { ran: true };
    },
    log: () => order.push('log'),
    errorLog: () => order.push('error'),
    ...over,
  };
  return { order, deps };
}

test('24-25. run:model resolves the meeting date, THEN checks the claim, THEN runs the model', async () => {
  const spy = runModelSpy();
  const code = await runModelCli(['r1'], spy.deps);
  assert.equal(code, 0);
  assert.deepEqual(
    spy.order.filter((s) => s !== 'log'),
    ['resolve', 'check', 'model'],
  );
});

test('26. run:model refuses a live claim (non-zero, no model run)', async () => {
  const spy = runModelSpy({ assertClaimClear: async () => ({ allow: false, reason: 'live_claim', ownerPrefix: '3f2504e0' }) });
  const code = await runModelCli(['r1'], spy.deps);
  assert.equal(code, 1);
  assert.equal(spy.order.includes('model'), false);
});

test('27. run:model refuses an indeterminate status (non-zero, no model run)', async () => {
  for (const reason of ['liveness_unknown', 'mechanism_unavailable', 'transient_uncertain', 'invalid_input', 'status_malformed'] as const) {
    const spy = runModelSpy({ assertClaimClear: async () => ({ allow: false, reason }) });
    const code = await runModelCli(['r1'], spy.deps);
    assert.equal(code, 1, reason);
    assert.equal(spy.order.includes('model'), false, reason);
  }
});

test('28-29. run:model allows an absent OR expired claim', async () => {
  for (const reason of ['unclaimed', 'expired'] as const) {
    const spy = runModelSpy({ assertClaimClear: async () => ({ allow: true, reason }) });
    assert.equal(await runModelCli(['r1'], spy.deps), 0);
    assert.equal(spy.order.includes('model'), true);
  }
});

test('30-32. run:model missing race / missing meeting_date / lookup error fails BEFORE model work', async () => {
  const spy = runModelSpy({ resolveMeetingDate: async () => null });
  const code = await runModelCli(['r1'], spy.deps);
  assert.equal(code, 1);
  assert.equal(spy.order.includes('check'), false); // never even checks the claim
  assert.equal(spy.order.includes('model'), false);
});

test('33. run:model refusal exits non-zero', async () => {
  const spy = runModelSpy({ assertClaimClear: async () => ({ allow: false, reason: 'live_claim' }) });
  assert.equal(await runModelCli(['r1'], spy.deps), 1);
});

test('34-35. run:model refusal prints no full owner id and no secret/env value', async () => {
  const messages: string[] = [];
  const spy = runModelSpy({
    assertClaimClear: async () => ({ allow: false, reason: 'live_claim', ownerPrefix: '3f2504e0' }),
    errorLog: (m) => messages.push(m),
  });
  await runModelCli(['r1'], spy.deps);
  const text = messages.join('\n');
  assert.doesNotMatch(text, new RegExp(OWNER));
  assert.doesNotMatch(text, /CRON_SECRET|SUPABASE|SERVICE_ROLE|Bearer|password/i);
  assert.match(text, /3f2504e0/); // the safe prefix is allowed
});

test('35b. missing race id -> usage error, no lookup/check/model', async () => {
  const spy = runModelSpy();
  assert.equal(await runModelCli([], spy.deps), 1);
  assert.deepEqual(spy.order.filter((s) => s !== 'error'), []);
});

/* -------------------------------------------------------------------------- */
/* 36-44 model:day integration (exported runModelDayCli, injected deps)        */
/* -------------------------------------------------------------------------- */

const RACE: RaceRow = { id: 'r1', course: 'Ascot', off_time: '2026-07-25T13:30:00Z', race_name: 'Test', status: 'upcoming' };

interface DaySpy {
  order: string[];
  checks: number;
  deps: ModelDayCliDeps;
}

function daySpy(over: Partial<ModelDayCliDeps> = {}): DaySpy {
  const order: string[] = [];
  const state = { checks: 0 };
  const deps: ModelDayCliDeps = {
    fetchRaces: async () => {
      order.push('fetch');
      return [RACE];
    },
    assertClaimClear: async () => {
      order.push('check');
      state.checks += 1;
      return { allow: true, reason: 'unclaimed' };
    },
    runMeeting: async () => {
      order.push('loop');
      return [{ raceId: 'r1', status: 'run', scored: 8, recommended: 1 }];
    },
    log: () => {},
    errorLog: () => {},
    ...over,
  };
  return {
    order,
    get checks() {
      return state.checks;
    },
    deps,
  };
}

test('36-37. model:day --commit checks EXACTLY once, BEFORE the model loop', async () => {
  const spy = daySpy();
  const code = await runModelDayCli(['--date', DATE, '--course', 'Ascot', '--commit'], spy.deps);
  assert.equal(code, 0);
  assert.equal(spy.checks, 1);
  const checkAt = spy.order.indexOf('check');
  const loopAt = spy.order.indexOf('loop');
  assert.ok(checkAt >= 0 && loopAt > checkAt, 'check precedes loop');
});

test('38. model:day --commit refuses a live claim (non-zero, no loop)', async () => {
  const spy = daySpy({ assertClaimClear: async () => ({ allow: false, reason: 'live_claim', ownerPrefix: '3f2504e0' }) });
  const code = await runModelDayCli(['--date', DATE, '--commit'], spy.deps);
  assert.equal(code, 1);
  assert.equal(spy.order.includes('loop'), false);
});

test('39. model:day --commit refuses an unknown/indeterminate status (non-zero, no loop)', async () => {
  const spy = daySpy({ assertClaimClear: async () => ({ allow: false, reason: 'liveness_unknown' }) });
  assert.equal(await runModelDayCli(['--date', DATE, '--commit'], spy.deps), 1);
  assert.equal(spy.order.includes('loop'), false);
});

test('40-41. model:day --commit allows an absent OR expired claim (loop runs)', async () => {
  for (const reason of ['unclaimed', 'expired'] as const) {
    const spy = daySpy({ assertClaimClear: async () => ({ allow: true, reason }) });
    assert.equal(await runModelDayCli(['--date', DATE, '--commit'], spy.deps), 0);
    assert.equal(spy.order.includes('loop'), true);
  }
});

test('42-43. model:day DRY-RUN performs NO claim query and does not run the loop', async () => {
  const spy = daySpy();
  const code = await runModelDayCli(['--date', DATE, '--course', 'Ascot'], spy.deps); // no --commit
  assert.equal(code, 0);
  assert.equal(spy.checks, 0); // never queried claim status
  assert.equal(spy.order.includes('check'), false);
  assert.equal(spy.order.includes('loop'), false);
});

test('44. no model operation occurs before an allow decision (commit)', async () => {
  const order: string[] = [];
  const spy = daySpy({
    fetchRaces: async () => {
      order.push('fetch');
      return [RACE];
    },
    assertClaimClear: async () => {
      order.push('check');
      return { allow: false, reason: 'live_claim' };
    },
    runMeeting: async () => {
      order.push('loop');
      return [];
    },
  });
  const code = await runModelDayCli(['--date', DATE, '--commit'], spy.deps);
  assert.equal(code, 1);
  // The loop (the only place the model runs) is never reached; the check ran
  // after the fetch, before any loop.
  assert.deepEqual(order, ['fetch', 'check']);
});

/* -------------------------------------------------------------------------- */
/* 45-62 Boundary source scans                                                */
/* -------------------------------------------------------------------------- */

const src = (p: string): string => readFileSync(p, 'utf8');
const CHANGED = ['src/lib/directModelClaimCheck.ts', 'scripts/runModel.ts', 'scripts/runModelsForRaceDay.ts'];

test('45. no changed file contains a claim mutation call', () => {
  for (const f of CHANGED) {
    assert.doesNotMatch(src(f), /tryAcquireProducerClaim|heartbeatProducerClaim|releaseProducerClaim|acquireProducerOwnership|acquireNationwideOwnership/);
  }
});

test('46-47. no provider call and no child process introduced in changed files', () => {
  for (const f of CHANGED) {
    const t = src(f);
    // Executable calls/imports only — the model:day docstring legitimately
    // mentions "Betfair"/"Racing API" to explain what it does NOT do.
    assert.doesNotMatch(t, /createRacingApiClient\s*\(|syncOddsFromBetfair\s*\(|syncRacecards\s*\(/);
    assert.doesNotMatch(t, /from '[^']*\/(liveSync|racingApi|betfair)'/);
    assert.doesNotMatch(t, /node:child_process|spawn\s*\(|execFile\s*\(|\bexec\s*\(/);
  }
});

/**
 * `runModelForRace.ts` left the byte-identity list when the Off-Time Integrity
 * programme made the pre-off guard evaluate the EFFECTIVE off (the stored off,
 * tightened only ever EARLIER by corroborated evidence) and recorded that value
 * on the run.
 *
 * What this test file actually protects is that the shared model core stays
 * CLAIM-FREE — ownership is enforced by the CLIs and the routes, never here.
 * That guarantee is asserted directly below, which is stricter than byte
 * identity for this purpose: it would catch claim machinery being added even in
 * a change that byte-identity had been updated to allow.
 */
test('48-49a. the shared model core stays claim-free and ownership-free', () => {
  const core = src('src/lib/runModelForRace.ts');
  assert.doesNotMatch(core, /tryAcquireProducerClaim|heartbeatProducerClaim|releaseProducerClaim/);
  assert.doesNotMatch(core, /producerOwnership|ownershipContext|ownershipPropagation|x-producer-ownership/);
  assert.doesNotMatch(core, /checkForeignProducerClaim|directModelClaimCheck/);
  // The pre-off guard is still evaluated BEFORE any model write, and still
  // delegates to the single shared guard rather than re-implementing it.
  const guardAt = core.indexOf('evaluateModelRunGuard(');
  const insertAt = core.indexOf('.from(MODEL_RUNS_TABLE)');
  assert.ok(guardAt > 0 && insertAt > guardAt, 'the guard must precede the model-run insert');
  // The off it judges against can only ever be the strictest known one.
  assert.match(core, /fetchEffectiveOffTime\(raceId, storedOffTime\)/);
  assert.match(core, /off_time: effectiveOff\.effectiveOffTime/);
});

test('48-49. the model-day core is byte-identical to HEAD', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of ['src/lib/modelDayRun.ts']) {
    const committed = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(committed), `${f} changed`);
  }
});

test('50-57. Slices 1-3, protected routes, pipeline, nationwide, auth, migration, deploy files unchanged', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of [
    'src/lib/ownershipContext.ts',
    'src/lib/routeOwnershipGuard.ts',
    'src/lib/ownershipPropagation.ts',
    'src/lib/raceDayPipelineRunner.ts',
    'src/lib/auth.ts',
    // 'src/app/api/cron/racecards/route.ts' and 'scripts/lockTMinus.ts' left this
    // list in the Off-Time Integrity programme; both keep TARGETED assertions of
    // the ownership guarantee instead of byte identity (see the tests above and
    // ownershipPropagation.test.ts 55-59a).
    'src/app/api/cron/odds/route.ts',
    'src/app/api/run-model/route.ts',
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'scripts/nationwideDryRun.ts',
    'src/lib/producerClaim.ts',
    'src/lib/producerOwnership.ts',
    'scripts/autoResults.ts',
    'supabase/migrations/20260711000000_producer_run_claims.sql',
    'vercel.json',
  ]) {
    const committed = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(committed), `${f} changed`);
  }
});

test('58-59. route enforcement still defaults to enforce; no enforcement env setting added', () => {
  assert.match(src('src/lib/routeOwnershipGuard.ts'), /return \{ mode: 'enforce', recognized: false \}/);
  for (const f of CHANGED) {
    assert.doesNotMatch(src(f), /PRODUCER_OWNERSHIP_ENFORCEMENT/);
  }
});

test('60. no betting or order-placement capability introduced', () => {
  for (const f of CHANGED) {
    assert.doesNotMatch(src(f), /placeBet|placeOrder|createOrder|placeInstruction|\/betting\/rest/i);
  }
});

test('61-62. changed CLIs are import-safe (guarded main) and refusal formatter is safe', () => {
  // Both CLIs guard main behind an entrypoint check so importing them here does
  // not execute a real run.
  assert.match(src('scripts/runModel.ts'), /const isEntrypoint = .*import\.meta\.url/);
  assert.match(src('scripts/runModelsForRaceDay.ts'), /const isEntrypoint = .*import\.meta\.url/);
  // The refusal message never suggests stealing/deleting/releasing a claim.
  const msg = formatDirectModelRefusal(DATE, { reason: 'live_claim', ownerPrefix: '3f2504e0' });
  assert.doesNotMatch(msg, new RegExp(OWNER));
  assert.match(msg, /do not steal, delete, or manually release/);
  const decision: DirectModelClaimDecision = { allow: false, reason: 'mechanism_unavailable' };
  assert.match(formatDirectModelRefusal(DATE, decision), /could not be verified/);
});
