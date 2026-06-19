/**
 * Unit tests for the launch secret / local-artifact scanner
 * (src/lib/secretScan.ts) plus read-only source-scan guards on the CLI.
 *
 * SECRET-SAFE: these tests use SYNTHETIC, non-real fixtures only and assert that
 * findings + the rendered report carry rule/level/path metadata but NEVER the
 * matched value. They lock the rules: real secret material is flagged, obvious
 * placeholders + test fixtures are not failed, and the CLI never reads ignored
 * files. Run with:  npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  scanContent,
  classifyRiskyFilename,
  isPlaceholderValue,
  isLowTrustPath,
  summarizeFindings,
  missingGitignorePatterns,
  renderSecretReport,
  RECOMMENDED_GITIGNORE_PATTERNS,
  isCodeReference,
} from '../src/lib/secretScan';

// Synthetic, non-real tokens built by concatenation (not real credentials).
const SK = 'sk-' + 'live' + 'A1b2C3d4E5f6G7h8J9k0L1m2N3';
const PEM = '-----BEGIN RSA PRIVATE KEY-----';
const PROD = 'config/prod.ts'; // a non-low-trust path

/* ----------------------------- content rules ------------------------------ */

test('scanContent flags a PEM private key as critical (real path)', () => {
  const f = scanContent(PROD, `const k = "${PEM}";`, 'tracked');
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'private_key');
  assert.equal(f[0].level, 'critical');
  assert.equal(f[0].line, 1);
});

test('scanContent flags an sk- key (critical) but SKIPS an obvious FAKE one', () => {
  assert.equal(scanContent(PROD, `OPENAI_API_KEY=${SK}`, 'tracked')[0].level, 'critical');
  // A placeholder value (contains FAKE) is not a secret.
  assert.deepEqual(scanContent(PROD, 'OPENAI_API_KEY=sk-FAKE-not-a-real-secret-0000', 'tracked'), []);
});

test('scanContent flags a JWT-shaped token as high', () => {
  const jwt = 'eyJhbGciOiJ' + 'IUzI1Niable.' + 'eyJzdWIiOiIxMjM.' + 'abcdef';
  const f = scanContent(PROD, `KEY=${jwt}`, 'tracked');
  assert.ok(f.some((x) => x.rule === 'jwt_token' && x.level === 'high'));
});

test('scanContent flags a sensitive env assignment but ignores empty / short / placeholder values', () => {
  assert.ok(scanContent(PROD, 'SUPABASE_SERVICE_ROLE_KEY=Zk9Long-Real-Looking-Value-123', 'tracked').some((x) => x.rule === 'env_assignment'));
  assert.deepEqual(scanContent('.env.example', 'OPENAI_API_KEY=', 'tracked'), []); // empty value
  assert.deepEqual(scanContent(PROD, "RACING_API_KEY = 'k'", 'tracked'), []); // short stub
  assert.deepEqual(scanContent(PROD, 'CRON_SECRET=YOUR_SECRET_HERE', 'tracked'), []); // placeholder
});

test('scanContent flags a bearer token with a value (high)', () => {
  assert.ok(scanContent(PROD, 'Authorization: Bearer abcdef0123456789ABCDEF', 'tracked').some((x) => x.rule === 'bearer_token'));
});

test('findings on a low-trust (test) path are downgraded to info', () => {
  const f = scanContent('scripts/foo.test.ts', `const k = "${PEM}";`, 'tracked');
  assert.equal(f[0].level, 'info');
});

/* ----------------------------- filename rules ----------------------------- */

test('classifyRiskyFilename flags key/cert/env-dump files by name', () => {
  assert.equal(classifyRiskyFilename('client-2048.key', 'untracked')?.level, 'critical');
  assert.equal(classifyRiskyFilename('secrets/server.pem', 'tracked')?.level, 'critical');
  assert.equal(classifyRiskyFilename('client-2048.crt', 'untracked')?.level, 'high');
  assert.equal(classifyRiskyFilename('betfair-key-env.txt', 'untracked')?.level, 'high');
  assert.equal(classifyRiskyFilename('id_rsa', 'untracked')?.level, 'critical');
  assert.equal(classifyRiskyFilename('.env.local', 'untracked')?.level, 'high');
});

test('classifyRiskyFilename allows .env.example and ignores correctly-ignored files', () => {
  assert.equal(classifyRiskyFilename('.env.example', 'tracked'), null);
  assert.equal(classifyRiskyFilename('src/lib/foo.ts', 'tracked'), null);
  // A key file that is git-ignored is local-only and acceptable.
  assert.equal(classifyRiskyFilename('client-2048.key', 'ignored'), null);
});

/* ------------------------------- helpers ---------------------------------- */

