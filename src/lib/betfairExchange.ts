/**
 * Betfair Exchange client — non-interactive (bot) login + market data.
 *
 * Used by `/api/cron/odds` to read current/projected prices for today's UK & IRE
 * win markets and turn them into `runner_quotes`. The transport is split:
 *   - cert login uses `node:https` (global fetch can't present a client cert);
 *   - JSON-RPC calls use `fetch` with the returned session token.
 *
 * AUTH (cert-based, per Betfair docs): POST form `username`/`password` to
 *   https://identitysso-cert.betfair.com/api/certlogin
 * with header `X-Application: <appKey>` and a client TLS cert/key, yielding
 * `{ loginStatus: 'SUCCESS', sessionToken }`. The token is then sent as
 * `X-Authentication` (with `X-Application`) to the Betting JSON-RPC endpoint.
 *
 * ENV (read from process, validated lazily so importing never throws):
 *   BETFAIR_APP_KEY   — application key
 *   BETFAIR_USERNAME  — account username
 *   BETFAIR_PASSWORD  — account password
 *   BETFAIR_CERT_PEM  — client certificate PEM (literal \n allowed)
 *   BETFAIR_KEY_PEM   — client private key PEM (literal \n allowed)
 *
 * NOTE: The Racing API's `/racecards/standard` ALSO bundles a "Betfair Exchange"
 * price per runner (see raceSync.bundledBetfairPrice) with no cross-provider
 * matching. This module is the direct-exchange alternative the odds cron uses
 * for true live/projected SP; see the route for which is active.
 *
 * Response shapes below cover only the fields we read and are defensive about
 * the rest (Betfair's Betting API shapes are stable + well documented).
 */

import { request as httpsRequest } from 'node:https';

const CERT_LOGIN_HOST = 'identitysso-cert.betfair.com';
const CERT_LOGIN_PATH = '/api/certlogin';
const JSONRPC_URL = 'https://api.betfair.com/exchange/betting/json-rpc/v1';
/** Horse Racing event type id. */
const HORSE_RACING_EVENT_TYPE = '7';

export interface BetfairCredentials {
  appKey: string;
  username: string;
  password: string;
  certPem: string;
  keyPem: string;
}

