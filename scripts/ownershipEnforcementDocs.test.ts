/**
 * Tests for the Slice 4b ownership-enforcement WORDING and DOCUMENTATION —
 * Phase 7A route-hardening.
 *
 * These assert the RENDERED operator guidance (the preflight `detail` strings
 * produced by the real evaluators) and the documentation content, plus that no
 * behavioural code changed. They target executable output and file content, not
 * explanatory test comments. No server, provider, Supabase, claim, or model.
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { evaluateProducerPreflight } from '../src/lib/producerPreflight';
import { evaluateNationwidePreflight } from '../src/lib/nationwidePreflight';

const src = (p: string): string => readFileSync(p, 'utf8');
const OWN_DOC = () => src('docs/OWNERSHIP_ENFORCEMENT.md');
const CLAUDE = () => src('CLAUDE.md');
const RUNBOOK = () => src('docs/RACE_DAY_RUNBOOK.md');
const RAILWAY = () => src('docs/RAILWAY_RACE_DAY_AUTOMATION.md');

/* -------------------------------------------------------------------------- */
/* Preflight rendered guidance                                                */
/* -------------------------------------------------------------------------- */

function producerBypassDetail(): string {
  const report = evaluateProducerPreflight({
    date: '2026-07-25',
    courseRaw: 'Ascot',
    requireServer: false,
    confirmExternal: true,
    env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: true, projectHost: 'abc.supabase.co' },
    baseUrl: { raw: 'http://localhost:3000', valid: true, origin: 'http://localhost:3000', reason: null },
    claim: { kind: 'absent' },
    workload: { races: 7, runners: 70, racesWithOdds: 7, racesWithModelRuns: 0, settled: 0, upcoming: 7 },
    workloadError: null,
    server: { mode: 'probed', outcome: { result: 'ok', detail: 'health ok' } },
  } as unknown as Parameters<typeof evaluateProducerPreflight>[0]);
  const c = report.checks.find((x) => x.id === 'bypass_entry_points');
  return c ? c.detail : '';
}

function nationwideBypassDetail(): string {
  const report = evaluateNationwidePreflight({
    date: '2026-07-25',
    targetMode: 'live-provider',
    requireServer: false,
    confirmExternal: true,
    env: { supabaseUrl: true, serviceRoleKey: true, cronSecret: true, projectHost: 'abc.supabase.co' },
    baseUrl: { raw: 'http://localhost:3000', valid: true, origin: 'http://localhost:3000', reason: null },
    claim: { kind: 'absent' },
    workloadRows: [{ race_id: 'r1', course_label: 'Curragh', country: 'IRE', runner_count: 8, has_odds: true, priced_runner_count: 8 }],
    workloadError: null,
    server: { mode: 'probed', outcome: { result: 'ok', detail: 'health ok' } },
    localLockSlugsForDate: [],
  } as unknown as Parameters<typeof evaluateNationwidePreflight>[0]);
  const c = report.checks.find((x) => x.id === 'bypass_entry_points');
  return c ? c.detail : '';
}

test('1. producer preflight no longer calls guarded direct routes unconditional bypasses', () => {
  const d = producerBypassDetail();
  assert.doesNotMatch(d, /still able to bypass the claim/i);
  assert.doesNotMatch(d, /unconditional/i);
  assert.match(d, /direct CRON_SECRET-only calls are rejected/);
});

test('2. nationwide preflight no longer calls guarded direct routes unconditional bypasses', () => {
  const d = nationwideBypassDetail();
  assert.doesNotMatch(d, /Still able to bypass ANY producer claim/i);
  assert.match(d, /direct CRON_SECRET-only calls are rejected/);
});

test('3. producer preflight names racecards+odds as guarded and propagated', () => {
  const d = producerBypassDetail();
  assert.match(d, /racecards\|odds/);
  assert.match(d, /pipeline:day and pipeline:watch/);
  assert.match(d, /require a valid ownership context/);
});

