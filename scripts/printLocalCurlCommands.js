/**
 * Print-only helper: writes the local route commands (curl + PowerShell) to the
 * console so they are easy to copy-paste on Windows. It NEVER executes a
 * request, never reads or prints CRON_SECRET (it emits a `<CRON_SECRET>`
 * placeholder), and changes nothing. See docs/WINDOWS_COMMANDS.md for context.
 *
 * Usage:
 *   npm run local:racecards            # default port 3000
 *   npm run local:racecards -- 3001    # custom port
 */

const port = process.argv[2] || '3000';
const base = `http://localhost:${port}`;

const lines = [
  '',
  `Local route commands (port ${port}) - copy/paste; nothing is executed.`,
  'Replace <CRON_SECRET> with your value only if CRON_SECRET is set. Never share it.',
  '',
  '# 1) Start the dev server in another terminal:',
  '    npm run dev',
  '',
  '# 2) Ingest racecards (GET) - open in local/dev when CRON_SECRET is unset:',
  `    curl ${base}/api/cron/racecards`,
  '',
  '#    PowerShell (native cmdlet):',
  `    Invoke-WebRequest -Uri "${base}/api/cron/racecards" -UseBasicParsing | Select-Object -ExpandProperty Content`,
  '',
  '#    With CRON_SECRET set (use curl.exe, not the PowerShell curl alias):',
  `    curl.exe -H "Authorization: Bearer <CRON_SECRET>" ${base}/api/cron/racecards`,
  '',
  '# 3) Other cron routes (same pattern):',
  `    curl ${base}/api/cron/odds`,
  `    curl ${base}/api/cron/results`,
  `    curl ${base}/api/cron/tipster-discovery`,
  '',
  '# 4) Run the model for one race (POST; only Supabase needed):',
  `    curl.exe -X POST "${base}/api/run-model?race_id=<race_id>"`,
  `    Invoke-WebRequest -Method POST -Uri "${base}/api/run-model?race_id=<race_id>" -UseBasicParsing | Select-Object -ExpandProperty Content`,
  '',
  '# Detect which port the dev server is on:',
  '    Get-NetTCPConnection -State Listen -LocalPort 3000,3001 | Select-Object LocalPort, OwningProcess',
  '',
];

console.log(lines.join('\n'));
