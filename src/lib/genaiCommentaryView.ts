/**
 * Pure selector for the read-only dashboard GenAI shadow-commentary panel.
 *
 * The dashboard must surface ONLY human-approved shadow commentary, never
 * pending or rejected text. This module is the single, pure gate for that:
 * given raw `genai_commentary` rows, it returns only the rows that are
 * `review_status = 'approved'` AND `status = 'candidate'` AND have non-empty
 * prose, mapped to a compact display shape. No I/O, no React — trivially
 * unit-testable, so "pending is never shown as fact" is provable.
 *
 * Nothing here is model-active and nothing here is betting advice; it only
 * formats already-reviewed, decision-support prose for display.
 */

/** A raw `genai_commentary` row (only the fields the panel reasons about). */
export interface GenaiCommentaryRow {
  kind: string;
  commentary_text: string | null;
  prompt_version: string | null;
  generator_name: string | null;
  generated_at: string | null;
  /** 'candidate' | 'rejected'. */
  status: string | null;
  /** 'pending' | 'approved' | 'rejected'. */
  review_status: string | null;
  /** The model pick this note was grounded in (from `grounding.modelPick`). */
  model_pick_horse?: string | null;
  /** The model run this note was generated for, when stored. */
  model_run_id?: string | null;
}

/**
 * The current displayed model state a note is checked against. When supplied, a
 * note is only surfaced if it is NOT stale relative to this run.
 */
export interface GenaiCommentaryGuard {
  /** The horse the CURRENT model run picks (the displayed pick). */
  currentModelPickHorse: string | null;
  /** The CURRENT model run's run_time (ISO) — notes older than this are stale. */
  currentModelRunTime: string | null;
  /** The CURRENT model run id, when known (exact-match currency). */
  currentModelRunId?: string | null;
}

/** A display-ready, approved commentary item. */
export interface GenaiCommentaryItem {
  kind: string;
  text: string;
  promptVersion: string | null;
  generatorName: string | null;
  generatedAt: string | null;
}

/** The view the panel renders. */
export interface GenaiCommentaryView {
  items: GenaiCommentaryItem[];
  hasAny: boolean;
  disclaimer: string;
  /** Shown when there is no approved commentary to display. */
  emptyMessage: string;
}

/** The persistent, always-shown disclaimer on every surfaced note. */
export const GENAI_SHADOW_DISCLAIMER = 'AI shadow note — not betting advice.';

/** Shown (or used) when there is no reviewed commentary to display. */
export const GENAI_EMPTY_MESSAGE = 'No reviewed AI shadow commentary available.';

function normHorse(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * STALENESS GUARD: returns true when `row` is stale relative to `guard` and must
 * be hidden — i.e. its grounded model pick no longer matches the current pick,
 * or it predates the current model run (and is not the same run). When the pick
 * cannot be confirmed to match the current displayed pick, the note is treated
 * as stale (fail-closed). Pure.
 */
function isStaleAgainstGuard(row: GenaiCommentaryRow, guard: GenaiCommentaryGuard): boolean {
  const rowPick = normHorse(row.model_pick_horse);
  const curPick = normHorse(guard.currentModelPickHorse);
  // The note's model pick must be known and equal the current displayed pick.
  if (curPick === '' || rowPick === '' || rowPick !== curPick) return true;
  // Currency: the same model run, OR generated at/after the current run time.
  const sameRun = !!row.model_run_id && !!guard.currentModelRunId && row.model_run_id === guard.currentModelRunId;
  if (sameRun) return false;
  if (guard.currentModelRunTime) {
    const run = Date.parse(guard.currentModelRunTime);
    const gen = row.generated_at ? Date.parse(row.generated_at) : NaN;
    if (Number.isFinite(run) && (!Number.isFinite(gen) || gen < run)) return true; // predates current run
  }
  return false;
}

/**
 * Returns ONLY approved candidate commentary with non-empty prose, mapped to
 * display items. Anything pending, rejected, text-less, or malformed is dropped.
 * Pure; never throws; never mutates the input.
 */
export function selectApprovedCommentary(
  rows: readonly GenaiCommentaryRow[] | null | undefined,
  guard?: GenaiCommentaryGuard,
): GenaiCommentaryItem[] {
  if (!Array.isArray(rows)) return [];
  const items: GenaiCommentaryItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.review_status !== 'approved') continue; // human review gate
    if (row.status !== 'candidate') continue; // never surface a rejected row
    const text = typeof row.commentary_text === 'string' ? row.commentary_text.trim() : '';
    if (text === '') continue; // no prose => nothing to show
    if (guard && isStaleAgainstGuard(row, guard)) continue; // stale vs the current run => hide
    items.push({
      kind: typeof row.kind === 'string' ? row.kind : 'commentary',
      text,
      promptVersion: typeof row.prompt_version === 'string' ? row.prompt_version : null,
      generatorName: typeof row.generator_name === 'string' ? row.generator_name : null,
      generatedAt: typeof row.generated_at === 'string' ? row.generated_at : null,
    });
  }
  return items;
}

/**
 * Counts approved-candidate notes that were HIDDEN by the staleness guard
 * (pick no longer matches the current run, or the note predates it). Pure.
 */
export function countStaleHidden(
  rows: readonly GenaiCommentaryRow[] | null | undefined,
  guard: GenaiCommentaryGuard,
): number {
  return selectApprovedCommentary(rows).length - selectApprovedCommentary(rows, guard).length;
}

/** Builds the full panel view (items + hasAny + disclaimer). Pure. */
export function buildGenaiCommentaryView(
  rows: readonly GenaiCommentaryRow[] | null | undefined,
  guard?: GenaiCommentaryGuard,
): GenaiCommentaryView {
  const items = selectApprovedCommentary(rows, guard);
  return {
    items,
    hasAny: items.length > 0,
    disclaimer: GENAI_SHADOW_DISCLAIMER,
    emptyMessage: GENAI_EMPTY_MESSAGE,
  };
}
