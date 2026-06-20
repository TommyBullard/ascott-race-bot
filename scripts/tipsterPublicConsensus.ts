/**
 * `tipster:public-consensus` — RESEARCH-ONLY public-source consensus report.
 *
 * Reads the LOCAL manual-review CSV of public tipster opinions, groups them by
 * race + runner, and writes a Markdown + JSON report:
 *
 *   race | runner | number of public-source mentions | sources | model pick |
 *   market favourite | agreement
 *
 * It is strictly read-only and research-only:
 *   - It reads ONE local CSV file (no scraping, no network capture).
 *   - It best-effort reads the stored model pick + market favourite per race via
 *     SELECT-only queries (fail-open to "—" when creds/data are absent).
 *   - It writes NOTHING to the database, imports no selections, makes nothing
 *     model-active, and changes no model probability, EV, staking, ranking, or
 *     recommendation. No bets are placed.
 *
 * Usage:
 *   npm run tipster:public-consensus -- --date 2026-06-20 --course Ascot
 *   [--file data/tipster-opinions-2026-06-20-ascot-manual-review.csv]
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import { fetchRaceIdsForMeeting, fetchRaceCard } from '../src/lib/raceData';
import { parseManualReviewCsv } from '../src/lib/tipsterManualReview';
import {
  buildPublicConsensusReport,
  renderPublicConsensusMarkdown,
  raceKey,
  type ConsensusContextMap,
} from '../src/lib/tipsterPublicConsensus';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      /* next */
    }
  }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function slug(course: string): string {
  return course.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** HH:MM in Europe/London for an ISO timestamp (handles BST). Never throws. */
function londonHhMm(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

/** Best-effort, read-only model pick + favourite per race. Never throws. */
async function buildContext(date: string, wantCourse: string | null): Promise<ConsensusContextMap> {
  const context: ConsensusContextMap = {};
  try {
    const ids = await fetchRaceIdsForMeeting(date);
    const cards = await Promise.allSettled(ids.map((id) => fetchRaceCard(id)));
    for (const result of cards) {
      if (result.status !== 'fulfilled') continue;
      const card = result.value;
      if (wantCourse && normalizeCourse(card.course ?? '') !== wantCourse) continue;
      const name = card.race_name ?? '';
      const utcTime = card.off_time ? new Date(card.off_time).toISOString().slice(11, 16) : '';
      const localTime = card.off_time ? londonHhMm(card.off_time) : '';
      if (utcTime === '' && name === '') continue;
      const entry = {
        modelPickHorse: card.modelPick?.horse_name ?? null,
        marketFavouriteHorse: card.favourite?.horse_name ?? null,
      };
      // The manual-review CSV uses London local times (e.g. 14:30) while the DB
      // stores UTC (13:30). Key by both UTC and London-local time (+ name) so the
      // research rows match regardless of which the operator captured.
      context[raceKey(utcTime, name)] = entry;
      if (utcTime !== '') context[raceKey(utcTime, '')] = entry;
      if (localTime !== '') {
        context[raceKey(localTime, name)] = entry;
        context[raceKey(localTime, '')] = entry;
      }
    }
  } catch {
    /* fail-open: context stays empty, columns render as "—" */
  }
  return context;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let date: string | undefined;
  let course = 'Ascot';
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = (argv[++i] ?? '').trim();
    else if (argv[i] === '--course') course = (argv[++i] ?? '').trim();
    else if (argv[i] === '--file') file = (argv[++i] ?? '').trim();
  }
  if (!date || !isValidIsoDate(date)) {
    console.error(
      'Usage: npm run tipster:public-consensus -- --date YYYY-MM-DD [--course <name>] [--file <csv>]',
    );
    process.exitCode = 1;
    return;
  }

  const csvPath = file ?? `data/tipster-opinions-${date}-${slug(course)}-manual-review.csv`;
  if (!existsSync(csvPath)) {
    console.error(`Manual-review CSV not found: ${csvPath}`);
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const wantCourse = course ? normalizeCourse(course) : null;
  const rows = parseManualReviewCsv(readFileSync(csvPath, 'utf8'));
  const context = await buildContext(date, wantCourse);

  const report = buildPublicConsensusReport({
    date,
    course,
    generatedAt: new Date().toISOString(),
    rows,
    context,
  });

  const base = `reports/tipster-public-consensus-${date}-${slug(course)}`;
  mkdirSync('reports', { recursive: true });
  writeFileSync(`${base}.md`, renderPublicConsensusMarkdown(report), 'utf8');
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`Public-source consensus (research only): ${report.race_count} race(s), ${report.total_rows} row(s).`);
  console.log(`Wrote ${base}.md and ${base}.json`);
  console.log('Nothing imported, nothing model-active, no bets placed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
