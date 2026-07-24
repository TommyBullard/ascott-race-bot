/**
 * Tests for the nationwide write-boundary evidence pack
 * (src/lib/nationwideWriteBoundaryAudit.ts,
 * scripts/nationwideWriteBoundaryAudit.ts,
 * scripts/nationwideWriteBoundaryCompare.ts) — Nationwide rebuild Phase 7A.2b.
 *
 * Proves: every category names a REAL table and a REAL date-scoping
 * relationship; a missing table, a permission failure, a failed query and an
 * unscopable table are NEVER collapsed into a zero count and can never support
 * a PASS; forbidden persistence must have a conclusive ZERO delta (an increase
 * AND a decrease both FAIL); allowed provider ingestion may grow freely;
 * database errors are reduced to a short redacted string that never carries a
 * key, token, URL or environment value; owner ids are truncated to a prefix;
 * the snapshot command is SELECT-only with no --commit flag, no provider call,
 * no model execution and no claim acquire/heartbeat/release; and the
 * comparison command touches no database at all. Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALLOWED_CATEGORY_IDS,
  EVIDENCE_STATEMENT,
  FORBIDDEN_CATEGORY_IDS,
  ID_CHUNK_SIZE,
  MANDATORY_FORBIDDEN_CATEGORY_IDS,
  WRITE_BOUNDARY_CATEGORIES,
  WRITE_BOUNDARY_SCHEMA_VERSION,
  WRITE_BOUNDARY_SCOPE,
  buildComparisonMarkdownPath,
  buildWriteBoundaryEvidence,
  buildWriteBoundaryJsonPath,
  buildWriteBoundaryMarkdownPath,
  checkWriteBoundaryInvariants,
  chunkIds,
  classifyCategoryError,
  compareWriteBoundaryEvidence,
  findCategory,
  gatherWriteBoundarySnapshot,
  isCounted,
  isValidEvidenceDate,
  ownerPrefix,
  parseSnapshotLabel,
  redactErrorDetail,
  renderComparisonConsole,
  renderComparisonMarkdown,
  renderWriteBoundaryConsole,
  renderWriteBoundaryMarkdown,
  utcDayBounds,
  type CategoryStatus,
  type ClaimEvidence,
  type CountFilters,
  type EvidenceCategory,
  type GatheredSnapshot,
  type PgErrorLike,
  type RawCategoryResult,
  type SnapshotLabel,
  type WriteBoundaryEvidence,
  type WriteBoundaryReadSeam,
} from '../src/lib/nationwideWriteBoundaryAudit';
import { classifyTableProbe } from '../src/lib/dbHealthSpec';
import { parseWriteBoundaryArgs } from './nationwideWriteBoundaryAudit';
import { parseCompareArgs, parseEvidenceFile } from './nationwideWriteBoundaryCompare';

const DATE = '2026-07-18';

/* -------------------------------------------------------------------------- */
/* Fake SELECT-only seam                                                      */
/* -------------------------------------------------------------------------- */

interface FakeSeamOptions {
  races?: { id: string; course: string | null; status: string | null }[];
  racesError?: PgErrorLike | null;
  counts?: Record<string, number>;
  countErrors?: Record<string, PgErrorLike>;
  idsByTable?: Record<string, string[]>;
  idsErrors?: Record<string, PgErrorLike>;
  cronCount?: number;
  cronError?: PgErrorLike | null;
  claim?: ClaimEvidence;
}

interface FakeSeam extends WriteBoundaryReadSeam {
  calls: string[];
}

function fakeSeam(options: FakeSeamOptions = {}): FakeSeam {
  const calls: string[] = [];
  const countKey = (table: string, filters?: CountFilters) =>
    filters?.notNullColumn ? `${table}:${filters.notNullColumn}` : table;
  return {
    calls,
    async fetchRaces(date: string) {
      calls.push(`fetchRaces(${date})`);
      if (options.racesError) return { rows: null, error: options.racesError };
      return { rows: (options.races ?? []).map((r) => ({ ...r })), error: null };
    },
    async countByIds(table: string, column: string, ids: readonly string[], filters?: CountFilters) {
      const key = countKey(table, filters);
      calls.push(`countByIds(${key},${column},${ids.length})`);
      const err = options.countErrors?.[key];
      if (err) return { count: null, error: err };
      const total = options.counts?.[key];
      if (total === undefined) return { count: 0, error: null };
      // Spread the configured total over chunks deterministically: the first
      // chunk carries it all, so summing across chunks reproduces `total`.
      return { count: ids[0] === '__later__' ? 0 : total, error: null };
    },
    async fetchIdsByIds(table: string, idColumn: string, column: string, ids: readonly string[]) {
      calls.push(`fetchIdsByIds(${table},${idColumn},${column},${ids.length})`);
      const err = options.idsErrors?.[table];
      if (err) return { ids: null, error: err };
      return { ids: options.idsByTable?.[table] ?? [], error: null };
    },
    async countByTimeRange(table: string, column: string, fromIso: string, toIso: string) {
      calls.push(`countByTimeRange(${table},${column},${fromIso},${toIso})`);
      if (options.cronError) return { count: null, error: options.cronError };
      return { count: options.cronCount ?? 0, error: null };
    },
    async claimStatus(date: string) {
      calls.push(`claimStatus(${date})`);
      return options.claim ?? { status: 'absent', scope: null, generation: null, owner_prefix: null };
    },
  };
}

