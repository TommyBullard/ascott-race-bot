/**
 * Offline unit tests for the pure, inert ownership-context library
 * (src/lib/ownershipContext.ts) — Phase 7A route-hardening, B/C Slice 1.
 *
 * These are entirely offline: no DB, no network, no route runtime, no claim.
 * `verifyOwnershipContext` is exercised with hand-built status outcomes so the
 * fail-closed decision table is proven without touching the real RPC. Plus
 * source-scan guards prove the module is inert (no I/O, no clock, no runtime
 * import of a provider/model/route/DB client) and that no production file
 * imports it yet.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  InvalidOwnershipStateError,
  OWNERSHIP_CONTEXT_HEADER,
  OWNERSHIP_CONTEXT_MAX_BYTES,
  OWNERSHIP_CONTEXT_VERSION,
  OwnershipContextSerializeError,
  REDACTED_OWNER,
  buildOwnershipContext,
  isValidOwnershipContext,
  parseOwnershipContext,
  redactOwner,
  serializeOwnershipContext,
  verifyOwnershipContext,
  type OwnershipContext,
  type ParseResult,
} from '../src/lib/ownershipContext';
import type { OwnershipState } from '../src/lib/producerOwnership';

const DATE = '2026-07-25';
const OWNER = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OWNER_2 = '9fa61152-0000-4000-8000-000000000000';
const SCOPE = 'course:ascot';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function state(over: Partial<OwnershipState> = {}): OwnershipState {
  return {
    raceDate: DATE,
    scope: SCOPE,
    ownerId: OWNER,
    generation: 2,
    mode: 'pipeline-day',
    believed: true,
    stopReason: null,
    ...over,
  };
}

function ctx(over: Partial<OwnershipContext> = {}): OwnershipContext {
  return { v: 1, date: DATE, owner: OWNER, generation: 2, scope: SCOPE, ...over };
}

/** A live, matching status outcome (shape mirrors producerClaim's StatusOutcome). */
function liveStatus(over: {
  ownerId?: string;
  generation?: number;
  scope?: string;
  raceDate?: string;
  livenessStatus?: string;
} = {}): unknown {
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

const validParse = (context: OwnershipContext = ctx()): ParseResult => ({ kind: 'valid', context });

/* -------------------------------------------------------------------------- */
/* 1-2 Build                                                                   */
/* -------------------------------------------------------------------------- */

test('1. build projects exactly the five allowed fields from a believed state', () => {
  const c = buildOwnershipContext(state());
  assert.deepEqual(Object.keys(c).sort(), ['date', 'generation', 'owner', 'scope', 'v']);
  assert.deepEqual(c, { v: 1, date: DATE, owner: OWNER, generation: 2, scope: SCOPE });
  // The context has EXACTLY five properties — no `mode`, no extras.
  assert.equal(Object.keys(c).length, 5);
  assert.equal('mode' in c, false);
});

test('1b. build does not depend on OwnershipState.mode', () => {
  // Both selected-course modes, and even an out-of-union mode value, yield the
  // same proof when date/owner/generation/scope match — mode is never read.
  const day = buildOwnershipContext(state({ mode: 'pipeline-day' }));
  const watch = buildOwnershipContext(state({ mode: 'pipeline-watch' }));
  const weird = buildOwnershipContext(state({ mode: 'anything' as unknown as OwnershipState['mode'] }));
  assert.deepEqual(day, watch);
  assert.deepEqual(day, weird);
});

test('2. build rejects invalid ownership state (never silently repairs)', () => {
  const bad: Array<Partial<OwnershipState>> = [
    { believed: false },
    { raceDate: '2026-13-01' },
    { raceDate: '' },
    { ownerId: '' },
    { ownerId: '   ' },
    { generation: 0 },
    { generation: -1 },
    { generation: 1.5 },
    { scope: 'nonsense' },
    { scope: '' },
  ];
  for (const over of bad) {
    assert.throws(() => buildOwnershipContext(state(over)), InvalidOwnershipStateError, JSON.stringify(over));
  }
});

/* -------------------------------------------------------------------------- */
/* 3-4 Serialize / round-trip                                                  */
/* -------------------------------------------------------------------------- */

test('3. build -> serialize -> parse round-trips to an identical context', () => {
  const built = buildOwnershipContext(state());
  const serialized = serializeOwnershipContext(built);
  const parsed = parseOwnershipContext(serialized);
  assert.equal(parsed.kind, 'valid');
  assert.deepEqual((parsed as { context: OwnershipContext }).context, built);
});

test('4. serialization is deterministic, key-order-independent, and has no mode field', () => {
  const a = serializeOwnershipContext(ctx());
  const b = serializeOwnershipContext({
    scope: SCOPE,
    generation: 2,
    owner: OWNER,
    date: DATE,
    v: 1,
  } as OwnershipContext);
  assert.equal(a, b);
  assert.equal(a, `{"v":1,"date":"${DATE}","owner":"${OWNER}","generation":2,"scope":"${SCOPE}"}`);
  // A serialized context contains no `mode` field at all.
  assert.doesNotMatch(a, /mode/);
  // Serialize refuses an invalid context.
  assert.throws(() => serializeOwnershipContext({ ...ctx(), generation: 0 }), OwnershipContextSerializeError);
});

/* -------------------------------------------------------------------------- */
/* 5-26 Parse contract                                                         */
/* -------------------------------------------------------------------------- */

test('5. null header is absent', () => {
  assert.deepEqual(parseOwnershipContext(null), { kind: 'absent' });
  assert.deepEqual(parseOwnershipContext(undefined), { kind: 'absent' });
});

test('6. empty / whitespace header is absent (documented contract)', () => {
  assert.deepEqual(parseOwnershipContext(''), { kind: 'absent' });
  assert.deepEqual(parseOwnershipContext('   '), { kind: 'absent' });
});

test('7. non-JSON is malformed', () => {
  assert.equal(parseOwnershipContext('not json').kind, 'malformed');
  assert.equal(parseOwnershipContext('{bad').kind, 'malformed');
});

test('8. JSON null is malformed', () => {
  assert.equal(parseOwnershipContext('null').kind, 'malformed');
});

test('9. array JSON is malformed', () => {
  assert.equal(parseOwnershipContext('[]').kind, 'malformed');
  assert.equal(parseOwnershipContext('[{"v":1}]').kind, 'malformed');
});

test('10. primitive JSON is malformed', () => {
  for (const raw of ['1', '"x"', 'true', '3.14']) {
    assert.equal(parseOwnershipContext(raw).kind, 'malformed', raw);
  }
});

test('11. unknown version is rejected as unsupported_version', () => {
  const raw = JSON.stringify({ ...ctx(), v: 2 });
  assert.equal(parseOwnershipContext(raw).kind, 'unsupported_version');
});

test('12. missing date is rejected', () => {
  const { date: _drop, ...rest } = ctx();
  void _drop;
  assert.equal(parseOwnershipContext(JSON.stringify(rest)).kind, 'malformed');
});

test('13. invalid calendar date is rejected (no coercion)', () => {
  for (const date of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '20260101', 'yesterday']) {
    assert.equal(parseOwnershipContext(JSON.stringify(ctx({ date }))).kind, 'malformed', date);
  }
});