test('isPlaceholderValue: short / FAKE / EXAMPLE / <...> are placeholders; long real ones are not', () => {
  assert.equal(isPlaceholderValue('u'), true);
  assert.equal(isPlaceholderValue('topsecret'), false); // 9 chars, no marker (handled by path instead)
  assert.equal(isPlaceholderValue('sk-FAKE-xxxxx'), true);
  assert.equal(isPlaceholderValue('YOUR_KEY_HERE'), true);
  assert.equal(isPlaceholderValue('<your-key>'), true);
  assert.equal(isPlaceholderValue('Zk9Long-Real-Looking-Value-123'), false);
});

test('isLowTrustPath: tests / examples / fixtures are low trust', () => {
  assert.equal(isLowTrustPath('scripts/foo.test.ts'), true);
  assert.equal(isLowTrustPath('data/results.example.csv'), true);
  assert.equal(isLowTrustPath('data/race-notes/example-notes.json'), true);
  assert.equal(isLowTrustPath('src/lib/secretScan.ts'), false);
});

test('isCodeReference skips env reads so process.env presence logs are not flagged', () => {
  assert.equal(isCodeReference('${process.env.CRON_SECRET'), true);
  assert.equal(isCodeReference('process.env.RACING_API_KEY'), true);
  assert.equal(isCodeReference('import.meta.env.FOO'), true);
  assert.equal(isCodeReference('Zk9Long-Real-Looking-Value-123'), false);
  // A presence-only log of a sensitive var is NOT flagged (the value is a code ref).
  assert.deepEqual(
    scanContent(PROD, "console.log(`CRON_SECRET: ${process.env.CRON_SECRET ? 'set' : 'MISSING'}`);", 'tracked'),
    [],
  );
});

test('summarizeFindings: ok only when there is no critical/high', () => {
  assert.equal(summarizeFindings([]).ok, true);
  assert.equal(summarizeFindings([{ path: 'a', rule: 'r', description: 'd', level: 'info', status: 'tracked' }]).ok, true);
  assert.equal(summarizeFindings([{ path: 'a', rule: 'r', description: 'd', level: 'high', status: 'tracked' }]).ok, false);
  const s = summarizeFindings([
    { path: 'a', rule: 'r', description: 'd', level: 'critical', status: 'tracked' },
    { path: 'b', rule: 'r', description: 'd', level: 'info', status: 'untracked' },
  ]);
  assert.deepEqual([s.critical, s.high, s.info, s.ok], [1, 0, 1, false]);
});

test('missingGitignorePatterns returns gaps and is empty when all present', () => {
  assert.ok(missingGitignorePatterns('# nothing\n').includes('*.key'));
  assert.deepEqual(missingGitignorePatterns(RECOMMENDED_GITIGNORE_PATTERNS.join('\n')), []);
});

/* --------------------------- secret-safety (KEY) -------------------------- */

test('findings + rendered report NEVER contain the matched secret value', () => {
  const content = `OPENAI_API_KEY=${SK}\nprivate = "${PEM}"`;
  const findings = scanContent(PROD, content, 'tracked');
  const summary = summarizeFindings(findings);
  const report = renderSecretReport(findings, summary);
  // The value is never serialised into the findings or the report.
  assert.equal(JSON.stringify(findings).includes(SK), false);
  assert.equal(report.includes(SK), false);
  // But the report DOES name the file + rule + level.
  assert.match(report, /private_key/);
  assert.match(report, new RegExp(PROD.replace('.', '\\.')));
  assert.match(report, /VERDICT: FAIL/);
});

test('renderSecretReport is deterministic and passes cleanly with no findings', () => {
  const empty = renderSecretReport([], summarizeFindings([]));
  assert.match(empty, /VERDICT: PASS/);
  assert.equal(renderSecretReport([], summarizeFindings([])), empty);
});

/* --------------------- read-only guards (source scans) -------------------- */

test('the scanner module is pure: no DB, env, network, or writes', () => {
  const lib = readFileSync('src/lib/secretScan.ts', 'utf8');
  assert.equal(/supabaseAdmin/.test(lib), false);
  assert.equal(/process\.env/.test(lib), false);
  assert.equal(/\bfetch\s*\(/.test(lib), false);
  assert.equal(/\.(insert|update|upsert|delete|rpc)\s*\(/.test(lib), false);
  assert.equal(/writeFileSync|mkdirSync/.test(lib), false);
});

test('the CLI excludes ignored files, never prints file content, and writes nothing', () => {
  const cli = readFileSync('scripts/securitySecretsCheck.ts', 'utf8');
  // Ignored files (e.g. .env.local) are excluded from the scan + never read.
  assert.match(cli, /--exclude-standard/);
  assert.match(cli, /check-ignore/);
  // No DB / network / file writes.
  assert.equal(/supabaseAdmin|\bfetch\s*\(/.test(cli), false);
  assert.equal(/writeFileSync|mkdirSync|\.(insert|update|upsert|delete|rpc)\s*\(/.test(cli), false);
  // Never logs raw file content (only the value-free report).
  assert.equal(/console\.\w+\([^)]*\bcontent\b/.test(cli), false);
});
