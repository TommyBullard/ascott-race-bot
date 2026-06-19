/**
 * CLI: shadow-only GenAI race commentary.
 *
 * Combines REVIEWED, licence-cleared operator notes (from genai:prepare-notes)
 * with READ-ONLY stored racecard / model / market context to produce a
 * deterministic, provenance-tagged commentary report for a meeting.
 *
 * SAFETY:
 *   - READ-ONLY DB. It issues only `select` reads (via the shared read-only
 *     {@link fetchRaceCard}); it never writes the database, runs the model,
 *     fetches live odds, or passes a commit flag. The only write is the local
 *     Markdown report.
 *   - OFFLINE BY DEFAULT. It does NOT call any LLM unless `--live` is passed AND
 *     OPENAI_API_KEY is present (fail-closed via the client resolver). Without
 *     `--live` the report is rendered deterministically from stored facts.
 *   - SHADOW-ONLY. Nothing here changes model probabilities, recommendations,
 *     ranking, or staking, and it is never betting advice. The API key (when
 *     used) is never printed.
 *   - NO INVENTED EVIDENCE. With no reviewed notes it writes a "No reviewed GenAI
 *     evidence available" report instead of inventing commentary.
 *
 * Usage:
 *   npm run genai:commentary -- --date YYYY-MM-DD --course COURSE \
 *     --notes data/race-notes/example.json --output reports/genai-commentary-<date>-<course>.md [--live]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { normalizeCourse } from '../src/lib/raceSync';
import { fetchRaceIdsForMeeting, fetchRaceCard, type RaceCard } from '../src/lib/raceData';
import { buildRaceIntelligence } from '../src/lib/raceIntelligence';
import { assessGenaiNoteSource } from '../src/lib/genaiSourceReview';
import { resolveCommentaryClient } from '../src/lib/genaiClient';
import {
  generateRaceCommentary,
  renderCommentaryReport,
  type CommentaryEvidence,
  type CommentaryReportInput,
  type RaceCommentaryInput,
  type RaceCommentaryResult,
} from '../src/lib/genaiCommentaryPrompt';

interface Args {
  date?: string;
  course?: string;
  notes?: string;
  output?: string;
  live: boolean;
  errors: string[];
}

/** Loads env from `.env.local`, then `.env`; falls back to the shell env. */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to the shell env.
    }
  }
}

/** Strict YYYY-MM-DD validation (round-trips to the same date). */
function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { live: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (isValidIsoDate(v)) args.date = v;
      else args.errors.push('--date must be YYYY-MM-DD.');
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.course = v;
    } else if (a === '--notes') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.notes = v;
    } else if (a === '--output') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.output = v;
    } else if (a === '--live') {
      args.live = true;
    }
  }
  if (!args.date) args.errors.push('--date is required (YYYY-MM-DD).');
  return args;
}

function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Reads alignment_label safely from the observability alignment object. */
function alignmentLabel(card: RaceCard): string | null {
  const a = card.observability.tipsterModelAlignment;
  const label = a && typeof a === 'object' ? (a as Record<string, unknown>).alignment_label : null;
  return typeof label === 'string' && label.trim() !== '' ? label : null;
}