function healthySeamOptions(): FakeSeamOptions {
  return {
    races: [
      { id: 'r1', course: 'Curragh', status: 'upcoming' },
      { id: 'r2', course: 'Down Royal', status: 'upcoming' },
    ],
    counts: {
      runners: 16,
      'runners:finish_pos': 0,
      market_snapshots: 4,
      model_runs: 0,
      recommendations: 0,
      locked_race_decisions: 0,
      ml_training_examples: 0,
      genai_commentary: 0,
      model_runner_scores: 0,
      runner_quotes: 40,
    },
    idsByTable: { model_runs: [], market_snapshots: ['s1', 's2'] },
    cronCount: 7,
  };
}

async function gatherHealthy(over: FakeSeamOptions = {}): Promise<GatheredSnapshot> {
  const opts = { ...healthySeamOptions(), ...over };
  return gatherWriteBoundarySnapshot(fakeSeam(opts), DATE, 'before', classifyTableProbe);
}

function evidenceFrom(gathered: GatheredSnapshot): WriteBoundaryEvidence {
  return buildWriteBoundaryEvidence(gathered, '2026-07-18T09:00:00.000Z');
}

function categoriesFrom(map: Record<string, RawCategoryResult>): EvidenceCategory[] {
  return WRITE_BOUNDARY_CATEGORIES.map((def) => ({
    ...def,
    ...(map[def.id] ?? { status: 'counted' as CategoryStatus, count: 0 }),
  }));
}

/* -------------------------------------------------------------------------- */
/* 1-10 Category registry: real tables, real relationships                    */
/* -------------------------------------------------------------------------- */

test('1. every category names a table that genuinely exists in this schema', () => {
  const known = new Set([
    'races',
    'runners',
    'market_snapshots',
    'runner_quotes',
    'model_runs',
    'model_runner_scores',
    'recommendations',
    'locked_race_decisions',
    'ml_training_examples',
    'genai_commentary',
    'cron_runs',
  ]);
  for (const c of WRITE_BOUNDARY_CATEGORIES) assert.ok(known.has(c.table), `unknown table ${c.table}`);
});

test('2. every category documents its actual date-scoping relationship', () => {
  for (const c of WRITE_BOUNDARY_CATEGORIES) {
    assert.ok(c.relationship.length > 20, `${c.id} has no real relationship description`);
    assert.match(c.relationship, /meeting_date|calendar day/);
  }
});

