/**
 * Producer Readiness Preflight — Nationwide rebuild Phase 7A.2b Step 3.
 *
 * PURE evaluation + rendering for the READ-ONLY `producer:preflight` CLI
 * (scripts/producerPreflight.ts): given already-gathered evidence, decide
 * whether it is safe to begin an ownership-aware SELECTED-COURSE producer run,
 * as one verdict — READY / REVIEW / BLOCKED — over twelve named checks.
 *
 * THIS MODULE PERFORMS NO I/O ITSELF except {@link probeHealthEndpoint}, whose
 * fetch is injectable and whose ONLY permitted target is the FIXED read-only
 * path `/api/cron/health?date=` (verified read-only: that route "RUNS NOTHING
 * and WRITES NOTHING"). Everything else here is pure functions over inputs
 * the CLI gathers via `fetchProducerClaimStatus` (the read-only status RPC —
 * the ONLY ownership operation the preflight ever performs) and SELECT-only
 * workload queries.
 *
 * SELECTED-COURSE ONLY: the reserved nationwide scope is rejected EXPLICITLY
 * ({@link isReservedNationwideCourse}) — 'all-uk-ire', 'all uk ire', and every
 * normalised equivalent — so the preflight can never build
 * `course:all-uk-ire` / `course:all uk ire` or bless a nationwide run.
 *
 * HONEST EVIDENCE LABELLING: every check carries an evidence source —
 * `automatically_verified` / `operator_attested` / `unknown` / `unavailable` /
 * `not_applicable`. Railway job state, Vercel cron state, and legacy
 * (pre-ownership) local processes are NEVER automatically verified: without
 * `--confirm-external` they stay unknown/manual (best verdict REVIEW); with it
 * they are labelled OPERATOR ATTESTATION ONLY — the command itself verified
 * nothing external.
 *
 * The verdict is informational: READY prints the exact next command as TEXT
 * and never executes it. No claim/heartbeat/release, no provider or model
 * work, no pipeline, no child processes, no writes (the CLI writes one local
 * Markdown report only under --report). Decision-support only — never a bet.
 */

import { normalizeCourse } from './raceSync';
import {
  ALL_UK_IRE_SCOPE,
  buildCourseScope,
  isValidRaceDate,
  isValidScope,
  type ClaimFailureKind,
  type StatusOutcome,
} from './producerClaim';

/* -------------------------------------------------------------------------- */
/* Reserved nationwide input (selected-course only — hard rejection)          */
/* -------------------------------------------------------------------------- */

/** What every reserved nationwide spelling normalises to under normalizeCourse. */
export const RESERVED_NATIONWIDE_NORMALISED = 'all uk ire';

/**
 * True when a course input is (any spelling of) the reserved nationwide scope
 * — 'all-uk-ire', 'all uk ire', case/punctuation variants — detected via BOTH
 * the raw literal and the SAME `normalizeCourse` rule used everywhere else.
 * This is an explicit check, deliberately not left to general scope
 * validation: the preflight must never produce `course:all uk ire`. Pure.
 */
export function isReservedNationwideCourse(courseRaw: string): boolean {
  const trimmed = courseRaw.trim().toLowerCase();
  if (trimmed === ALL_UK_IRE_SCOPE) return true;
  return normalizeCourse(courseRaw) === RESERVED_NATIONWIDE_NORMALISED;
}

/* -------------------------------------------------------------------------- */
/* Base URL validation + the FIXED health-probe URL                           */
/* -------------------------------------------------------------------------- */

export interface BaseUrlValidation {
  valid: boolean;
  /** The origin (scheme://host[:port]) — path/credentials stripped. */
  origin: string | null;
  reason: string | null;
}

/** Validates the operator's base URL: http/https only, NO URL credentials. Pure. */
export function validateBaseUrl(raw: string): BaseUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, origin: null, reason: 'not a parseable URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, origin: null, reason: `unsupported protocol "${url.protocol}" (http/https only)` };
  }
  if (url.username !== '' || url.password !== '') {
    return { valid: false, origin: null, reason: 'URL credentials are not permitted in the base URL' };
  }
  return { valid: true, origin: url.origin, reason: null };
}

/**
 * The ONLY URL the preflight may request: the fixed, read-only health path on
 * the validated origin. The path is NOT operator-configurable. Pure.
 */
