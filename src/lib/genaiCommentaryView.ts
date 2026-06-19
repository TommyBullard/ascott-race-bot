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

/**
 * Returns ONLY approved candidate commentary with non-empty prose, mapped to
 * display items. Anything pending, rejected, text-less, or malformed is dropped.
 * Pure; never throws; never mutates the input.
 */
export function selectApprovedCommentary(
  rows: readonly GenaiCommentaryRow[] | null | undefined,
): GenaiCommentaryItem[] {
  if (!Array.isArray(rows)) return [];
  const items: GenaiCommentaryItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.review_status !== 'approved') continue; // human review gate
    if (row.status !== 'candidate') continue; // never surface a rejected row
    const text = typeof row.commentary_text === 'string' ? row.commentary_text.trim() : '';
    if (text === '') continue; // no prose => nothing to show
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

/** Builds the full panel view (items + hasAny + disclaimer). Pure. */
export function buildGenaiCommentaryView(
  rows: readonly GenaiCommentaryRow[] | null | undefined,
): GenaiCommentaryView {
  const items = selectApprovedCommentary(rows);
  return {
    items,
    hasAny: items.length > 0,
    disclaimer: GENAI_SHADOW_DISCLAIMER,
    emptyMessage: GENAI_EMPTY_MESSAGE,
  };
}
