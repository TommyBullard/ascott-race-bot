/**
 * Seed the tipster pool from HAND-ENTERED, proofed leaderboard figures.
 *
 * Edit the `MANUAL_SEED` array below with REAL numbers you read off public
 * proofing leaderboards (Tipping League, The Tipster League, Betting Gods,
 * Puntrr, ...), then run this script. It feeds the rows through
 * `discoverTipsters()` — the same path the (future) scrapers will use — to
 * score (needle_score / final_weight), dedupe across sources via
 * `resolveCanonicalTipster`, persist into `tipster_priors`, and auto
 * promote/demote in the active pool.
 *
 * INTEGRITY: only ever enter numbers you actually read from a real, proofed
 * source. This script does not invent or estimate anything — it just scores and
 * stores what you type. Leave a field out only if the source genuinely does not
 * publish it.
 *
 * SAFE BY DEFAULT — DRY RUN: running with no flags computes and prints the
 * scored preview but writes NOTHING. Pass `--commit` to actually persist. As a
 * guard, `--commit` is REFUSED while any EXAMPLE placeholder rows remain, so you
 * cannot accidentally seed the illustrative data.
 *
 * Usage:
 *   npm run seed:tipsters                      # dry run (preview only)
 *   npm run seed:tipsters -- --commit          # persist (after editing rows)
 *   npm run seed:tipsters -- --commit --as-of 2026-06-12
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local`.
 */

import {
  discoverTipsters,
  type TipsterWindowedStats,
} from '../src/lib/discoverTipsters';

/**
 * One hand-entered proofed row. The first six fields are the core the task
 * asked for; the rest are OPTIONAL and only worth filling if the leaderboard
 * publishes them.
 *
 * ROI values are FRACTIONS: 0.12 = +12%, -0.05 = -5%. Settle at Betfair SP
 * where the source provides it.
 */
interface SeedRow {
  /** Tipster's name exactly as shown on the source (used for canonical dedup). */
  name: string;
  /** Source/platform label, e.g. 'Tipping League'. */
  source: string;
  /** All-time / 365d ROI (long-run signal). */
  longRunRoi: number;
  /** Last-30-days ROI (recent-momentum signal). */
  recentRoi30d: number;
  /** Longest run of consecutive losers (>= 0). Shorter scores better. */
  streak: number;
  /** Number of settled bets backing the figures (sample size N). */
  betsCount: number;

  // ---- optional (fill only if the source publishes them) -------------------
  /** Affiliation/handle, helps `resolveCanonicalTipster` disambiguate. */
  affiliation?: string;
  /** Link to the proofed profile (stored for audit). */
  profileUrl?: string;
  /** 90-day ROI, if shown. */
  recentRoi90d?: number;
  /** 7-day / today ROI. When present it REPLACES streak as the 3rd signal. */
  recentRoi7d?: number;
  /**
   * Strike rate (win fraction) in [0, 1], if shown. Does NOT affect the needle
   * score or promotion — it is only stored for display and to derive
   * wins_count. Left undefined => stored as 0 ("not provided").
   */
  strikeRate?: number;
  /** Wins backing the figures, if published. */
  winsCount?: number;
}

/** Marks the illustrative rows so `--commit` can refuse to seed them. */
const EXAMPLE_PREFIX = 'EXAMPLE \u2014 ';

/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MANUAL_SEED — EDIT THIS.                                              ║
 * ║  Replace the EXAMPLE rows with REAL proofed numbers you read from      ║
 * ║  public leaderboards, and delete the `EXAMPLE — ` prefix from each     ║
 * ║  name. `--commit` stays blocked until no EXAMPLE rows remain.          ║
 * ║  The numbers below are ILLUSTRATIVE ONLY — not real proofed data.      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
const MANUAL_SEED: SeedRow[] = [
  {
    name: `${EXAMPLE_PREFIX}Sharp Sam`,
    source: 'Tipping League',
    longRunRoi: 0.14, // +14% all-time   (ILLUSTRATIVE)
    recentRoi30d: 0.21, // +21% last 30d  (ILLUSTRATIVE)
    streak: 4,
    betsCount: 850,
    strikeRate: 0.29,
  },
  {
    name: `${EXAMPLE_PREFIX}Steady Eddie`,
    source: 'Betting Gods',
    longRunRoi: 0.06,
    recentRoi30d: 0.03,
    streak: 7,
    betsCount: 1200,
    strikeRate: 0.22,
  },
  {
    name: `${EXAMPLE_PREFIX}Cold Streak Carl`,
    source: 'Puntrr',
    longRunRoi: 0.02,
    recentRoi30d: -0.11, // decaying -> should auto-demote (ILLUSTRATIVE)
    streak: 15,
    betsCount: 600,
    strikeRate: 0.18,
  },
];

