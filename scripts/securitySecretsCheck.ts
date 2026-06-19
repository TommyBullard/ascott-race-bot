/**
 * CLI: launch security check for secrets + risky local artifacts.
 *
 * Scans every TRACKED and UNTRACKED-but-not-ignored file for secret material
 * (private keys, certs, sk- / JWT tokens, sensitive env assignments, bearer
 * tokens) and risky filenames (key/cert/env-dump files), and reports ONLY the
 * file path, rule, and risk level — NEVER a secret value.
 *
 * SECRET-SAFE BY CONSTRUCTION: git-ignored files (e.g. `.env.local`) are never
 * read, so their contents cannot leak. It performs no DB access, no network, and
 * no writes. Exit code is 1 when any committable secret (critical/high) is found,
 * else 0.
 *
 * Usage:
 *   npm run security:secrets-check
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

import {
  scanContent,
  classifyRiskyFilename,
  summarizeFindings,
  renderSecretReport,
  missingGitignorePatterns,
  type SecretFinding,
  type FileStatus,
} from '../src/lib/secretScan';

const MAX_BYTES = 1_500_000;
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'svg', 'woff', 'woff2', 'ttf', 'eot',
  'pdf', 'zip', 'gz', 'tar', 'mp4', 'mov', 'mp3', 'wasm', 'node', 'lock',
]);

/** Runs git, returning trimmed stdout lines; [] on failure. */
function gitLines(args: string[]): string[] {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '');
  } catch {
    return [];
  }
}

/** True when `path` is git-ignored. */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isBinaryPath(path: string): boolean {
  const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  return BINARY_EXT.has(ext);
}

/** Reads a small text file, or null when missing / too big / binary. */
function readTextFile(path: string): string | null {
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    const content = readFileSync(path, 'utf8');
    if (content.includes('\u0000')) return null; // binary
    return content;
  } catch {
    return null;
  }
}

function main(): void {
  const tracked = gitLines(['ls-files']);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);
  const files: { path: string; status: FileStatus }[] = [
    ...tracked.map((path) => ({ path, status: 'tracked' as const })),
    ...untracked.map((path) => ({ path, status: 'untracked' as const })),
  ];

  const findings: SecretFinding[] = [];
  for (const { path, status } of files) {
    const nameFinding = classifyRiskyFilename(path, status);
    if (nameFinding) findings.push(nameFinding);
    if (isBinaryPath(path)) continue;
    const content = readTextFile(path);
    if (content !== null) findings.push(...scanContent(path, content, status));
  }

  const summary = summarizeFindings(findings);
  console.log(renderSecretReport(findings, summary));

  // Positive ignore checks (filenames only — these files are never read).
  console.log('\nIgnore checks:');
  for (const f of ['.env.local', '.env', 'client-2048.key', 'betfair-key-env.txt']) {
    console.log(`  ${isIgnored(f) ? '\u2713 ignored' : '\u2717 NOT ignored'}  ${f}`);
  }

  // .gitignore hardening recommendations.
  let gitignore = '';
  try {
    gitignore = readFileSync('.gitignore', 'utf8');
  } catch {
    /* none */
  }
  const missing = missingGitignorePatterns(gitignore);
  if (missing.length > 0) {
    console.log('\nRecommended .gitignore additions (not yet present):');
    for (const p of missing) console.log(`  ${p}`);
  } else {
    console.log('\n.gitignore already covers the recommended secret/key/cert patterns.');
  }

  console.log(
    summary.ok
      ? '\nNo committable secrets detected.'
      : '\nCommittable secret material detected — resolve before committing.',
  );
  process.exitCode = summary.ok ? 0 : 1;
}

main();