test('3. category ids are unique', () => {
  const ids = WRITE_BOUNDARY_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('4. the six mandatory forbidden categories are exactly the core persistence tables', () => {
  assert.deepEqual(MANDATORY_FORBIDDEN_CATEGORY_IDS, [
    'model_runs',
    'model_runner_scores',
    'recommendations',
    'locked_race_decisions',
    'settled_races',
    'runner_finish_positions',
  ]);
});

test('5. training and GenAI capture are forbidden but OPTIONAL (they may be absent elsewhere)', () => {
  for (const id of ['training_examples', 'genai_artifacts']) {
    const c = findCategory(id);
    assert.equal(c?.kind, 'forbidden');
    assert.equal(c?.mandatory, false);
  }
});

test('6. model_runner_scores is scoped through model_runs, never directly by race_id', () => {
  const c = findCategory('model_runner_scores');
  assert.match(c?.relationship ?? '', /model_run_id -> model_runs\.race_id/);
});

test('7. runner_quotes is scoped through market_snapshots, never directly by race_id', () => {
  const c = findCategory('runner_quotes');
  assert.match(c?.relationship ?? '', /snapshot_id -> market_snapshots\.race_id/);
});

test('8. cron_runs is declared NOT race-scopable and uses a UTC calendar day instead', () => {
  const c = findCategory('cron_telemetry');
  assert.match(c?.relationship ?? '', /NOT a race relationship/);
  assert.match(c?.relationship ?? '', /finished_at/);
});

test('9. locked decisions count EVERY horizon, not just the official minutes_before = 5', () => {
  assert.match(findCategory('locked_race_decisions')?.relationship ?? '', /ALL horizons/);
});

test('10. allowed vs forbidden partition covers every category exactly once', () => {
  assert.equal(ALLOWED_CATEGORY_IDS.length + FORBIDDEN_CATEGORY_IDS.length, WRITE_BOUNDARY_CATEGORIES.length);
  assert.equal(new Set([...ALLOWED_CATEGORY_IDS, ...FORBIDDEN_CATEGORY_IDS]).size, WRITE_BOUNDARY_CATEGORIES.length);
});

/* -------------------------------------------------------------------------- */
/* 11-18 Input validation                                                     */
/* -------------------------------------------------------------------------- */

test('11. isValidEvidenceDate accepts a real calendar date and rejects a fake one', () => {
  assert.equal(isValidEvidenceDate('2026-07-24'), true);
  assert.equal(isValidEvidenceDate('2026-02-30'), false);
  assert.equal(isValidEvidenceDate('2026-7-4'), false);
  assert.equal(isValidEvidenceDate(''), false);
  assert.equal(isValidEvidenceDate(null), false);
});

test('12. parseSnapshotLabel accepts only exactly "before" or "after"', () => {
  assert.equal(parseSnapshotLabel('before'), 'before');
  assert.equal(parseSnapshotLabel('after'), 'after');
  assert.equal(parseSnapshotLabel('BEFORE'), null);
  assert.equal(parseSnapshotLabel('pre'), null);
  assert.equal(parseSnapshotLabel(undefined), null);
});

test('13. the REAL CLI parser requires both --date and --label (no defaults invented)', () => {
  const none = parseWriteBoundaryArgs([]);
  assert.equal(none.date, null);
  assert.equal(none.label, null);
  const dateOnly = parseWriteBoundaryArgs(['--date', DATE]);
  assert.equal(dateOnly.label, null);
});

test('14. the REAL CLI parser rejects an invalid date and an invalid label explicitly', () => {
  assert.match(parseWriteBoundaryArgs(['--date', 'yesterday']).error ?? '', /invalid --date/);
  assert.match(parseWriteBoundaryArgs(['--label', 'both']).error ?? '', /invalid --label/);
});

test('15. the REAL CLI parser REJECTS --commit — this command has no write mode', () => {
  const parsed = parseWriteBoundaryArgs(['--date', DATE, '--label', 'after', '--commit']);
  assert.match(parsed.error ?? '', /SELECT-only/);
});

test('16. the REAL CLI parser rejects unknown flags rather than silently ignoring them', () => {
  assert.match(parseWriteBoundaryArgs(['--date', DATE, '--label', 'after', '--force']).error ?? '', /unknown flag/);
});

test('17. --report and --json are accepted and are the only optional flags', () => {
  const parsed = parseWriteBoundaryArgs(['--date', DATE, '--label', 'before', '--report', '--json']);
  assert.equal(parsed.error, null);
  assert.equal(parsed.report, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.date, DATE);
  assert.equal(parsed.label, 'before');
});

test('18. report paths are deterministic and label-scoped so the pair never overwrites itself', () => {
  assert.equal(buildWriteBoundaryMarkdownPath(DATE, 'before'), `reports/nationwide-write-boundary-${DATE}-before.md`);
  assert.equal(buildWriteBoundaryMarkdownPath(DATE, 'after'), `reports/nationwide-write-boundary-${DATE}-after.md`);
  assert.equal(buildWriteBoundaryJsonPath(DATE, 'after'), `reports/nationwide-write-boundary-${DATE}-after.json`);
  assert.equal(buildComparisonMarkdownPath(DATE), `reports/nationwide-write-boundary-${DATE}-comparison.md`);
});

/* -------------------------------------------------------------------------- */
/* 19-28 Redaction and error classification                                   */
/* -------------------------------------------------------------------------- */

test('19. redactErrorDetail strips a JWT-shaped service key', () => {
  const detail = redactErrorDetail({ code: 'PGRST301', message: 'bad key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc' });
  assert.doesNotMatch(detail, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.match(detail, /\[redacted\]/);
});

test('20. redactErrorDetail strips a connection URL that could carry credentials', () => {
  const detail = redactErrorDetail({ message: 'connect failed https://user:pw@abc.supabase.co/rest/v1/races' });
  assert.doesNotMatch(detail, /supabase\.co/);
  assert.doesNotMatch(detail, /user:pw/);
});

test('21. redactErrorDetail strips authorization/bearer/apikey style fragments', () => {
  for (const raw of ['authorization: Bearer abc123', 'apikey=sekret-value', 'CRON_SECRET=hunter2']) {
    const detail = redactErrorDetail({ message: raw });
    assert.doesNotMatch(detail, /abc123|sekret-value|hunter2/);
  }
});

test('22. redactErrorDetail truncates long messages and keeps the code', () => {
  const detail = redactErrorDetail({ code: '42P01', message: 'x'.repeat(500) });
  assert.ok(detail.startsWith('42P01: '));
  assert.ok(detail.length < 200);
});

test('23. redactErrorDetail never throws on a null/undefined/empty error', () => {
  assert.equal(redactErrorDetail(null), 'unknown error');
  assert.equal(redactErrorDetail(undefined), 'unknown error');
  assert.equal(redactErrorDetail({}), 'unknown error');
});

test('24. ownerPrefix truncates an owner id to a non-identifying prefix', () => {
  const full = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const prefix = ownerPrefix(full);
  assert.equal(prefix, '3f2504e0');
  assert.ok((prefix ?? '').length <= 8);
  assert.notEqual(prefix, full);
  assert.equal(ownerPrefix(''), null);
  assert.equal(ownerPrefix(null), null);
});

test('25. a missing table classifies as table_missing, never as a zero count', () => {
  const out = classifyCategoryError({ code: '42P01', message: 'relation "x" does not exist' }, classifyTableProbe);
  assert.equal(out.status, 'table_missing');
});

test('26. a permission failure classifies as permission_denied, never as table_missing', () => {
  const byCode = classifyCategoryError({ code: '42501', message: 'permission denied for table x' }, classifyTableProbe);
  assert.equal(byCode.status, 'permission_denied');
  const byMessage = classifyCategoryError({ message: 'permission denied for table x' }, classifyTableProbe);
  assert.equal(byMessage.status, 'permission_denied');
});

test('27. any other error classifies as query_failed', () => {
  assert.equal(classifyCategoryError({ code: '57014', message: 'canceling statement' }, classifyTableProbe).status, 'query_failed');
});

test('28. classifyCategoryError never returns a count field at all', () => {
  const out = classifyCategoryError({ code: '42P01', message: 'does not exist' }, classifyTableProbe) as Record<string, unknown>;
  assert.equal('count' in out, false);
});

/* -------------------------------------------------------------------------- */
/* 29-44 Gathering over the fake SELECT-only seam                             */
/* -------------------------------------------------------------------------- */

test('29. a healthy gather counts every category and reports zero forbidden persistence', async () => {
  const evidence = evidenceFrom(await gatherHealthy());
  for (const id of FORBIDDEN_CATEGORY_IDS) {
    const c = evidence.categories.find((x) => x.id === id);
    assert.equal(c?.status, 'counted', `${id} was not counted`);
    assert.equal(c?.count, 0, `${id} should be zero in the fixture`);
  }
  assert.equal(evidence.verdict, 'OK');
});

test('30. allowed ingestion categories carry their real counts', async () => {
  const evidence = evidenceFrom(await gatherHealthy());
  assert.equal(evidence.categories.find((c) => c.id === 'stored_races')?.count, 2);
  assert.equal(evidence.categories.find((c) => c.id === 'stored_runners')?.count, 16);
  assert.equal(evidence.categories.find((c) => c.id === 'market_snapshots')?.count, 4);
  assert.equal(evidence.categories.find((c) => c.id === 'runner_quotes')?.count, 40);
  assert.equal(evidence.categories.find((c) => c.id === 'cron_telemetry')?.count, 7);
  assert.equal(evidence.stored_courses.count, 2);
});

test('31. settled races are derived from the fetched race rows, case-insensitively', async () => {
  const gathered = await gatherHealthy({
    races: [
      { id: 'r1', course: 'Curragh', status: 'RESULT' },
      { id: 'r2', course: 'Curragh', status: 'upcoming' },
    ],
  });
  assert.equal(gathered.categories.settled_races.count, 1);
  assert.equal(gathered.categories.stored_races.count, 2);
});

test('32. a failed races query makes EVERY race-scoped category unavailable — never zero', async () => {
  const gathered = await gatherWriteBoundarySnapshot(
    fakeSeam({ ...healthySeamOptions(), racesError: { code: '57014', message: 'canceling statement' } }),
    DATE,
    'before',
    classifyTableProbe,
  );
  const evidence = evidenceFrom(gathered);
  for (const id of ['stored_races', 'settled_races', 'model_runs', 'recommendations', 'model_runner_scores', 'runner_quotes']) {
    const c = evidence.categories.find((x) => x.id === id);
    assert.notEqual(c?.status, 'counted', `${id} must not be counted when races is unreadable`);
    assert.equal(c?.count, null, `${id} must not carry a fabricated count`);
  }
  assert.equal(evidence.verdict, 'FAIL');
});

test('33. a missing optional table is reported table_missing with a null count', async () => {
  const gathered = await gatherHealthy({
    countErrors: { ml_training_examples: { code: '42P01', message: 'relation "ml_training_examples" does not exist' } },
  });
  const evidence = evidenceFrom(gathered);
  const c = evidence.categories.find((x) => x.id === 'training_examples');
  assert.equal(c?.status, 'table_missing');
  assert.equal(c?.count, null);
});

test('34. a missing OPTIONAL forbidden table yields REVIEW, not OK and not FAIL', async () => {
  const evidence = evidenceFrom(
    await gatherHealthy({ countErrors: { genai_commentary: { code: '42P01', message: 'does not exist' } } }),
  );
  assert.equal(evidence.verdict, 'REVIEW');
});

test('35. a missing MANDATORY forbidden table yields FAIL — the snapshot cannot be evidence', async () => {
  const evidence = evidenceFrom(
    await gatherHealthy({ countErrors: { model_runs: { code: '42P01', message: 'does not exist' } } }),
  );
  assert.equal(evidence.verdict, 'FAIL');
});

test('36. a permission failure on a forbidden category is surfaced, not silently zeroed', async () => {
  const evidence = evidenceFrom(
    await gatherHealthy({ countErrors: { recommendations: { code: '42501', message: 'permission denied for table recommendations' } } }),
  );
  const c = evidence.categories.find((x) => x.id === 'recommendations');
  assert.equal(c?.status, 'permission_denied');
  assert.equal(c?.count, null);
  assert.equal(evidence.verdict, 'FAIL');
});

test('37. a two-hop parent failure marks the CHILD unavailable and says why', async () => {
  const evidence = evidenceFrom(
    await gatherHealthy({ idsErrors: { market_snapshots: { code: '57014', message: 'canceling statement' } } }),
  );
  const c = evidence.categories.find((x) => x.id === 'runner_quotes');
  assert.equal(c?.status, 'query_failed');
  assert.equal(c?.count, null);
  assert.match(c?.detail ?? '', /parent market_snapshots id list unavailable/);
});

test('38. zero parent rows legitimately gives a counted zero for the child, with an explanation', async () => {
  const gathered = await gatherHealthy({ idsByTable: { model_runs: [], market_snapshots: [] } });
  const c = gathered.categories.model_runner_scores;
  assert.equal(c.status, 'counted');
  assert.equal(c.count, 0);
  assert.match(c.detail ?? '', /no date-scoped parent rows/);
});

test('39. a date with no stored races gives counted zeros, never an error', async () => {
  const gathered = await gatherHealthy({ races: [], idsByTable: {} });
  assert.equal(gathered.categories.stored_races.count, 0);
  assert.equal(gathered.categories.model_runs.status, 'counted');
  assert.equal(gathered.categories.model_runs.count, 0);
  assert.equal(gathered.courses.count, 0);
});

test('40. runner finish positions are counted with an explicit NOT NULL filter on finish_pos', async () => {
  const seam = fakeSeam({ ...healthySeamOptions(), counts: { ...healthySeamOptions().counts, 'runners:finish_pos': 3 } });
  const gathered = await gatherWriteBoundarySnapshot(seam, DATE, 'after', classifyTableProbe);
  assert.equal(gathered.categories.runner_finish_positions.count, 3);
  assert.ok(seam.calls.some((c) => c.startsWith('countByIds(runners:finish_pos,race_id')));
});

test('41. cron telemetry is queried over the half-open UTC day of the date', async () => {
  const seam = fakeSeam(healthySeamOptions());
  await gatherWriteBoundarySnapshot(seam, DATE, 'before', classifyTableProbe);
  const bounds = utcDayBounds(DATE);
  assert.equal(bounds.fromIso, '2026-07-18T00:00:00.000Z');
  assert.equal(bounds.toIso, '2026-07-19T00:00:00.000Z');
  assert.ok(seam.calls.includes(`countByTimeRange(cron_runs,finished_at,${bounds.fromIso},${bounds.toIso})`));
});

test('42. the snapshot always warns that cron_runs is not race-scoped in this schema', async () => {
  const gathered = await gatherHealthy();
  assert.ok(gathered.warnings.some((w) => /cron_runs has no race_id/.test(w)));
});

test('43. the claim is read with STATUS ONLY — the seam exposes no acquire/heartbeat/release', async () => {
  const seam = fakeSeam(healthySeamOptions());
  await gatherWriteBoundarySnapshot(seam, DATE, 'before', classifyTableProbe);
  assert.ok(seam.calls.includes(`claimStatus(${DATE})`));
  const seamMethods = Object.keys(seam).filter((k) => k !== 'calls');
  assert.deepEqual(seamMethods.sort(), ['claimStatus', 'countByIds', 'countByTimeRange', 'fetchIdsByIds', 'fetchRaces']);
});

test('44. id lists are chunked so a large date cannot build an unbounded request', () => {
  const ids = Array.from({ length: ID_CHUNK_SIZE * 2 + 5 }, (_, i) => `id-${i}`);
  const chunks = chunkIds(ids);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, ID_CHUNK_SIZE);
  assert.equal(chunks[2].length, 5);
  assert.equal(chunks.flat().length, ids.length);
  assert.equal(chunkIds([]).length, 0);
});

/* -------------------------------------------------------------------------- */
/* 45-52 Evidence assembly and invariants                                     */
/* -------------------------------------------------------------------------- */

test('45. the evidence object records read-only provenance fields', async () => {
  const evidence = evidenceFrom(await gatherHealthy());
  assert.equal(evidence.read_only, true);
  assert.equal(evidence.database_mutated, false);
  assert.equal(evidence.external_provider_calls, 'none');
  assert.equal(evidence.claim_operation, 'status_only');
  assert.equal(evidence.scope, WRITE_BOUNDARY_SCOPE);
  assert.equal(evidence.schema_version, WRITE_BOUNDARY_SCHEMA_VERSION);
  assert.equal(evidence.statement, EVIDENCE_STATEMENT);
});

test('46. the evidence is deterministic for the same gathered input and timestamp', async () => {
  const gathered = await gatherHealthy();
  assert.equal(JSON.stringify(evidenceFrom(gathered)), JSON.stringify(evidenceFrom(gathered)));
});

test('47. unavailable_categories lists every non-counted category', async () => {
  const evidence = evidenceFrom(
    await gatherHealthy({ countErrors: { genai_commentary: { code: '42P01', message: 'does not exist' } } }),
  );
  assert.deepEqual(evidence.unavailable_categories, ['genai_artifacts']);
});

test('48. a category with a non-counted status carrying a count is an invariant violation', () => {
  const categories = categoriesFrom({ model_runs: { status: 'table_missing', count: 0 } });
  const violations = checkWriteBoundaryInvariants(categories, { status: 'counted', count: 1 });
  assert.ok(violations.some((v) => /must not carry a count/.test(v)));
});

test('49. settled races exceeding stored races is an invariant violation', () => {
  const violations = checkWriteBoundaryInvariants(
    categoriesFrom({ stored_races: { status: 'counted', count: 2 }, settled_races: { status: 'counted', count: 5 } }),
    { status: 'counted', count: 1 },
  );
  assert.ok(violations.some((v) => /settled_races \(5\) exceeds stored_races \(2\)/.test(v)));
});

test('50. finish positions exceeding stored runners is an invariant violation', () => {
  const violations = checkWriteBoundaryInvariants(
    categoriesFrom({
      stored_runners: { status: 'counted', count: 4 },
      runner_finish_positions: { status: 'counted', count: 9 },
    }),
    { status: 'counted', count: 1 },
  );
  assert.ok(violations.some((v) => /runner_finish_positions \(9\) exceeds stored_runners \(4\)/.test(v)));
});

test('51. scores or recommendations without any date-scoped model run is an invariant violation', () => {
  const violations = checkWriteBoundaryInvariants(
    categoriesFrom({
      model_runs: { status: 'counted', count: 0 },
      model_runner_scores: { status: 'counted', count: 12 },
      recommendations: { status: 'counted', count: 3 },
    }),
    { status: 'counted', count: 1 },
  );
  assert.ok(violations.some((v) => /model_runner_scores \(12\)/.test(v)));
  assert.ok(violations.some((v) => /recommendations \(3\)/.test(v)));
});

test('52. an invariant violation forces the snapshot verdict to FAIL', async () => {
  const gathered = await gatherHealthy({
    races: [{ id: 'r1', course: 'Curragh', status: 'upcoming' }],
    counts: { ...healthySeamOptions().counts, locked_race_decisions: 4 },
  });
  const evidence = evidenceFrom(gathered);
  assert.ok(evidence.invariant_violations.length > 0);
  assert.equal(evidence.verdict, 'FAIL');
});

/* -------------------------------------------------------------------------- */
/* 53-63 Comparison rules                                                     */
/* -------------------------------------------------------------------------- */

async function pair(
  beforeOver: FakeSeamOptions = {},
  afterOver: FakeSeamOptions = {},
): Promise<{ before: WriteBoundaryEvidence; after: WriteBoundaryEvidence }> {
  const b = await gatherWriteBoundarySnapshot(
    fakeSeam({ ...healthySeamOptions(), ...beforeOver }),
    DATE,
    'before',
    classifyTableProbe,
  );
  const a = await gatherWriteBoundarySnapshot(
    fakeSeam({ ...healthySeamOptions(), ...afterOver }),
    DATE,
    'after',
    classifyTableProbe,
  );
  return { before: evidenceFrom(b), after: evidenceFrom(a) };
}

test('53. an unchanged forbidden set with grown ingestion PASSES', async () => {
  const counts = healthySeamOptions().counts as Record<string, number>;
  const { before, after } = await pair({}, { counts: { ...counts, runners: 40, market_snapshots: 12 }, cronCount: 20 });
  const comparison = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'PASS');
  assert.equal(comparison.categories.find((c) => c.id === 'stored_runners')?.delta, 24);
});

test('54. ANY increase in a forbidden category FAILS the comparison', async () => {
  const counts = healthySeamOptions().counts as Record<string, number>;
  const { before, after } = await pair({}, { counts: { ...counts, model_runs: 1 } });
  const comparison = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'FAIL');
  const c = comparison.categories.find((x) => x.id === 'model_runs');
  assert.equal(c?.verdict, 'FAIL');
  assert.match(c?.explanation ?? '', /INCREASED by 1/);
});