export function buildHealthProbeUrl(origin: string, date: string): string {
  return `${origin}/api/cron/health?date=${encodeURIComponent(date)}`;
}

/* -------------------------------------------------------------------------- */
/* Health probe (injectable fetch; bounded; GET-only; redirects refused)      */
/* -------------------------------------------------------------------------- */

export const HEALTH_PROBE_TIMEOUT_MS = 5_000;

export type HealthProbeResult =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'redirect_refused'
  | 'wrong_app'
  | 'unreachable'
  | 'timeout';

export interface HealthProbeOutcome {
  result: HealthProbeResult;
  /** Fixed, classification-only wording — never echoes headers, bodies, or secrets. */
  detail: string;
}

/** The exact request shape the probe sends (visible to tests via the fake). */
export interface HealthProbeInit {
  method: 'GET';
  headers: Record<string, string>;
  redirect: 'manual';
  signal: AbortSignal;
}

export type HealthFetch = (
  url: string,
  init: HealthProbeInit,
) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * GETs the fixed health path once. Bounded by {@link HEALTH_PROBE_TIMEOUT_MS}
 * via AbortSignal; `redirect: 'manual'` means NO redirect (cross-origin or
 * otherwise) is ever followed — any 3xx is refused. The CRON_SECRET bearer may
 * be sent but is never logged, echoed, or included in any outcome detail.
 * 401/403 are classified honestly (reachable, auth not accepted). A 2xx whose
 * body is not the race-day health shape (`meetingDate` + `health`) is
 * `wrong_app`. Never throws.
 */
export async function probeHealthEndpoint(
  origin: string,
  date: string,
  bearer: string | null,
  fetchFn: HealthFetch = fetch as unknown as HealthFetch,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Promise<HealthProbeOutcome> {
  const url = buildHealthProbeUrl(origin, date);
  const headers: Record<string, string> = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { result: 'timeout', detail: `no response within ${timeoutMs}ms` };
    }
    return { result: 'unreachable', detail: 'network error — server not reachable' };
  }
  if (res.status >= 300 && res.status < 400) {
    return { result: 'redirect_refused', detail: `HTTP ${res.status} redirect refused (redirects are never followed)` };
  }
  if (res.status === 401) {
    return { result: 'unauthorized', detail: 'reachable, but the CRON_SECRET bearer was not accepted (HTTP 401)' };
  }
  if (res.status === 403) {
    return { result: 'forbidden', detail: 'reachable, but access was forbidden (HTTP 403)' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { result: 'wrong_app', detail: `unexpected response (HTTP ${res.status}) — cannot confirm the race-day app` };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { result: 'wrong_app', detail: 'HTTP 2xx but the body is not JSON — cannot confirm the race-day app' };
  }
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || typeof b.meetingDate !== 'string' || typeof b.health !== 'object' || b.health === null) {
    return { result: 'wrong_app', detail: 'HTTP 2xx but the response shape is not the race-day health endpoint' };
  }
  return { result: 'ok', detail: `read-only health endpoint responded for meeting date ${b.meetingDate}` };
}

/* -------------------------------------------------------------------------- */
/* Claim-status summary (from the read-only status RPC only)                  */
/* -------------------------------------------------------------------------- */

export type ClaimStatusSummary =
  | { kind: 'absent' }
  | { kind: 'live'; ownerPrefix: string; scope: string; generation: number; remainingSeconds: number | null; expiresAt: string }
  | { kind: 'expired'; ownerPrefix: string; scope: string; generation: number; expiredSeconds: number | null }
  | { kind: 'unknown_liveness' }
  | { kind: 'mechanism_failed'; failureKind: ClaimFailureKind; message: string };

/**
 * Reduces the read-only status RPC outcome to the preflight's honest claim
 * summary. Server-time liveness only; a liveness of `unknown` is preserved
 * (never guessed live or absent). Only an 8-char owner prefix survives. Pure.
 */
