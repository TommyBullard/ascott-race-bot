/**
 * Pure helpers for the ownership-aware configurable local race-day supervisor
 * (race-day-local/start-race-day.bat) — Nationwide rebuild Phase 7A.2b Step 4.
 *
 * The Windows batch launcher delegates ALL parsing, validation, and URL
 * construction to this module (via the read-only `race-day:launch-check` CLI)
 * so the brittle parts are unit-tested TypeScript, not batch string handling.
 *
 * WINDOWS-SAFE COURSE RULE: only the characters UK/Irish course names actually
 * need are allowed — letters, digits, spaces, hyphen, apostrophe, parentheses,
 * period. Everything else (cmd metacharacters: double quote, percent,
 * exclamation mark, ampersand, pipe, angle brackets, caret, CR/LF, tabs) is
 * REJECTED, never silently rewritten — the validated course is then safe to
 * pass verbatim to child commands, window titles, log paths, lock metadata and
 * URLs. The reserved nationwide scope ('all-uk-ire' / 'all uk ire', any
 * spelling or normalised equivalent) is explicitly rejected via the SAME
 * {@link isReservedNationwideCourse} rule the preflight uses.
 *
 * PUBLIC URL CONFIG: the public dashboard link comes ONLY from the explicit
 * `PUBLIC_DASHBOARD_URL` configuration — it is a DISTINCT concept from the
 * local/pipeline base URL, is never guessed from `PIPELINE_BASE_URL`, and no
 * Railway hostname is hardcoded anywhere. Absent/invalid config → the caller
 * prints "Production dashboard: not configured".
 *
 * This module performs NO I/O of any kind: no filesystem, no network, no
 * database, no child processes. Decision-support only — never a bet.
 */

import { normalizeCourse } from './raceSync';
import { isValidRaceDate } from './producerClaim';
import { isReservedNationwideCourse, validateBaseUrl } from './producerPreflight';

/* -------------------------------------------------------------------------- */
/* Windows-safe course validation (never silently rewritten)                  */
/* -------------------------------------------------------------------------- */

