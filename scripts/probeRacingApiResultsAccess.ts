/**
 * READ-ONLY Racing API results-access probe (Phase 5A.0).
 *
 * Before touching /api/cron/results, this answers ONE question: can the current
 * Racing API plan read `/v1/results` for a given date? It performs a single
 * read-only GET via the existing client and reports a clear verdict — it does
 * NOT write to Supabase, settle anything, change model/staking logic, or
 * fabricate results.
 *
 * SAFETY:
 *   - One read-only Racing API request. No Supabase access, no mutations.
 *   - Credentials are read from the environment but NEVER printed (only their
 *     presence is reported as a boolean).
 *   - On failure it categorises the error (esp. "Standard Plan required") and
 *     prints a static hint — never a fabricated result.
 *
 * Usage:
 *   npm run probe:results -- --date 2026-06-16
 *   npm run probe:results -- --date 2026-06-16 --region gb,ire
 *
 * Requires RACING_API_USER + RACING_API_KEY in `.env.local` (or `.env`).
 */

import { pathToFileURL } from 'node:url';

import {
  createRacingApiClient,
  isStandardPlanRequiredError,
  type RacingApiClient,
} from '../src/lib/racingApi';

/** Default UK + Irish region codes for The Racing API (matches the live sync). */
const DEFAULT_REGIONS = ['gb', 'ire'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/** Parsed CLI arguments for the probe. */
export interface ProbeArgs {
  /** Raw `--date` value as given (validated separately; may be undefined). */
  date?: string;
  /** Region codes to query; defaults to gb,ire when `--region` is absent/empty. */
  regions: string[];
}

/** Splits a comma list into trimmed, lower-cased, de-duplicated, non-empty codes. */
function parseRegionList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const code = part.trim().toLowerCase();
    if (code !== '' && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Parses `--date YYYY-MM-DD` and optional `--region gb,ire`. The date is kept
 * verbatim (validation is a separate, testable step); regions fall back to the
 * gb,ire default when the flag is absent or empties out. Pure.
 */
export function parseProbeArgs(argv: string[]): ProbeArgs {
  let date: string | undefined;
  let regions: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') date = argv[++i];
    else if (a === '--region') regions = parseRegionList(argv[++i]);
  }
  return {
    date,
    regions: regions && regions.length > 0 ? regions : [...DEFAULT_REGIONS],
  };
}

/**
 * True for a strict `YYYY-MM-DD` calendar date that round-trips (so impossible
 * dates like 2026-13-01 / 2026-02-30 are rejected, never coerced). Pure.
 */
export function isValidIsoDate(value: string | undefined | null): boolean {
  if (!value || !ISO_DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** How a failed access attempt is classified for the operator. */
export type ResultsAccessErrorCategory =
  | 'standard_plan_required'
  | 'missing_credentials'
  | 'unauthorized'
  | 'rate_limited'
  | 'other';

/** A classified error plus a static, secret-free operator hint. */
export interface ResultsAccessErrorInfo {
  category: ResultsAccessErrorCategory;
  hint: string;
}

/** Static hints — fixed strings only, so nothing sensitive can be interpolated. */
const HINTS: Record<ResultsAccessErrorCategory, string> = {
  standard_plan_required:
    'BLOCKER: your Racing API plan does not include /v1/results (Standard Plan ' +
    'required). /api/cron/results cannot settle results on this plan — upgrade ' +
    'the plan or use an alternative results source before Phase 5A.',
  missing_credentials:
    'Missing RACING_API_USER / RACING_API_KEY in .env.local. Add them and retry.',
  unauthorized:
    'Unauthorized (401). Check RACING_API_USER / RACING_API_KEY are correct and active.',
  rate_limited:
    'Rate limited (429). Wait and retry; the Racing API allows ~100 requests / 10s.',
  other: 'Unexpected error contacting the Racing API (see the detail line above).',
};

/**
 * Classifies an error thrown while probing `/v1/results`. The most specific
 * cause wins: a "Standard Plan required" response is detected first (it can
 * arrive as a 401 whose body carries the plan message), then missing
 * credentials, then a generic 401, then a 429, else `other`. Pure; the hint is
 * always a fixed string. Never inspects or echoes credentials.
 */
export function categorizeResultsAccessError(error: unknown): ResultsAccessErrorInfo {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (isStandardPlanRequiredError(error)) {
    return { category: 'standard_plan_required', hint: HINTS.standard_plan_required };
  }
  if (/missing environment variable/i.test(message)) {
    return { category: 'missing_credentials', hint: HINTS.missing_credentials };
  }
  if (/\b401\b|unauthorized/i.test(message)) {
    return { category: 'unauthorized', hint: HINTS.unauthorized };
  }
  if (/\b429\b|rate[ -]?limited/i.test(message)) {
    return { category: 'rate_limited', hint: HINTS.rate_limited };
  }
  return { category: 'other', hint: HINTS.other };
}

/** Counts results in a `/v1/results` response, null-safe (never fabricates). */
export function countResults(
  response: { results?: unknown[] | null } | null | undefined,
): number {
  if (!response || !Array.isArray(response.results)) return 0;
  return response.results.length;
}

/** A short, secret-free one-line detail derived from an error message. */
function safeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseProbeArgs(process.argv.slice(2));

  // Validate the date up front (no fabrication — refuse rather than guess).
  if (args.date === undefined) {
    console.error('Missing required --date YYYY-MM-DD.');
    console.error('Usage: npm run probe:results -- --date 2026-06-16 [--region gb,ire]');
    process.exitCode = 1;
    return;
  }
  if (!isValidIsoDate(args.date)) {
    console.error(`--date must be a valid calendar date in YYYY-MM-DD form (got "${args.date}").`);
    process.exitCode = 1;
    return;
  }

  const date = args.date;
  const regions = args.regions;

  console.log(`Racing API /results access probe — date ${date}, regions ${regions.join(',')}`);

  // Report credential PRESENCE only (booleans) — never the values themselves.
  const hasUser = (process.env.RACING_API_USER ?? '').trim() !== '';
  const hasKey = (process.env.RACING_API_KEY ?? '').trim() !== '';
  console.log(`credentials: RACING_API_USER ${hasUser ? 'set' : 'MISSING'}, RACING_API_KEY ${hasKey ? 'set' : 'MISSING'}`);
  if (!hasUser || !hasKey) {
    console.log('ok: false');
    console.log('status: missing_credentials');
    console.log(`hint: ${HINTS.missing_credentials}`);
    process.exitCode = 1;
    return;
  }

  const client: RacingApiClient = createRacingApiClient();

  try {
    const res = await client.getResults({
      startDate: date,
      endDate: date,
      regionCodes: regions,
    });
    const count = countResults(res);
    const total = typeof res.total === 'number' ? res.total : null;

    console.log('ok: true');
    console.log('status: accessible');
    console.log(`results_count: ${count}`);
    if (total !== null) console.log(`total_reported: ${total}`);
    console.log('-> /v1/results is accessible on this plan; Phase 5A can proceed.');
  } catch (error) {
    const { category, hint } = categorizeResultsAccessError(error);
    console.log('ok: false');
    console.log(`status: ${category}`);
    // The detail is the API/transport message (response body snippet at most) —
    // it contains no credentials (those live only in the request header).
    console.log(`detail: ${safeErrorDetail(error)}`);
    console.log(`hint: ${hint}`);
    process.exitCode = 1;
  }
}

/** Run only when invoked directly, so importing for tests triggers no network. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
