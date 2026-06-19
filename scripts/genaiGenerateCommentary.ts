/**
 * CLI: generate + (optionally) store shadow GenAI commentary candidates.
 *
 * This wires the Phase 4G core ({@link generateShadowCommentary}) to the
 * OpenAI-backed generator ({@link resolveOpenAiShadowGenerator}) and the
 * `genai_commentary` review store. It is the "generate → validate → store →
 * (await human review)" half of the shadow pipeline. The "surface approved
 * notes" half is the read-only dashboard panel.
 *
 * SAFETY (enforced here + by the orchestrator/DB):
 *   - OFFLINE + DRY-RUN BY DEFAULT. No `--live` ⇒ NO OpenAI call. No `--commit`
 *     ⇒ NO database writes. The bare command only PLANS (lists eligible
 *     race/kind pairs) and writes nothing.
 *   - FAIL-CLOSED KEY. `--live` without OPENAI_API_KEY fails safely (value-free
 *     error) and writes no rows.
 *   - SHADOW-ONLY. Every stored row is `model_active = false` (DB CHECK) and
 *     `review_status = 'pending'`; only an approved candidate is ever surfaced.
 *     Nothing here changes model probabilities, EV, staking, ranking, or
 *     recommendations, and nothing is betting advice. The API key is never printed.
 *   - GRACEFUL DEGRADE. If `genai_commentary` is missing, it explains the
 *     migration and writes nothing.
 *
 * Usage:
 *   npm run genai:generate -- --date 2026-06-19 --course Ascot            # offline plan, no writes
 *   npm run genai:generate -- --date 2026-06-19 --course Ascot --live     # calls OpenAI, no writes
 *   npm run genai:generate -- --date 2026-06-19 --course Ascot --live --commit  # stores pending candidates
 */

import { normalizeCourse } from '../src/lib/raceSync';
import { fetchRaceIdsForMeeting, fetchRaceCard, type RaceCard } from '../src/lib/raceData';
import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import {
  COMMENTARY_KINDS,
  commentaryPrecondition,
  generateShadowCommentary,
  type CommentaryContext,
  type CommentaryKind,
  type ContextRunner,
} from '../src/lib/genaiShadowCommentary';
import { resolveOpenAiShadowGenerator } from '../src/lib/openAiShadowGenerator';

const GENAI_COMMENTARY_TABLE = 'genai_commentary';

interface Args {
  date?: string;
  course?: string;
  live: boolean;
  commit: boolean;
  errors: string[];
}

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // try next; fall back to the shell environment
    }
  }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { live: false, commit: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = (argv[++i] ?? '').trim();
      if (isValidIsoDate(v)) args.date = v;
      else args.errors.push('--date must be YYYY-MM-DD.');
    } else if (a === '--course') {
      const v = (argv[++i] ?? '').trim();
      if (v !== '') args.course = v;
    } else if (a === '--live') {
      args.live = true;
    } else if (a === '--commit') {
      args.commit = true;
    }
  }
  if (!args.date) args.errors.push('--date is required (YYYY-MM-DD).');
  return args;
}

function isFiniteNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function toContextRunner(r: {
  runner_id: string;
  horse_name: string;
  odds: number | null;
  market_prob: number | null;
  model_prob: number | null;
  edge: number | null;
  ev: number | null;
  confidence_label?: string | null;
}): ContextRunner {
  return {
    runnerId: r.runner_id,
    horseName: r.horse_name,
    odds: isFiniteNum(r.odds) ? r.odds : null,
    modelProb: isFiniteNum(r.model_prob) ? r.model_prob : null,
    marketProb: isFiniteNum(r.market_prob) ? r.market_prob : null,
    edge: isFiniteNum(r.edge) ? r.edge : null,
    ev: isFiniteNum(r.ev) ? r.ev : null,
    confidenceLabel: typeof r.confidence_label === 'string' ? r.confidence_label : null,
  };
}

function alignmentLabel(card: RaceCard): string | null {
  const a = card.observability.tipsterModelAlignment;
  const label = a && typeof a === 'object' ? (a as Record<string, unknown>).alignment_label : null;
  return typeof label === 'string' && label.trim() !== '' ? label : null;
}

/**
 * Builds a grounding {@link CommentaryContext} from a read-only RaceCard. Only
 * already-computed facts are used; absent facts stay null/empty (NEVER
 * fabricated), so kinds without supporting evidence fail their precondition and
 * are skipped rather than invented.
 */
function buildContextFromCard(card: RaceCard): CommentaryContext {
  const modelPick = card.modelPick ? toContextRunner(card.modelPick) : null;
  const favourite = card.favourite ? toContextRunner(card.favourite) : null;
  const agree = modelPick && favourite ? modelPick.runnerId === favourite.runnerId : null;
  const consensusDetail = card.observability.tipsterConsensusShortSummary;

  return {
    race: {
      course: card.course,
      raceName: card.race_name,
      offTime: card.off_time,
      fieldSize: card.runners.length > 0 ? card.runners.length : null,
    },
    modelPick,
    marketFavourite: favourite,
    runQuality: card.observability.runQuality,
    dataQualityFlags: [],
    consensus:
      typeof consensusDetail === 'string' && consensusDetail.trim() !== ''
        ? { strength: null, type: alignmentLabel(card), detail: consensusDetail }
        : null,
    // No narrative source on the read-only card => never fabricate one.
    narratives: { attractive: [], caution: [] },
    disagreement:
      modelPick && favourite
        ? {
            modelTopHorse: modelPick.horseName,
            marketTopHorse: favourite.horseName,
            agree,
            edge: modelPick.edge,
          }
        : null,
  };
}

