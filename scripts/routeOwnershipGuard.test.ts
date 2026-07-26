/**
 * Tests for the route ownership guard (src/lib/routeOwnershipGuard.ts) and its
 * integration into the six write-capable routes — Phase 7A route-hardening,
 * B/C Slice 2.
 *
 * BOUNDARY: the guard's decision logic is exercised with INJECTED deps (a spy
 * `fetchStatus` + spy `log`), so no live Supabase / provider / model is ever
 * touched. Route integration is exercised on the REAL handlers in-process, but
 * ONLY on paths that refuse (or fail Step A) BEFORE any provider/model/write —
 * so those are fully offline too. The allow path (valid context + live claim)
 * is proven at the guard-unit level, never by calling a real route (that would
 * hit the DB and provider). Plus source scans for the inert-boundary
 * properties. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  ENFORCEMENT_ENV_VAR,
  defaultGuardDeps,
  guardRouteOwnership,
  logOwnershipEvent,
  ownershipRefusalBody,
  readEnforcementMode,
  resolveEnforcementMode,
  type EffectiveDate,
  type GuardDeps,
  type RouteOwnershipGuardInput,
  type SafeOwnershipEvent,
} from '../src/lib/routeOwnershipGuard';
import { OWNERSHIP_CONTEXT_HEADER, OWNERSHIP_CONTEXT_MAX_BYTES } from '../src/lib/ownershipContext';

const DATE = '2026-07-25';
const OWNER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OWNER_2 = '9fa61152-0000-4000-8000-000000000000';
const SCOPE = 'course:ascot';
const SECRET = 'slice2-secret-value';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function ctxHeader(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, date: DATE, owner: OWNER, generation: 2, scope: SCOPE, ...over });
}

function liveStatus(over: { ownerId?: string; generation?: number; scope?: string; raceDate?: string; livenessStatus?: string } = {}): unknown {
  return {
    ok: true,
    serverNowIso: '2026-07-25T12:00:00.000Z',
    liveness: { status: over.livenessStatus ?? 'live', remainingSeconds: 120, expiredSeconds: null },
    claim: {
      raceDate: over.raceDate ?? DATE,
      scope: over.scope ?? SCOPE,
      ownerId: over.ownerId ?? OWNER,
      generation: over.generation ?? 2,
      claimedAt: '2026-07-25T11:58:00.000Z',
      heartbeatAt: '2026-07-25T11:59:00.000Z',
      expiresAt: '2026-07-25T12:04:00.000Z',
      hostname: 'host',
      pid: 123,
      appVersion: 'v1',
      mode: 'course:ascot',
    },
  };
}

interface SpyState {
  fetchCalls: number;
  lastFetchDate: string | null;
  dateResolveCalls: number;
  logs: SafeOwnershipEvent[];
}

function spy(status: unknown, dateResolves: EffectiveDate = { ok: true, date: DATE }): {
  deps: GuardDeps;
  state: SpyState;
  resolveEffectiveDate: () => Promise<EffectiveDate>;
} {
  const state: SpyState = { fetchCalls: 0, lastFetchDate: null, dateResolveCalls: 0, logs: [] };
  return {
    state,
    resolveEffectiveDate: async () => {
      state.dateResolveCalls += 1;
      return dateResolves;
    },
    deps: {
      fetchStatus: async (date: string) => {
        state.fetchCalls += 1;
        state.lastFetchDate = date;
        return status;
      },
      log: (e: SafeOwnershipEvent) => {
        state.logs.push(e);
      },
    },
  };
}

function input(over: Partial<RouteOwnershipGuardInput>, resolveEffectiveDate: () => Promise<EffectiveDate>): RouteOwnershipGuardInput {
  return { route: 'test/route', headerValue: null, mode: 'enforce', resolveEffectiveDate, ...over };
}

/* -------------------------------------------------------------------------- */
/* 1-10 Enforcement-mode resolution (fail-closed)                              */
/* -------------------------------------------------------------------------- */