export function summarizeClaimStatus(outcome: StatusOutcome): ClaimStatusSummary {
  if (!outcome.ok) {
    return { kind: 'mechanism_failed', failureKind: outcome.failure.kind, message: outcome.failure.message };
  }
  if (outcome.claim === null) return { kind: 'absent' };
  const prefix = outcome.claim.ownerId.slice(0, 8);
  if (outcome.liveness.status === 'live') {
    return {
      kind: 'live',
      ownerPrefix: prefix,
      scope: outcome.claim.scope,
      generation: outcome.claim.generation,
      remainingSeconds: outcome.liveness.remainingSeconds,
      expiresAt: outcome.claim.expiresAt,
    };
  }
  if (outcome.liveness.status === 'expired') {
    return {
      kind: 'expired',
      ownerPrefix: prefix,
      scope: outcome.claim.scope,
      generation: outcome.claim.generation,
      expiredSeconds: outcome.liveness.expiredSeconds,
    };
  }
  return { kind: 'unknown_liveness' };
}

/* -------------------------------------------------------------------------- */
/* Evaluation input / report types                                            */
/* -------------------------------------------------------------------------- */

export type CheckStatus = 'pass' | 'review' | 'blocked' | 'info';
export type EvidenceSource =
  | 'automatically_verified'
  | 'operator_attested'
  | 'unknown'
  | 'unavailable'
  | 'not_applicable';
export type PreflightVerdict = 'READY' | 'REVIEW' | 'BLOCKED';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  evidence: EvidenceSource;
  detail: string;
}

/** Stored-workload counts for the date+course (SELECT-only, gathered by the CLI). */
export interface WorkloadSummary {
  races: number;
  runners: number;
  racesWithOdds: number;
  racesWithModelRuns: number;
  settled: number;
  upcoming: number;
}

export interface PreflightInput {
  date: string;
  courseRaw: string;
  requireServer: boolean;
  confirmExternal: boolean;
  env: {
    supabaseUrl: boolean;
    serviceRoleKey: boolean;
    cronSecret: boolean;
    /** SUPABASE_URL host only (a non-secret project identity) — never a key. */
    projectHost: string | null;
  };
  baseUrl: BaseUrlValidation & { raw: string };
  /** null = not queried (e.g. required configuration missing). */
  claim: ClaimStatusSummary | null;
  /** null = not gathered. */
  workload: WorkloadSummary | null;
  workloadError: string | null;
  server: { mode: 'skipped' | 'probed'; outcome: HealthProbeOutcome | null };
}

export interface ProducerPreflightReport {
  date: string;
  courseRaw: string;
  /** `course:<normalised>` when the input is valid, else null. */
  scope: string | null;
  verdict: PreflightVerdict;
  checks: PreflightCheck[];
  /** Honest provenance of the external checks — NEVER 'automatically verified'. */
  externalChecksSource: 'operator_attestation' | 'unknown';
  /** Text of the next safe command; READY only; NEVER executed by the preflight. */
  suggestedCommand: string | null;
}

/** The exact next-safe-command text (suggestion only — never executed here). */
export function buildSuggestedPipelineCommand(date: string, courseRaw: string): string {
  return `npm run pipeline:day -- --date ${date} --course "${courseRaw}" --commit`;
}

/* -------------------------------------------------------------------------- */
/* The evaluator                                                              */
/* -------------------------------------------------------------------------- */

const OPERATOR_ATTESTATION_NOTE =
  'operator attestation only (--confirm-external) — NOT automatically verified by this command';

/**
 * Reduces the gathered evidence to the twelve checks and one verdict. Pure and
 * deterministic. BLOCKED beats REVIEW beats READY; `info` checks never affect
 * the verdict. Stored model coverage is workload EVIDENCE, never a blocker —
 * the pipeline exists to create model runs. External conditions (Railway /
 * Vercel / legacy local processes) are unknown/manual unless the operator
 * explicitly attested them; they are never marked automatically verified.
 */