test('14-15. missing / blank owner is rejected', () => {
  const { owner: _o, ...noOwner } = ctx();
  void _o;
  assert.equal(parseOwnershipContext(JSON.stringify(noOwner)).kind, 'malformed');
  assert.equal(parseOwnershipContext(JSON.stringify(ctx({ owner: '' }))).kind, 'malformed');
  assert.equal(parseOwnershipContext(JSON.stringify(ctx({ owner: '   ' }))).kind, 'malformed');
});

test('16-20. generation must be a positive integer (no coercion)', () => {
  const { generation: _g, ...noGen } = ctx();
  void _g;
  assert.equal(parseOwnershipContext(JSON.stringify(noGen)).kind, 'malformed'); // missing
  assert.equal(parseOwnershipContext(JSON.stringify({ ...ctx(), generation: '2' })).kind, 'malformed'); // string
  assert.equal(parseOwnershipContext(JSON.stringify(ctx({ generation: 0 }))).kind, 'malformed'); // zero
  assert.equal(parseOwnershipContext(JSON.stringify(ctx({ generation: -3 }))).kind, 'malformed'); // negative
  assert.equal(parseOwnershipContext(JSON.stringify(ctx({ generation: 2.5 }))).kind, 'malformed'); // decimal
});

test('21-22. scope must be present and well-formed', () => {
  const { scope: _s, ...noScope } = ctx();
  void _s;
  assert.equal(parseOwnershipContext(JSON.stringify(noScope)).kind, 'malformed');
  for (const scope of ['', 'course:', 'course:Ascot', 'course:ascot-park', 'random', 'all uk ire']) {
    assert.equal(parseOwnershipContext(JSON.stringify(ctx({ scope }))).kind, 'malformed', scope);
  }
  // The two legitimate shapes parse.
  assert.equal(parseOwnershipContext(JSON.stringify(ctx({ scope: 'all-uk-ire' }))).kind, 'valid');
  assert.equal(parseOwnershipContext(JSON.stringify(ctx({ scope: 'course:newmarket' }))).kind, 'valid');
});

