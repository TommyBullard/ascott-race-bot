/**
 * Betfair Starting Price (BSP) CSV -> historical-races import converter.
 *
 * Transforms a downloaded Betfair SP results file (the free daily CSVs at
 * promo.betfair.com/betfairsp/prices/, e.g. `dwbfpricesukwin01062026.csv`) into
 * the `HistoricalImport` shape that `scripts/loadHistoricalRaces.ts` accepts.
 *
 * PURE (no I/O): the script layer reads the file and writes JSON; this module
 * only parses + maps text it is handed, so it is fully unit-testable on fixtures.
 *
 * INTEGRITY — NO FABRICATION:
 *  - Every value comes verbatim from the CSV. Missing prices/results become
 *    `null`/omitted, never invented.
 *  - The BSP win file records only WIN/LOSE, NOT the full finishing order, so
 *    ONLY the winner gets `finish_pos = 1`; all other runners get no finish_pos
 *    (we do not know whether a horse came 2nd or last, so we do not guess).
 *  - Non-runners (no valid BSP) are emitted as `runner_status = 'non_runner'`
 *    with null prices — never priced, never settled.
 *  - Void / abandoned markets (no winner) and dead heats (>1 winner) are SKIPPED
 *    with a clear reason, because neither can be faithfully represented as a
 *    single-winner race without inventing a result.
 *
 * OPTIMISTIC-QUOTE CAVEAT: by default the pre-race quote the model scores on
 * (`odds_decimal`) is set to the BSP itself. BSP is only known AFTER the off, so
 * a real pre-race strategy could not have obtained it — this is OPTIMISTIC and
 * is flagged via `quote_type: 'bsp_optimistic'`. Pass `quoteSource: 'ppwap'` to
 * use the pre-play weighted average price instead (a more realistic, if still
 * imperfect, proxy for an obtainable pre-race price).
 *
 * The Betfair free BSP file columns (verified format):
 *   SP_ID, EVENT_DT, EVENT_ID, MENU_HINT, EVENT_NAME, SELECTION_ID,
 *   SELECTION_NAME, WIN_LOSE, BSP, PPWAP, MORNINGWAP, PPMAX, PPMIN, IPMAX,
 *   IPMIN, MORNINGTRADEDVOL, PPTRADEDVOL, IPTRADEDVOL
 * Parsing is header-driven (columns matched by name, case-insensitively), so a
 * minor header variation is reported rather than silently mis-mapped.
 */

import type {
  HistoricalImport,
  RaceInput,
  RunnerInput,
} from './historicalRaceLoader';

/** A parsed CSV: trimmed header + one record per data row keyed by header. */
export interface ParsedCsv {
  header: string[];
  rows: Record<string, string>[];
}

/** Which CSV price column to use as the pre-race quote (`odds_decimal`). */
export type QuoteSource = 'bsp' | 'ppwap';

export interface ConvertOptions {
  /** Pre-race quote source. 'bsp' (default, OPTIMISTIC) or 'ppwap'. */
  quoteSource?: QuoteSource;
  /** Country code used only when MENU_HINT has no parseable prefix. Default 'GB'. */
  fallbackCountry?: string;
}

/** One skipped race, with the reason it could not be faithfully represented. */
export interface SkippedRace {
  reason: string;
  label: string;
}

export interface ConvertSummary {
  /** Data rows read (excluding header). */
  totalRows: number;
  /** Distinct races (markets) found. */
  racesFound: number;
  /** Races emitted to the import (exactly one winner + >=1 priced runner). */
  racesEmitted: number;
  /** Races skipped (void/abandoned, dead heat, or unparseable). */
  racesSkipped: number;
  skipped: SkippedRace[];
  /** Non-runner rows across emitted races. */
  nonRunners: number;
  /** Runners across emitted races (incl. non-runners). */
  runnersEmitted: number;
  /** Skipped because no winner (void/abandoned market). */
  voidMarkets: number;
  /** Skipped because >1 winner (dead heat). */
  deadHeats: number;
  /** Emitted winners that were missing a BSP (rare data gap; settle falls back). */
  winnersMissingBsp: number;
}

export interface ConvertResult {
  import: HistoricalImport;
  summary: ConvertSummary;
  warnings: string[];
}

/** Logical column -> actual header name (or undefined when absent). */
export interface ColumnMap {
  eventId?: string;
  eventDt?: string;
  menuHint?: string;
  eventName?: string;
  selectionName?: string;
  winLose?: string;
  bsp?: string;
  ppwap?: string;
}

/** Columns the converter cannot function without. */
export const ESSENTIAL_COLUMNS: (keyof ColumnMap)[] = [
  'eventDt',
  'menuHint',
  'eventName',
  'selectionName',
  'winLose',
  'bsp',
];

