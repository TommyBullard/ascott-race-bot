/**
 * Pure helpers for the dashboard's LIVE race-day status indicator.
 *
 * The dashboard polls the consolidated read-only `/api/race-day/status` endpoint
 * on scoped day/course pages. These helpers turn the poll's bookkeeping (last
 * status-refresh time, last cards-refresh time, whether the latest poll failed)
 * into the small view-model the live-mode bar renders: which timestamp to show
 * as "last refreshed", and a non-blocking warning when the latest poll failed.
 *
 * Decision-support only. There is NO I/O here: no DB, no network, no writes.
 * Deterministic given its inputs, so it is fully unit-testable. When the status
 * poll has not succeeded yet (or the endpoint is unavailable) it falls back to
 * the cards-refresh time, and renders "unknown" downstream when neither exists.
 */

/** Non-blocking warning shown when the latest race-day status poll failed. */
export const LIVE_STATUS_WARNING =
  'Live status update failed — showing last known data.';

export interface LiveStatusView {
  /**
   * Epoch ms to display as the last refresh: the consolidated status poll's time
   * when available, else the cards-refresh time, else null (renders "unknown").
   */
  refreshedMs: number | null;
  /** Non-blocking warning text, or null when the last poll succeeded. */
  warning: string | null;
}

/**
 * Builds the live-status view-model. The status-poll time is preferred (it is the
 * consolidated heartbeat); it falls back to the cards-refresh time so the page
 * still shows a sensible "last refreshed" even when the status endpoint is
 * unavailable. A failed latest poll raises a non-blocking warning while the last
 * known data is kept on screen. Pure & deterministic.
 */
export function buildLiveStatusView(input: {
  statusUpdatedMs: number | null;
  cardsUpdatedMs: number | null;
  statusError: boolean;
}): LiveStatusView {
  return {
    refreshedMs: input.statusUpdatedMs ?? input.cardsUpdatedMs,
    warning: input.statusError ? LIVE_STATUS_WARNING : null,
  };
}