export function evaluateProducerPreflight(input: PreflightInput): ProducerPreflightReport {
  const checks: PreflightCheck[] = [];

  // 1. date / course / scope --------------------------------------------------
  let scope: string | null = null;
  let inputValid = false;
  if (!isValidRaceDate(input.date)) {
    checks.push({
      id: 'date_course_scope',
      label: 'date/course scope',
      status: 'blocked',
      evidence: 'automatically_verified',
      detail: `invalid date "${input.date}" — expected strict YYYY-MM-DD`,
    });
  } else if (!input.courseRaw || input.courseRaw.trim() === '') {
    checks.push({
      id: 'date_course_scope',
      label: 'date/course scope',
      status: 'blocked',
      evidence: 'automatically_verified',
      detail: 'a course is required — this preflight is selected-course only',
    });
  } else if (isReservedNationwideCourse(input.courseRaw)) {
    checks.push({
      id: 'date_course_scope',
      label: 'date/course scope',
      status: 'blocked',
      evidence: 'automatically_verified',
      detail:
        `"${input.courseRaw}" is the reserved nationwide scope — this preflight is selected-course only ` +
        'and never produces a nationwide course scope',
    });
  } else {
    const built = buildCourseScope(input.courseRaw);
    if (!isValidScope(built)) {
      checks.push({
        id: 'date_course_scope',
        label: 'date/course scope',
        status: 'blocked',
        evidence: 'automatically_verified',
        detail: `course "${input.courseRaw}" does not normalise to a valid course scope`,
      });
    } else {
      scope = built;
      inputValid = true;
      checks.push({
        id: 'date_course_scope',
        label: 'date/course scope',
        status: 'pass',
        evidence: 'automatically_verified',
        detail: `date ${input.date}, scope ${built}`,
      });
    }
  }

  // 2–3. ownership mechanism + active claim -----------------------------------
  if (!inputValid) {
    checks.push(
      skippedCheck('ownership_mechanism', 'ownership mechanism'),
      skippedCheck('active_claim', 'active claim'),
    );
  } else if (input.claim === null) {
    checks.push(
      {
        id: 'ownership_mechanism',
        label: 'ownership mechanism',
        status: 'blocked',
        evidence: 'unavailable',
        detail: 'not queried — required configuration is missing, so ownership cannot be established safely',
      },
      {
        id: 'active_claim',
        label: 'active claim',
        status: 'blocked',
        evidence: 'unavailable',
        detail: 'unknown — the claim status could not be read',
      },
    );
  } else if (input.claim.kind === 'mechanism_failed') {
    checks.push(
      {
        id: 'ownership_mechanism',
        label: 'ownership mechanism',
        status: 'blocked',
        evidence: 'unavailable',
        detail: `status RPC failed (${input.claim.failureKind}): ${input.claim.message}`,
      },
      {
        id: 'active_claim',
        label: 'active claim',
        status: 'blocked',
        evidence: 'unavailable',
        detail: 'unknown — the claim status could not be read',
      },
    );
  } else {
    checks.push({
      id: 'ownership_mechanism',
      label: 'ownership mechanism',
      status: 'pass',
      evidence: 'automatically_verified',
      detail: 'producer_claim_status RPC reachable and well-formed (read-only)',
    });
    if (input.claim.kind === 'live') {
      checks.push({
        id: 'active_claim',
        label: 'active claim',
        status: 'blocked',
        evidence: 'automatically_verified',
        detail:
          `a LIVE claim exists — owner ${input.claim.ownerPrefix}… scope=${input.claim.scope} ` +
          `generation=${input.claim.generation} expires_at=${input.claim.expiresAt} ` +
          `(${input.claim.remainingSeconds ?? '?'}s remaining). An active producer holds this date; do not start another.`,
      });
    } else if (input.claim.kind === 'expired') {
      checks.push({
        id: 'active_claim',
        label: 'active claim',
        status: 'review',
        evidence: 'automatically_verified',
        detail:
          `an EXPIRED claim exists — owner ${input.claim.ownerPrefix}… scope=${input.claim.scope} ` +
          `generation=${input.claim.generation} (expired ${input.claim.expiredSeconds ?? '?'}s ago). ` +
          'It is stealable by a starting producer, but this preflight did NOT steal it and never will.',
      });
    } else if (input.claim.kind === 'unknown_liveness') {
      checks.push({
        id: 'active_claim',
        label: 'active claim',
        status: 'blocked',
        evidence: 'unavailable',
        detail: 'claim liveness could not be established from server time — fail-closed for any ownership decision',
      });
    } else {
      checks.push({
        id: 'active_claim',
        label: 'active claim',
        status: 'pass',
        evidence: 'automatically_verified',
        detail: 'no claim exists for this date (unclaimed)',
      });
    }
  }

  // 4–6. stored workload -------------------------------------------------------
  if (!inputValid) {
    checks.push(
      skippedCheck('stored_races', 'stored races'),
      skippedCheck('stored_odds', 'stored odds'),
      skippedCheck('model_coverage', 'stored model coverage'),
    );
  } else if (input.workload === null) {
    const why = input.workloadError ?? 'not gathered';
    checks.push(
      {
        id: 'stored_races',
        label: 'stored races',
        status: 'review',
        evidence: 'unavailable',
        detail: `stored workload could not be read (${why})`,
      },
      { id: 'stored_odds', label: 'stored odds', status: 'info', evidence: 'unavailable', detail: 'unknown' },
      { id: 'model_coverage', label: 'stored model coverage', status: 'info', evidence: 'unavailable', detail: 'unknown' },
    );
  } else {
    const w = input.workload;
    if (w.races === 0) {
      checks.push(
        {
          id: 'stored_races',
          label: 'stored races',
          status: 'review',
          evidence: 'automatically_verified',
          detail:
            'ZERO stored races for this date/course — racecards have not been ingested yet. ' +
            'This preflight did NOT fetch them (read-only); run the pipeline racecards stage when ready.',
        },
        { id: 'stored_odds', label: 'stored odds', status: 'info', evidence: 'not_applicable', detail: 'no stored races' },
        { id: 'model_coverage', label: 'stored model coverage', status: 'info', evidence: 'not_applicable', detail: 'no stored races' },
      );
    } else {
      checks.push({
        id: 'stored_races',
        label: 'stored races',
        status: 'pass',
        evidence: 'automatically_verified',
        detail: `${w.races} race(s), ${w.runners} runner(s), ${w.settled} settled, ${w.upcoming} upcoming`,
      });
      if (w.racesWithOdds === 0) {
        checks.push({
          id: 'stored_odds',
          label: 'stored odds',
          status: 'review',
          evidence: 'automatically_verified',
          detail: `0/${w.races} races have stored odds — the odds stage has not produced snapshots yet`,
        });
      } else {
        checks.push({
          id: 'stored_odds',
          label: 'stored odds',
          status: 'pass',
          evidence: 'automatically_verified',
          detail: `${w.racesWithOdds}/${w.races} races have stored odds snapshots`,
        });
      }
      // Model coverage is workload EVIDENCE, never a blocker: the pipeline is
      // expected to CREATE model runs, so zero/partial coverage stays 'info'.
      const coverage =
        w.racesWithModelRuns === 0
          ? `0/${w.races} races have model runs — expected before a first run; the pipeline creates them`
          : w.racesWithModelRuns < w.races
            ? `${w.racesWithModelRuns}/${w.races} races have model runs (partial — informational)`
            : `${w.racesWithModelRuns}/${w.races} races have model runs (complete)`;
      checks.push({
        id: 'model_coverage',
        label: 'stored model coverage',
        status: 'info',
        evidence: 'automatically_verified',
        detail: coverage,
      });
    }
  }

  // 7. required configuration --------------------------------------------------
  {
    const missing: string[] = [];
    if (!input.env.supabaseUrl) missing.push('SUPABASE_URL');
    if (!input.env.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!input.env.cronSecret) missing.push('CRON_SECRET');
    if (missing.length > 0) {
      checks.push({
        id: 'required_configuration',
        label: 'required configuration',
        status: 'blocked',
        evidence: 'automatically_verified',
        detail:
          `missing (by NAME only — values are never read into output): ${missing.join(', ')}. ` +
          'The selected-course pipeline cannot run without these.',
      });
    } else {
      checks.push({
        id: 'required_configuration',
        label: 'required configuration',
        status: 'pass',
        evidence: 'automatically_verified',
        detail:
          `SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET present (presence only — no values)` +
          (input.env.projectHost ? `; Supabase project host: ${input.env.projectHost}` : '') +
          '. Racing API / Betfair credentials are SERVER-side requirements, not verifiable from here.',
      });
    }
  }

  // 8. server reachability -----------------------------------------------------
  if (!input.baseUrl.valid) {
    checks.push({
      id: 'server_reachability',
      label: 'server reachability',
      status: 'blocked',
      evidence: 'automatically_verified',
      detail: `base URL "${input.baseUrl.raw}" is invalid: ${input.baseUrl.reason}`,
    });
  } else if (input.server.mode === 'skipped' || input.server.outcome === null) {
    checks.push({
      id: 'server_reachability',
      label: 'server reachability',
      status: 'review',
      evidence: 'unknown',
      detail: 'not probed (--skip-server) — confirm the server at the base URL yourself before a commit run',
    });
  } else {
    const o = input.server.outcome;
    if (o.result === 'ok') {
      checks.push({
        id: 'server_reachability',
        label: 'server reachability',
        status: 'pass',
        evidence: 'automatically_verified',
        detail: o.detail,
      });
    } else if (o.result === 'wrong_app' || o.result === 'redirect_refused') {
      checks.push({
        id: 'server_reachability',
        label: 'server reachability',
        status: 'blocked',
        evidence: 'automatically_verified',
        detail: `${o.detail} — a reachable endpoint that is not verifiably this app blocks a producer start`,
      });
    } else {
      // unauthorized / forbidden / unreachable / timeout
      const blocked = input.requireServer;
      checks.push({
        id: 'server_reachability',
        label: 'server reachability',
        status: blocked ? 'blocked' : 'review',
        evidence: 'automatically_verified',
        detail: o.detail + (blocked ? ' (--require-server: this blocks the run)' : ''),
      });
    }
  }

  // 9–11. external producer knowledge (NEVER automatically verified) -----------
  const externalEvidence: EvidenceSource = input.confirmExternal ? 'operator_attested' : 'unknown';
  const externalStatus: CheckStatus = input.confirmExternal ? 'pass' : 'review';
  checks.push(
    {
      id: 'local_process_knowledge',
      label: 'local process knowledge',
      status: externalStatus,
      evidence: input.confirmExternal ? 'operator_attested' : 'unknown',
      detail: input.confirmExternal
        ? `no legacy/unclaimed local producer running — ${OPERATOR_ATTESTATION_NOTE}`
        : 'claim-holding producers are visible via the claim row; legacy/unclaimed local processes CANNOT be detected from here — MANUAL check',
    },
    {
      id: 'railway_job_state',
      label: 'Railway job state',
      status: externalStatus,
      evidence: externalEvidence,
      detail: input.confirmExternal
        ? `Railway pipeline-refresh job quiescent — ${OPERATOR_ATTESTATION_NOTE}`
        : 'UNKNOWN — Railway cron configuration lives in the Railway dashboard and cannot be proven from this repository; MANUAL check',
    },
    {
      id: 'vercel_cron_state',
      label: 'Vercel cron state',
      status: externalStatus,
      evidence: externalEvidence,
      detail: input.confirmExternal
        ? `no live Vercel deployment firing vercel.json crons — ${OPERATOR_ATTESTATION_NOTE}`
        : 'UNKNOWN — vercel.json declares odds/model/results crons, but whether a Vercel deployment is live cannot be proven from this repository; MANUAL check',
    },
  );

  // 12. bypass entry points (static knowledge; informational) -------------------
  checks.push({
    id: 'bypass_entry_points',
    label: 'bypass entry points',
    status: 'info',
    evidence: 'automatically_verified',
    detail:
      'gated: pipeline:day, pipeline:watch (and transitively race-day:refresh-today). ' +
      'exempt by policy: lock:t-minus, results:auto, read-only audits/reports. ' +
      'still able to bypass the claim (operational restrictions — do not use during an owned day): ' +
      'direct CRON_SECRET calls to /api/cron/racecards|odds|model|results, POST /api/run-model, run:model, model:day.',
  });

  // Verdict --------------------------------------------------------------------
  const verdict: PreflightVerdict = checks.some((c) => c.status === 'blocked')
    ? 'BLOCKED'
    : checks.some((c) => c.status === 'review')
      ? 'REVIEW'
      : 'READY';

  return {
    date: input.date,
    courseRaw: input.courseRaw,
    scope,
    verdict,
    checks,
    externalChecksSource: input.confirmExternal ? 'operator_attestation' : 'unknown',
    suggestedCommand: verdict === 'READY' ? buildSuggestedPipelineCommand(input.date, input.courseRaw) : null,
  };
}

