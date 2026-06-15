/**
 * Read-only env preflight check.
 *
 * Prints which required/optional environment variables are SET vs MISSING so an
 * operator can spot a missing `.env.local` entry before running the pipelines.
 *
 * SECURITY: this script NEVER prints, copies, or transforms a secret value. It
 * reports only the variable NAME and a presence marker (set / missing). It does
 * no DB or network I/O and writes nothing.
 *
 * Usage:
 *   npm run check:env
 *
 * Exit code: 0 when every REQUIRED variable is present; 1 when one or more
 * required variables are missing (handy for a preflight gate).
 */

import {
  summarizeEnvPresence,
  type EnvPresenceResult,
} from '../src/lib/envPreflight';

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

function line(r: EnvPresenceResult): string {
  const mark = r.present ? '\u2713 set    ' : '\u2717 missing';
  const tag = r.required ? 'required' : 'optional';
  const note = r.note ? `  — ${r.note}` : '';
  return `  ${mark}  ${r.name}  (${tag})${note}`;
}

function main(): void {
  loadEnv();

  const summary = summarizeEnvPresence(process.env);

  console.log('Environment preflight (presence only — no values are read out):\n');

  let currentGroup = '';
  for (const r of summary.results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      console.log(`${currentGroup}:`);
    }
    console.log(line(r));
  }

  console.log(
    `\n${summary.presentCount}/${summary.results.length} variable(s) set.`,
  );

  if (summary.ok) {
    console.log('All REQUIRED variables are present.');
    process.exitCode = 0;
  } else {
    console.log(`Missing REQUIRED: ${summary.missingRequired.join(', ')}`);
    console.log(
      'Add them to .env.local (see .env.example), then restart the dev server.',
    );
    process.exitCode = 1;
  }
}

main();
