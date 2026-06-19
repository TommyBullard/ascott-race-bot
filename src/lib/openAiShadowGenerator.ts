/**
 * OpenAI-backed shadow-commentary generator.
 *
 * This is the thin ADAPTER that exposes the existing key-gated OpenAI transport
 * ({@link ./genaiClient}) as the {@link CommentaryGenerator} the Phase 4G
 * orchestrator ({@link ./genaiShadowCommentary}) expects. It adds NO new way to
 * call OpenAI — it reuses `genaiClient`'s fail-closed, secret-safe client and
 * only maps a {@link CommentaryPrompt} → {@link GenaiPrompt} and `generate` →
 * `complete`.
 *
 * Invariants (inherited, not weakened):
 *   - OFF BY DEFAULT. `resolveOpenAiShadowGenerator({ live: false })` returns a
 *     non-calling generator; only `{ live: true }` with a present OPENAI_API_KEY
 *     yields a calling one (fail-closed via `resolveCommentaryClient`).
 *   - SHADOW-ONLY. The returned text is validated + stored for human review by
 *     the orchestrator; it never feeds the model, staking, ranking, EV, or
 *     recommendations, and it is never betting advice.
 *   - SECRET-SAFE. The key lives only inside `genaiClient`; it is never logged,
 *     printed, or returned here.
 *   - TESTABLE. Pass a {@link stubGenaiClient} (or any GenaiClient) to
 *     {@link createOpenAiShadowGenerator} for a deterministic, network-free
 *     generator in tests.
 */

import type { CommentaryGenerator, CommentaryPrompt } from './genaiShadowCommentary';
import {
  resolveCommentaryClient,
  type GenaiClient,
  type ResolveClientOptions,
} from './genaiClient';

/**
 * Wraps any {@link GenaiClient} as a {@link CommentaryGenerator}. Pure mapping;
 * it performs no generation itself (the injected client does, when called).
 */
export function createOpenAiShadowGenerator(
  client: GenaiClient,
  opts: { name?: string } = {},
): CommentaryGenerator {
  return {
    name: opts.name ?? `openai:${client.name}`,
    version: client.model,
    async generate(prompt: CommentaryPrompt): Promise<string> {
      return client.complete({
        system: prompt.system,
        user: prompt.user,
        maxChars: prompt.maxChars,
      });
    },
  };
}

/** The resolved generator plus whether a live API call will actually happen. */
export interface ResolvedShadowGenerator {
  generator: CommentaryGenerator;
  /** True only in live mode with a present key. */
  willCallApi: boolean;
  mode: 'offline' | 'live';
}

/**
 * Resolves a shadow-commentary generator. Offline (default) returns the
 * non-calling generator. Live mode FAILS CLOSED: `resolveCommentaryClient`
 * calls `requireOpenAiApiKey` first, so a missing key throws a value-free error
 * before any generator is built — no un-keyed run, no DB write. Never logs the key.
 */
export function resolveOpenAiShadowGenerator(
  opts: ResolveClientOptions,
): ResolvedShadowGenerator {
  const resolved = resolveCommentaryClient(opts);
  return {
    generator: createOpenAiShadowGenerator(resolved.client),
    willCallApi: resolved.willCallApi,
    mode: resolved.mode,
  };
}