test('23-24. mode is NOT part of the contract — a bare five-field context is valid', () => {
  // Data minimisation: no mode field exists, so a valid context has exactly the
  // five fields and nothing else.
  assert.equal(parseOwnershipContext(JSON.stringify(ctx())).kind, 'valid');
  const parsed = parseOwnershipContext(JSON.stringify(ctx()));
  assert.equal('mode' in (parsed as { context: OwnershipContext }).context, false);
});

test('25. unknown / extra properties are rejected (including a stray mode)', () => {
  assert.equal(parseOwnershipContext(JSON.stringify({ ...ctx(), extra: 1 })).kind, 'malformed');
  assert.equal(parseOwnershipContext(JSON.stringify({ ...ctx(), owner_id: OWNER })).kind, 'malformed');
  // A context carrying a `mode` property is rejected because unknown properties
  // are forbidden — mode is no longer in the contract.
  assert.equal(parseOwnershipContext(JSON.stringify({ ...ctx(), mode: 'commit' })).kind, 'malformed');
  assert.equal(parseOwnershipContext(JSON.stringify({ ...ctx(), mode: 'dry-run' })).kind, 'malformed');
});

test('26. oversized input is rejected BEFORE JSON parsing', () => {
  const huge = 'x'.repeat(OWNERSHIP_CONTEXT_MAX_BYTES + 1);
  assert.equal(parseOwnershipContext(huge).kind, 'oversized');
  // A valid-but-padded oversized JSON is also rejected as oversized, not parsed.
  const padded = JSON.stringify({ ...ctx(), owner: 'o'.repeat(OWNERSHIP_CONTEXT_MAX_BYTES) });
  assert.equal(parseOwnershipContext(padded).kind, 'oversized');
});

/* -------------------------------------------------------------------------- */
/* 27-43 Verify decision table                                                 */
/* -------------------------------------------------------------------------- */

test('27. valid context + matching live claim allows', () => {
  assert.deepEqual(verifyOwnershipContext(validParse(), liveStatus(), DATE), { allow: true });
});

test('28. absent claim denies 409', () => {
  const outcome = { ok: true, serverNowIso: 's', liveness: { status: 'absent' }, claim: null };
  assert.deepEqual(verifyOwnershipContext(validParse(), outcome, DATE), {
    allow: false,
    status: 409,
    reason: 'no_claim',
  });
});

test('29. expired claim denies 409', () => {
  const outcome = liveStatus({ livenessStatus: 'expired' });
  assert.deepEqual(verifyOwnershipContext(validParse(), outcome, DATE), {
    allow: false,
    status: 409,
    reason: 'claim_expired',
  });
});

