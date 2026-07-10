/**
 * Optional in-process integration:
 *
 *   import OpenAI from "openai";
 *   import { wrap } from "blindfold";
 *   const openai = wrap(new OpenAI({ apiKey: "__blindfold__" }));
 *
 * `wrap` replaces the OpenAI SDK's `fetch` with one that points at the
 * local Blindfold proxy. The "apiKey" passed to OpenAI is meaningless;
 * the SDK requires *some* string, so we use the sentinel.
 *
 * The wrap layer never sees the real key. Substitution happens inside
 * the T3 contract, downstream.
 */
import { DEFAULT_PORT, SENTINEL } from "./constants.ts";

export interface WrapOpts {
  /** Defaults to http://127.0.0.1:<DEFAULT_PORT>/v1 */
  baseUrl?: string;
  /**
   * Per-session proxy auth token. When set, the wrapped client sends it on
   * every request as the `x-blindfold-token` header, so the proxy accepts calls
   * only from this wrapped client (not any co-resident local process). Falls
   * back to the `BLINDFOLD_PROXY_TOKEN` env var.
   */
  token?: string;
}

const PROXY_TOKEN_HEADER = "x-blindfold-token";

/**
 * Loose structural type — we don't want a hard dep on the openai package.
 * Anything with `baseURL` and `fetch` (or `apiKey`) fields can be wrapped.
 */
export interface OpenAIish {
  baseURL?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export function wrap<T extends OpenAIish>(client: T, opts: WrapOpts = {}): T {
  const baseUrl = opts.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}/v1`;
  client.baseURL = baseUrl;
  client.apiKey = SENTINEL;

  const token = (opts.token ?? process.env.BLINDFOLD_PROXY_TOKEN ?? "").trim();
  if (token) {
    // Inject the per-session token on every outbound request without a hard
    // dep on the OpenAI SDK: wrap whatever fetch the client uses.
    const base = client.fetch ?? fetch;
    client.fetch = ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
      const headers = new Headers(init?.headers);
      headers.set(PROXY_TOKEN_HEADER, token);
      return base(input, { ...init, headers });
    }) as typeof fetch;
  }
  return client;
}