/**
 * Parses CSV text (RFC4180-ish: handles quoted fields with embedded commas and
 * doubled quotes). Returns the trimmed header and one record per non-blank data
 * row, keyed by header name.
 */
export function parseCsv(text: string): ParsedCsv {
  const matrix: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      matrix.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  // Flush trailing field/row (file may not end in a newline).
  if (field !== '' || row.length > 0) {
    row.push(field);
    matrix.push(row);
  }

  const header = (matrix.shift() ?? []).map((h) => h.trim());
  const rows = matrix
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => {
      const record: Record<string, string> = {};
      header.forEach((h, idx) => {
        record[h] = (r[idx] ?? '').trim();
      });
      return record;
    });

  return { header, rows };
}

/** Resolves logical columns to the file's actual header names (case-insensitive). */
export function resolveColumns(header: string[]): ColumnMap {
  const byNorm = new Map<string, string>();
  for (const h of header) {
    byNorm.set(h.trim().toLowerCase(), h);
  }
  const pick = (...candidates: string[]): string | undefined => {
    for (const c of candidates) {
      const hit = byNorm.get(c);
      if (hit) return hit;
    }
    return undefined;
  };
  return {
    eventId: pick('event_id'),
    eventDt: pick('event_dt'),
    menuHint: pick('menu_hint'),
    eventName: pick('event_name'),
    selectionName: pick('selection_name'),
    winLose: pick('win_lose'),
    bsp: pick('bsp'),
    ppwap: pick('ppwap'),
  };
}

/**
 * Parses a decimal price. Returns the number when finite and > 1 (a real
 * exchange price), else null (covers blank, 0, and the non-runner case).
 */
export function toPrice(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/** True when WIN_LOSE marks the winner. Betfair uses '1'/'0' (or WIN/LOSE text). */
export function parseWinLose(value: string | undefined): boolean {
  if (value === undefined) return false;
  const t = value.trim().toLowerCase();
  return t === '1' || t === '1.0' || t === 'w' || t === 'win' || t === 'winner';
}

/**
 * Parses Betfair EVENT_DT into a calendar date + ISO off time. Accepts the
 * file's `DD-MM-YYYY HH:MM` format (UK wall-clock) and an ISO-ish fallback.
 *
 * The off time is labelled `Z` using the file's wall-clock hour: a minor
 * approximation (UK local, not converted to UTC) that does not affect daily
 * backtesting. `meetingDate` is taken from the date part directly, so it is
 * always the correct UK calendar date regardless of the time-of-day label.
 */
export function parseEventDt(
  value: string | undefined,
): { meetingDate: string; offTime: string } | null {
  if (value === undefined || value.trim() === '') return null;
  const v = value.trim();

  // DD-MM-YYYY HH:MM[:SS]  (the Betfair BSP file format)
  const m = v.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, dd, mm, yyyy, hh, min, ss] = m;
    return {
      meetingDate: `${yyyy}-${mm}-${dd}`,
      offTime: `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss ?? '00'}Z`,
    };
  }

  // ISO-ish fallback: YYYY-MM-DD[ T]HH:MM[:SS]
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (iso) {
    const [, yyyy, mm, dd, hh, min, ss] = iso;
    return {
      meetingDate: `${yyyy}-${mm}-${dd}`,
      offTime: `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss ?? '00'}Z`,
    };
  }

  return null;
}

/**
 * Parses MENU_HINT (e.g. `GB / Ascot 1st Jun`, `IRE / Cork (AW) 3rd Jun`) into a
 * country code and course name, stripping the trailing `Nth Mon` date. Falls
 * back to `fallbackCountry` only when no prefix is present.
 */
export function parseMenuHint(
  menuHint: string | undefined,
  fallbackCountry: string,
): { course: string; country: string } {
  const raw = (menuHint ?? '').trim();
  if (raw === '') return { course: '(unknown course)', country: fallbackCountry };

  let country = fallbackCountry;
  let rest = raw;
  const slash = raw.indexOf('/');
  if (slash !== -1) {
    country = raw.slice(0, slash).trim() || fallbackCountry;
    rest = raw.slice(slash + 1).trim();
  }

  // Strip a trailing date like "1st Jun" / "23rd December".
  const course = rest
    .replace(/\s+\d{1,2}(st|nd|rd|th)\s+[A-Za-z]{3,}\.?$/i, '')
    .trim();

  return { course: course || '(unknown course)', country };
}

const HANDICAP_RE = /\bh'?cap\b|\bhandicap\b/i;

/**
 * Converts parsed BSP rows into a `HistoricalImport`. Groups rows into races
 * (by EVENT_ID, else a composite key), maps the winner + prices, and skips
 * races that cannot be faithfully represented (void/abandoned, dead heat,
 * unparseable date). Invents nothing.
 *
 * @throws if an essential column is missing from the header.
 */
