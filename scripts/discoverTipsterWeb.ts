/**
 * CLI: `tipsters:discover-web` — PUBLIC tipster discovery PLANNER (no scraping).
 *
 * SAFETY (by design, not by flag): this command performs NO network I/O. It does
 * not fetch, scrape, browse, or bypass any wall. It is the COMPLIANCE planner +
 * LOCAL extractor:
 *
 *   - It CLASSIFIES candidate sources (seed list + any `--url`), hard-BLOCKING the
 *     subscription walls (Racing Post / Tipstrr / Betting Gods / Tipsters Empire)
 *     and flagging every other source as "operator must confirm robots.txt/ToS
 *     and supply short excerpts locally."
 *   - It EXTRACTS opinions only from operator-SUPPLIED LOCAL notes (`--notes`),
 *     through the existing evidence-grounding gate, truncating to short excerpts
 *     (never full articles) and stamping `retrieved_at` + `source_url`.
 *   - Every emitted row is `review_status=pending`, `model_active_eligible=false`.
 *     Nothing is model-active; no model/staking math changes; no bets.
 *
 * Usage:
 *   npm run tipsters:discover-web -- --date 2026-06-19 --course Ascot \
 *     [--url <candidate-url> ...] [--notes <local-notes.json>] \
 *     --output data/tipster-opinions-2026-06-19-ascot.csv
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  PUBLIC_SEED_SOURCES,
  classifySource,
  truncateExcerpt,
} from '../src/lib/tipsterWebDiscovery';
import {
  extractOpinions,
  serializeOpinionCsv,
  OPINION_COLUMNS,
  type TipsterNotesFile,
} from '../src/lib/tipsterOpinions';

interface Args {
  date?: string;
  course?: string;
  urls: string[];
  notes?: string;
  output?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { urls: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') args.date = (argv[++i] ?? '').trim();
    else if (argv[i] === '--course') args.course = (argv[++i] ?? '').trim();
    else if (argv[i] === '--url') args.urls.push((argv[++i] ?? '').trim());
    else if (argv[i] === '--notes') args.notes = (argv[++i] ?? '').trim();
    else if (argv[i] === '--output') args.output = (argv[++i] ?? '').trim();
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log('Public tipster discovery — COMPLIANCE PLANNER (no scraping, no network I/O)');
  console.log('========================================================================');
  console.log(`Meeting: ${args.date ?? '?'}${args.course ? ` · ${args.course}` : ''}`);
  console.log('This tool never fetches the web. Subscription walls are blocked; other');
  console.log('sources require operator-confirmed robots.txt/ToS + locally-supplied short');
  console.log('excerpts. It never stores full articles and never fabricates a tip.\n');

  // 1. Seed sources + their access class.
  console.log('Configured public/media seed sources (operator supplies ToS-cleared excerpts):');
  for (const s of PUBLIC_SEED_SOURCES) {
    console.log(`  - [${s.access_class}] ${s.label}${s.ingestible ? '' : ' (synthetic — never a real tipster)'}`);
  }

  // 2. Classify any operator-supplied candidate URLs (planning only — no fetch).
  if (args.urls.length > 0) {
    console.log('\nCandidate URL classification (no fetch performed):');
    for (const url of args.urls) {
      const c = classifySource(url);
      const tag = c.decision === 'blocked_wall' ? 'BLOCKED' : c.permitted ? 'OK-IF-CONFIRMED' : 'SKIP';
      console.log(`  [${tag}] ${c.host || url} — ${c.reason}`);
    }
  }

  // 3. Extract opinions from operator-supplied LOCAL notes only (no web fetch).
  let rows: ReturnType<typeof extractOpinions>['rows'] = [];
  if (args.notes) {
    let file: TipsterNotesFile;
    try {
      const parsed = JSON.parse(readFileSync(args.notes, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as TipsterNotesFile).notes)) {
        throw new Error('expected { "notes": [ ... ] }');
      }
      file = parsed as TipsterNotesFile;
    } catch (err) {
      console.error(`\nInvalid local notes JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const result = extractOpinions(file);
    const retrievedAt = new Date().toISOString();
    // Enforce SHORT excerpts + stamp retrieved_at (never store full text).
    rows = result.rows.map((r) => ({
      ...r,
      evidence_excerpt: truncateExcerpt(r.evidence_excerpt),
      notes: [r.notes, `retrieved_at=${retrievedAt}`].filter(Boolean).join(' | '),
    }));
    console.log('\nLocal extraction audit:');
    for (const [k, v] of Object.entries(result.audit)) console.log(`  ${k}: ${v}`);
    for (const w of result.warnings.slice(0, 30)) console.log(`  - ${w}`);
  } else {
    console.log('\nNo --notes supplied → no opinions extracted (this tool never auto-fetches the web).');
  }

  // 4. Write the opinions CSV (header always; rows only from local notes).
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    const csv = rows.length > 0 ? serializeOpinionCsv(rows) : OPINION_COLUMNS.join(',') + '\n';
    writeFileSync(args.output, csv, 'utf8');
    console.log(`\nOpinions CSV written (${rows.length} row(s), all pending) -> ${args.output}`);
    console.log('Review next:  npm run tipsters:review-opinions -- --file ' + args.output);
  }
  console.log('\n(no network) Nothing was fetched, scraped, or made model-active.');
}

main();