test('30. wrong route date denies 409', () => {
  const d = verifyOwnershipContext(validParse(ctx({ date: '2026-07-24' })), liveStatus(), DATE);
  assert.deepEqual(d, { allow: false, status: 409, reason: 'date_mismatch' });
});

test('31. wrong owner denies 409', () => {
  const d = verifyOwnershipContext(validParse(ctx({ owner: OWNER_2 })), liveStatus(), DATE);
  assert.deepEqual(d, { allow: false, status: 409, reason: 'owner_mismatch' });
});

test('32-33. generation mismatch (lower and higher) denies 409', () => {
  const lower = verifyOwnershipContext(validParse(ctx({ generation: 1 })), liveStatus({ generation: 2 }), DATE);
  assert.deepEqual(lower, { allow: false, status: 409, reason: 'generation_mismatch' });
  const higher = verifyOwnershipContext(validParse(ctx({ generation: 3 })), liveStatus({ generation: 2 }), DATE);
  assert.deepEqual(higher, { allow: false, status: 409, reason: 'generation_mismatch' });
});

test('34. course context against a nationwide claim denies 409 (fail-closed scope)', () => {
  const d = verifyOwnershipContext(
    validParse(ctx({ scope: 'course:ascot' })),
    liveStatus({ scope: 'all-uk-ire' }),
    DATE,
  );
  assert.deepEqual(d, { allow: false, status: 409, reason: 'scope_mismatch' });
});

test('35. nationwide context against a course claim denies 409 (fail-closed scope)', () => {
  const d = verifyOwnershipContext(
    validParse(ctx({ scope: 'all-uk-ire' })),
    liveStatus({ scope: 'course:ascot' }),
    DATE,
  );
  assert.deepEqual(d, { allow: false, status: 409, reason: 'scope_mismatch' });
});

test('36. two different course scopes deny 409', () => {
  const d = verifyOwnershipContext(
    validParse(ctx({ scope: 'course:ascot' })),
    liveStatus({ scope: 'course:newmarket' }),
    DATE,
  );
  assert.deepEqual(d, { allow: false, status: 409, reason: 'scope_mismatch' });
});

test('37. unknown liveness denies 503', () => {
  const d = verifyOwnershipContext(validParse(), liveStatus({ livenessStatus: 'unknown' }), DATE);
  assert.deepEqual(d, { allow: false, status: 503, reason: 'liveness_unknown' });
});

test('38. mechanism unavailable denies 503', () => {
  const outcome = { ok: false, failure: { kind: 'mechanism_unavailable', message: 'x' } };
  assert.deepEqual(verifyOwnershipContext(validParse(), outcome, DATE), {
    allow: false,
    status: 503,
    reason: 'mechanism_unavailable',
  });
});

test('39. permission failure denies 503 (classified as mechanism_unavailable upstream)', () => {
  // producerClaim maps SQLSTATE 42501 / "permission denied" to mechanism_unavailable.
  const outcome = { ok: false, failure: { kind: 'mechanism_unavailable', message: 'permission denied' } };
  assert.equal(verifyOwnershipContext(validParse(), outcome, DATE).allow, false);
  assert.equal((verifyOwnershipContext(validParse(), outcome, DATE) as { status: number }).status, 503);
});

test('40. transient uncertainty denies 503', () => {
  const outcome = { ok: false, failure: { kind: 'transient_uncertain', message: 'x' } };
  assert.deepEqual(verifyOwnershipContext(validParse(), outcome, DATE), {
    allow: false,
    status: 503,
    reason: 'transient_uncertain',
  });
});

test('41. malformed status outcome denies 503', () => {
  for (const outcome of [null, undefined, 42, 'nope', {}, { ok: 'yes' }, { ok: true }, { ok: true, liveness: {} }]) {
    const d = verifyOwnershipContext(validParse(), outcome, DATE);
    assert.equal(d.allow, false, JSON.stringify(outcome));
    assert.equal((d as { status: number }).status, 503);
  }
});

