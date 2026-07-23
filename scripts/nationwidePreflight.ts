/**
 * CLI: Nationwide Readiness Preflight — Nationwide rebuild Phase 7A.2b Step 5.
 *
 * A SEPARATE command from `producer:preflight` (which remains selected-
 * course-only and untouched by this file — it still rejects `all-uk-ire`).
 * Determines whether it is safe to begin a NATIONWIDE dry-run for one date,
 * WITHOUT starting anything. One verdict — READY / REVIEW / BLOCKED — over
 * twelve checks (see src/lib/nationwidePreflight.ts).
 *
 * Usage (--target-mode is REQUIRED — there is no default):
 *   npm run nationwide:preflight -- --date 2026-07-18 --target-mode stored-only
 *   npm run nationwide:preflight -- --date 2026-07-18 --target-mode live-provider
 *   npm run nationwide:preflight -- --date 2026-07-18 --target-mode live-provider --json
 *   npm run nationwide:preflight -- --date 2026-07-18 --target-mode live-provider --report
 *   npm run nationwide:preflight -- --date 2026-07-18 --target-mode live-provider --skip-server
 *   npm run nationwide:preflight -- --date 2026-07-18 --target-mode live-provider --require-server
 *   npm run nationwide:preflight -- --date 2026-07-18 --target-mode live-provider --confirm-external
 *
 * `--target-mode` controls how an EMPTY stored workload is judged: for
 * `stored-only` (which scores only already-stored data) zero races BLOCKS;
 * for `live-provider` (which is expected to ingest racecards/odds) zero
 * races is the normal starting state and does not block by itself. Missing
 * or invalid `--target-mode`, or any unrecognised flag, exits 1 before any
 * status RPC, workload query, health probe, claim, or filesystem write.
 *
 * The operator MUST obtain a genuine READY here before running
 * `nationwide:dry-run -- --mode live-provider` (see
 * docs/NATIONWIDE_DRY_RUN_PROCEDURE.md). This command never manufactures
 * `--confirm-external` on the caller's behalf, and `nationwide:dry-run` never
 * accepts that flag itself or checks this preflight's result automatically.
 *
 * READ-ONLY: the read-only `producer_claim_status` RPC (never claim/
 * heartbeat/release), SELECT-only workload reads, one optional bounded GET
 * to the FIXED read-only health path, and a read-only directory listing of
 * `logs/` for local `supervisor.lock` signals. No writes except one optional
 * local Markdown report with `--report`. No `--commit` flag exists.
 *
 * Exit codes: 0 READY, 3 REVIEW, 2 BLOCKED, 1 usage. Decision-support only.
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEnvValuePresent } from '../src/lib/envPreflight';
import { fetchProducerClaimStatus } from '../src/lib/producerClaim';
import { fetchNationwideWorkloadRows, parseNationwideCliMode, type NationwideWorkloadClient } from '../src/lib/nationwideDryRun';
import {
  buildNationwidePreflightJson,
  buildNationwidePreflightPath,
  evaluateNationwidePreflight,
  probeHealthEndpoint,
  renderNationwidePreflightConsole,
  renderNationwidePreflightMarkdown,
  summarizeClaimStatus,
  validateBaseUrl,
  type HealthProbeOutcome,
  type NationwidePreflightInput,
} from '../src/lib/nationwidePreflight';

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

export interface Args {
  date: string | null;
  /** Raw --target-mode value, unvalidated (validated by the caller via parseNationwideCliMode). */
  targetMode: string | null;
  baseUrl: string;
  skipServer: boolean;
  requireServer: boolean;
  confirmExternal: boolean;
  report: boolean;
  json: boolean;
}

/**
 * Parses argv. Unrecognised `--flag`-shaped tokens are collected, never
 * silently ignored. Exported so tests exercise the REAL parser directly
 * rather than only a pure-helper approximation of it.
 */
export function parseArgs(argv: readonly string[]): { args: Args; unknownFlags: string[] } {
  const args: Args = {
    date: null,
    targetMode: null,
    baseUrl: 'http://localhost:3000',
    skipServer: false,
    requireServer: false,
    confirmExternal: false,
    report: false,
    json: false,
  };
  const unknownFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case '--date':
        args.date = (next() ?? '').trim();
        break;
      case '--target-mode':
        args.targetMode = (next() ?? '').trim();
        break;
      case '--base-url': {
        const value = (next() ?? '').trim();
        if (value !== '') args.baseUrl = value;
        break;
      }
      case '--skip-server':
        args.skipServer = true;
        break;
      case '--require-server':
        args.requireServer = true;
        break;
      case '--confirm-external':
        args.confirmExternal = true;
        break;
      case '--report':
        args.report = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        if (flag.startsWith('--')) unknownFlags.push(flag);
        break;
    }
  }
  return { args, unknownFlags };
}

