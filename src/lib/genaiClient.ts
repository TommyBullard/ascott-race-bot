/**
 * LLM transport abstraction for the shadow-only GenAI commentary layer.
 *
 * This is the ONLY place that can talk to a live LLM. It is deliberately gated:
 *   - OFF BY DEFAULT. The default {@link unconfiguredGenaiClient} throws, so no
 *     network call ever happens unless a real client is explicitly resolved.
 *   - FAIL-CLOSED. The live client reads OPENAI_API_KEY via `requireOpenAiApiKey`
 *     (which throws a value-free error when the key is absent), so a missing key
 *     fails safely instead of running un-keyed.
 *   - SECRET-SAFE. The API key is used only to build the Authorization header. It
 *     is NEVER logged, printed, echoed into an error, or returned.
 *   - INJECTABLE. `fetch` is injectable so tests drive a fake transport and never
 *     touch the network; the deterministic {@link stubGenaiClient} returns canned
 *     text for unit tests.
 *
 * Nothing here is model-active: the returned text is shadow commentary that the
 * caller validates and stores for human review. It never feeds the model,
 * staking, ranking, or recommendations, and it is never betting advice.
 */

import { requireOpenAiApiKey } from './genaiEnvPreflight';

/** A built prompt for the LLM: a system contract + the grounded user payload. */
export interface GenaiPrompt {
  system: string;
  user: string;
  /** Soft length budget for the prose (chars); advisory for the transport. */
  maxChars?: number;
}

/** A minimal LLM client. Implementations call a real API; the default throws. */
export interface GenaiClient {
  readonly name: string;
  readonly model: string;
  /** Produce prose for a built prompt. MUST NOT be wired to anything that bets. */
  complete(prompt: GenaiPrompt): Promise<string>;
}

/** Raised by GenAI clients; messages NEVER contain a secret value. */
export class GenaiClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenaiClientError';
  }
}

/**
 * The default client: it REFUSES to run, by design, so commentary can never be
 * produced against a live API until an operator explicitly resolves a configured
 * client (with a present OPENAI_API_KEY). Mirrors the unconfigured generator in
 * genaiShadowCommentary.ts.
 */
export function unconfiguredGenaiClient(): GenaiClient {
  return {
    name: 'unconfigured',
    model: 'none',
    async complete(): Promise<string> {
      throw new GenaiClientError(
        'GenAI client is not configured. Run the commentary command with --live and a ' +
          'present OPENAI_API_KEY to enable shadow commentary generation. It must remain ' +
          'shadow-only: never model-active, never betting advice.',
      );
    },
  };
}

/**
 * A deterministic, NETWORK-FREE client for tests + offline composition. Returns a
 * fixed string (or `responder(prompt)`), so the orchestrator can be unit-tested
 * with NO real LLM call. The mocked client used by the tests.
 */
export function stubGenaiClient(
  responder: string | ((prompt: GenaiPrompt) => string),
  opts: { name?: string; model?: string } = {},
): GenaiClient {
  return {
    name: opts.name ?? 'stub',
    model: opts.model ?? 'stub-model',
    async complete(prompt: GenaiPrompt): Promise<string> {
      return typeof responder === 'function' ? responder(prompt) : responder;
    },
  };
}

/** The default chat model for commentary (overridable). */
export const DEFAULT_COMMENTARY_MODEL = 'gpt-4o-mini';
/** The default API base (OpenAI-compatible chat completions). */
const DEFAULT_API_BASE = 'https://api.openai.com/v1';

/** Options for the live, key-gated commentary client. */
export interface LiveClientOptions {
  model?: string;
  apiBaseUrl?: string;
  /** Environment to read the key from (defaults to the process environment). */
  env?: Record<string, string | undefined>;
  /** Injectable fetch (tests pass a fake; never a real call in tests). */
  fetchImpl?: typeof fetch;
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * Builds a live, key-gated commentary client. The key is read fail-closed on each
 * call via `requireOpenAiApiKey` and used ONLY for the Authorization header — it
 * is never logged, returned, or placed in an error message. `fetch` is injectable
 * so this is unit-testable without the network.
 */
export function createLiveCommentaryClient(opts: LiveClientOptions = {}): GenaiClient {
  const model = opts.model ?? DEFAULT_COMMENTARY_MODEL;
  const apiBase = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const temperature = opts.temperature ?? 0;
  const maxTokens = opts.maxOutputTokens ?? 400;

  return {
    name: 'live',
    model,
    async complete(prompt: GenaiPrompt): Promise<string> {
      // Fail closed: require the key. requireOpenAiApiKey throws a value-free
      // error when it is missing. The key is used only below, never logged.
      const apiKey = requireOpenAiApiKey(env);

      let res: Response;
      try {
        res = await doFetch(`${apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
          }),
        });
      } catch (err) {
        // Surface a generic transport failure — never include the key/header.
        throw new GenaiClientError(
          `GenAI request failed to send: ${err instanceof Error ? err.message : 'network error'}.`,
        );
      }

      if (!res.ok) {
        // Never echo the key or the Authorization header.
        throw new GenaiClientError(`GenAI request was rejected (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = data.choices?.[0]?.message?.content;
      return typeof text === 'string' ? text : '';
    },
  };
}

/** Options for {@link resolveCommentaryClient}. */
export interface ResolveClientOptions {
  /** When false (default), the offline (non-calling) client is returned. */
  live: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  model?: string;
}

/** The resolved client plus whether a live API call will actually happen. */
export interface ResolvedCommentaryClient {
  client: GenaiClient;
  willCallApi: boolean;
  mode: 'offline' | 'live';
}

/**
 * Decides which client to use. Offline (the default) returns the non-calling
 * client and `willCallApi: false`. Live mode FAILS CLOSED: it calls
 * `requireOpenAiApiKey` first, so a missing key throws before any client is
 * built. Only when `--live` is set AND the key is present is a calling client
 * returned. Never logs the key.
 */
export function resolveCommentaryClient(
  opts: ResolveClientOptions,
): ResolvedCommentaryClient {
  if (!opts.live) {
    return { client: unconfiguredGenaiClient(), willCallApi: false, mode: 'offline' };
  }
  // Live: fail closed if the key is missing (throws GenAiKeyMissingError).
  requireOpenAiApiKey(opts.env ?? process.env);
  return {
    client: createLiveCommentaryClient({
      env: opts.env,
      fetchImpl: opts.fetchImpl,
      model: opts.model,
    }),
    willCallApi: true,
    mode: 'live',
  };
}