test('42. live but missing generation in the claim denies 503', () => {
  const outcome = liveStatus();
  delete (outcome as { claim: Record<string, unknown> }).claim.generation;
  assert.deepEqual(verifyOwnershipContext(validParse(), outcome, DATE), {
    allow: false,
    status: 503,
    reason: 'status_malformed',
  });
});

test('43. live but missing scope in the claim denies 503', () => {
  const outcome = liveStatus();
  delete (outcome as { claim: Record<string, unknown> }).claim.scope;
  assert.deepEqual(verifyOwnershipContext(validParse(), outcome, DATE), {
    allow: false,
    status: 503,
    reason: 'status_malformed',
  });
});

test('43b. an invalid routeResolvedDate is indeterminate -> 503', () => {
  assert.deepEqual(verifyOwnershipContext(validParse(), liveStatus(), '2026-13-40'), {
    allow: false,
    status: 503,
    reason: 'status_malformed',
  });
});

test('43c. an absent/malformed/oversized parse denies 403', () => {
  assert.deepEqual(verifyOwnershipContext({ kind: 'absent' }, liveStatus(), DATE), {
    allow: false,
    status: 403,
    reason: 'context_absent',
  });
  assert.deepEqual(verifyOwnershipContext({ kind: 'malformed', detail: 'x' }, liveStatus(), DATE), {
    allow: false,
    status: 403,
    reason: 'context_malformed',
  });
  assert.deepEqual(verifyOwnershipContext({ kind: 'unsupported_version', detail: 'x' }, liveStatus(), DATE), {
    allow: false,
    status: 403,
    reason: 'context_unsupported_version',
  });
  assert.deepEqual(verifyOwnershipContext({ kind: 'oversized', detail: 'x' }, liveStatus(), DATE), {
    allow: false,
    status: 403,
    reason: 'context_oversized',
  });
});

/* -------------------------------------------------------------------------- */
/* 44-47 Safety properties                                                     */
/* -------------------------------------------------------------------------- */

const LIB_SRC = readFileSync('src/lib/ownershipContext.ts', 'utf8');