test('1. resolveEnforcementMode: exact off/warn/enforce recognised', () => {
  assert.deepEqual(resolveEnforcementMode('off'), { mode: 'off', recognized: true });
  assert.deepEqual(resolveEnforcementMode('warn'), { mode: 'warn', recognized: true });
  assert.deepEqual(resolveEnforcementMode('enforce'), { mode: 'enforce', recognized: true });
});

test('2. resolveEnforcementMode: missing/blank/unknown -> enforce (fail-closed)', () => {
  for (const raw of [undefined, null, '', '   ', 'Warn', 'ENFORCE', 'warn ', ' off', 'on', 'true', 'disabled']) {
    const r = resolveEnforcementMode(raw as string | null | undefined);
    assert.equal(r.mode, 'enforce', JSON.stringify(raw));
    assert.equal(r.recognized, raw === 'off' || raw === 'warn' || raw === 'enforce');
  }
});

test('3. readEnforcementMode reads the documented env var', () => {
  const saved = process.env[ENFORCEMENT_ENV_VAR];
  try {
    process.env[ENFORCEMENT_ENV_VAR] = 'warn';
    assert.equal(readEnforcementMode().mode, 'warn');
    delete process.env[ENFORCEMENT_ENV_VAR];
    assert.equal(readEnforcementMode().mode, 'enforce');
  } finally {
    if (saved === undefined) delete process.env[ENFORCEMENT_ENV_VAR];
    else process.env[ENFORCEMENT_ENV_VAR] = saved;
  }
});

test('4. ownershipRefusalBody maps status to a fixed generic body', () => {
  assert.deepEqual(ownershipRefusalBody(403), { error: 'Ownership required' });
  assert.deepEqual(ownershipRefusalBody(409), { error: 'Ownership conflict' });
  assert.deepEqual(ownershipRefusalBody(503), { error: 'Ownership verification unavailable' });
});

/* -------------------------------------------------------------------------- */
/* 5-14 OFF and ABSENT paths (no I/O)                                          */
/* -------------------------------------------------------------------------- */

test('5. off mode: permits without parsing or querying, emits ENFORCEMENT_OFF', async () => {
  const s = spy(liveStatus());
  const d = await guardRouteOwnership(input({ mode: 'off', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal(d.proceed, true);
  assert.equal(s.state.fetchCalls, 0);
  assert.equal(s.state.dateResolveCalls, 0);
  assert.equal(d.event.event, 'OWNERSHIP_ENFORCEMENT_OFF');
  assert.equal(d.event.ownerPrefix, null);
});

test('6. warn + absent: permits with OWNERSHIP_ABSENT_COMPAT, no claim query', async () => {
  const s = spy(liveStatus());
  const d = await guardRouteOwnership(input({ mode: 'warn', headerValue: null }, s.resolveEffectiveDate), s.deps);
  assert.equal(d.proceed, true);
  assert.equal(d.event.event, 'OWNERSHIP_ABSENT_COMPAT');
  assert.equal(s.state.fetchCalls, 0);
  assert.equal(s.state.dateResolveCalls, 0);
  assert.equal(d.event.ownerPrefix, null);
});

test('7. enforce + absent: refuses 403, no claim query', async () => {
  const s = spy(liveStatus());
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: null }, s.resolveEffectiveDate), s.deps);
  assert.equal(d.proceed, false);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 403);
  assert.equal(s.state.fetchCalls, 0);
});

test('8. warn + absent applies to empty/whitespace header (treated as absent)', async () => {
  for (const raw of ['', '   ']) {
    const s = spy(liveStatus());
    const d = await guardRouteOwnership(input({ mode: 'warn', headerValue: raw }, s.resolveEffectiveDate), s.deps);
    assert.equal(d.proceed, true);
    assert.equal(d.event.event, 'OWNERSHIP_ABSENT_COMPAT');
    assert.equal(s.state.fetchCalls, 0);
  }
});

/* -------------------------------------------------------------------------- */
/* 9-16 Malformed / unsupported / oversized (fail closed both modes, no I/O)   */
/* -------------------------------------------------------------------------- */