/** Maps a read-only RaceCard into the pure commentary input. */
function toRaceInput(
  card: RaceCard,
  reviewedNotes: RaceCommentaryInput['reviewedNotes'],
  notesScope: RaceCommentaryInput['notesScope'],
): RaceCommentaryInput {
  const settled =
    card.status === 'result' || card.runners.some((r) => isFiniteNum(r.finish_pos));
  const intel = buildRaceIntelligence({
    runners: card.runners.map((r) => ({
      runner_id: r.runner_id,
      horse_name: r.horse_name,
      odds: r.odds,
      market_prob: r.market_prob,
      model_prob: r.model_prob,
      ev: r.ev,
      rank: r.rank,
      finish_pos: r.finish_pos,
    })),
    favourite: card.favourite
      ? {
          runner_id: card.favourite.runner_id,
          horse_name: card.favourite.horse_name,
          odds: card.favourite.odds,
          market_prob: card.favourite.market_prob,
          model_prob: card.favourite.model_prob,
          ev: card.favourite.ev,
          rank: card.favourite.rank,
          finish_pos: card.favourite.finish_pos,
        }
      : null,
    modelPickRunnerId: card.modelPick?.runner_id ?? null,
    settled,
  });
  const wv = intel.winValueCandidate;
  const wvEv = wv ? (card.runners.find((r) => r.runner_id === wv.runner_id)?.ev ?? null) : null;

  return {
    raceId: card.race_id,
    course: card.course,
    raceName: card.race_name,
    offTime: card.off_time,
    fieldSize: card.runners.length > 0 ? card.runners.length : null,
    raceState: card.status,
    settled,
    hasModelRun: card.hasModelRun,
    modelPick: card.modelPick
      ? {
          horseName: card.modelPick.horse_name,
          odds: card.modelPick.odds,
          modelProb: card.modelPick.model_prob,
          marketProb: card.modelPick.market_prob,
          edge: card.modelPick.edge,
          ev: card.modelPick.ev,
          confidenceLabel: card.modelPick.confidence_label,
          isFavourite: card.modelPick.isFavourite,
          stakeSuppressed: card.modelPick.stake_amount === 0,
        }
      : null,
    marketFavourite: card.favourite
      ? {
          horseName: card.favourite.horse_name,
          odds: card.favourite.odds,
          modelProb: card.favourite.model_prob,
          marketProb: card.favourite.market_prob,
          edge: card.favourite.edge,
          ev: card.favourite.ev,
          confidenceLabel: null,
        }
      : null,
    winValue: wv ? { horseName: wv.horse_name, odds: wv.odds, ev: wvEv } : null,
    eachWay: intel.eachWayCandidate
      ? { horseName: intel.eachWayCandidate.horse_name, odds: intel.eachWayCandidate.odds }
      : null,
    runQuality: card.observability.runQuality,
    dataQualityShortSummary: card.observability.dataQualityShortSummary,
    dataQualitySummary: card.observability.dataQualitySummary,
    tipsterConsensusShortSummary: card.observability.tipsterConsensusShortSummary,
    tipsterAlignmentLabel: alignmentLabel(card),
    reviewedNotes,
    notesScope,
  };
}

