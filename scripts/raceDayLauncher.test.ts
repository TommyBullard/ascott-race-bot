/**
 * Tests for the pure race-day launcher helpers (src/lib/raceDayLauncher.ts)
 * and the read-only race-day:launch-check CLI — Nationwide rebuild Phase
 * 7A.2b Step 4.
 *
 * Proves the Windows-safe course rule (every forbidden cmd metacharacter
 * rejected by name, safe punctuation accepted, nothing silently rewritten,
 * reserved nationwide input rejected in every spelling), the strict date
 * gate, scoped URL building with encoding (local base vs the DISTINCT
 * PUBLIC_DASHBOARD_URL concept — never guessed, never a hardcoded host,
 * credentialed/invalid URLs refused), lock-metadata content safety, the
 * pipeline-watch exit-code classification (0/2/3 terminal, others bounded-
 * retryable, max 5), the planned watcher commands, and — by source scan —
 * that the launch-check CLI is read-only (no fs writes, no DB, no network,
 * no child processes) and neither file hardcodes a course, date, or Railway
 * host. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_LOCAL_BASE_URL,
  FORBIDDEN_COURSE_CHARACTERS,
  MAX_PIPELINE_WATCH_RETRIES,
  PIPELINE_WATCH_RETRY_DELAY_SECONDS,
  buildCourseSlug,
  buildLauncherLockMetadataLines,
  buildPlannedWatcherCommands,
  buildScopedDashboardUrl,
  classifyPipelineWatchExit,
  evaluateLaunchCheck,
  resolvePublicDashboardUrl,
  validateLauncherCourse,
} from '../src/lib/raceDayLauncher';

const DATE = '2026-07-18';

/* --------------------------- course validation ------------------------------- */

test('course: safe UK/Irish course punctuation is accepted (letters, digits, spaces, hyphen, apostrophe, parentheses, period)', () => {
  for (const course of ['Curragh', 'Down Royal', 'Lingfield (AW)', "Fairyhouse", 'Epsom Downs', 'Newton-Abbot', "St. Leger's", 'Ascot 2']) {
    const v = validateLauncherCourse(course);
    assert.equal(v.valid, true, `expected valid: "${course}" (${v.reason})`);
  }
});

test('course: every forbidden cmd metacharacter is rejected by name, never rewritten', () => {
  for (const { char, name } of FORBIDDEN_COURSE_CHARACTERS) {
    const v = validateLauncherCourse(`Cur${char}ragh`);
    assert.equal(v.valid, false, `expected invalid for ${name}`);
    assert.match(v.reason ?? '', new RegExp(name), `reason should name the ${name}`);
  }
  // Outside-safe-set characters without a dedicated name are also rejected.
  assert.equal(validateLauncherCourse('Curragh;').valid, false);
  assert.equal(validateLauncherCourse('Curragh$').valid, false);
});

test('course: empty, whitespace-only, and padded input are rejected (no silent trim)', () => {
  assert.equal(validateLauncherCourse('').valid, false);
  assert.equal(validateLauncherCourse('   ').valid, false);
  const padded = validateLauncherCourse(' Curragh ');
  assert.equal(padded.valid, false);
  assert.match(padded.reason ?? '', /whitespace/);
});

test('course: reserved nationwide representations are rejected in every spelling', () => {
  for (const raw of ['all-uk-ire', 'all uk ire', 'ALL-UK-IRE', 'All UK Ire', 'ALL  UK  IRE']) {
    const v = validateLauncherCourse(raw);
    assert.equal(v.valid, false, `expected reserved rejection: "${raw}"`);
    assert.match(v.reason ?? '', /nationwide|selected-course/);
  }
});

test('course slug: reuses normalizeCourse (Royal Ascot -> ascot; Lingfield (AW) -> lingfield)', () => {
  assert.equal(buildCourseSlug('Curragh'), 'curragh');
  assert.equal(buildCourseSlug('Royal Ascot'), 'ascot');
  assert.equal(buildCourseSlug('Lingfield (AW)'), 'lingfield');
  assert.equal(buildCourseSlug('Down Royal'), 'down-royal');
});

/* -------------------------------- URLs --------------------------------------- */

test('local URL: scoped, encoded, from a validated base; invalid/credentialed bases refused', () => {
  assert.equal(
    buildScopedDashboardUrl('http://localhost:3000', DATE, 'Down Royal'),
    'http://localhost:3000/?date=2026-07-18&course=Down%20Royal',
  );
  assert.equal(buildScopedDashboardUrl('ftp://x', DATE, 'Curragh'), null);
  assert.equal(buildScopedDashboardUrl('http://user:pass@host', DATE, 'Curragh'), null);
  assert.equal(buildScopedDashboardUrl('not a url', DATE, 'Curragh'), null);
});

test('public URL: ONLY from explicit PUBLIC_DASHBOARD_URL — absent -> not_configured, invalid -> invalid, never guessed', () => {
  assert.deepEqual(resolvePublicDashboardUrl(undefined, DATE, 'Curragh'), { configured: false, reason: 'not_configured' });
  assert.deepEqual(resolvePublicDashboardUrl('', DATE, 'Curragh'), { configured: false, reason: 'not_configured' });
  assert.deepEqual(resolvePublicDashboardUrl('http://u:p@host', DATE, 'Curragh'), { configured: false, reason: 'invalid' });
  const ok = resolvePublicDashboardUrl('https://example-dashboard.app', DATE, 'Down Royal');
  assert.equal(ok.configured, true);
  assert.equal(ok.configured && ok.url, 'https://example-dashboard.app/?date=2026-07-18&course=Down%20Royal');
});