test('55. a DECREASE in a forbidden category is surfaced as FAIL, never silently passed', async () => {
  const counts = { ...(healthySeamOptions().counts as Record<string, number>), locked_race_decisions: 2 };
  const { before, after } = await pair({ counts }, { counts: { ...counts, locked_race_decisions: 1 } });
  const comparison = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'FAIL');
  assert.match(comparison.categories.find((c) => c.id === 'locked_race_decisions')?.explanation ?? '', /DECREASED by 1/);
});

test('56. a non-comparable forbidden category yields REVIEW and can never produce a PASS', async () => {
  const { before, after } = await pair({}, { countErrors: { genai_commentary: { code: '42P01', message: 'does not exist' } } });
  const comparison = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'REVIEW');
  const c = comparison.categories.find((x) => x.id === 'genai_artifacts');
  assert.equal(c?.verdict, 'REVIEW');
  assert.equal(c?.delta, null);
  assert.match(c?.explanation ?? '', /NEVER treated as zero/);
});

test('57. a decrease in an ALLOWED ingestion category is REVIEW, not FAIL', async () => {
  const counts = healthySeamOptions().counts as Record<string, number>;
  const { before, after } = await pair({}, { counts: { ...counts, runners: 4 } });
  const comparison = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'REVIEW');
  assert.equal(comparison.categories.find((c) => c.id === 'stored_runners')?.verdict, 'REVIEW');
});

