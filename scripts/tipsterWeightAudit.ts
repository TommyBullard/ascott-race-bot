/**
 * Dynamic tipster weighting audit (Phase 4D) — decision-support report.
 *
 * Prints every tracked tipster's EXPLAINABLE dynamic weight (seven-factor,
 * sample-size-shrunk) so an operator can see who SHOULD carry more intelligence
 * and WHY. Strictly read-only by default and strictly NON-BETTING: it never
 * changes model probability, EV, staking, ranking, or any recommendation.
 *
 * The reported `effective` weight is gated by a gradual ramp `--alpha` that
 * defaults to 0 (no influence) — raising it only PREVIEWS how a future, validated
 * integration would scale tipster influence; it changes nothing live.
 *
 *   --commit writes an as-of snapshot per tipster into `tipster_dynamic_weights`
 *   (the additive decision-support history). It writes NO model/staking table.
 *
 * Usage:
 *   npm run tipsters:weights
 *   npm run tipsters:weights -- --alpha 0.5            # preview a 50% ramp
 *   npm run tipsters:weights -- --as-of 2026-06-18 --commit   # persist snapshot
 *
 * REQUIRES SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env.local` (or `.env`).
 */

import {
  fetchDynamicTipsterWeights,
  persistDynamicWeightSnapshots,
  type DynamicWeightEntry,
} from '../src/lib/tipsterDynamicWeightApi';

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

interface Args {
  commit: boolean;
  help: boolean;
  alpha: number;
  asOf: string;
  limit?: number;
}

/** Today's date as YYYY-MM-DD (UTC). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false, help: false, alpha: 0, asOf: todayUtc() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--alpha') args.alpha = Math.min(Math.max(Number(argv[++i] ?? '0'), 0), 1);
    else if (a === '--as-of') args.asOf = (argv[++i] ?? '').trim() || todayUtc();
    else if (a === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

const DASH = '\u2014';

/** Formats a fraction as a signed percent, or a dash. */
function pct(value: number | null): string {
  return value === null ? DASH : `${(value * 100).toFixed(1)}%`;
}

/** Formats a 0..1 weight as a 2-dp number. */
function w2(value: number): string {
  return value.toFixed(2);
}

function printHelp(): void {
  console.log(
    [
      'Dynamic tipster weighting audit — explainable, decision-support only.',
      '',
      'Read-only by default. Prints each tipster\u2019s dynamic weight + why.',
      '',
      'Options:',
      '  --alpha <0..1>   Preview the gradual ramp (default 0 = no influence).',
      '  --as-of <date>   Snapshot date YYYY-MM-DD (default today UTC).',
      '  --commit         Persist an as-of snapshot per tipster (decision-support history).',
      '  --limit <n>      Only show the top n by dynamic weight.',
      '  --help           Show this help.',
    ].join('\n'),
  );
}

/** Prints the explainable table, strongest dynamic weight first. */
function printTable(entries: DynamicWeightEntry[], limit?: number): void {
  const shown = limit && limit > 0 ? entries.slice(0, limit) : entries;
  console.log(
    'weight  eff   relia  cover  N      ROI     recent  strike  tipster',
  );
  console.log(
    '------  ----  -----  -----  -----  ------  ------  ------  -----------------------',
  );
  for (const e of shown) {
    const a = e.assessment;
    const roi = a.factors.find((f) => f.factor === 'roi')?.rawValue ?? null;
    const recent = a.factors.find((f) => f.factor === 'recent_form')?.rawValue ?? null;
    const strike = a.factors.find((f) => f.factor === 'strike_rate')?.rawValue ?? null;
    console.log(
      `${w2(a.dynamic_weight).padStart(6)}  ${w2(a.effective_weight).padStart(4)}  ` +
        `${a.reliability.toFixed(2).padStart(5)}  ${a.coverage.toFixed(2).padStart(5)}  ` +
        `${String(a.bets_count ?? 0).padStart(5)}  ${pct(roi).padStart(6)}  ` +
        `${pct(recent).padStart(6)}  ${pct(strike).padStart(6)}  ${e.name}` +
        (e.isActive ? '' : '  (demoted)'),
    );
  }
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let entries: DynamicWeightEntry[];
  try {
    entries = await fetchDynamicTipsterWeights({ rampAlpha: args.alpha });
  } catch (err) {
    console.error(
      `Failed to compute dynamic weights: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error('Confirm SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY with `npm run check:env`.');
    process.exitCode = 1;
    return;
  }

  if (entries.length === 0) {
    console.log('No tracked tipsters (no tipster_priors rows yet).');
    return;
  }

  console.log(
    `\nDynamic tipster weights \u2014 ${entries.length} tipster(s), ramp \u03b1=${args.alpha}` +
      (args.alpha === 0 ? ' (neutral: no betting influence)' : ' (PREVIEW only)') +
      '.\n',
  );
  printTable(entries, args.limit);

  // Explain the strongest few so the report is self-justifying.
  const topN = Math.min(3, entries.length);
  console.log(`\nWhy the top ${topN}:`);
  for (const e of entries.slice(0, topN)) {
    console.log(`\n  ${e.name}  (weight ${w2(e.assessment.dynamic_weight)})`);
    for (const reason of e.assessment.reasons) console.log(`    - ${reason}`);
  }

  if (args.commit) {
    try {
      const written = await persistDynamicWeightSnapshots(entries, args.asOf);
      console.log(`\nWrote ${written} snapshot(s) to tipster_dynamic_weights for ${args.asOf}.`);
    } catch (err) {
      console.error(
        `\nFailed to persist snapshots: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error('Has the migration 20260618010000_tipster_dynamic_weights.sql been applied?');
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(
      '\nRead-only (decision-support). Re-run with --commit to persist an as-of snapshot.',
    );
    console.log(
      'These weights do NOT affect betting: effective influence is gated by ramp \u03b1 (default 0).',
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