/** Read-only probe: does the genai_commentary table exist on this DB? */
async function commentaryTableExists(): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from(GENAI_COMMENTARY_TABLE)
    .select('id', { head: true, count: 'exact' })
    .limit(1);
  if (!error) return true;
  const code = (error.code ?? '').toUpperCase();
  const msg = (error.message ?? '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist') || msg.includes('schema cache')) {
    return false;
  }
  // Unknown error: treat as not-storable to be safe (write nothing).
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length > 0) {
    console.error('genai:generate — generate + store shadow commentary candidates (offline + dry-run by default).\n');
    for (const e of args.errors) console.error(`  - ${e}`);
    console.error(
      '\nUsage: npm run genai:generate -- --date YYYY-MM-DD [--course <name>] [--live] [--commit]',
    );
    console.error('Offline + dry-run by default. --live calls OpenAI (needs OPENAI_API_KEY). --commit stores pending candidates.');
    process.exitCode = 1;
    return;
  }

  loadEnv();
  const date = args.date as string;
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  console.log(
    `GenAI shadow commentary — ${args.live ? 'LIVE (OpenAI)' : 'OFFLINE (no OpenAI call)'}` +
      `${args.commit ? ' — COMMIT (store pending candidates)' : ' — DRY RUN (no DB writes)'}`,
  );
  console.log(`  meeting: ${date}${args.course ? ` · course ~ "${args.course}"` : ''}`);
  console.log('  shadow-only — never model-active, never betting advice; the API key is never printed.\n');

  // Fail closed on a live run without a key, BEFORE any DB read or write.
  let generator;
  try {
    const resolved = resolveOpenAiShadowGenerator({ live: args.live, env: process.env });
    generator = resolved.generator;
  } catch (err) {
    console.error(
      `Cannot run --live: ${err instanceof Error ? err.message : 'OPENAI_API_KEY is required'}`,
    );
    console.error('No OpenAI call was made and no rows were written.');
    process.exitCode = 1;
    return;
  }

  // Load read-only race context.
  const raceIds = await fetchRaceIdsForMeeting(date);
  const cards: RaceCard[] = [];
  for (const id of raceIds) {
    const card = await fetchRaceCard(id);
    if (wantCourse && (card.course ? normalizeCourse(card.course) : '') !== wantCourse) continue;
    cards.push(card);
  }

  if (cards.length === 0) {
    console.log('No races found for that meeting/course. Nothing to do.');
    return;
  }

  // Plan eligible (race, kind) pairs (precondition-gated; never fabricated).
  const plan: { card: RaceCard; kind: CommentaryKind; context: CommentaryContext }[] = [];
  for (const card of cards) {
    const context = buildContextFromCard(card);
    for (const kind of COMMENTARY_KINDS) {
      if (commentaryPrecondition(kind, context).ok) plan.push({ card, kind, context });
    }
  }
  console.log(`Eligible commentary: ${plan.length} (race × kind) across ${cards.length} race(s).`);

  if (!args.live) {
    for (const p of plan) {
      console.log(`  [plan] ${p.card.race_name ?? p.card.race_id} — ${p.kind}`);
    }
    console.log('\n(offline) No OpenAI call, no DB writes. Re-run with --live to generate (needs OPENAI_API_KEY).');
    return;
  }

  // LIVE: generate each via guardrails. Storage only with --commit.
  let canStore = false;
  if (args.commit) {
    canStore = await commentaryTableExists();
    if (!canStore) {
      console.error(
        `\nTable "${GENAI_COMMENTARY_TABLE}" is missing — apply supabase/migrations/20260618020000_genai_commentary.sql first.`,
      );
      console.error('Continuing in DRY RUN: generating + validating, but writing nothing.');
    }
  }

  let candidates = 0;
  let rejected = 0;
  const rows: Record<string, unknown>[] = [];
  for (const p of plan) {
    const artifact = await generateShadowCommentary(generator, { kind: p.kind, context: p.context });
    if (artifact.status === 'candidate') candidates += 1;
    else rejected += 1;
    console.log(
      `  [${artifact.status}] ${p.card.race_name ?? p.card.race_id} — ${p.kind}` +
        (artifact.problems.length > 0 ? ` (${artifact.problems.join('; ')})` : ''),
    );
    rows.push({
      race_id: p.card.race_id,
      kind: artifact.kind,
      commentary_text: artifact.text,
      prompt_version: artifact.prompt_version,
      generator_name: artifact.generator_name,
      generator_version: artifact.generator_version,
      status: artifact.status,
      model_active: false,
      review_status: 'pending',
      problems: artifact.problems,
      grounding: p.context,
    });
  }

  console.log(`\nGenerated: ${candidates} candidate(s), ${rejected} rejected.`);

  if (args.commit && canStore && rows.length > 0) {
    const { error } = await supabaseAdmin.from(GENAI_COMMENTARY_TABLE).insert(rows);
    if (error) {
      console.error(`Store failed: ${error.message}. No partial state is surfaced (review-gated).`);
      process.exitCode = 1;
      return;
    }
    console.log(`Stored ${rows.length} row(s) as review_status='pending' (model_active=false). Awaiting human review.`);
  } else {
    console.log('(dry run) Nothing written. Re-run with --commit (and the table present) to store pending candidates.');
  }
}

main().catch((err) => {
  // Never leak a key; surface a generic message.
  console.error(`genai:generate failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
