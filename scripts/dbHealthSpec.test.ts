/**
 * Unit tests for the pure DB-health spec + classifiers (src/lib/dbHealthSpec.ts).
 *
 * No DB, no network: synthetic PostgREST-style errors and TableHealth rows
 * exercise the present/missing/indeterminate classification, the PASS/FAIL
 * summary, and the SQL builders. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTableProbe,
  classifyColumnProbe,
  summarizeHealth,
  buildSuggestedSql,
  buildManualVerificationSql,
  REQUIRED_TABLES,
  REQUIRED_INDEXES,
  type TableHealth,
} from '../src/lib/dbHealthSpec';

test('classifyTableProbe: null error = present', () => {
  assert.equal(classifyTableProbe(null), 'present');
  assert.equal(classifyTableProbe(undefined), 'present');
});

test('classifyTableProbe: known missing codes/messages = missing', () => {
  assert.equal(classifyTableProbe({ code: '42P01' }), 'missing');
  assert.equal(classifyTableProbe({ code: 'PGRST205' }), 'missing');
  assert.equal(
    classifyTableProbe({ message: 'Could not find the table \'public.races\' in the schema cache' }),
    'missing',
  );
  assert.equal(classifyTableProbe({ message: 'relation "public.x" does not exist' }), 'missing');
});

test('classifyTableProbe: other errors = indeterminate (no false FAIL)', () => {
  assert.equal(classifyTableProbe({ code: '42501', message: 'permission denied' }), 'indeterminate');
  assert.equal(classifyTableProbe({ message: 'network timeout' }), 'indeterminate');
});

test('classifyColumnProbe: present / missing / indeterminate', () => {
  assert.equal(classifyColumnProbe(null), 'present');
  assert.equal(classifyColumnProbe({ code: '42703' }), 'missing');
  assert.equal(classifyColumnProbe({ code: 'PGRST204' }), 'missing');
  assert.equal(
    classifyColumnProbe({ message: 'column "source_label" does not exist' }),
    'missing',
  );
  assert.equal(classifyColumnProbe({ message: 'some unrelated error' }), 'indeterminate');
});

function health(partial: Partial<TableHealth> & { table: string }): TableHealth {
  return {
    status: 'present',
    rowCount: 0,
    missingColumns: [],
    indeterminateColumns: [],
    ...partial,
  };
}

test('summarizeHealth: all present -> PASS', () => {
  const summary = summarizeHealth([
    health({ table: 'races', rowCount: 5 }),
    health({ table: 'runners', rowCount: 40 }),
  ]);
  assert.equal(summary.pass, true);
  assert.deepEqual(summary.missingTables, []);
  assert.deepEqual(summary.missingColumns, []);
  assert.equal(summary.presentTables, 2);
});

test('summarizeHealth: a missing table or column -> FAIL', () => {
  const summary = summarizeHealth([
    health({ table: 'races', status: 'missing', rowCount: null }),
    health({ table: 'runners', missingColumns: ['weight_lbs'] }),
  ]);
  assert.equal(summary.pass, false);
  assert.deepEqual(summary.missingTables, ['races']);
  assert.deepEqual(summary.missingColumns, [{ table: 'runners', column: 'weight_lbs' }]);
});

test('summarizeHealth: indeterminate does NOT fail the run', () => {
  const summary = summarizeHealth([
    health({ table: 'races', status: 'indeterminate', rowCount: null }),
    health({ table: 'runners' }),
  ]);
  assert.equal(summary.pass, true);
  assert.deepEqual(summary.indeterminateTables, ['races']);
});

test('buildSuggestedSql: additive column adds + table note; empty when clean', () => {
  assert.deepEqual(buildSuggestedSql(summarizeHealth([health({ table: 'races' })])), []);

  const lines = buildSuggestedSql(
    summarizeHealth([
      health({ table: 'model_runs', status: 'missing', rowCount: null }),
      health({ table: 'tipster_selections', missingColumns: ['source_label'] }),
    ]),
  );
  const joined = lines.join('\n');
  assert.ok(joined.includes('model_runs'));
  assert.ok(
    joined.includes(
      'alter table public.tipster_selections add column if not exists source_label',
    ),
  );
  // Suggestions are additive only — never a drop/delete.
  assert.equal(/drop |delete /i.test(joined), false);
});

test('buildManualVerificationSql: read-only, references dedupe idx + pg_indexes + RLS', () => {
  const sql = buildManualVerificationSql().join('\n');
  assert.ok(sql.includes('pg_indexes'));
  assert.ok(sql.includes('tipster_selections_dedupe_idx'));
  assert.ok(sql.includes('relrowsecurity'));
  // Strictly read-only.
  assert.equal(/insert |update |delete |drop |alter /i.test(sql), false);
});

test('spec sanity: required tables + history columns + dedupe index are declared', () => {
  const names = REQUIRED_TABLES.map((t) => t.name);
  for (const t of [
    'races', 'runners', 'market_snapshots', 'runner_quotes', 'model_runs',
    'model_runner_scores', 'recommendations', 'bankroll_ledger', 'tipsters',
    'tipster_aliases', 'tipster_priors', 'tipster_review_queue', 'tipster_selections',
    'tipster_source_registry', 'tipster_selection_candidates',
  ]) {
    assert.ok(names.includes(t), `missing required table in spec: ${t}`);
  }
  // History columns present in the model tables' specs.
  for (const t of ['model_runs', 'model_runner_scores', 'recommendations']) {
    const spec = REQUIRED_TABLES.find((s) => s.name === t);
    assert.ok(spec?.columns.includes('is_current'));
    assert.ok(spec?.columns.includes('superseded_at'));
  }
  // source_label required on tipster_selections.
  assert.ok(
    REQUIRED_TABLES.find((s) => s.name === 'tipster_selections')?.columns.includes('source_label'),
  );
  // Dedupe index declared.
  assert.ok(REQUIRED_INDEXES.some((i) => i.name === 'tipster_selections_dedupe_idx'));
});