test('58. mismatched dates are a structural FAIL', async () => {
  const { before, after } = await pair();
  const comparison = compareWriteBoundaryEvidence(before, { ...after, date: '2026-07-19' }, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'FAIL');
  assert.ok(comparison.structural_failures.some((f) => /date mismatch/.test(f)));
});

test('59. swapped snapshot labels are a structural FAIL', async () => {
  const { before, after } = await pair();
  const comparison = compareWriteBoundaryEvidence(after, before, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'FAIL');
  assert.equal(comparison.structural_failures.length, 2);
});

test('60. a schema-version mismatch is a structural FAIL rather than a best-effort compare', async () => {
  const { before, after } = await pair();
  const comparison = compareWriteBoundaryEvidence(before, { ...after, schema_version: 99 }, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'FAIL');
  assert.ok(comparison.structural_failures.some((f) => /incompatible schema versions/.test(f)));
});

test('61. an invariant-violating snapshot cannot support a PASS', async () => {
  const { before, after } = await pair();
  const broken = { ...after, invariant_violations: ['settled_races (5) exceeds stored_races (2)'] };
  const comparison = compareWriteBoundaryEvidence(before, broken, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.verdict, 'FAIL');
});

test('62. the comparison records that it is read-only and mutated nothing', async () => {
  const { before, after } = await pair();
  const comparison = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  assert.equal(comparison.read_only, true);
  assert.equal(comparison.database_mutated, false);
  assert.match(comparison.statement, /no database query/);
});