for (const mode of ['warn', 'enforce'] as const) {
  test(`9.${mode}. malformed context -> 403, no query`, async () => {
    const s = spy(liveStatus());
    const d = await guardRouteOwnership(input({ mode, headerValue: 'not json' }, s.resolveEffectiveDate), s.deps);
    assert.equal(d.proceed, false);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 403);
    assert.equal(s.state.fetchCalls, 0);
    assert.equal(s.state.dateResolveCalls, 0);
  });

  test(`10.${mode}. unsupported version -> 403, no query`, async () => {
    const s = spy(liveStatus());
    const d = await guardRouteOwnership(input({ mode, headerValue: ctxHeader({ v: 2 }) }, s.resolveEffectiveDate), s.deps);
    assert.equal(d.proceed, false);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 403);
    assert.equal(s.state.fetchCalls, 0);
  });

  test(`11.${mode}. oversized context -> 403, no query`, async () => {
    const s = spy(liveStatus());
    const huge = 'x'.repeat(OWNERSHIP_CONTEXT_MAX_BYTES + 1);
    const d = await guardRouteOwnership(input({ mode, headerValue: huge }, s.resolveEffectiveDate), s.deps);
    assert.equal(d.proceed, false);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 403);
    assert.equal(s.state.fetchCalls, 0);
  });
}

/* -------------------------------------------------------------------------- */
/* 12-24 Valid context -> query + verify decision table                        */
/* -------------------------------------------------------------------------- */

test('12. valid + live matching claim -> allow (queries exactly once, with the resolved date)', async () => {
  const s = spy(liveStatus());
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal(d.proceed, true);
  assert.equal(d.event.event, 'OWNERSHIP_VERIFIED');
  assert.equal(s.state.fetchCalls, 1);
  assert.equal(s.state.lastFetchDate, DATE);
  assert.equal(s.state.dateResolveCalls, 1);
});

test('13. valid but route date unresolved -> 503, no query', async () => {
  const s = spy(liveStatus(), { ok: false });
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal(d.proceed, false);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 503);
  assert.equal(s.state.dateResolveCalls, 1);
  assert.equal(s.state.fetchCalls, 0);
  assert.equal(d.event.reason, 'route_date_unresolved');
});

test('14. wrong route date -> 409', async () => {
  const s = spy(liveStatus({ raceDate: '2026-07-24' }));
  // Context date (2026-07-25) != route-resolved date (2026-07-24).
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, async () => ({ ok: true, date: '2026-07-24' })), s.deps);
  assert.equal((d as { refusal?: { status: number } }).refusal?.status, 409);
});

test('15. wrong owner -> 409', async () => {
  const s = spy(liveStatus({ ownerId: OWNER_2 }));
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 409);
});

test('16. wrong generation -> 409 (both directions)', async () => {
  for (const g of [1, 3]) {
    const s = spy(liveStatus({ generation: 2 }));
    const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader({ generation: g }) }, s.resolveEffectiveDate), s.deps);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 409);
  }
});

test('17. wrong scope -> 409 (course vs nationwide, nationwide vs course, two courses)', async () => {
  const cases: Array<[string, string]> = [
    ['course:ascot', 'all-uk-ire'],
    ['all-uk-ire', 'course:ascot'],
    ['course:ascot', 'course:newmarket'],
  ];
  for (const [ctxScope, claimScope] of cases) {
    const s = spy(liveStatus({ scope: claimScope }));
    const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader({ scope: ctxScope }) }, s.resolveEffectiveDate), s.deps);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 409, `${ctxScope} vs ${claimScope}`);
  }
});

test('18. absent claim -> 409', async () => {
  const s = spy({ ok: true, serverNowIso: 's', liveness: { status: 'absent' }, claim: null });
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 409);
});

test('19. expired claim -> 409', async () => {
  const s = spy(liveStatus({ livenessStatus: 'expired' }));
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 409);
});

test('20. unknown liveness -> 503', async () => {
  const s = spy(liveStatus({ livenessStatus: 'unknown' }));
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 503);
});

test('21. mechanism unavailable / permission failure -> 503', async () => {
  for (const message of ['boom', 'permission denied for function producer_claim_status']) {
    const s = spy({ ok: false, failure: { kind: 'mechanism_unavailable', message } });
    const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 503);
  }
});