function usageError(json: boolean, message: string): void {
  if (json) {
    console.log(JSON.stringify({ read_only: true, ok: false, error: { kind: 'usage', message } }));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}

/** Read-only scan: race-day-<date>-* directories under logs/ containing a supervisor.lock subdirectory. Never mutates. */
function scanLocalSupervisorLocks(date: string): string[] {
  const logsDir = 'logs';
  if (!existsSync(logsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return [];
  }
  const prefix = `race-day-${date}-`;
  return entries.filter((name) => name.startsWith(prefix) && existsSync(join(logsDir, name, 'supervisor.lock')));
}

function createWorkloadClient(): NationwideWorkloadClient {
  return {
    async selectRaces(date) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin.from('races').select('id, course, country').eq('meeting_date', date);
      return { data, error };
    },
    async selectRunners(raceIds) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin.from('runners').select('id, race_id').in('race_id', raceIds);
      return { data, error };
    },
    async selectLatestSnapshots(raceIds) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin
        .from('market_snapshots')
        .select('id, race_id')
        .in('race_id', raceIds)
        .order('snapshot_time', { ascending: false });
      return { data, error };
    },
    async selectQuotes(snapshotIds) {
      const { supabaseAdmin } = await import('../src/lib/supabaseAdmin');
      const { data, error } = await supabaseAdmin.from('runner_quotes').select('snapshot_id, runner_id').in('snapshot_id', snapshotIds);
      return { data, error };
    },
  };
}

async function main(): Promise<void> {
  const { args, unknownFlags } = parseArgs(process.argv.slice(2));

  if (unknownFlags.length > 0) {
    usageError(args.json, `Unknown flag(s): ${unknownFlags.join(', ')}. See usage: npm run nationwide:preflight -- --date YYYY-MM-DD --target-mode stored-only|live-provider [...]`);
    return; // NO status RPC, NO workload query, NO health probe, NO claim, NO write.
  }
  if (args.skipServer && args.requireServer) {
    usageError(args.json, '--skip-server and --require-server are mutually exclusive.');
    return;
  }
  const targetMode = parseNationwideCliMode(args.targetMode);
  if (!targetMode) {
    usageError(
      args.json,
      'Usage: npm run nationwide:preflight -- --date YYYY-MM-DD --target-mode stored-only|live-provider [--base-url URL] [--skip-server|--require-server] [--confirm-external] [--report] [--json]\n' +
        '--target-mode is REQUIRED — there is no default. Only stored-only or live-provider are valid.',
    );
    return; // NO status RPC, NO workload query, NO health probe, NO claim, NO write.
  }
  if (!args.date) {
    usageError(
      args.json,
      'Usage: npm run nationwide:preflight -- --date YYYY-MM-DD --target-mode stored-only|live-provider [--base-url URL] [--skip-server|--require-server] [--confirm-external] [--report] [--json]',
    );
    return;
  }

  loadEnv();

  const env = {
    supabaseUrl: isEnvValuePresent(process.env.SUPABASE_URL),
    serviceRoleKey: isEnvValuePresent(process.env.SUPABASE_SERVICE_ROLE_KEY),
    cronSecret: isEnvValuePresent(process.env.CRON_SECRET),
    projectHost: ((): string | null => {
      try {
        return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null;
      } catch {
        return null;
      }
    })(),
  };
  const baseUrl = { raw: args.baseUrl, ...validateBaseUrl(args.baseUrl) };

  let claim: NationwidePreflightInput['claim'] = null;
  let workloadRows: NationwidePreflightInput['workloadRows'] = null;
  let workloadError: string | null = null;
  if (env.supabaseUrl && env.serviceRoleKey) {
    claim = summarizeClaimStatus(await fetchProducerClaimStatus(args.date));
    const gathered = await fetchNationwideWorkloadRows(createWorkloadClient(), args.date);
    workloadRows = gathered.rows;
    workloadError = gathered.error;
  }

  let server: NationwidePreflightInput['server'] = { mode: 'skipped', outcome: null };
  if (!args.skipServer && baseUrl.valid && baseUrl.origin) {
    const outcome: HealthProbeOutcome = await probeHealthEndpoint(baseUrl.origin, args.date, process.env.CRON_SECRET ?? null);
    server = { mode: 'probed', outcome };
  }

  const localLockSlugsForDate = scanLocalSupervisorLocks(args.date);

  const report = evaluateNationwidePreflight({
    date: args.date,
    targetMode,
    requireServer: args.requireServer,
    confirmExternal: args.confirmExternal,
    env,
    baseUrl,
    claim,
    workloadRows,
    workloadError,
    server,
    localLockSlugsForDate,
  });

  if (args.json) {
    console.log(JSON.stringify(buildNationwidePreflightJson(report)));
  } else {
    for (const line of renderNationwidePreflightConsole(report)) console.log(line);
  }

  if (args.report) {
    const path = buildNationwidePreflightPath(args.date);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderNationwidePreflightMarkdown(report, new Date().toISOString()), 'utf8');
    if (!args.json) console.log(`\nReport written: ${path}`);
  }

  process.exitCode = report.verdict === 'READY' ? 0 : report.verdict === 'REVIEW' ? 3 : 2;
}

// Only run when this file is the invoked entrypoint (`tsx scripts/nationwidePreflight.ts …`),
// never merely when imported (e.g. by scripts/nationwidePreflight.test.ts for `parseArgs`).
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
}