test('63. comparison is deterministic and covers every registered category', async () => {
  const { before, after } = await pair();
  const first = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  const second = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.categories.length, WRITE_BOUNDARY_CATEGORIES.length);
});

/* -------------------------------------------------------------------------- */
/* 64-70 Rendering and evidence-file validation                               */
/* -------------------------------------------------------------------------- */

test('64. console output shows a non-counted category by status, never as 0', async () => {
  const evidence = evidenceFrom(
    await gatherHealthy({ countErrors: { ml_training_examples: { code: '42P01', message: 'does not exist' } } }),
  );
  const line = renderWriteBoundaryConsole(evidence).find((l) => l.includes('training capture'));
  assert.match(line ?? '', /TABLE_MISSING/);
  assert.doesNotMatch(line ?? '', /\s0\b/);
});

test('65. Markdown lists each category with its real table and relationship, plus the limitations', async () => {
  const markdown = renderWriteBoundaryMarkdown(evidenceFrom(await gatherHealthy()));
  for (const c of WRITE_BOUNDARY_CATEGORIES) assert.ok(markdown.includes(`\`${c.table}\``), `missing table ${c.table}`);
  assert.match(markdown, /## Limitations/);
  assert.match(markdown, /cron_runs` has no race relationship|`cron_runs` has no race relationship/);
  assert.match(markdown, /never treated as zero/);
});

test('66. rendered output never contains a full owner id, only a prefix', async () => {
  const full = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const evidence = evidenceFrom(
    await gatherHealthy({
      claim: { status: 'live', scope: 'all-uk-ire', generation: 2, owner_prefix: ownerPrefix(full) },
    }),
  );
  const rendered = `${renderWriteBoundaryConsole(evidence).join('\n')}\n${renderWriteBoundaryMarkdown(evidence)}`;
  assert.doesNotMatch(rendered, /3f2504e0-4f89/);
  assert.match(rendered, /3f2504e0/);
});

test('67. comparison renderers show forbidden deltas and the read-only statement', async () => {
  const counts = healthySeamOptions().counts as Record<string, number>;
  const { before, after } = await pair({}, { counts: { ...counts, model_runs: 2 } });
  const comparison = compareWriteBoundaryEvidence(before, after, '2026-07-18T10:00:00.000Z');
  const console_ = renderComparisonConsole(comparison).join('\n');
  const markdown = renderComparisonMarkdown(comparison);
  assert.match(console_, /Verdict: FAIL/);
  assert.match(console_, /INCREASED by 2/);
  assert.match(markdown, /## Verdict: FAIL/);
  assert.match(markdown, /read two local evidence files only/);
});

test('68. the compare CLI parser requires both paths and rejects --commit', () => {
  assert.equal(parseCompareArgs([]).before, null);
  assert.match(parseCompareArgs(['--before', 'a.json', '--after', 'b.json', '--commit']).error ?? '', /read-only/);
  const ok = parseCompareArgs(['--before', 'a.json', '--after', 'b.json', '--report']);
  assert.equal(ok.error, null);
  assert.equal(ok.report, true);
});

test('69. parseEvidenceFile rejects non-evidence JSON instead of comparing against zeros', () => {
  assert.throws(() => parseEvidenceFile('not json', 'x'), /not valid JSON/);
  assert.throws(() => parseEvidenceFile('{"date":"2026-07-18"}', 'x'), /valid "date" and "label"/);
  assert.throws(
    () => parseEvidenceFile(JSON.stringify({ date: DATE, label: 'before', categories: [] }), 'x'),
    /missing categories/,
  );
});

test('70. parseEvidenceFile accepts a genuine snapshot produced by this pack', async () => {
  const evidence = evidenceFrom(await gatherHealthy());
  const parsed = parseEvidenceFile(JSON.stringify(evidence), 'before');
  assert.equal(parsed.date, DATE);
  assert.equal(parsed.categories.length, WRITE_BOUNDARY_CATEGORIES.length);
  assert.equal(isCounted(parsed.categories[0]), true);
});

/* -------------------------------------------------------------------------- */
/* 71-79 Source-scan safety boundary                                          */
/* -------------------------------------------------------------------------- */

const LIB = () => readFileSync('src/lib/nationwideWriteBoundaryAudit.ts', 'utf8');
const CLI = () => readFileSync('scripts/nationwideWriteBoundaryAudit.ts', 'utf8');
const COMPARE = () => readFileSync('scripts/nationwideWriteBoundaryCompare.ts', 'utf8');

test('71. no file in the pack contains a database write call', () => {
  for (const src of [LIB(), CLI(), COMPARE()]) {
    assert.doesNotMatch(src, /\.insert\s*\(/);
    assert.doesNotMatch(src, /\.upsert\s*\(/);
    assert.doesNotMatch(src, /\.update\s*\(/);
    assert.doesNotMatch(src, /\.delete\s*\(/);
  }
});

test('72. the pack never imports a claim mutation, the model runner, or a provider client', () => {
  for (const src of [LIB(), CLI(), COMPARE()]) {
    assert.doesNotMatch(src, /tryAcquireProducerClaim\s*[(,]/);
    assert.doesNotMatch(src, /heartbeatProducerClaim\s*[(,]/);
    assert.doesNotMatch(src, /releaseProducerClaim\s*[(,]/);
    assert.doesNotMatch(src, /runModelForRace\s*[(,]/);
    assert.doesNotMatch(src, /scoreRaceRunners\s*[(,]/);
    assert.doesNotMatch(src, /from\s+'\.\.\/src\/lib\/(liveSync|raceSync|bettingEngine|nationwideDryRun)'/);
  }
});

test('73. the snapshot CLI uses ONLY the read-only claim status RPC', () => {
  const src = CLI();
  assert.match(src, /fetchProducerClaimStatus\(/);
  assert.doesNotMatch(src, /\.rpc\(\s*'(try_acquire|heartbeat|release)_producer_claim'/);
});

test('74. the snapshot CLI performs no HTTP request of any kind', () => {
  const src = CLI();
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /node:https?/);
  assert.doesNotMatch(src, /callCron\s*\(/);
});

test('75. the comparison CLI never opens a database client', () => {
  const src = COMPARE();
  assert.doesNotMatch(src, /supabaseAdmin/);
  assert.doesNotMatch(src, /createClient\s*\(/);
  assert.doesNotMatch(src, /\.rpc\s*\(/);
});

test('76. the library performs no I/O at all', () => {
  const src = LIB();
  assert.doesNotMatch(src, /require\s*\(|node:fs|node:child_process|writeFileSync|\bfetch\s*\(/);
});

test('77. neither CLI spawns a process or starts a pipeline/watcher/supervisor', () => {
  for (const src of [CLI(), COMPARE()]) {
    assert.doesNotMatch(src, /\bspawn\s*\(|\bexec\s*\(|execSync|node:child_process/);
    assert.doesNotMatch(src, /pipeline:day|pipeline:watch|lock:t-minus|results:auto/);
  }
});

test('78. the SELECT-only read seam declares only read methods', () => {
  const src = LIB();
  const seamBlock = src.slice(src.indexOf('export interface WriteBoundaryReadSeam'));
  const seamInterface = seamBlock.slice(0, seamBlock.indexOf('\n}\n') + 2);
  // Method DECLARATIONS only — a doc comment naming what the seam cannot do
  // must not be mistaken for a capability.
  const methods = [...seamInterface.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(methods.sort(), ['claimStatus', 'countByIds', 'countByTimeRange', 'fetchIdsByIds', 'fetchRaces']);
  for (const name of methods) {
    assert.doesNotMatch(name, /insert|update|upsert|delete|acquire|heartbeat|release|write|run/i);
  }
});

test('79. the pre-existing Step 1-5 modules are untouched by this pack', () => {
  for (const file of [
    'src/lib/producerClaim.ts',
    'src/lib/producerOwnership.ts',
    'src/lib/producerPreflight.ts',
    'src/lib/nationwideDryRun.ts',
    'src/lib/nationwideOwnership.ts',
    'src/lib/nationwidePreflight.ts',
  ]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /nationwideWriteBoundaryAudit/);
  }
  // …and the claim contract they rely on is still in place.
  assert.match(readFileSync('src/lib/producerClaim.ts', 'utf8'), /ALL_UK_IRE_SCOPE\s*=\s*'all-uk-ire'/);
});

test('80. the label type stays a closed two-value set (a third snapshot kind cannot appear)', () => {
  const labels: SnapshotLabel[] = ['before', 'after'];
  assert.deepEqual(labels, ['before', 'after']);
  assert.equal(parseSnapshotLabel('during'), null);
});