test('22. transient uncertainty -> 503', async () => {
  const s = spy({ ok: false, failure: { kind: 'transient_uncertain', message: 'x' } });
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 503);
});

test('23. malformed status response -> 503', async () => {
  for (const status of [null, {}, { ok: true }, { ok: true, liveness: {} }, 42, 'x']) {
    const s = spy(status);
    const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 503, JSON.stringify(status));
  }
});

test('24. live claim missing generation or scope -> 503', async () => {
  for (const drop of ['generation', 'scope']) {
    const status = liveStatus() as { claim: Record<string, unknown> };
    delete status.claim[drop];
    const s = spy(status);
    const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
    assert.equal((d as { refusal: { status: number } }).refusal.status, 503, drop);
  }
});

test('25. warn fails closed for every conflicting/indeterminate case (only absent differs)', async () => {
  // A valid-but-conflicting context is refused in warn exactly as in enforce.
  const conflicts: unknown[] = [
    liveStatus({ ownerId: OWNER_2 }),
    liveStatus({ generation: 9 }),
    liveStatus({ scope: 'all-uk-ire' }),
    liveStatus({ livenessStatus: 'expired' }),
    { ok: false, failure: { kind: 'mechanism_unavailable', message: 'x' } },
  ];
  for (const status of conflicts) {
    const s = spy(status);
    const d = await guardRouteOwnership(input({ mode: 'warn', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
    assert.equal(d.proceed, false, JSON.stringify(status));
  }
});

/* -------------------------------------------------------------------------- */
/* 26-30 Claim-status query rule + lazy date resolution                        */
/* -------------------------------------------------------------------------- */

test('26. claim status is queried ONLY for a valid parsed context', async () => {
  for (const header of [null, '', '   ', 'not json', ctxHeader({ v: 5 }), 'x'.repeat(OWNERSHIP_CONTEXT_MAX_BYTES + 1)]) {
    const s = spy(liveStatus());
    await guardRouteOwnership(input({ mode: 'enforce', headerValue: header }, s.resolveEffectiveDate), s.deps);
    assert.equal(s.state.fetchCalls, 0, JSON.stringify(header));
  }
  const ok = spy(liveStatus());
  await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, ok.resolveEffectiveDate), ok.deps);
  assert.equal(ok.state.fetchCalls, 1);
});

test('27. off mode never queries claim status even with a valid context', async () => {
  const s = spy(liveStatus());
  await guardRouteOwnership(input({ mode: 'off', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal(s.state.fetchCalls, 0);
  assert.equal(s.state.dateResolveCalls, 0);
});

test('28. resolveEffectiveDate is invoked ONLY on the valid-context path', async () => {
  for (const [mode, header] of [['off', ctxHeader()], ['warn', null], ['enforce', null], ['enforce', 'not json']] as const) {
    const s = spy(liveStatus());
    await guardRouteOwnership(input({ mode, headerValue: header }, s.resolveEffectiveDate), s.deps);
    assert.equal(s.state.dateResolveCalls, 0, `${mode}/${String(header)}`);
  }
  const s = spy(liveStatus());
  await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal(s.state.dateResolveCalls, 1);
});

/* -------------------------------------------------------------------------- */
/* 29-33 Redaction / no secret leakage                                         */
/* -------------------------------------------------------------------------- */

test('29. refusal bodies contain only a generic error string', async () => {
  const s = spy(liveStatus({ ownerId: OWNER_2 }));
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  const body = (d as { refusal: { body: Record<string, unknown> } }).refusal.body;
  assert.deepEqual(Object.keys(body), ['error']);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(OWNER));
  assert.doesNotMatch(JSON.stringify(body), /course:ascot|generation|expiresAt|hostname/);
});

test('30. events carry at most an 8-char owner prefix, never the full id or raw header', async () => {
  const s = spy(liveStatus());
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal(d.event.ownerPrefix, '3f2504e0');
  const text = JSON.stringify(d.event);
  assert.doesNotMatch(text, new RegExp(OWNER)); // never the full uuid
  assert.doesNotMatch(text, /4f89-11d3/); // never a later fragment of the id
});

test('31. the safe event has only the whitelisted keys', async () => {
  const s = spy(liveStatus());
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.deepEqual(Object.keys(d.event).sort(), ['date', 'event', 'mode', 'ownerPrefix', 'reason', 'route']);
});

test('32. logOwnershipEvent emits structured JSON and never a raw header/owner', () => {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (l?: unknown) => { lines.push(String(l)); };
  console.warn = (l?: unknown) => { lines.push(String(l)); };
  try {
    logOwnershipEvent({ event: 'OWNERSHIP_REFUSED', route: 'r', mode: 'enforce', reason: 'owner_mismatch', date: DATE, ownerPrefix: '3f2504e0' });
    logOwnershipEvent({ event: 'OWNERSHIP_VERIFIED', route: 'r', mode: 'enforce', reason: 'ok', date: DATE, ownerPrefix: '3f2504e0' });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  assert.equal(lines.length, 2);
  for (const l of lines) {
    JSON.parse(l); // structured
    assert.doesNotMatch(l, new RegExp(OWNER));
    assert.doesNotMatch(l, new RegExp(OWNERSHIP_CONTEXT_HEADER));
  }
});

/* -------------------------------------------------------------------------- */
/* 33-52 Route integration (real handlers; refuse / pre-work paths only)       */
/* -------------------------------------------------------------------------- */

type RouteHandler = (request: Request) => Promise<Response>;

async function importRoute(path: string): Promise<Record<string, unknown>> {
  return (await import(`../${path.replace(/\.ts$/, '')}`)) as Record<string, unknown>;
}

const CRON_ROUTES = [
  { id: 'racecards', path: 'src/app/api/cron/racecards/route.ts', method: 'GET' },
  { id: 'odds', path: 'src/app/api/cron/odds/route.ts', method: 'GET' },
  { id: 'model', path: 'src/app/api/cron/model/route.ts', method: 'GET' },
  { id: 'results', path: 'src/app/api/cron/results/route.ts', method: 'GET' },
  { id: 'training-capture', path: 'src/app/api/cron/training-capture/route.ts', method: 'GET' },
] as const;

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k] as string;
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

const authed = (url: string, extra: Record<string, string> = {}, method = 'GET'): Request =>
  new Request(url, { method, headers: { authorization: `Bearer ${SECRET}`, ...extra } });

test('33. cron routes: authorized + enforce + ABSENT context -> 403 before any provider/write', async () => {
  await withEnv({ CRON_SECRET: SECRET, PRODUCER_OWNERSHIP_ENFORCEMENT: 'enforce' }, async () => {
    for (const r of CRON_ROUTES) {
      const mod = await importRoute(r.path);
      const res = await (mod.GET as RouteHandler)(authed(`http://localhost/api/cron/${r.id}`));
      assert.equal(res.status, 403, r.id);
      assert.deepEqual(await res.json(), { error: 'Ownership required' });
    }
  });
});

test('34. cron routes: authorized + MALFORMED context -> 403 in warn AND enforce', async () => {
  for (const mode of ['warn', 'enforce']) {
    await withEnv({ CRON_SECRET: SECRET, PRODUCER_OWNERSHIP_ENFORCEMENT: mode }, async () => {
      for (const r of CRON_ROUTES) {
        const mod = await importRoute(r.path);
        const res = await (mod.GET as RouteHandler)(authed(`http://localhost/api/cron/${r.id}`, { [OWNERSHIP_CONTEXT_HEADER]: 'not json' }));
        assert.equal(res.status, 403, `${r.id}/${mode}`);
      }
    });
  }
});

test('35. cron routes: MISSING CRON_SECRET still returns Step A 503 (auth before ownership)', async () => {
  await withEnv({ CRON_SECRET: undefined, PRODUCER_OWNERSHIP_ENFORCEMENT: 'enforce' }, async () => {
    for (const r of CRON_ROUTES) {
      const mod = await importRoute(r.path);
      // Even WITH a valid-looking context, Step A refuses first.
      const res = await (mod.GET as RouteHandler)(
        new Request(`http://localhost/api/cron/${r.id}`, { headers: { [OWNERSHIP_CONTEXT_HEADER]: ctxHeader() } }),
      );
      assert.equal(res.status, 503, r.id);
      assert.deepEqual(await res.json(), { error: 'Endpoint unavailable' });
    }
  });
});

test('36. cron routes: WRONG bearer returns Step A 401 (auth before ownership)', async () => {
  await withEnv({ CRON_SECRET: SECRET, PRODUCER_OWNERSHIP_ENFORCEMENT: 'enforce' }, async () => {
    for (const r of CRON_ROUTES) {
      const mod = await importRoute(r.path);
      const res = await (mod.GET as RouteHandler)(
        new Request(`http://localhost/api/cron/${r.id}`, { headers: { authorization: 'Bearer wrong', [OWNERSHIP_CONTEXT_HEADER]: ctxHeader() } }),
      );
      assert.equal(res.status, 401, r.id);
      assert.deepEqual(await res.json(), { error: 'Unauthorized' });
    }
  });
});

test('37. run-model: MISSING CRON_SECRET -> 503, no race lookup, no ownership work (auth first)', async () => {
  await withEnv({ CRON_SECRET: undefined, PRODUCER_OWNERSHIP_ENFORCEMENT: 'enforce' }, async () => {
    const mod = await importRoute('src/app/api/run-model/route.ts');
    const res = await (mod.POST as RouteHandler)(
      new Request('http://localhost/api/run-model?race_id=r1', { method: 'POST', headers: { [OWNERSHIP_CONTEXT_HEADER]: ctxHeader() } }),
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'Endpoint unavailable' });
  });
});

test('38. run-model: authorized + enforce + ABSENT context -> 403, before any race lookup or model', async () => {
  await withEnv({ CRON_SECRET: SECRET, PRODUCER_OWNERSHIP_ENFORCEMENT: 'enforce' }, async () => {
    const mod = await importRoute('src/app/api/run-model/route.ts');
    const res = await (mod.POST as RouteHandler)(authed('http://localhost/api/run-model?race_id=r1', {}, 'POST'));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Ownership required' });
  });
});

test('39. run-model: authorized + malformed context -> 403 (no model run)', async () => {
  await withEnv({ CRON_SECRET: SECRET, PRODUCER_OWNERSHIP_ENFORCEMENT: 'enforce' }, async () => {
    const mod = await importRoute('src/app/api/run-model/route.ts');
    const res = await (mod.POST as RouteHandler)(
      authed('http://localhost/api/run-model?race_id=r1', { [OWNERSHIP_CONTEXT_HEADER]: '{bad' }, 'POST'),
    );
    assert.equal(res.status, 403);
  });
});

/* -------------------------------------------------------------------------- */
/* 40-46 Date-resolution behaviour (guard-level, offline) + run-model lookup   */
/* -------------------------------------------------------------------------- */

test('40. racecards resolves today/tomorrow via the same UTC rule (cronDate)', async () => {
  const { resolveCronMeetingDate } = await import('../src/lib/cronDate');
  const now = new Date('2026-07-25T09:00:00Z');
  assert.equal(resolveCronMeetingDate({ day: 'today' }, now).meetingDate, '2026-07-25');
  assert.equal(resolveCronMeetingDate({ day: 'tomorrow' }, now).meetingDate, '2026-07-26');
});

test('41. odds/model/training-capture honour ?date=; results uses today UTC', async () => {
  const { resolveCronMeetingDate } = await import('../src/lib/cronDate');
  const now = new Date('2026-07-25T09:00:00Z');
  assert.equal(resolveCronMeetingDate({ date: '2026-08-01' }, now).meetingDate, '2026-08-01');
  assert.equal(resolveCronMeetingDate({}, now).meetingDate, '2026-07-25'); // results' today-UTC rule
});

test('42. run-model: a valid context with an UNRESOLVABLE race date -> 503 (never runs the model)', async () => {
  // Model the route's lazy resolver returning {ok:false} for a missing race / no meeting_date.
  const s = spy(liveStatus(), { ok: false });
  const d = await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, s.resolveEffectiveDate), s.deps);
  assert.equal(d.proceed, false);
  assert.equal((d as { refusal: { status: number } }).refusal.status, 503);
  assert.equal(s.state.fetchCalls, 0); // never even queried the claim
});

