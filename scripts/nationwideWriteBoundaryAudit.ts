/**
 * CLI (STRICTLY SELECT-ONLY): nationwide write-boundary evidence snapshot.
 *
 * Captures, for one meeting date, the exact row counts of every FORBIDDEN
 * persistence category (model runs, runner scores, recommendations, locked
 * decisions, settled races, finish positions, training captures, GenAI
 * artifacts) alongside the ALLOWED provider-ingestion categories (races,
 * runners, market snapshots, runner quotes, cron telemetry). Two snapshots —
 * `--label before` and `--label after` — bracket a future attended nationwide
 * live-provider dry-run so `audit:nationwide-write-boundary:compare` can prove
 * a ZERO delta across every forbidden category.
 *
 * Usage:
 *   npm run audit:nationwide-write-boundary -- --date YYYY-MM-DD --label before|after [--report] [--json]
 *
 * WHAT THIS COMMAND DOES: SELECT queries, plus ONE read-only
 * `producer_claim_status` RPC. That is all.
 *
 * WHAT IT NEVER DOES: it has NO --commit flag and no write path. It never
 * inserts, updates, upserts or deletes any row; never calls a racecard, odds,
 * results or any other provider route; never runs the model or persists a
 * model run, runner score or recommendation; never creates or mutates a locked
 * decision; never settles or imports a result; never acquires, renews,
 * releases or steals a producer claim; never starts a pipeline, watcher or
 * supervisor. The ONLY writes are the optional local report files under
 * `reports/`. Credentials load from .env.local / .env and are NEVER printed —
 * database errors are reduced to a short, redacted code+message.
 *
 * Decision-support only — not betting advice, and nothing here places a bet.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { classifyTableProbe } from '../src/lib/dbHealthSpec';
import { fetchProducerClaimStatus } from '../src/lib/producerClaim';
import {
  buildWriteBoundaryEvidence,
  buildWriteBoundaryJsonPath,
  buildWriteBoundaryMarkdownPath,
  gatherWriteBoundarySnapshot,
  isValidEvidenceDate,
  ownerPrefix,
  parseSnapshotLabel,
  redactErrorDetail,
  renderWriteBoundaryConsole,
  renderWriteBoundaryMarkdown,
  type ClaimEvidence,
  type CountFilters,
  type PgErrorLike,
  type RaceRowForBoundary,
  type SnapshotLabel,
  type WriteBoundaryReadSeam,
} from '../src/lib/nationwideWriteBoundaryAudit';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to shell env.
    }
  }
}

export interface WriteBoundaryArgs {
  date: string | null;
  label: SnapshotLabel | null;
  report: boolean;
  json: boolean;
  /** Set when an argument was present but invalid, so usage can be explicit. */
  error: string | null;
}

/** Pure argument parsing — no defaults are invented for date or label. */
export function parseWriteBoundaryArgs(argv: readonly string[]): WriteBoundaryArgs {
  const out: WriteBoundaryArgs = { date: null, label: null, report: false, json: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') {
      const value = argv[i + 1] ?? '';
      i += 1;
      if (!isValidEvidenceDate(value)) {
        out.error = `invalid --date "${value}" (expected YYYY-MM-DD)`;
        continue;
      }
      out.date = value;
    } else if (arg === '--label') {
      const value = argv[i + 1] ?? '';
      i += 1;
      const label = parseSnapshotLabel(value);
      if (!label) {
        out.error = `invalid --label "${value}" (expected exactly "before" or "after")`;
        continue;
      }
      out.label = label;
    } else if (arg === '--report') {
      out.report = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--commit') {
      out.error = 'this command is SELECT-only and has no --commit flag';
    } else if (arg.startsWith('--')) {
      out.error = `unknown flag ${arg}`;
    }
  }
  return out;
}

/**
 * The live SELECT-only seam. Every method issues a read; there is no write
 * method here, and the claim method calls the READ-ONLY status RPC only.
 */