/** Loose race-name match for attaching a note to a specific stored race. */
function raceNameMatches(noteRaceName: string, storedRaceName: string | null): boolean {
  if (!storedRaceName) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = norm(noteRaceName);
  const b = norm(storedRaceName);
  return a !== '' && (a === b || b.includes(a) || a.includes(b));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length > 0) {
    console.error('genai:commentary — shadow-only race commentary (read-only DB, offline by default).\n');
    for (const e of args.errors) console.error(`  - ${e}`);
    console.error(
      '\nUsage: npm run genai:commentary -- --date YYYY-MM-DD [--course <name>] [--notes <notes.json>] [--output <report.md>] [--live]',
    );
    console.error('Read-only: SELECT-only DB reads; no model run, no DB writes, no commit flag. --live needs OPENAI_API_KEY.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const date = args.date as string;
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  // 1. Reviewed, licence-cleared evidence (local file; never fabricated).
  let evidence: CommentaryEvidence | null = null;
  if (args.notes) {
    try {
      const parsed = JSON.parse(readFileSync(args.notes, 'utf8')) as unknown;
      const assessment = assessGenaiNoteSource(parsed);
      if (assessment.ready_for_extraction) {
        const courseMatches = !args.course || normalizeCourse(assessment.course) === wantCourse;
        evidence = {
          sourceDocumentId: assessment.source_document_id,
          sourceLabel: assessment.source_label,
          sourceType: assessment.source_type,
          licenceStatus: assessment.licence_status,
          noteRaceName: assessment.race_name,
          excerpt: assessment.raw_note_excerpt,
          notes: assessment.notes,
          dateMatchesCommand: assessment.race_date === date,
          courseMatchesCommand: courseMatches,
          noteRaceDate: assessment.race_date,
        };
        if (!courseMatches) {
          console.error(
            `Note course "${assessment.course}" does not match --course "${args.course}". ` +
              'Treating as no applicable evidence.',
          );
          evidence = null;
        }
      } else {
        console.error(
          `Notes file "${args.notes}" is not ready for extraction ` +
            `(licence: ${assessment.licence_policy}, errors: ${assessment.errors.length}). ` +
            'Producing a no-evidence report.',
        );
      }
    } catch (err) {
      console.error(
        `Could not read/parse notes file "${args.notes}": ${err instanceof Error ? err.message : String(err)}. ` +
          'Producing a no-evidence report.',
      );
    }
  }

  // 2. Read-only stored races for the meeting; filter by course.
  const cards: RaceCard[] = [];
  try {
    const allIds = await fetchRaceIdsForMeeting(date);
    const settled = await Promise.allSettled(allIds.map((id) => fetchRaceCard(id)));
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        console.error('Skipped a race (read failed):', result.reason);
        continue;
      }
      const card = result.value;
      if (wantCourse && normalizeCourse(card.course) !== wantCourse) continue;
      cards.push(card);
    }
  } catch (err) {
    console.error(
      `Failed to read races for ${date}: ${err instanceof Error ? err.message : String(err)}\n` +
        '(check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local — read-only access).',
    );
    process.exitCode = 1;
    return;
  }
  cards.sort((a, b) => (a.off_time ?? '').localeCompare(b.off_time ?? ''));

  // 3. Attach reviewed notes per race (race-specific where the name matches,
  //    else meeting-level fallback). No evidence => scope 'none'.
  const matchedIds = new Set<string>();
  if (evidence?.noteRaceName) {
    for (const card of cards) {
      if (raceNameMatches(evidence.noteRaceName, card.race_name)) matchedIds.add(card.race_id);
    }
  }
  const meetingLevel = evidence != null && matchedIds.size === 0;

  const races: RaceCommentaryInput[] = cards.map((card) => {
    let scope: RaceCommentaryInput['notesScope'] = 'none';
    if (evidence) {
      if (matchedIds.size > 0) scope = matchedIds.has(card.race_id) ? 'race' : 'none';
      else scope = 'meeting';
    }
    const reviewedNotes = evidence && scope !== 'none' ? evidence.notes : [];
    return toRaceInput(card, reviewedNotes, scope);
  });

  // 4. Optional live AI prose (only with --live AND a present OPENAI_API_KEY).
  let mode: 'offline' | 'live' = 'offline';
  let liveCallMade = false;
  let aiByRace: Record<string, RaceCommentaryResult | null> | undefined;
  if (args.live && evidence) {
    try {
      const resolved = resolveCommentaryClient({ live: true, env: process.env });
      mode = resolved.mode;
      aiByRace = {};
      for (const race of races) {
        aiByRace[race.raceId] = await generateRaceCommentary(resolved.client, race);
      }
      liveCallMade = resolved.willCallApi;
    } catch (err) {
      console.error(
        `--live requested but the GenAI client could not be configured: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
      return;
    }
  } else if (args.live && !evidence) {
    console.error('--live ignored: no reviewed evidence, so no commentary is generated.');
  }

  // 5. Render the deterministic report (no-evidence report when evidence is null).
  const reportInput: CommentaryReportInput = { date, course: args.course ?? null, evidence, races, aiByRace, mode, liveCallMade };
  const markdown = renderCommentaryReport(reportInput);

  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, markdown, 'utf8');
    console.log(`GenAI commentary written (shadow-only): ${args.output}`);
  } else {
    console.log(markdown);
  }
  console.log(
    `  races: ${races.length} · evidence: ${evidence ? 'yes' : 'no'} · mode: ${mode} · ` +
      `OpenAI called: ${liveCallMade ? 'yes' : 'no'}${meetingLevel ? ' · notes: meeting-level' : ''}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