test('43. run-model: the resolver is invoked before any claim query, only on a valid context', async () => {
  // valid -> resolver then fetch; absent -> neither.
  const okv = spy(liveStatus());
  await guardRouteOwnership(input({ mode: 'enforce', headerValue: ctxHeader() }, okv.resolveEffectiveDate), okv.deps);
  assert.equal(okv.state.dateResolveCalls, 1);
  assert.equal(okv.state.fetchCalls, 1);
  const abs = spy(liveStatus());
  await guardRouteOwnership(input({ mode: 'enforce', headerValue: null }, abs.resolveEffectiveDate), abs.deps);
  assert.equal(abs.state.dateResolveCalls, 0);
});

/* -------------------------------------------------------------------------- */
/* 44-60 Source-scan boundary                                                  */
/* -------------------------------------------------------------------------- */

const GUARD_SRC = readFileSync('src/lib/routeOwnershipGuard.ts', 'utf8');
const src = (p: string): string => readFileSync(p, 'utf8');

test('44. the guard never acquires/heartbeats/releases/steals a claim', () => {
  assert.doesNotMatch(GUARD_SRC, /tryAcquireProducerClaim|heartbeatProducerClaim|releaseProducerClaim/);
  assert.doesNotMatch(GUARD_SRC, /try_acquire_producer_claim|heartbeat_producer_claim|release_producer_claim/);
});