export const supabaseReadSeam: WriteBoundaryReadSeam = {
  async fetchRaces(date: string): Promise<{ rows: RaceRowForBoundary[] | null; error: PgErrorLike | null }> {
    const { data, error } = await supabaseAdmin.from('races').select('id, course, status').eq('meeting_date', date);
    if (error) return { rows: null, error };
    const rows = ((data ?? []) as { id: string | number; course: string | null; status: string | null }[]).map((r) => ({
      id: String(r.id),
      course: r.course ?? null,
      status: r.status ?? null,
    }));
    return { rows, error: null };
  },

  async countByIds(
    table: string,
    column: string,
    ids: readonly string[],
    filters?: CountFilters,
  ): Promise<{ count: number | null; error: PgErrorLike | null }> {
    let query = supabaseAdmin.from(table).select('*', { count: 'exact', head: true }).in(column, ids as string[]);
    if (filters?.notNullColumn) {
      query = query.not(filters.notNullColumn, 'is', null);
    }
    const { count, error } = await query;
    if (error) return { count: null, error };
    return { count: typeof count === 'number' ? count : null, error: null };
  },

  async fetchIdsByIds(
    table: string,
    idColumn: string,
    column: string,
    ids: readonly string[],
  ): Promise<{ ids: string[] | null; error: PgErrorLike | null }> {
    const { data, error } = await supabaseAdmin.from(table).select(idColumn).in(column, ids as string[]);
    if (error) return { ids: null, error };
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    return { ids: rows.map((r) => String(r[idColumn])), error: null };
  },

  async countByTimeRange(
    table: string,
    column: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ count: number | null; error: PgErrorLike | null }> {
    const { count, error } = await supabaseAdmin
      .from(table)
      .select('*', { count: 'exact', head: true })
      .gte(column, fromIso)
      .lt(column, toIso);
    if (error) return { count: null, error };
    return { count: typeof count === 'number' ? count : null, error: null };
  },

  async claimStatus(date: string): Promise<ClaimEvidence> {
    const outcome = await fetchProducerClaimStatus(date);
    if (!outcome.ok) {
      return {
        status: 'unavailable',
        scope: null,
        generation: null,
        owner_prefix: null,
        detail: `${outcome.failure.kind}: ${redactErrorDetail({ message: outcome.failure.message })}`,
      };
    }
    if (!outcome.claim) {
      return { status: 'absent', scope: null, generation: null, owner_prefix: null };
    }
    const liveness = outcome.liveness.status;
    return {
      status: liveness === 'live' ? 'live' : liveness === 'expired' ? 'expired' : 'unknown',
      scope: outcome.claim.scope,
      generation: outcome.claim.generation,
      owner_prefix: ownerPrefix(outcome.claim.ownerId),
    };
  },
};

const USAGE =
  'Usage: npm run audit:nationwide-write-boundary -- --date YYYY-MM-DD --label before|after [--report] [--json]\n' +
  '(SELECT-only evidence snapshot plus one read-only claim status check. There is no --commit flag,\n' +
  'no provider call, no model run, and no claim acquire/heartbeat/release anywhere in this command.)';

async function main(): Promise<void> {
  loadEnv();

  const args = parseWriteBoundaryArgs(process.argv.slice(2));
  if (args.error || !args.date || !args.label) {
    console.error(args.error ? `Error: ${args.error}\n\n${USAGE}` : USAGE);
    process.exitCode = 1;
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const gathered = await gatherWriteBoundarySnapshot(supabaseReadSeam, args.date, args.label, classifyTableProbe);
  const evidence = buildWriteBoundaryEvidence(gathered, new Date().toISOString());

  if (args.json) {
    console.log(JSON.stringify(evidence, null, 2));
  } else {
    for (const line of renderWriteBoundaryConsole(evidence)) console.log(line);
  }

  if (args.report) {
    const markdownPath = buildWriteBoundaryMarkdownPath(args.date, args.label);
    const jsonPath = buildWriteBoundaryJsonPath(args.date, args.label);
    mkdirSync(dirname(markdownPath), { recursive: true });
    writeFileSync(markdownPath, renderWriteBoundaryMarkdown(evidence), 'utf8');
    writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    if (!args.json) {
      console.log(`\nEvidence written (database untouched): ${markdownPath}`);
      console.log(`Machine-readable evidence: ${jsonPath}`);
    }
  }

  if (evidence.verdict === 'FAIL') process.exitCode = 2;
  else if (evidence.verdict === 'REVIEW') process.exitCode = 3;
}

// Only run when this file is the invoked entrypoint, never merely when imported
// (the test file imports `parseWriteBoundaryArgs` and the seam shape).
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
}
