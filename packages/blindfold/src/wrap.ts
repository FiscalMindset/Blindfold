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
import http from "node:http";
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
  /**
   * Route requests over a unix-domain socket (see `blindfold proxy --socket`)
   * instead of a TCP host:port. The request URL's host is ignored; only its
   * path is used. Falls back to the `BLINDFOLD_PROXY_SOCKET` env var.
   */
  socket?: string;
}

const PROXY_TOKEN_HEADER = "x-blindfold-token";

/**
 * A `fetch`-compatible function that sends the request over a unix-domain
 * socket via node:http (`socketPath`). Only the URL's path+query is used; the
 * host is irrelevant when talking to a socket. Optionally injects the
 * per-session token header.
 */
function socketFetch(socketPath: string, token?: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const reqObj = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const rawUrl = reqObj ? reqObj.url : String(input);
    const url = new URL(rawUrl);
    const method = init?.method ?? reqObj?.method ?? "GET";
    const headers = new Headers(init?.headers ?? reqObj?.headers);
    if (token) headers.set(PROXY_TOKEN_HEADER, token);

    const outHeaders: Record<string, string> = {};
    headers.forEach((v, k) => { outHeaders[k] = v; });

    return await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        { socketPath, path: url.pathname + url.search, method, headers: outHeaders },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const respHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") respHeaders.set(k, v);
              else if (Array.isArray(v)) respHeaders.set(k, v.join(", "));
            }
            resolve(new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              statusText: res.statusMessage ?? "",
              headers: respHeaders,
            }));
          });
        },
      );
      req.on("error", reject);
      const body = init?.body;
      if (body != null) {
        if (typeof body === "string" || body instanceof Buffer || body instanceof Uint8Array) req.write(body);
        else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) req.write(body.toString());
        else if (ArrayBuffer.isView(body as ArrayBufferView)) { const v = body as ArrayBufferView; req.write(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); }
        else if (body instanceof ArrayBuffer) req.write(Buffer.from(body));
        else { req.destroy(); reject(new Error("socketFetch: unsupported body type (use string/Buffer/typed-array/URLSearchParams)")); return; }
      }
      req.end();
    });
  }) as typeof fetch;
}

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

  const token = (opts.token ?? process.env.BLINDFOLD_PROXY_TOKEN ?? "").trim() || undefined;
  const socket = (opts.socket ?? process.env.BLINDFOLD_PROXY_SOCKET ?? "").trim() || undefined;

  if (socket) {
    // Talk to the proxy over its unix-domain socket (adds the token too, if set).
    client.fetch = socketFetch(socket, token);
  } else if (token) {
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