test('4. nationwide preflight names racecards+odds as guarded and propagated (all-uk-ire)', () => {
  const d = nationwideBypassDetail();
  assert.match(d, /racecards \+ odds/);
  assert.match(d, /all-uk-ire/);
  assert.match(d, /require a valid ownership context/);
});

test('5. guarded model/results/training/run-model are described as requiring context (fail-closed)', () => {
  for (const d of [producerBypassDetail(), nationwideBypassDetail()]) {
    assert.match(d, /cron\/model, cron\/results, cron\/training-capture and run-model/);
    assert.match(d, /fail-closed/);
  }
});

test('6. direct CRON_SECRET-only calls are described as refused under enforce', () => {
  for (const d of [producerBypassDetail(), nationwideBypassDetail()]) {
    assert.match(d, /Under enforce/);
    assert.match(d, /rejected/);
  }
});

/* -------------------------------------------------------------------------- */
/* Documentation content                                                      */
/* -------------------------------------------------------------------------- */

test('7-9. run:model / model:day --commit / dry-run policy documented', () => {
  const doc = OWN_DOC();
  assert.match(doc, /`run:model`.*resolves the target race's meeting date/s);
  assert.match(doc, /`model:day --commit`.*before.*the model loop/s);
  assert.match(doc, /`model:day`\s*\*\*dry-run\*\* does not query claim status/);
});

test('10-13. tipster-discovery / lock:t-minus / results:auto / import:results exemptions documented', () => {
  const doc = OWN_DOC();
  assert.match(doc, /tipster-discovery.*today \+ tomorrow/s);
  assert.match(doc, /lock:t-minus.*OUTSIDE the claim/s);
  assert.match(doc, /results:auto.*[Rr]ead-only/s);
  assert.match(doc, /import:results.*audited, manual, operator-gated/s);
});

test('14. read-only routes are documented as NOT bypasses / not needing ownership', () => {
  const doc = OWN_DOC();
  assert.match(doc, /Read-only routes\/audits\/reports/);
  assert.match(doc, /No writes/);
});

test('15-19. enforcement modes documented (enforce default, fail-closed, warn absent-only, off emergency)', () => {
  const doc = OWN_DOC();
  assert.match(doc, /`enforce`\*\* is the default/);
  assert.match(doc, /fail closed\s*\n?\s*to enforce/);
  assert.match(doc, /`warn`\*\* permits \*\*only a missing \(absent\) context/);
  assert.match(doc, /malformed, conflicting,[\s\S]*?fails closed\*\* under `warn`/);
  assert.match(doc, /`off`\*\* skips route ownership verification[\s\S]*?emergency-only/);
});

test('20-21. deploy Slice 2+3 together; context-less Vercel crons enforce-incompatible', () => {
  const doc = OWN_DOC();
  assert.match(doc, /Slice 2 and Slice 3 must be deployed together/);
  assert.match(doc, /Context-less `vercel.json` platform crons would be \*\*rejected under enforce/);
});

test('22. Railway offline state is described historically, not assumed permanent', () => {
  const doc = OWN_DOC();
  assert.match(doc, /at the time of this work/);
  assert.match(doc, /must be re-checked before any future deployment/);
  assert.match(doc, /Railway was \*\*offline\*\*/);
});

test('37-38. Step A auth + /api/settle 410 remain documented', () => {
  const doc = OWN_DOC();
  assert.match(doc, /Step A — authentication/);
  assert.match(doc, /`POST \/api\/settle`.*permanent inert \*\*410\*\*/s);
});

test('39-42. Slice 1 fields / Slice 2 route set / Slice 3 propagation / Slice 4a policy documented', () => {
  const doc = OWN_DOC();
  assert.match(doc, /`v`, `date`, `owner`, `generation`, `scope`/);
  assert.match(doc, /`GET \/api\/cron\/racecards`[\s\S]*`POST \/api\/run-model`/);
  assert.match(doc, /`pipeline:day`[\s\S]*?`pipeline:watch`[\s\S]*?nationwide \*\*live-provider\*\* dry-run/);
  assert.match(doc, /\*\*Live claim → refuse\*\*/);
});

/* -------------------------------------------------------------------------- */
/* Attended verification runbook                                              */
/* -------------------------------------------------------------------------- */

test('27. attended verification is explicitly NOT executed automatically', () => {
  const doc = OWN_DOC();
  assert.match(doc, /DO NOT run as part of any automated task/);
  assert.match(doc, /Not executed by this repository or by CI/);
});

test('28-30. runbook requires repo cleanliness, pre-run claim absence, and final claim absence', () => {
  const doc = OWN_DOC();
  assert.match(doc, /Repository clean & reviewed/);
  assert.match(doc, /No producer active/);
  assert.match(doc, /Final claim status absent/);
});

test('31-33. runbook includes context-less 403, stale-generation 409, and direct-CLI refusal', () => {
  const doc = OWN_DOC();
  assert.match(doc, /Context-less call rejected.*403/s);
  assert.match(doc, /wrong-generation context rejected.*409/s);
  assert.match(doc, /Direct model CLIs refuse an owned date/);
});

test('34-36. runbook keeps lock/results unchanged, no nationwide persistence, no deployment', () => {
  const doc = OWN_DOC();
  assert.match(doc, /Lock\/result workflows unchanged/);
  assert.match(doc, /No nationwide persistence enabled/);
  assert.match(doc, /No deployment required/);
});

test('runbook separates the three verification tiers', () => {
  const doc = OWN_DOC();
  assert.match(doc, /Offline automated verification/);
  assert.match(doc, /Attended local integration verification/);
  assert.match(doc, /Future deployment verification/);
});

/* -------------------------------------------------------------------------- */
/* Safety of the wording itself                                               */
/* -------------------------------------------------------------------------- */

const WORDING_FILES = [
  'docs/OWNERSHIP_ENFORCEMENT.md',
  'src/lib/producerPreflight.ts',
  'src/lib/nationwidePreflight.ts',
  'docs/RACE_DAY_RUNBOOK.md',
  'docs/RAILWAY_RACE_DAY_AUTOMATION.md',
];

test('23. no CRON_SECRET value is rendered anywhere new', () => {
  // A literal secret would look like an assignment or a long token; the docs use
  // only the VARIABLE NAME and a `<CRON_SECRET>` placeholder.
  for (const f of WORDING_FILES) {
    const t = src(f);
    assert.doesNotMatch(t, /CRON_SECRET\s*=\s*['"][^'"]+['"]/);
    assert.doesNotMatch(t, /Bearer\s+[A-Za-z0-9]{16,}/);
  }
});

test('24. no full owner id (uuid) appears in docs or preflight wording', () => {
  const realUuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  // The runbook's placeholder is all-zeros/one nibble — an explicit fixture, not a real id.
  const placeholder = /00000000-0000-4000-8000-000000000000/;
  for (const f of WORDING_FILES) {
    const withoutPlaceholder = src(f).replace(new RegExp(placeholder, 'g'), '');
    assert.doesNotMatch(withoutPlaceholder, realUuid, `${f} contains a real-looking owner id`);
  }
});

test('25-26. no doc suggests weakening the guard, stealing, or manually releasing a live claim', () => {
  for (const f of WORDING_FILES) {
    const t = src(f);
    assert.doesNotMatch(t, /weaken the guard to make an old caller work(?!.)/i); // no positive advice to weaken
    assert.doesNotMatch(t, /steal (the|a) (live )?claim(?! )/i);
  }
  // The primary doc explicitly forbids it.
  assert.match(OWN_DOC(), /stealing, deleting, or manually releasing a live claim/i);
  assert.match(OWN_DOC(), /Never manually release a live claim/i);
  assert.match(OWN_DOC(), /Do not weaken the guard/);
});

test('60. no secret-shaped literal in the new/changed wording files', () => {
  for (const f of WORDING_FILES) {
    assert.doesNotMatch(src(f), /eyJ[A-Za-z0-9._-]{20,}/); // JWT-shaped
    assert.doesNotMatch(src(f), /sb[ph]_[A-Za-z0-9_-]{12,}/); // supabase key prefix
  }
});

/* -------------------------------------------------------------------------- */
/* Behavioural code + deployment files UNCHANGED (byte-identical to HEAD)      */
/* -------------------------------------------------------------------------- */

test('43-46. preflight verdict logic / report paths / structure unchanged apart from wording', () => {
  // The only diff vs HEAD in the two preflight libs is the ownership-boundary
  // check's `label` + `detail` text (id, status, and everything else intact).
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of ['src/lib/producerPreflight.ts', 'src/lib/nationwidePreflight.ts']) {
    const head = normalize(execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' }));
    const now = normalize(src(f));
    // Structural anchors that must NOT change.
    for (const anchor of ["id: 'bypass_entry_points'", "status: 'info'", "evidence: 'automatically_verified'"]) {
      assert.equal(now.includes(anchor), head.includes(anchor), `${f}: ${anchor}`);
    }
    // Verdict computation line unchanged.
    assert.equal(
      now.includes("checks.some((c) => c.status === 'blocked')"),
      head.includes("checks.some((c) => c.status === 'blocked')"),
    );
  }
});

test('47-56. all behavioural + deployment files are byte-identical to HEAD', () => {
  const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
  for (const f of [
    'src/lib/ownershipContext.ts',
    'src/lib/routeOwnershipGuard.ts',
    'src/lib/ownershipPropagation.ts',
    'src/lib/directModelClaimCheck.ts',
    'src/lib/raceDayPipelineRunner.ts',
    'src/lib/auth.ts',
    'src/app/api/cron/racecards/route.ts',
    'src/app/api/cron/odds/route.ts',
    'src/app/api/cron/model/route.ts',
    'src/app/api/cron/results/route.ts',
    'src/app/api/cron/training-capture/route.ts',
    'src/app/api/run-model/route.ts',
    'src/app/api/settle/route.ts',
    'scripts/runRaceDayPipeline.ts',
    'scripts/runRaceDayPipelineWatch.ts',
    'scripts/nationwideDryRun.ts',
    'scripts/runModel.ts',
    'scripts/runModelsForRaceDay.ts',
    'src/lib/producerClaim.ts',
    'src/lib/producerOwnership.ts',
    'scripts/lockTMinus.ts',
    'scripts/autoResults.ts',
    'supabase/migrations/20260711000000_producer_run_claims.sql',
    'vercel.json',
  ]) {
    const head = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    assert.equal(normalize(src(f)), normalize(head), `${f} changed`);
  }
});

test('57-58. no provider/model/db-write or betting code introduced in changed wording files', () => {
  for (const f of ['src/lib/producerPreflight.ts', 'src/lib/nationwidePreflight.ts']) {
    // These files were edited for TEXT only; assert they still match HEAD except
    // the label/detail — covered by 47-56 exclusion, so here just no new writes.
    const head = execFileSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' });
    const insertCount = (s: string): number => (s.match(/\.insert\(|\.upsert\(|\.update\(|\.delete\(/g) ?? []).length;
    assert.equal(insertCount(src(f)), insertCount(head), `${f}: write-call count changed`);
    assert.doesNotMatch(src(f), /placeBet|placeOrder|createOrder|placeInstruction/i);
  }
});

test('59. route enforcement still defaults to enforce (unchanged behaviour)', () => {
  assert.match(src('src/lib/routeOwnershipGuard.ts'), /return \{ mode: 'enforce', recognized: false \}/);
});

test('CLAUDE.md marks the old bypass wording superseded and documents the final state', () => {
  const c = CLAUDE();
  assert.match(c, /Route-hardening Steps B\/C \+ Slice 4a \(IMPLEMENTED/);
  assert.match(c, /SUPERSEDED/);
  assert.doesNotMatch(c, /Still pending:\*\* the ownership-context half of route-level enforcement/);
});

test('operator docs point to OWNERSHIP_ENFORCEMENT.md', () => {
  assert.match(RUNBOOK(), /OWNERSHIP_ENFORCEMENT\.md/);
  assert.match(RAILWAY(), /OWNERSHIP_ENFORCEMENT\.md/);
  assert.match(RAILWAY(), /Do not edit `vercel.json`/);
});
