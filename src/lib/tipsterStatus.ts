/**
 * Pure copy for the dashboard's tipster-status panel (Phase 4C-lite).
 *
 * Turns a read-only count summary (fetched server-side) into the plain-language
 * lines the dashboard shows, so a viewer understands the CURRENT tipster state:
 *   - whether any approved tipster selections are feeding the model,
 *   - that captured candidate tips are NOT model-active until approved, and
 *   - that "no consensus" simply means the model is running market-only.
 *
 * This is presentation only — NO I/O, NO DB, NO model maths, NO recomputation of
 * any model value. It just formats counts the server already computed, so it is
 * safe to import on the client and is fully unit-testable. `null` counts mean
 * "not available" (e.g. the candidate tables aren't set up yet) and are handled
 * gracefully rather than shown as a misleading zero.
 */

/** Read-only tipster-state counts (mirrors the server summary). */
export interface TipsterStatusSummary {
  /** Approved, model-active selections in `tipster_selections` (null if absent). */
  approvedSelections: number | null;
  /** Candidate tips awaiting review (null if the candidate table is absent). */
  candidatesPending: number | null;
  /** Candidates already approved (null if absent). */
  candidatesApproved: number | null;
  /** Candidates rejected in review (null if absent). */
  candidatesRejected: number | null;
}

/** Pluralises a count: `1 tip`, `2 tips`. */
function plural(count: number, singular: string, suffix = 's'): string {
  return `${count} ${singular}${count === 1 ? '' : suffix}`;
}

/**
 * Builds the explanatory lines for the tipster-status panel from a count
 * summary. The first line always states the model mode; a candidate line is
 * added when candidate counts are available; and when nothing is approved a
 * clarifier explains that "no tipster consensus" means market-only — not a
 * negative signal. Pure; never throws.
 */
export function buildTipsterStatusLines(summary: TipsterStatusSummary): string[] {
  const { approvedSelections, candidatesPending } = summary;
  const lines: string[] = [];

  // 1. Model-mode line (always present).
  if (approvedSelections === null) {
    lines.push(
      'No approved tipster selections are set up yet — the model is running in ' +
        'market-only mode (market prices only).',
    );
  } else if (approvedSelections === 0) {
    lines.push(
      'No approved tipster selections yet — the model is running in market-only ' +
        'mode (market prices only).',
    );
  } else {
    lines.push(
      `${plural(approvedSelections, 'approved tipster selection')} feeding the ` +
        'model.',
    );
  }

  // 2. Candidate line (only when candidate counts are available).
  if (candidatesPending !== null) {
    if (candidatesPending > 0) {
      lines.push(
        `${plural(candidatesPending, 'candidate tip')} pending review — captured ` +
          'but NOT model-active until approved.',
      );
    } else {
      lines.push('No candidate tips are pending review.');
    }
  }

  // 3. Clarify what "no consensus" means while nothing is approved.
  if (approvedSelections !== null && approvedSelections === 0) {
    lines.push(
      '"No tipster consensus" on a race just means there are no approved ' +
        'selections for it — not a negative signal.',
    );
  }

  return lines;
}