/** Maps a hand-entered seed row to the module's proofed-stats shape. */
function toWindowedStats(row: SeedRow): TipsterWindowedStats {
  return {
    name: row.name,
    source: row.source,
    affiliation: row.affiliation,
    profileUrl: row.profileUrl,
    longRunRoi: row.longRunRoi,
    recentRoi90d: row.recentRoi90d,
    recentRoi30d: row.recentRoi30d,
    recentRoi7d: row.recentRoi7d,
    // Not provided => 0 (stored only; does not affect needle/promotion).
    strikeRate: row.strikeRate ?? 0,
    longestLosingStreak: row.streak,
    betsCount: row.betsCount,
    winsCount: row.winsCount,
  };
}

/** Loads env from .env.local then .env (first found wins). */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Try the next; fall back to the shell environment.
    }
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (s: unknown, w: number) => String(s).padEnd(w);
const padL = (s: unknown, w: number) => String(s).padStart(w);
const rule = (n = 78) => console.log('-'.repeat(n));
const roi = (n: number) => `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;

function parseArgs(argv: string[]): { commit: boolean; asOf?: string } {
  const commit = argv.includes('--commit');
  let asOf: string | undefined;
  const idx = argv.indexOf('--as-of');
  if (idx !== -1) {
    asOf = argv[idx + 1];
    if (!asOf || !DATE_RE.test(asOf)) {
      console.error('Invalid --as-of (expected YYYY-MM-DD).');
      process.exit(1);
    }
  }
  return { commit, asOf };
}

async function main(): Promise<void> {
  const { commit, asOf } = parseArgs(process.argv.slice(2));
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local.',
    );
    process.exit(1);
  }

  if (MANUAL_SEED.length === 0) {
    console.error('MANUAL_SEED is empty — add some proofed rows first.');
    process.exit(1);
  }

  const exampleRows = MANUAL_SEED.filter((r) => r.name.startsWith(EXAMPLE_PREFIX));

  // Guard: never persist the illustrative placeholder rows.
  if (commit && exampleRows.length > 0) {
    console.error('');
    console.error(
      `Refusing to --commit: ${exampleRows.length} EXAMPLE placeholder row(s) ` +
        'still present.',
    );
    console.error(
      'Edit MANUAL_SEED in scripts/seedInFormTipsters.ts with real proofed ' +
        `numbers and remove the "${EXAMPLE_PREFIX.trim()}" prefix, then re-run.`,
    );
    process.exit(1);
  }

  const dryRun = !commit;

  console.log('');
  console.log('=== Seed in-form tipsters ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'COMMIT (writing to DB)'}`);
  if (exampleRows.length > 0) {
    console.log(
      `NOTE: ${exampleRows.length}/${MANUAL_SEED.length} row(s) are EXAMPLE ` +
        'placeholders (illustrative only).',
    );
  }
  console.log(`Rows: ${MANUAL_SEED.length}`);
  console.log('');

  const stats = MANUAL_SEED.map(toWindowedStats);
  const result = await discoverTipsters(stats, { dryRun, asOfDate: asOf });

  console.log(
    `received=${result.received}  deduped=${result.deduped}  ` +
      `written=${result.written}  promoted=${result.promoted}  ` +
      `demoted=${result.demoted}  (as_of ${result.asOfDate})`,
  );
  console.log('');

  console.log('SCORED (strongest needle first)');
  rule();
  console.log(
    `${pad('tipster', 26)}${pad('source', 18)}${padL('needle', 9)}` +
      `${padL('weight', 9)}${padL('action', 11)}`,
  );
  rule();
  for (const r of result.rows) {
    console.log(
      `${pad(r.name.slice(0, 25), 26)}${pad(r.source.slice(0, 17), 18)}` +
        `${padL(r.needleScore.toFixed(3), 9)}${padL(r.finalWeight.toFixed(3), 9)}` +
        `${padL(r.active ? r.action + ' \u2713' : r.action, 11)}`,
    );
  }
  rule();
  console.log('');

  if (dryRun) {
    console.log(
      'Dry run complete — nothing written. Re-run with --commit to persist ' +
        '(after replacing any EXAMPLE rows).',
    );
  } else {
    console.log(
      `Committed: ${result.written} tipster_priors row(s); ` +
        `${result.promoted} promoted, ${result.demoted} demoted.`,
    );
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