test('launch-check evaluation: valid input yields slug + URLs; each invalid input yields ok:false', () => {
  const ok = evaluateLaunchCheck({ date: DATE, course: 'Curragh' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.slug, 'curragh');
  assert.equal(ok.ok && ok.localUrl, `${DEFAULT_LOCAL_BASE_URL}/?date=2026-07-18&course=Curragh`);
  assert.equal(ok.ok && ok.prodUrl, null); // public URL not configured -> null

  assert.equal(evaluateLaunchCheck({ date: '2026-13-40', course: 'Curragh' }).ok, false);
  assert.equal(evaluateLaunchCheck({ date: null, course: 'Curragh' }).ok, false);
  assert.equal(evaluateLaunchCheck({ date: DATE, course: 'all-uk-ire' }).ok, false);
  assert.equal(evaluateLaunchCheck({ date: DATE, course: 'Cur&ragh' }).ok, false);
  assert.equal(evaluateLaunchCheck({ date: DATE, course: 'Curragh', baseUrl: 'http://u:p@x' }).ok, false);
});

/* ------------------------------ lock metadata -------------------------------- */

test('lock metadata: only date/course/slug/created_at (+ optional diagnostic pid) — no secret-shaped values', () => {
  const lines = buildLauncherLockMetadataLines({
    date: DATE,
    course: 'Curragh',
    slug: 'curragh',
    createdAtIso: '2026-07-18T09:00:00.000Z',
    pid: 1234,
  });
  assert.equal(lines.length, 5);
  assert.equal(lines[0], `date=${DATE}`);
  assert.match(lines[4], /^launcher_pid=1234 \(diagnostic only/);
  const joined = lines.join('\n');
  assert.equal(/key|secret|token|password|bearer|authorization|CRON|SUPABASE|BETFAIR|RACING_API/i.test(joined), false);
  // pid omitted when not supplied
  assert.equal(
    buildLauncherLockMetadataLines({ date: DATE, course: 'Curragh', slug: 'curragh', createdAtIso: 't' }).length,
    4,
  );
});

/* --------------------------- exit classification ----------------------------- */

test('pipeline-watch exit classification: 0/2/3 terminal, everything else bounded-retryable; max 5 retries at 60s', () => {
  assert.equal(classifyPipelineWatchExit(0), 'terminal_graceful');
  assert.equal(classifyPipelineWatchExit(2), 'terminal_mechanism');
  assert.equal(classifyPipelineWatchExit(3), 'terminal_ownership');
  assert.equal(classifyPipelineWatchExit(1), 'retryable');
  assert.equal(classifyPipelineWatchExit(99), 'retryable');
  assert.equal(MAX_PIPELINE_WATCH_RETRIES, 5);
  assert.equal(PIPELINE_WATCH_RETRY_DELAY_SECONDS, 60);
});

/* --------------------------- planned commands -------------------------------- */

test('planned watcher commands: exactly three roles, validated args quoted, results dry-run-first, no nationwide scope', () => {
  const commands = buildPlannedWatcherCommands(DATE, 'Down Royal');
  assert.equal(commands.length, 3);
  assert.match(commands[0], /^npm run pipeline:watch -- --date 2026-07-18 --course "Down Royal" --interval-minutes 5 --commit$/);
  assert.match(commands[1], /^npm run lock:t-minus -- --date 2026-07-18 --course "Down Royal" --minutes-before 5 --commit$/);
  assert.match(commands[2], /^npm run results:auto -- --date 2026-07-18 --course "Down Royal" {2}\(dry-run first/);
  assert.equal(commands.join(' ').includes('all-uk-ire'), false);
});

/* ------------------------------ source scans ---------------------------------- */

const LIB_SRC = () => readFileSync('src/lib/raceDayLauncher.ts', 'utf8');
const CLI_SRC = () => readFileSync('scripts/raceDayLaunchCheck.ts', 'utf8');

test('launch-check CLI is read-only: no fs writes, no DB, no network, no child processes', () => {
  const src = CLI_SRC();
  assert.equal(/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/.test(src), false);
  assert.equal(/supabase|from\s+['"][^'"]*supabaseAdmin['"]/i.test(src), false);
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(/child_process|spawnSync|spawn\(|execSync|fork\(/.test(src), false);
  assert.equal(/producerClaim|producerOwnership|tryAcquire|heartbeat|release/i.test(src), false);
});

test('no hardcoded course, date, or Railway host in the launcher lib/CLI', () => {
  for (const src of [LIB_SRC(), CLI_SRC()]) {
    assert.equal(/newmarket|ascot|curragh/i.test(src), false, 'no hardcoded course');
    assert.equal(/\b20\d{2}-\d{2}-\d{2}\b/.test(src), false, 'no hardcoded date');
    assert.equal(/railway\.app/i.test(src), false, 'no hardcoded Railway host');
  }
});

test('PUBLIC_DASHBOARD_URL is the ONLY public-URL source — PIPELINE_BASE_URL is never READ', () => {
  // The CLI reads exactly one URL config variable. The lib's docstring may
  // MENTION PIPELINE_BASE_URL (to document that it is deliberately not used),
  // so the scan targets actual env READS, not prose.
  assert.match(CLI_SRC(), /process\.env\.PUBLIC_DASHBOARD_URL/);
  for (const src of [LIB_SRC(), CLI_SRC()]) {
    assert.equal(/process\.env\.PIPELINE_BASE_URL/.test(src), false);
  }
});