function skippedCheck(id: string, label: string): PreflightCheck {
  return { id, label, status: 'info', evidence: 'not_applicable', detail: 'skipped — input invalid' };
}

/* -------------------------------------------------------------------------- */
/* Rendering (console / JSON / Markdown) — deterministic, secret-free         */
/* -------------------------------------------------------------------------- */

const STATUS_TAG: Record<CheckStatus, string> = {
  pass: '[PASS]   ',
  review: '[REVIEW] ',
  blocked: '[BLOCKED]',
  info: '[INFO]   ',
};

/** Console lines for the human summary. Pure. */
export function renderPreflightConsole(report: ProducerPreflightReport): string[] {
  const lines: string[] = [];
  lines.push(`Producer readiness — ${report.date} — ${report.courseRaw}`);
  lines.push('READ ONLY — status inspection only; no claim acquired, no provider/model work, nothing executed.');
  lines.push('');
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`External checks source: ${report.externalChecksSource === 'operator_attestation' ? 'operator_attestation (NOT automatically verified)' : 'unknown (manual checks outstanding)'}`);
  lines.push('');
  lines.push('Checks:');
  for (const c of report.checks) {
    lines.push(`  ${STATUS_TAG[c.status]} ${c.label} — ${c.detail} [${c.evidence}]`);
  }
  lines.push('');
  if (report.verdict === 'READY') {
    lines.push('Operator actions:');
    lines.push(`  Next safe command (suggestion only — NOT executed by this preflight):`);
    lines.push(`    ${report.suggestedCommand}`);
  } else if (report.verdict === 'REVIEW') {
    lines.push('Operator actions — manual checks required before a producer starts:');
    for (const c of report.checks.filter((c) => c.status === 'review')) {
      lines.push(`  - ${c.label}: ${c.detail}`);
    }
  } else {
    lines.push('Operator actions — NO producer should start:');
    for (const c of report.checks.filter((c) => c.status === 'blocked')) {
      lines.push(`  - ${c.label}: ${c.detail}`);
    }
  }
  return lines;
}