test('44. the module never references the local clock', () => {
  assert.doesNotMatch(LIB_SRC, /Date\.now\(/);
  assert.doesNotMatch(LIB_SRC, /new Date\(/);
  assert.doesNotMatch(LIB_SRC, /\bDate\(/);
});

test('45. redactOwner returns at most eight safe characters or a placeholder', () => {
  assert.equal(redactOwner(OWNER), '3f2504e0');
  assert.ok(redactOwner(OWNER).length <= 8);
  assert.notEqual(redactOwner(OWNER), OWNER);
  // Malformed / short / blank -> placeholder, never the whole id.
  assert.equal(redactOwner(''), REDACTED_OWNER);
  assert.equal(redactOwner('   '), REDACTED_OWNER);
  assert.equal(redactOwner('short'), REDACTED_OWNER);
  assert.equal(redactOwner('exactly8'), REDACTED_OWNER); // length 8 -> placeholder
  assert.equal(redactOwner(null), REDACTED_OWNER);
  assert.equal(redactOwner(42), REDACTED_OWNER);
  assert.equal(redactOwner('bad/\\:chars-here'), REDACTED_OWNER);
});

test('46. no deny decision object contains the owner id or the claim row', () => {
  const decisions = [
    verifyOwnershipContext(validParse(ctx({ owner: OWNER_2 })), liveStatus(), DATE),
    verifyOwnershipContext(validParse(), liveStatus({ scope: 'all-uk-ire' }), DATE),
    verifyOwnershipContext({ kind: 'malformed', detail: 'x' }, liveStatus(), DATE),
  ];
  for (const d of decisions) {
    const text = JSON.stringify(d);
    assert.doesNotMatch(text, new RegExp(OWNER));
    assert.doesNotMatch(text, new RegExp(OWNER_2));
    assert.doesNotMatch(text, /hostname|pid|appVersion|claimedAt|expiresAt/);
    // Only allow/status/reason keys.
    assert.ok(Object.keys(d).every((k) => ['allow', 'status', 'reason'].includes(k)));
  }
});

test('47. parse failures never echo the raw header value', () => {
  const secretish = JSON.stringify({ v: 1, date: DATE, owner: OWNER, generation: 2, scope: SCOPE, leak: OWNER });
  const result = parseOwnershipContext(secretish);
  assert.equal(result.kind, 'malformed');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(OWNER));
  // The oversized detail also never echoes input.
  assert.doesNotMatch(JSON.stringify(parseOwnershipContext('z'.repeat(OWNERSHIP_CONTEXT_MAX_BYTES + 5))), /zzzz/);
});

/* -------------------------------------------------------------------------- */
/* 48-54 Inertness / purity / boundary                                         */
/* -------------------------------------------------------------------------- */

test('48. the module has no runtime import (only an erased type-only projection)', () => {
  // Runtime imports only (an erased `import type` is allowed).
  const runtimeImports = [...LIB_SRC.matchAll(/^import (?!type )\{[^}]*\} from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(runtimeImports, [], `unexpected runtime imports: ${runtimeImports.join(', ')}`);
  // The only import at all is a type-only projection of the state shape.
  const allImports = [...LIB_SRC.matchAll(/^import .*$/gm)].map((m) => m[0]);
  assert.deepEqual(allImports, ["import type { OwnershipState } from './producerOwnership';"]);
  // Specifically: no RUNTIME import from producerOwnership (a type import is erased).
  assert.doesNotMatch(LIB_SRC, /^import (?!type )[^;]*from '\.\/producerOwnership';/m);
});

test('49. the module performs no I/O', () => {
  assert.doesNotMatch(LIB_SRC, /\bfetch\(/);
  assert.doesNotMatch(LIB_SRC, /node:fs|node:child_process|node:net|node:https?/);
  assert.doesNotMatch(LIB_SRC, /require\(/);
  assert.doesNotMatch(LIB_SRC, /supabaseAdmin|\.rpc\(|\.from\(/);
  assert.doesNotMatch(LIB_SRC, /process\.env/);
  assert.doesNotMatch(LIB_SRC, /console\./);
});

test('50. ownershipContext is consumed ONLY by the Slice 2 route guard (no other production importer)', () => {
  // Slice 1 was inert; Slice 2 wires it into the route ownership guard exactly
  // once. Any OTHER production importer would be unexpected.
  const roots = ['src/lib', 'src/app', 'scripts'];
  const ALLOWED_IMPORTERS = ['src/lib/routeOwnershipGuard.ts'];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSyncSafe(dir)) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        if (full.endsWith('src/lib/ownershipContext.ts')) continue;
        if (ALLOWED_IMPORTERS.some((a) => full.endsWith(a))) continue;
        if (/from '[^']*ownershipContext'|from "[^"]*ownershipContext"/.test(readFileSync(full, 'utf8'))) {
          offenders.push(full);
        }
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(offenders, [], `ownershipContext is imported by unexpected files: ${offenders.join(', ')}`);
});

test('51-53. the header/version constants and validity helper are stable', () => {
  assert.equal(OWNERSHIP_CONTEXT_VERSION, 1);
  assert.equal(OWNERSHIP_CONTEXT_HEADER, 'x-producer-ownership');
  assert.equal(OWNERSHIP_CONTEXT_MAX_BYTES, 1024);
  assert.equal(isValidOwnershipContext(ctx()), true);
  assert.equal(isValidOwnershipContext({ ...ctx(), extra: 1 }), false);
  assert.equal(isValidOwnershipContext(null), false);
});

test('54. no betting or order-placement functionality is introduced', () => {
  assert.doesNotMatch(LIB_SRC, /placeBet|placeOrder|createOrder|placeInstruction|\/betting\/rest/i);
});

/* -------------------------------------------------------------------------- */
/* helper                                                                      */
/* -------------------------------------------------------------------------- */

import { readdirSync } from 'node:fs';
function readdirSyncSafe(dir: string): { name: string; isDirectory(): boolean; isFile(): boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