test('45. the guard imports no provider/model client and writes nothing', () => {
  assert.doesNotMatch(GUARD_SRC, /from '\.\/liveSync'|from '\.\/raceSync'|from '\.\/runModelForRace'|betfair|racingApi/i);
  assert.doesNotMatch(GUARD_SRC, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  // The only claim call it may make is the read-only status fetch.
  assert.match(GUARD_SRC, /fetchProducerClaimStatus/);
  assert.doesNotMatch(GUARD_SRC, /\.rpc\(/);
});

test('46. every selected route calls the guard AFTER requireCronSecret and imports it', () => {
  const routes = [
    'src/app/api/cron/racecards/route.ts',
    'src/app/api/cron/odds/route.ts',
    'src/app/api/cron/model/route.ts',
    'src/app/api/cron/results/route.ts',
    'src/app/api/cron/training-capture/route.ts',
    'src/app/api/run-model/route.ts',
  ];
  for (const r of routes) {
    const text = src(r);
    assert.match(text, /enforceRouteOwnership\(/, `${r} does not call the guard`);
    const authAt = text.indexOf('requireCronSecret(');
    const guardAt = text.indexOf('enforceRouteOwnership(');
    assert.ok(authAt > 0 && guardAt > authAt, `${r}: guard must come after auth`);
  }
});

test('47. selected routes: the guard precedes the provider/model call', () => {
  const pairs: Array<[string, RegExp]> = [
    ['src/app/api/cron/racecards/route.ts', /syncRacecards\(/],
    ['src/app/api/cron/odds/route.ts', /syncOddsFromBetfair\(/],
    ['src/app/api/cron/model/route.ts', /refreshModelForMeeting\(/],
    ['src/app/api/cron/results/route.ts', /syncResults\(/],
    ['src/app/api/cron/training-capture/route.ts', /captureTrainingExamples\(/],
    ['src/app/api/run-model/route.ts', /runModelForRace\(/],
  ];
  for (const [file, work] of pairs) {
    const text = src(file);
    const guardAt = text.indexOf('enforceRouteOwnership(');
    const workAt = (work.exec(text) as RegExpExecArray).index;
    assert.ok(guardAt > 0 && guardAt < workAt, `${file}: work runs before the guard`);
  }
});

test('48. run-model: the race lookup is passed to the guard lazily, invoked only after auth', () => {
  const text = src('src/app/api/run-model/route.ts');
  const authAt = text.indexOf('requireCronSecret(');
  const guardAt = text.indexOf('enforceRouteOwnership(');
  // The resolver is INVOKED (not merely defined) after auth, by handing it to
  // the guard which calls it lazily only on the valid-context path.
  const invokeAt = text.indexOf('resolveRaceMeetingDate(raceId)');
  assert.ok(authAt > 0 && guardAt > authAt, 'guard after auth');
  assert.ok(invokeAt > authAt && invokeAt <= guardAt + 200, 'resolver handed to the guard after auth');
  // The lookup itself is a single read-only SELECT of meeting_date.
  assert.match(text, /\.from\('races'\)/);
  assert.match(text, /\.select\('meeting_date'\)/);
  assert.doesNotMatch(text, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  // The model only runs after the gate proceeds.
  const modelAt = text.indexOf('runModelForRace(');
  assert.ok(modelAt > guardAt, 'model runs after the guard');
});

test('49. tipster-discovery remains EXEMPT: no ownership imports', () => {
  const text = src('src/app/api/cron/tipster-discovery/route.ts');
  assert.doesNotMatch(text, /routeOwnershipGuard|ownershipContext|enforceRouteOwnership/);
  // It still has its Step A auth.
  assert.match(text, /requireCronSecret\(/);
});

test('50. ownershipContext.ts and auth.ts are unchanged by Slice 2', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of ['src/lib/ownershipContext.ts', 'src/lib/auth.ts']) {
    const committed = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(committed), `${f} changed`);
  }
});

test('51. createCallCron / raceDayPipelineRunner / orchestrators are unchanged', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of [
    'src/lib/raceDayPipelineRunner.ts',
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'scripts/nationwideDryRun.ts',
  ]) {
    const committed = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(committed), `${f} changed`);
  }
});

test('52. nationwide + producer-claim + write-boundary modules are unchanged', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of [
    'src/lib/producerOwnership.ts',
    'src/lib/producerClaim.ts',
    'src/lib/nationwideOwnership.ts',
    'src/lib/nationwidePreflight.ts',
    'src/lib/nationwideWriteBoundaryAudit.ts',
  ]) {
    const committed = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(committed), `${f} changed`);
  }
});

test('53. lock:t-minus and results:auto remain claim-free and guard-free', () => {
  for (const f of ['scripts/lockTMinus.ts', 'scripts/autoResults.ts']) {
    assert.doesNotMatch(src(f), /routeOwnershipGuard|enforceRouteOwnership|tryAcquireProducerClaim/);
  }
});

test('54. migrations, vercel.json, and Railway docs are byte-identical to HEAD', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of [
    'supabase/migrations/20260711000000_producer_run_claims.sql',
    'vercel.json',
    'docs/RAILWAY_RACE_DAY_AUTOMATION.md',
  ]) {
    const committed = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(committed), `${f} changed`);
  }
});

