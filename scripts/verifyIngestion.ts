/**
 * Integration check: real Supabase DB + resolver + ingestion, end to end.
 *
 * Runs three mock raw tipster selections (a known alias, a canonical name, and
 * an unknown name) through `ingestTipsterSelections`, prints the resolution,
 * inserts the prepared rows into `tipster_selections`, then queries them back.
 *
 * Run with:        npm run verify:ingestion
 * Resolve only:    npm run verify:ingestion -- --dry-run   (skips the
 *                  tipster_selections insert + read-back; see note below)
 *
 * REQUIRES real credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) in
 * `.env` / `.env.local` or the shell environment. This uses the service-role
 * client, which BYPASSES RLS and WRITES to your database:
 *   - inserts rows into `tipster_selections`
 *   - the resolver enqueues unresolved/ambiguous names into
 *     `tipster_review_queue`
 * `--dry-run` only skips the `tipster_selections` insert and read-back; the
 * resolver still reads `tipster_aliases`/`tipsters` and may write the review
 * queue, because that is intrinsic to ingestion.
 */

import {
  ingestTipsterSelections,
  type RawTipsterSelection,
} from '../src/lib/raceData';
import { supabaseAdmin } from '../src/lib/supabaseAdmin';

const SELECTIONS_TABLE = 'tipster_selections';

/** Skip the destructive tipster_selections insert + read-back. */
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Tags this run's rows so the read-back is precise and cleanup is trivial.
 * NOTE: if `tipster_selections.race_id` is a UUID/FK column, replace this with
 * a real race id (and `runner_id` likewise) or the insert will be rejected.
 */
const TEST_RACE_ID = process.env.TEST_RACE_ID ?? `test-run-${Date.now()}`;

/**
 * The three mock selections. The "known alias" and "canonical name" cases only
 * resolve if these exact values exist in YOUR database — adjust them (or set
 * the env overrides) to match real `tipster_aliases.alias_name` /
 * `tipsters.canonical_name` rows.
 */
const RAW_SELECTIONS: RawTipsterSelection[] = [
  {
    race_id: TEST_RACE_ID,
    runner_id: 'test-runner-1',
    rawName: process.env.TEST_ALIAS_NAME ?? 'SamTips',
    rawAffiliation: process.env.TEST_ALIAS_AFFILIATION ?? 'RacingPost',
  },
  {
    race_id: TEST_RACE_ID,
    runner_id: 'test-runner-2',
    rawName: process.env.TEST_CANONICAL_NAME ?? 'Jane Doe',
  },
  {
    race_id: TEST_RACE_ID,
    runner_id: 'test-runner-3',
    rawName: process.env.TEST_UNKNOWN_NAME ?? 'Totally Unknown Person 9999',
  },
];

const pad = (s: unknown, w: number) => String(s).padEnd(w);
const rule = (n = 92) => console.log('-'.repeat(n));

/** Loads env from .env.local then .env (first found wins). Optional. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // File not present; try the next, then fall back to shell env.
    }
  }
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n' +
        'Set them in .env (see .env.example) before running this integration check.',
    );
    process.exit(1);
  }

  console.log('');
  console.log('=== Ingestion integration check ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no tipster_selections writes)' : 'LIVE (writes to DB)'}`);
  console.log(`Test race_id: ${TEST_RACE_ID}`);
  console.log('');

  // --- Step 2: run the raw selections through ingestion (resolver runs here).
  const ingested = await ingestTipsterSelections(RAW_SELECTIONS);

  // --- Step 3: log the resolution outcome for each selection.
  console.log('INGESTION RESULTS');
  rule();
  console.log(
    `${pad('raw_tipster_name', 32)}${pad('tipster_id', 18)}${pad('matchType', 16)}enqueuedForReview`,
  );
  rule();
  for (const item of ingested) {
    console.log(
      `${pad(item.row.raw_tipster_name, 32)}${pad(item.row.tipster_id ?? 'null', 18)}${pad(item.matchType, 16)}${item.enqueuedForReview}`,
    );
  }
  rule();
  console.log('');

  if (DRY_RUN) {
    console.log('Dry run: skipping tipster_selections insert and read-back.');
    return;
  }

  // --- Step 4: insert the prepared rows into tipster_selections.
  const rows = ingested.map((item) => item.row);
  const { error: insertError } = await supabaseAdmin
    .from(SELECTIONS_TABLE)
    .insert(rows);

  if (insertError) {
    throw new Error(`Insert into ${SELECTIONS_TABLE} failed: ${insertError.message}`);
  }
  console.log(`Inserted ${rows.length} row(s) into ${SELECTIONS_TABLE}.`);
  console.log('');

  // --- Step 5: query the rows back and print them.
  const { data, error: selectError } = await supabaseAdmin
    .from(SELECTIONS_TABLE)
    .select('race_id, runner_id, tipster_id, raw_tipster_name, raw_affiliation')
    .eq('race_id', TEST_RACE_ID)
    .order('runner_id', { ascending: true });

  if (selectError) {
    throw new Error(`Read-back from ${SELECTIONS_TABLE} failed: ${selectError.message}`);
  }

  console.log(`READ-BACK (${data?.length ?? 0} row(s) for race_id ${TEST_RACE_ID})`);
  rule();
  console.log(JSON.stringify(data, null, 2));
  rule();
  console.log('');
  console.log('Cleanup when done:');
  console.log(
    `  delete from ${SELECTIONS_TABLE} where race_id = '${TEST_RACE_ID}';`,
  );
}

main().catch((err) => {
  console.error('Integration check failed:', err);
  process.exit(1);
});