/** Reads + validates Betfair credentials at call time (lazy). */
export function getBetfairCredentials(): BetfairCredentials {
  const appKey = process.env.BETFAIR_APP_KEY;
  const username = process.env.BETFAIR_USERNAME;
  const password = process.env.BETFAIR_PASSWORD;
  // Allow PEMs supplied with literal "\n" (common in single-line env stores).
  const certPem = process.env.BETFAIR_CERT_PEM?.replace(/\\n/g, '\n');
  const keyPem = process.env.BETFAIR_KEY_PEM?.replace(/\\n/g, '\n');

  const missing = [
    ['BETFAIR_APP_KEY', appKey],
    ['BETFAIR_USERNAME', username],
    ['BETFAIR_PASSWORD', password],
    ['BETFAIR_CERT_PEM', certPem],
    ['BETFAIR_KEY_PEM', keyPem],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing Betfair env var(s): ${missing.join(', ')}`);
  }
  return {
    appKey: appKey as string,
    username: username as string,
    password: password as string,
    certPem: certPem as string,
    keyPem: keyPem as string,
  };
}

// --- Response shapes (only the fields we read) -----------------------------

export interface BetfairRunnerCatalogue {
  selectionId?: number;
  runnerName?: string;
}
export interface BetfairMarketCatalogue {
  marketId?: string;
  marketName?: string;
  marketStartTime?: string;
  event?: { venue?: string; countryCode?: string; name?: string };
  runners?: BetfairRunnerCatalogue[];
}

export interface BetfairPriceSize {
  price?: number;
  size?: number;
}
export interface BetfairRunnerBook {
  selectionId?: number;
  status?: string;
  lastPriceTraded?: number;
  ex?: { availableToBack?: BetfairPriceSize[] };
  sp?: { nearPrice?: number; farPrice?: number; actualSP?: number };
}
export interface BetfairMarketBook {
  marketId?: string;
  status?: string;
  runners?: BetfairRunnerBook[];
}

/** The client surface the odds cron depends on (fake-able in tests). */
export interface BetfairExchangeClient {
  listTodaysWinMarkets(params: {
    fromIso: string;
    toIso: string;
    countryCodes?: string[];
  }): Promise<BetfairMarketCatalogue[]>;
  listMarketBooks(marketIds: string[]): Promise<BetfairMarketBook[]>;
}

// --- Pure helpers (tested) -------------------------------------------------

/**
 * The pre-race quote price for a Betfair book runner: best available-to-back
 * price, else last traded, else the projected SP near price. Returns null when
 * none is a real price (> 1) — never invented.
 */
export function extractBackPrice(runner: BetfairRunnerBook): number | null {
  const candidates: (number | undefined)[] = [
    runner.ex?.availableToBack?.[0]?.price,
    runner.lastPriceTraded,
    runner.sp?.nearPrice,
    runner.sp?.actualSP,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 1) return c;
  }
  return null;
}

/** Flattens a catalogue into the {venue, marketStartIso} shape matchMarketToRace wants. */
export function toMatchableMarket(m: BetfairMarketCatalogue): {
  marketId: string;
  venue?: string;
  marketStartIso?: string;
  runners: BetfairRunnerCatalogue[];
} {
  return {
    marketId: m.marketId ?? '',
    venue: m.event?.venue,
    marketStartIso: m.marketStartTime,
    runners: m.runners ?? [],
  };
}

// --- Transport -------------------------------------------------------------

/** Posts the cert-login form and returns the session token (throws on failure). */
async function certLogin(creds: BetfairCredentials): Promise<string> {
  const body = `username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  const raw = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: CERT_LOGIN_HOST,
        path: CERT_LOGIN_PATH,
        method: 'POST',
        cert: creds.certPem,
        key: creds.keyPem,
        headers: {
          'X-Application': creds.appKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  let parsed: { loginStatus?: string; sessionToken?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Betfair cert login returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (parsed.loginStatus !== 'SUCCESS' || !parsed.sessionToken) {
    throw new Error(
      `Betfair cert login failed: ${parsed.loginStatus ?? 'UNKNOWN'} ` +
        `(check app key, credentials, and that the cert is registered).`,
    );
  }
  return parsed.sessionToken;
}

/** Invokes one Betting JSON-RPC method, returning its `result` (throws on error). */
async function jsonRpc<T>(
  method: string,
  params: unknown,
  appKey: string,
  sessionToken: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(JSONRPC_URL, {
    method: 'POST',
    headers: {
      'X-Application': appKey,
      'X-Authentication': sessionToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: `SportsAPING/v1.0/${method}`,
      params,
      id: 1,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Betfair ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    result?: T;
    error?: { message?: string; data?: unknown };
  };
  if (json.error) {
    throw new Error(`Betfair ${method} error: ${JSON.stringify(json.error).slice(0, 300)}`);
  }
  return json.result as T;
}

/**
 * Builds a network-backed Betfair client. Logs in lazily on first use and
 * caches the session token for the lifetime of the client (one cron run).
 */
export function createBetfairExchangeClient(
  fetchImpl: typeof fetch = fetch,
): BetfairExchangeClient {
  let sessionToken: string | null = null;
  let appKey: string | null = null;

  const ensureSession = async (): Promise<{ appKey: string; token: string }> => {
    if (sessionToken && appKey) return { appKey, token: sessionToken };
    const creds = getBetfairCredentials();
    appKey = creds.appKey;
    sessionToken = await certLogin(creds);
    return { appKey, token: sessionToken };
  };

  return {
    async listTodaysWinMarkets({ fromIso, toIso, countryCodes }) {
      const { appKey: ak, token } = await ensureSession();
      return jsonRpc<BetfairMarketCatalogue[]>(
        'listMarketCatalogue',
        {
          filter: {
            eventTypeIds: [HORSE_RACING_EVENT_TYPE],
            marketTypeCodes: ['WIN'],
            marketCountries: countryCodes ?? ['GB', 'IE'],
            marketStartTime: { from: fromIso, to: toIso },
          },
          marketProjection: ['EVENT', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION'],
          maxResults: 1000,
          sort: 'FIRST_TO_START',
        },
        ak,
        token,
        fetchImpl,
      );
    },
    async listMarketBooks(marketIds) {
      if (marketIds.length === 0) return [];
      const { appKey: ak, token } = await ensureSession();
      const books: BetfairMarketBook[] = [];
      // Betfair weights full price data heavily; request in modest batches.
      const BATCH = 20;
      for (let i = 0; i < marketIds.length; i += BATCH) {
        const slice = marketIds.slice(i, i + BATCH);
        const result = await jsonRpc<BetfairMarketBook[]>(
          'listMarketBook',
          {
            marketIds: slice,
            priceProjection: {
              priceData: ['EX_BEST_OFFERS', 'SP_AVAILABLE'],
              virtualise: true,
            },
          },
          ak,
          token,
          fetchImpl,
        );
        books.push(...(result ?? []));
      }
      return books;
    },
  };
}
