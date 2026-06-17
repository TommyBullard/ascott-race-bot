/**
 * CLI (READ-ONLY): generate a Markdown tipster-intelligence audit from stored
 * data. Phase 4 of the autonomous race-day workflow.
 *
 * For a meeting day (optionally one course) it aggregates the approved tipster
 * selections, the candidate review queue, correlation / de-duplication checks,
 * tipster evidence metrics, same-day form, and model-vs-tipster divergence — all
 * straight from stored rows. Per-race model context (alignment, consensus, pick)
 * comes from the FINAL PRE-OFF run via the same pure `selectPreOffRun` the
 * dashboard uses, so post-off reruns are ignored.
 *
 * Usage:
 *   npm run tipsters:audit -- --date 2026-06-16 --course Ascot
 *
 * Output (deterministic):
 *   reports/tipster-audit-2026-06-16-ascot.md
 *
 * STRICTLY READ-ONLY. It issues only `select` queries via the service-role
 * client; it NEVER changes the model, weighting, or rankings, NEVER approves a
 * tipster/candidate, NEVER fetches a live API, and NEVER writes to the database.
 * The only write is the Markdown file. It loads credentials from `.env.local` /
 * `.env` and never prints them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { supabaseAdmin } from '../src/lib/supabaseAdmin';
import { normalizeCourse } from '../src/lib/raceSync';
import { selectPreOffRun } from '../src/lib/modelPerformance';
import { classifyTableProbe } from '../src/lib/dbHealthSpec';
import {
  getTipsterConsensusFromConfig,
  getTipsterModelAlignmentFromConfig,
} from '../src/lib/modelRunConfigReaders';
import {
  parseTipsterAuditArgs,
  buildTipsterAuditPath,
  summarizeCandidateRows,
  renderTipsterAuditMarkdown,
  type AuditSelection,
  type AuditRaceContext,
  type AuditCandidateSummary,
  type AuditTipsterEvidence,
  type TipsterAuditReport,
} from '../src/lib/tipsterAudit';

const RACES_TABLE = 'races';
const RACE_MEETING_DATE_COLUMN = 'meeting_date';
const RUNNERS_TABLE = 'runners';
const MODEL_RUNS_TABLE = 'model_runs';
const RECOMMENDATIONS_TABLE = 'recommendations';
const TIPSTER_SELECTIONS_TABLE = 'tipster_selections';
const TIPSTER_SELECTION_CANDIDATES_TABLE = 'tipster_selection_candidates';
const TIPSTERS_TABLE = 'tipsters';
const TIPSTER_PRIORS_TABLE = 'tipster_priors';

function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
      return;
    } catch {
      // Not present; try the next, then fall back to shell env.
    }
  }
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface RaceRow {
  id: string | number;
  off_time: string | null;
  course: string | null;
  race_name: string | null;
}

interface RunnerRow {
  id: string | number;
  race_id: string | number;
  horse_name: string;
  finish_pos: number | string | null;
}

interface RunRow {
  id: string | number;
  run_time: string | null;
  config_json: unknown;
}

function offTimeSortKey(offTime: string | null): number {
  if (!offTime) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(offTime);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local (or .env).');
    process.exitCode = 1;
    return;
  }

  const args = parseTipsterAuditArgs(process.argv.slice(2));
  if (!args.date) {
    console.error(
      'Usage: npm run tipsters:audit -- --date YYYY-MM-DD [--course <name>]\n' +
        '(read-only; writes a Markdown report under reports/, never the database).',
    );
    process.exitCode = 1;
    return;
  }
  const wantCourse = args.course ? normalizeCourse(args.course) : null;

  // Races for the meeting day (read-only).
  const { data: raceData, error: raceError } = await supabaseAdmin
    .from(RACES_TABLE)
    .select('id, off_time, course, race_name')
    .eq(RACE_MEETING_DATE_COLUMN, args.date);
  if (raceError) throw new Error(`Failed to read races for ${args.date}: ${raceError.message}`);

  let races = (raceData ?? []) as RaceRow[];
  if (wantCourse) races = races.filter((r) => normalizeCourse(r.course ?? '') === wantCourse);
  races.sort((a, b) => offTimeSortKey(a.off_time) - offTimeSortKey(b.off_time));
  const raceIds = races.map((r) => String(r.id));
  const raceById = new Map(races.map((r) => [String(r.id), r]));

  // Runners (names + finish positions) for those races.
  const nameById = new Map<string, string>();
  const finishById = new Map<string, number | null>();
  const winnerNameByRace = new Map<string, string | null>();
  const hasResultByRace = new Map<string, boolean>();
  if (raceIds.length > 0) {
    const { data: runnerData, error: runnerError } = await supabaseAdmin
      .from(RUNNERS_TABLE)
      .select('id, race_id, horse_name, finish_pos')
      .in('race_id', raceIds);
    if (runnerError) throw new Error(`Failed to read runners: ${runnerError.message}`);
    for (const r of (runnerData ?? []) as RunnerRow[]) {
      const id = String(r.id);
      nameById.set(id, r.horse_name);
      const finish = toNumberOrNull(r.finish_pos);
      finishById.set(id, finish);
      if (finish === 1) {
        const raceId = String(r.race_id);
        if (!winnerNameByRace.has(raceId)) winnerNameByRace.set(raceId, r.horse_name);
        hasResultByRace.set(raceId, true);
      }
    }
  }

  // Approved tipster selections for those races (read-only).
  interface SelRow {
    race_id: string | number;
    runner_id: string | number;
    tipster_id: string | number | null;
    raw_tipster_name: string | null;
    source_label: string | null;
  }
  let selRows: SelRow[] = [];
  if (raceIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from(TIPSTER_SELECTIONS_TABLE)
      .select('race_id, runner_id, tipster_id, raw_tipster_name, source_label')
      .in('race_id', raceIds);
    if (error) throw new Error(`Failed to read tipster selections: ${error.message}`);
    selRows = (data ?? []) as SelRow[];
  }

  // Canonical tipster names for the selection tipster ids (read-only, optional).
  const tipsterNameById = new Map<string, string>();
  const tipsterIds = [...new Set(selRows.map((s) => (s.tipster_id == null ? '' : String(s.tipster_id))).filter((x) => x !== ''))];
  if (tipsterIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from(TIPSTERS_TABLE)
      .select('id, canonical_name, display_name')
      .in('id', tipsterIds);
    if (error && classifyTableProbe(error) !== 'missing') {
      throw new Error(`Failed to read tipsters: ${error.message}`);
    }
    for (const t of (data ?? []) as { id: string | number; canonical_name: string | null; display_name: string | null }[]) {
      tipsterNameById.set(String(t.id), (t.display_name ?? t.canonical_name ?? '').trim());
    }
  }

  const selections: AuditSelection[] = selRows.map((s) => {
    const raceId = String(s.race_id);
    const runnerId = String(s.runner_id);
    const race = raceById.get(raceId);
    const tipsterId = s.tipster_id == null ? null : String(s.tipster_id);
    const canonical = tipsterId ? tipsterNameById.get(tipsterId) : undefined;
    const tipsterName =
      canonical && canonical !== '' ? canonical : (s.raw_tipster_name ?? '').trim() || null;
    return {
      race_id: raceId,
      runner_id: runnerId,
      runner_name: nameById.get(runnerId) ?? null,
      off_time: race?.off_time ?? null,
      race_name: race?.race_name ?? null,
      tipster_id: tipsterId,
      tipster_name: tipsterName,
      source_label: (s.source_label ?? '').trim() || null,
      correlation_group: null, // no family/correlation metadata stored -> unknown
      finish_pos: finishById.get(runnerId) ?? null,
      has_result: hasResultByRace.get(raceId) === true,
    };
  });

  // Candidate review-queue summary (date-scoped; optional table).
  const candidates: AuditCandidateSummary = { pending: null, approved: null, rejected: null, source_labels: [] };
  {
    const { data, error } = await supabaseAdmin
      .from(TIPSTER_SELECTION_CANDIDATES_TABLE)
      .select('status, source_label, course')
      .eq('meeting_date', args.date);
    if (error) {
      if (classifyTableProbe(error) !== 'missing') {
        throw new Error(`Failed to read tipster candidates: ${error.message}`);
      }
      // Table absent -> counts stay null.
    } else {
      const rows = ((data ?? []) as { status: string | null; source_label: string | null; course: string | null }[])
        .filter((row) => !wantCourse || normalizeCourse(row.course ?? '') === wantCourse);
      const summary = summarizeCandidateRows(rows);
      candidates.pending = summary.pending;
      candidates.approved = summary.approved;
      candidates.rejected = summary.rejected;
      candidates.source_labels = summary.source_labels;
    }
  }

  // Tipster evidence from priors (latest per tipster; optional table).
  const evidence: AuditTipsterEvidence[] = [];
  if (tipsterIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from(TIPSTER_PRIORS_TABLE)
      .select('tipster_id, as_of_date, bets_count, roi_bsp_net, roi_bsp_gross, ae_bsp, strike_rate, reliability')
      .in('tipster_id', tipsterIds)
      .order('as_of_date', { ascending: false });
    if (error) {
      if (classifyTableProbe(error) !== 'missing') {
        throw new Error(`Failed to read tipster priors: ${error.message}`);
      }
    } else {
      const seen = new Set<string>();
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const tipsterId = String(row.tipster_id);
        if (seen.has(tipsterId)) continue; // first (latest as_of_date) wins
        seen.add(tipsterId);
        evidence.push({
          tipster_id: tipsterId,
          tipster_name: tipsterNameById.get(tipsterId) ?? null,
          sample_size: toNumberOrNull(row.bets_count),
          roi: toNumberOrNull(row.roi_bsp_net) ?? toNumberOrNull(row.roi_bsp_gross),
          ae: toNumberOrNull(row.ae_bsp),
          strike_rate: toNumberOrNull(row.strike_rate),
          reliability: toNumberOrNull(row.reliability),
          as_of_date: typeof row.as_of_date === 'string' ? row.as_of_date : null,
        });
      }
    }
  }

  // Per-race model/tipster context from the final pre-off run.
  const raceContexts: AuditRaceContext[] = [];
  for (const race of races) {
    const raceId = String(race.id);
    const { data: runData, error: runError } = await supabaseAdmin
      .from(MODEL_RUNS_TABLE)
      .select('id, run_time, config_json')
      .eq('race_id', raceId)
      .lte('run_time', race.off_time ?? '9999-12-31')
      .order('run_time', { ascending: true });
    if (runError) throw new Error(`Failed to read model runs for race ${raceId}: ${runError.message}`);
    const runs = (runData ?? []) as RunRow[];
    const chosen = selectPreOffRun(
      runs.map((r) => ({ run_id: String(r.id), run_time: String(r.run_time) })),
      race.off_time,
    );

    let alignmentLabel: string | null = null;
    let consensusName: string | null = null;
    let modelPickName: string | null = null;
    if (chosen) {
      const selected = runs.find((r) => String(r.id) === chosen.run_id) as RunRow;
      const alignment = getTipsterModelAlignmentFromConfig(selected.config_json);
      alignmentLabel =
        alignment && typeof alignment.alignment_label === 'string' ? alignment.alignment_label : null;
      const consensus = getTipsterConsensusFromConfig(selected.config_json);
      const consensusRunnerId =
        consensus && (typeof consensus.consensus_runner_id === 'string' || typeof consensus.consensus_runner_id === 'number')
          ? String(consensus.consensus_runner_id)
          : null;
      if (consensusRunnerId) consensusName = nameById.get(consensusRunnerId) ?? null;

      const { data: recData, error: recError } = await supabaseAdmin
        .from(RECOMMENDATIONS_TABLE)
        .select('runner_id, recommendation_rank')
        .eq('model_run_id', chosen.run_id)
        .eq('recommendation_rank', 1)
        .limit(1);
      if (recError) throw new Error(`Failed to read recommendation for race ${raceId}: ${recError.message}`);
      const rec = (recData ?? [])[0] as { runner_id: string | number } | undefined;
      if (rec) modelPickName = nameById.get(String(rec.runner_id)) ?? null;
    }

    raceContexts.push({
      race_id: raceId,
      off_time: race.off_time,
      race_name: race.race_name,
      winner_name: winnerNameByRace.get(raceId) ?? null,
      has_result: hasResultByRace.get(raceId) === true,
      model_pick_name: modelPickName,
      tipster_consensus_name: consensusName,
      tipster_alignment_label: alignmentLabel,
    });
  }

  const report: TipsterAuditReport = {
    date: args.date,
    course: args.course ?? null,
    generatedAt: new Date().toISOString(),
    selections,
    raceContexts,
    candidates,
    evidence,
  };

  const markdown = renderTipsterAuditMarkdown(report);
  const outPath = buildTipsterAuditPath(args.date, args.course);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  console.log(`Tipster audit written (read-only DB): ${outPath}`);
  console.log(
    `  approved selections: ${selections.length} · races: ${races.length}` +
      `${wantCourse ? ` (course ~ "${args.course}")` : ''}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