/** The ONLY characters a launcher course may contain (documented safe set). */
export const SAFE_COURSE_RE = /^[A-Za-z0-9 '().-]+$/;

/** Human-readable names for the explicitly forbidden cmd metacharacters. */
export const FORBIDDEN_COURSE_CHARACTERS: ReadonlyArray<{ char: string; name: string }> = [
  { char: '"', name: 'double quote' },
  { char: '%', name: 'percent' },
  { char: '!', name: 'exclamation mark' },
  { char: '&', name: 'ampersand' },
  { char: '|', name: 'pipe' },
  { char: '<', name: 'less-than' },
  { char: '>', name: 'greater-than' },
  { char: '^', name: 'caret' },
  { char: '\r', name: 'carriage return' },
  { char: '\n', name: 'line feed' },
  { char: '\t', name: 'tab' },
];

export interface CourseValidation {
  valid: boolean;
  reason: string | null;
}

/**
 * Validates an operator-typed course for launcher use. Rejects (never
 * rewrites): empty/whitespace-only input, leading/trailing whitespace,
 * every forbidden cmd metacharacter (by name, for a clear message), anything
 * outside the documented safe set, and every reserved nationwide
 * representation. Pure.
 */
export function validateLauncherCourse(raw: string): CourseValidation {
  if (raw === '' || raw.trim() === '') {
    return { valid: false, reason: 'a course is required (empty or whitespace-only input)' };
  }
  if (raw !== raw.trim()) {
    return { valid: false, reason: 'leading/trailing whitespace is not permitted (type the course without padding)' };
  }
  for (const { char, name } of FORBIDDEN_COURSE_CHARACTERS) {
    if (raw.includes(char)) {
      return { valid: false, reason: `course contains a forbidden character: ${name}` };
    }
  }
  if (!SAFE_COURSE_RE.test(raw)) {
    return {
      valid: false,
      reason: 'course contains characters outside the safe set (letters, digits, spaces, hyphen, apostrophe, parentheses, period)',
    };
  }
  if (isReservedNationwideCourse(raw)) {
    return {
      valid: false,
      reason: 'the reserved nationwide scope is not a course — this launcher is selected-course only',
    };
  }
  return { valid: true, reason: null };
}

/** Log-folder slug for a course (same normalizeCourse rule; spaces → '-'). Pure. */
export function buildCourseSlug(course: string): string {
  return normalizeCourse(course).replace(/ /g, '-');
}

/* -------------------------------------------------------------------------- */
/* Dashboard URLs (encoded; local vs public are DISTINCT concepts)            */
/* -------------------------------------------------------------------------- */

export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:3000';

/** Builds the scoped dashboard URL for a VALIDATED base. Returns null on an invalid base. Pure. */
export function buildScopedDashboardUrl(baseUrl: string, date: string, course: string): string | null {
  const validated = validateBaseUrl(baseUrl);
  if (!validated.valid || !validated.origin) return null;
  return `${validated.origin}/?date=${encodeURIComponent(date)}&course=${encodeURIComponent(course)}`;
}

export type PublicUrlResolution =
  | { configured: true; url: string }
  | { configured: false; reason: 'not_configured' | 'invalid' };

/**
 * Resolves the PUBLIC dashboard URL from the EXPLICIT `PUBLIC_DASHBOARD_URL`
 * value only. Never guesses from any other variable, never falls back to a
 * documented host. Absent → not_configured; unparseable / non-http(s) /
 * credentialed → invalid (also rendered as "not configured", with the reason
 * available for logging). Pure.
 */
export function resolvePublicDashboardUrl(
  publicDashboardUrl: string | undefined | null,
  date: string,
  course: string,
): PublicUrlResolution {
  if (!publicDashboardUrl || publicDashboardUrl.trim() === '') {
    return { configured: false, reason: 'not_configured' };
  }
  const url = buildScopedDashboardUrl(publicDashboardUrl.trim(), date, course);
  if (url === null) return { configured: false, reason: 'invalid' };
  return { configured: true, url };
}

/* -------------------------------------------------------------------------- */
/* Launch-check evaluation (what the CLI prints for the batch to consume)     */
/* -------------------------------------------------------------------------- */

export type LaunchCheckResult =
  | { ok: true; slug: string; localUrl: string; prodUrl: string | null }
  | { ok: false; reason: string };

/**
 * Full launcher input validation: strict date, Windows-safe selected course,
 * valid local base URL, and the (optional, distinct) public dashboard URL.
 * Pure — the CLI passes env/config values in.
 */
export function evaluateLaunchCheck(params: {
  date: string | null | undefined;
  course: string | null | undefined;
  baseUrl?: string;
  publicDashboardUrl?: string | null;
}): LaunchCheckResult {
  if (!params.date || !isValidRaceDate(params.date)) {
    return { ok: false, reason: `invalid or missing --date "${params.date ?? ''}" — expected strict YYYY-MM-DD` };
  }
  if (params.course === null || params.course === undefined) {
    return { ok: false, reason: 'a --course is required (selected-course only)' };
  }
  const course = validateLauncherCourse(params.course);
  if (!course.valid) {
    return { ok: false, reason: course.reason ?? 'invalid course' };
  }
  const base = params.baseUrl ?? DEFAULT_LOCAL_BASE_URL;
  const localUrl = buildScopedDashboardUrl(base, params.date, params.course);
  if (localUrl === null) {
    return { ok: false, reason: `invalid local base URL "${base}" (http/https only, no URL credentials)` };
  }
  const publicResolved = resolvePublicDashboardUrl(params.publicDashboardUrl, params.date, params.course);
  return {
    ok: true,
    slug: buildCourseSlug(params.course),
    localUrl,
    prodUrl: publicResolved.configured ? publicResolved.url : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Local launcher-lock metadata (no secrets, ever)                            */
/* -------------------------------------------------------------------------- */

/**
 * The metadata lines the launcher writes inside the atomic lock DIRECTORY —
 * date, display course, slug, created_at, and optionally the launcher pid as
 * diagnostic metadata only (never trusted after reboot/reuse). No secrets,
 * commands, environment values or credentials, by construction. Pure.
 */
export function buildLauncherLockMetadataLines(params: {
  date: string;
  course: string;
  slug: string;
  createdAtIso: string;
  pid?: number | null;
}): string[] {
  const lines = [
    `date=${params.date}`,
    `course=${params.course}`,
    `slug=${params.slug}`,
    `created_at=${params.createdAtIso}`,
  ];
  if (typeof params.pid === 'number' && Number.isFinite(params.pid)) {
    lines.push(`launcher_pid=${params.pid} (diagnostic only — never trusted after reboot)`);
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Pipeline-watch exit-code classification (mirrors Step 2's exit codes)      */
/* -------------------------------------------------------------------------- */

/** Maximum bounded retries for a GENERIC (code 1/other) pipeline-watch exit. */
export const MAX_PIPELINE_WATCH_RETRIES = 5;

/** Seconds between bounded retries. */
export const PIPELINE_WATCH_RETRY_DELAY_SECONDS = 60;

export type PipelineWatchExitClass =
  | 'terminal_graceful'
  | 'terminal_mechanism'
  | 'terminal_ownership'
  | 'retryable';

/**
 * Classifies a pipeline:watch exit code per Step 2's contract:
 * 0 graceful stop (never restarted); 2 claim mechanism unavailable/uncertain
 * (terminal, fail-closed); 3 ownership refused or lost (terminal — restarting
 * cannot succeed until the operator intervenes); anything else (1, crashes)
 * is retryable with a bounded count. Pure.
 */
export function classifyPipelineWatchExit(code: number): PipelineWatchExitClass {
  if (code === 0) return 'terminal_graceful';
  if (code === 2) return 'terminal_mechanism';
  if (code === 3) return 'terminal_ownership';
  return 'retryable';
}

/* -------------------------------------------------------------------------- */
/* Planned watcher commands (displayed by --preflight-only; suggestion only)  */
/* -------------------------------------------------------------------------- */

/** The exact three watcher commands the launcher will run after READY. Pure. */
export function buildPlannedWatcherCommands(date: string, course: string): string[] {
  return [
    `npm run pipeline:watch -- --date ${date} --course "${course}" --interval-minutes 5 --commit`,
    `npm run lock:t-minus -- --date ${date} --course "${course}" --minutes-before 5 --commit`,
    `npm run results:auto -- --date ${date} --course "${course}"  (dry-run first; --commit only after a clean dry-run)`,
  ];
}
