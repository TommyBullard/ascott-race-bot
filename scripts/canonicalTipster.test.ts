/**
 * Unit tests for resolveCanonicalTipster.
 *
 * Supabase is mocked with an in-memory fake client — no real DB or network. The
 * fake returns canned rows per table, so these tests exercise the resolver's
 * decision logic (alias hit, canonical-name fallback, ambiguous, unresolved)
 * rather than any query-string formatting. The fake is injected via the
 * resolver's optional `client` parameter.
 *
 * Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveCanonicalTipster } from '../src/lib/raceData';

type Id = string | number;

interface FakeTableConfig {
  /** Rows returned by `select(...).ilike(...)` for this table. */
  rows?: { tipster_id: Id }[];
  /** When set, the select resolves with this error message instead of rows. */
  error?: string;
}

interface FakeClientConfig {
  /** Rows for the `alias_name`-only lookup. */
  aliases?: FakeTableConfig;
  /** Rows for the `alias_name` + `affiliation` (scoped) lookup. */
  aliasesScoped?: FakeTableConfig;
  tipsters?: FakeTableConfig;
  /** When set, the review-queue insert resolves with this error message. */
  reviewQueueError?: string;
}

interface QueryResult {
  data: { tipster_id: Id }[];
  error: { message: string } | null;
}

/**
 * Builds a minimal fake covering exactly the surface resolveCanonicalTipster
 * uses:
 *   from(table).select(cols).ilike(col, val)[.ilike(...)]  -> { data, error }
 *   from('tipster_review_queue').insert(values)            -> { error }
 *
 * For the alias table, the affiliation-scoped query (which adds an
 * `affiliation` filter) returns `aliasesScoped`, while the alias_name-only
 * fallback returns `aliases` — so tests can drive the two branches
 * independently. The canned rows are what drive the resolver. Returns the fake
 * client plus the rows inserted into the review queue, for side-effect
 * assertions.
 */
function makeFakeClient(config: FakeClientConfig) {
  const inserted: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table === 'tipster_review_queue') {
        return {
          insert(values: Record<string, unknown>) {
            inserted.push(values);
            return Promise.resolve({
              error: config.reviewQueueError
                ? { message: config.reviewQueueError }
                : null,
            });
          },
        };
      }

      // Capture the filtered columns so the alias table can distinguish the
      // affiliation-scoped query from the alias_name-only fallback.
      const ilikeCols: string[] = [];
      const builder = {
        select() {
          return builder;
        },
        ilike(col: string) {
          ilikeCols.push(col);
          return builder;
        },
        then(
          resolve: (value: QueryResult) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          let cfg: FakeTableConfig | undefined;
          if (table === 'tipster_aliases') {
            // The scoped query adds an `alias_affiliation` filter; the
            // name-only fallback does not.
            cfg = ilikeCols.includes('alias_affiliation')
              ? config.aliasesScoped
              : config.aliases;
          } else {
            cfg = config.tipsters;
          }
          const result: QueryResult = {
            data: cfg?.rows ?? [],
            error: cfg?.error ? { message: cfg.error } : null,
          };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient, inserted };
}

test('resolveCanonicalTipster: alias hit resolves to the canonical id', async () => {
  const { client } = makeFakeClient({
    aliases: { rows: [{ tipster_id: 'sharp_sam' }] },
  });

  const result = await resolveCanonicalTipster('SamTips', undefined, {}, client);

  assert.equal(result.tipster_id, 'sharp_sam');
  assert.equal(result.matchType, 'alias');
  assert.equal(result.rawName, 'SamTips'); // raw name preserved for audit
});

test('resolveCanonicalTipster: falls back to an exact canonical_name match', async () => {
  const { client } = makeFakeClient({
    aliases: { rows: [] }, // no alias hit
    tipsters: { rows: [{ tipster_id: 'jane_doe' }] },
  });

  const result = await resolveCanonicalTipster('Jane Doe', undefined, {}, client);

  assert.equal(result.tipster_id, 'jane_doe');
  assert.equal(result.matchType, 'canonical_name');
});

test('resolveCanonicalTipster: an ambiguous alias resolves to null', async () => {
  const { client, inserted } = makeFakeClient({
    // Two distinct canonical ids match the same raw alias.
    aliases: { rows: [{ tipster_id: 'id_1' }, { tipster_id: 'id_2' }] },
  });

  const result = await resolveCanonicalTipster(
    'Ambiguous Name',
    undefined,
    { enqueueForReview: true },
    client,
  );

  assert.equal(result.tipster_id, null);
  assert.equal(result.matchType, 'ambiguous');
  // Does not guess — the raw name is queued for review.
  assert.equal(result.enqueuedForReview, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].raw_name, 'Ambiguous Name');
});

test('resolveCanonicalTipster: no match resolves to null (unresolved)', async () => {
  const { client, inserted } = makeFakeClient({
    aliases: { rows: [] },
    tipsters: { rows: [] },
  });

  const result = await resolveCanonicalTipster(
    'Nobody Knows',
    undefined,
    { enqueueForReview: true },
    client,
  );

  assert.equal(result.tipster_id, null);
  assert.equal(result.matchType, 'unresolved');
  assert.equal(result.enqueuedForReview, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].raw_name, 'Nobody Knows');
});

test('resolveCanonicalTipster: affiliation-scoped alias match resolves first', async () => {
  const { client } = makeFakeClient({
    aliasesScoped: { rows: [{ tipster_id: 'scoped_sam' }] },
    // A different alias_name-only result that must NOT be used once the scoped
    // match already resolves.
    aliases: { rows: [{ tipster_id: 'other_sam' }] },
  });

  const result = await resolveCanonicalTipster('Sam', 'RacingPost', {}, client);

  assert.equal(result.tipster_id, 'scoped_sam');
  assert.equal(result.matchType, 'alias');
});

test('resolveCanonicalTipster: falls back to alias_name-only when affiliation has no match', async () => {
  const { client } = makeFakeClient({
    aliasesScoped: { rows: [] }, // no affiliation-scoped match
    aliases: { rows: [{ tipster_id: 'sam' }] }, // single name-only match
  });

  const result = await resolveCanonicalTipster(
    'Sam',
    'UnknownAffiliation',
    {},
    client,
  );

  assert.equal(result.tipster_id, 'sam');
  assert.equal(result.matchType, 'alias');
});

test('resolveCanonicalTipster: alias_name-only fallback with multiple ids is ambiguous', async () => {
  const { client, inserted } = makeFakeClient({
    aliasesScoped: { rows: [] },
    aliases: { rows: [{ tipster_id: 'id_1' }, { tipster_id: 'id_2' }] },
  });

  const result = await resolveCanonicalTipster(
    'Sam',
    'UnknownAffiliation',
    { enqueueForReview: true },
    client,
  );

  assert.equal(result.tipster_id, null);
  assert.equal(result.matchType, 'ambiguous');
  assert.equal(result.enqueuedForReview, true);
  assert.equal(inserted.length, 1);
});

test('resolveCanonicalTipster: ambiguous affiliation-scoped match does not fall back', async () => {
  const { client } = makeFakeClient({
    aliasesScoped: { rows: [{ tipster_id: 'id_1' }, { tipster_id: 'id_2' }] },
    // If the function unsafely fell back, this single id would resolve — it
    // must not.
    aliases: { rows: [{ tipster_id: 'tempting_single' }] },
  });

  const result = await resolveCanonicalTipster('Sam', 'RacingPost', {}, client);

  assert.equal(result.tipster_id, null);
  assert.equal(result.matchType, 'ambiguous');
});
