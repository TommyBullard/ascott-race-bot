/**
 * API route: GET /api/search/racing
 *
 * Bounded, read-only search over STORED racecards. Public, matching the
 * repository's policy for read-only data endpoints (`/api/recommendations`,
 * `/api/accuracy`): no authentication, no writes, no secrets.
 *
 * SELECT-ONLY. It reads the `races` table through `racingSearchRead.ts` and
 * nothing else — no insert, update, upsert, delete, rpc, storage write,
 * provider call, model run, odds capture, lock, settlement or producer claim,
 * and it invokes no other application route.
 *
 * BOUNDED BY THE SERVER. Query length, result count and per-probe row count
 * are fixed constants; a caller cannot request more. Scope is a closed set.
 *
 * PRIVACY. The response carries no internal uuid, no provider identifier and
 * no model, odds, ownership or operational field — those columns are not read.
 * Raw database errors are never returned; failures are logged server-side with
 * the stage only, never the search text.
 *
 *   200 { query, scope, results[], truncated }
 *   400 { error }  invalid request (states WHICH rule, never a database detail)
 *   405 { error }  any method other than GET
 *   503 { error }  the stored data could not be read (NOT "no results")
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  DEFAULT_SEARCH_SCOPE,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
  buildContainsPattern,
  buildSearchResults,
  normaliseSearchQuery,
  parseSearchScope,
  queryAsMeetingDate,
} from '@/lib/racingSearchContract';
import {
  searchRacingRows,
  supabaseRacingSearchSeam,
  type RacingSearchReadSeam,
} from '@/lib/racingSearchRead';

/** Public, cacheable for a short window; results change only on ingestion. */
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

/** Never cache a refusal or a failure as though it were an answer. */
const NO_STORE = 'no-store';

/** Operator-facing reason -> user-facing sentence. No database text ever. */
const REJECTION_MESSAGE: Record<string, string> = {
  missing: 'Provide a search term using the "q" parameter.',
  too_short: `Search terms must be at least ${SEARCH_MIN_QUERY_LENGTH} characters.`,
  too_long: `Search terms must be at most ${SEARCH_MAX_QUERY_LENGTH} characters.`,
  invalid_characters: 'Search terms must not contain control characters.',
  wildcard:
    'Search terms must not contain "*". It is treated as a wildcard by the data layer, so it cannot be searched for literally.',
  unsupported_scope: 'Scope must be one of: all, meetings, races.',
};

function badRequest(reason: keyof typeof REJECTION_MESSAGE | string): NextResponse {
  return NextResponse.json(
    { error: REJECTION_MESSAGE[reason] ?? 'Invalid search request.' },
    { status: 400, headers: { 'Cache-Control': NO_STORE } },
  );
}

/**
 * The handler, with the read seam injectable.
 *
 * Production always uses the live Supabase seam; a test supplies a fixture so
 * the 200 and 503 paths are exercised behaviourally rather than by reading the
 * source. The seam is a parameter, never a request input.
 */
export async function handleRacingSearch(
  request: NextRequest,
  seam: RacingSearchReadSeam = supabaseRacingSearchSeam,
) {
  const { searchParams } = new URL(request.url);

  const scope = parseSearchScope(searchParams.get('scope'));
  if (!scope.ok) return badRequest(scope.reason);

  const query = normaliseSearchQuery(searchParams.get('q'));
  if (!query.ok) return badRequest(query.reason);

  try {
    const outcome = await searchRacingRows(
      {
        // The ONLY caller-derived value reaching the database, and it travels
        // as a discrete ilike parameter with LIKE metacharacters escaped.
        pattern: buildContainsPattern(query.query),
        meetingDate: queryAsMeetingDate(query.query),
      },
      seam,
    );

    if (outcome.kind === 'read_failed') {
      // Deliberately NOT an empty result set: a failed read presented as "no
      // results" would tell the user the racing does not exist.
      return NextResponse.json(
        { error: 'Racing data could not be searched right now. Please try again.' },
        { status: 503, headers: { 'Cache-Control': NO_STORE } },
      );
    }

    const body = buildSearchResults({
      rows: outcome.rows,
      query: query.query,
      scope: scope.scope,
      // A clipped probe window means matches may be missing, so the response
      // must not read as a complete answer.
      probeTruncated: outcome.truncated,
    });

    return NextResponse.json(body, { headers: { 'Cache-Control': CACHE_CONTROL } });
  } catch {
    // The thrown value is deliberately not inspected or echoed: it can carry a
    // connection string or a filter fragment.
    console.error('RACING_SEARCH_UNEXPECTED_FAILURE');
    return NextResponse.json(
      { error: 'Racing data could not be searched right now. Please try again.' },
      { status: 503, headers: { 'Cache-Control': NO_STORE } },
    );
  }
}

/**
 * Every other method is refused explicitly.
 *
 * Search is a read. Exporting these means a POST cannot fall through to a
 * framework default, and `Allow` states the contract.
 */
function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { error: 'Method not allowed. Racing search is read-only; use GET.' },
    { status: 405, headers: { Allow: 'GET', 'Cache-Control': NO_STORE } },
  );
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

/** Next’s entry point. Production wiring: the live seam, no test surface. */
export function GET(request: NextRequest) {
  return handleRacingSearch(request);
}

/** Referenced by tests so the default scope cannot drift unnoticed. */
export const ROUTE_DEFAULT_SCOPE = DEFAULT_SEARCH_SCOPE;