test('55. no betting or order-placement functionality is introduced', () => {
  const files = [
    'src/lib/routeOwnershipGuard.ts',
    'src/app/api/cron/racecards/route.ts',
    'src/app/api/cron/odds/route.ts',
    'src/app/api/cron/model/route.ts',
    'src/app/api/cron/results/route.ts',
    'src/app/api/cron/training-capture/route.ts',
    'src/app/api/run-model/route.ts',
  ];
  for (const f of files) {
    assert.doesNotMatch(src(f), /placeBet|placeOrder|createOrder|placeInstruction|\/betting\/rest/i);
  }
});

test('56. the guard defaults wire the read-only status RPC and the structured logger', () => {
  assert.equal(typeof defaultGuardDeps.fetchStatus, 'function');
  assert.equal(defaultGuardDeps.log, logOwnershipEvent);
});

test('57. the guard body performs no direct database/provider I/O of its own', () => {
  // All I/O is via the injected deps (fetchStatus) — the guard imports no client.
  assert.doesNotMatch(GUARD_SRC, /supabaseAdmin/);
  assert.doesNotMatch(GUARD_SRC, /\bfetch\(/);
});

test('58. the guard reads exactly one env var (the enforcement mode)', () => {
  const envReads = [...GUARD_SRC.matchAll(/process\.env\[([^\]]+)\]|process\.env\.(\w+)/g)];
  for (const m of envReads) {
    const ref = m[1] ?? `'${m[2]}'`;
    assert.ok(/ENFORCEMENT_ENV_VAR/.test(ref), `unexpected env read: ${m[0]}`);
  }
});