export function convertBspToImport(
  parsed: ParsedCsv,
  options: ConvertOptions = {},
): ConvertResult {
  const quoteSource: QuoteSource = options.quoteSource ?? 'bsp';
  const fallbackCountry = options.fallbackCountry ?? 'GB';
  const warnings: string[] = [];

  const cols = resolveColumns(parsed.header);
  const missing = ESSENTIAL_COLUMNS.filter((c) => !cols[c]);
  if (missing.length > 0) {
    throw new Error(
      `Betfair BSP CSV is missing required column(s): ${missing.join(', ')}. ` +
        `Header found: [${parsed.header.join(', ')}]. ` +
        `Expected a UK win file like dwbfpricesukwin<DDMMYYYY>.csv.`,
    );
  }

  const get = (row: Record<string, string>, key: string | undefined): string =>
    key ? (row[key] ?? '').trim() : '';

  // Group rows into races.
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of parsed.rows) {
    const key =
      get(row, cols.eventId) ||
      `${get(row, cols.eventDt)}|${get(row, cols.menuHint)}|${get(row, cols.eventName)}`;
    if (key.trim() === '') continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const races: RaceInput[] = [];
  const summary: ConvertSummary = {
    totalRows: parsed.rows.length,
    racesFound: groups.size,
    racesEmitted: 0,
    racesSkipped: 0,
    skipped: [],
    nonRunners: 0,
    runnersEmitted: 0,
    voidMarkets: 0,
    deadHeats: 0,
    winnersMissingBsp: 0,
  };

  for (const rows of groups.values()) {
    const dt = parseEventDt(get(rows[0], cols.eventDt));
    const { course, country } = parseMenuHint(get(rows[0], cols.menuHint), fallbackCountry);
    const raceName = get(rows[0], cols.eventName) || '(unknown race)';
    const label = `${course} ${dt?.offTime ?? get(rows[0], cols.eventDt) ?? '?'} — ${raceName}`;

    if (!dt) {
      summary.racesSkipped++;
      summary.skipped.push({ reason: 'unparseable EVENT_DT', label });
      continue;
    }

    let winnerCount = 0;
    let localNonRunners = 0;
    let winnerMissingBsp = false;

    const runners: RunnerInput[] = rows.map((r) => {
      const horseName = get(r, cols.selectionName) || '(unknown runner)';
      const isWinner = parseWinLose(get(r, cols.winLose));
      const bspNum = toPrice(get(r, cols.bsp));
      const ppwapNum = toPrice(get(r, cols.ppwap));

      if (isWinner) winnerCount++;

      // A row with no valid BSP that did not win is a non-runner (no price, no
      // result) — never priced, never settled.
      const isNonRunner = bspNum === null && !isWinner;
      if (isNonRunner) {
        localNonRunners++;
        return { horse_name: horseName, status: 'non_runner' };
      }

      if (isWinner && bspNum === null) winnerMissingBsp = true;

      const quote =
        quoteSource === 'ppwap' ? (ppwapNum ?? bspNum) : bspNum;

      const runner: RunnerInput = { horse_name: horseName, status: 'ran' };
      if (quote !== null) runner.odds_decimal = quote;
      if (bspNum !== null) runner.bsp_decimal = bspNum;
      // sp_decimal is NOT in the BSP file — left absent (null), never invented.
      if (isWinner) runner.finish_pos = 1; // only the winner; order unknown otherwise
      return runner;
    });

    if (winnerCount > 1) {
      summary.racesSkipped++;
      summary.deadHeats++;
      summary.skipped.push({ reason: `dead heat (${winnerCount} winners)`, label });
      continue;
    }
    if (winnerCount === 0) {
      summary.racesSkipped++;
      summary.voidMarkets++;
      summary.skipped.push({ reason: 'no winner (void/abandoned market)', label });
      continue;
    }

    if (winnerMissingBsp) {
      summary.winnersMissingBsp++;
      warnings.push(`${label}: winner has no BSP — settlement will fall back / yield 0 on a win.`);
    }

    races.push({
      course,
      country,
      race_name: raceName,
      meeting_date: dt.meetingDate,
      off_time: dt.offTime,
      handicap: HANDICAP_RE.test(raceName),
      status: 'result',
      source_label: 'betfair_bsp',
      quote_type: quoteSource === 'ppwap' ? 'ppwap' : 'bsp_optimistic',
      runners,
    });
    summary.racesEmitted++;
    summary.runnersEmitted += runners.length;
    summary.nonRunners += localNonRunners;
  }

  if (summary.racesEmitted === 0) {
    warnings.push('No races emitted — check the file is a settled UK win BSP file.');
  }

  return { import: { races }, summary, warnings };
}