/** The single JSON object for --json. Pure and deterministic (no timestamp). */
export function buildPreflightJson(report: ProducerPreflightReport): Record<string, unknown> {
  return {
    read_only: true,
    date: report.date,
    course: report.courseRaw,
    scope: report.scope,
    verdict: report.verdict,
    external_checks_source: report.externalChecksSource,
    checks: report.checks.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      evidence: c.evidence,
      detail: c.detail,
    })),
    suggested_next_command: report.suggestedCommand,
    suggested_command_executed: false,
    nationwide_execution: 'disabled',
  };
}

/** Deterministic Markdown report (timestamp injected by the caller). Pure. */
export function renderPreflightMarkdown(report: ProducerPreflightReport, generatedAtIso: string): string {
  const lines: string[] = [];
  lines.push(`# Producer readiness preflight — ${report.date} — ${report.courseRaw}`);
  lines.push('');
  lines.push(`Generated: ${generatedAtIso}`);
  lines.push('');
  lines.push('**READ ONLY.**');
  lines.push('');
  lines.push('- No provider or model work was started.');
  lines.push('- No ownership claim was acquired (status inspection only).');
  lines.push('- Nationwide execution remains disabled.');
  lines.push('- External producer checks (Railway / Vercel / legacy local processes) are manual/operator-attested unless proven — this command did not verify them.');
  lines.push('- The suggested pipeline command was NOT executed.');
  lines.push('');
  lines.push(`## Verdict: ${report.verdict}`);
  lines.push('');
  lines.push(`External checks source: \`${report.externalChecksSource}\``);
  lines.push('');
  lines.push('| Check | Status | Evidence | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of report.checks) {
    lines.push(`| ${c.label} | ${c.status.toUpperCase()} | ${c.evidence} | ${c.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  if (report.verdict === 'READY' && report.suggestedCommand) {
    lines.push('## Next safe command (suggestion only — not executed)');
    lines.push('');
    lines.push('```');
    lines.push(report.suggestedCommand);
    lines.push('```');
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('Decision-support only — no betting, no bet placement.');
  lines.push('');
  return lines.join('\n');
}

/** Report path: reports/producer-preflight-<date>-<course-slug>.md. Pure. */
export function buildProducerPreflightPath(date: string, courseRaw: string): string {
  const slug = normalizeCourse(courseRaw).replace(/ /g, '-');
  return `reports/producer-preflight-${date}-${slug}.md`;
}
