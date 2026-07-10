/**
 * OpenAI-shaped local HTTP proxy.
 *
 * What it does, exactly:
 *   - Listens on http://127.0.0.1:<port>.
 *   - Accepts any path/method the agent sends.
 *   - Reads the agent's headers and body verbatim.
 *   - Builds a ForwardRequest whose Authorization header is the sentinel
 *     "Bearer __BLINDFOLD__" (NOT whatever the agent sent — that value
 *     is discarded; the agent never had the real one anyway).
 *   - Sends the ForwardRequest to the T3 contract via `invokeForward`.
 *   - Returns the contract's response to the agent.
 *
 * What it does NOT do:
 *   - Read any secret from disk or env.
 *   - Cache responses by anything containing a secret.
 *   - Log header values (it uses `safeLog`, which scrubs them).
 *
 * The "one line" the developer changes is:
 *   OPENAI_BASE_URL=http://127.0.0.1:<port>/v1
 *
 * Routing + per-provider auth live in `providers.ts`. Each concrete provider
 * declares its upstream host, sealed-secret name, and auth scheme (bearer /
 * basic / sigv4). For basic and sigv4 the enclave *computes* the Authorization
 * from the sealed secret — the raw secret never appears in a header on its own.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { SENTINEL } from "./constants.ts";
import { loadBlindfoldEnv } from "./env.ts";
import { safeLog } from "./log.ts";
import { openT3Client, T3TimeoutError, type T3ClientHandle } from "./t3-client.ts";
import type { BlindfoldEnv, ForwardRequest } from "./types.ts";
import { logUsage, providerForUpstream } from "./usage-log.ts";
import { resolveProvider } from "./providers.ts";

export interface ProxyOpts {
  port?: number;
  /** Logical name of the secret to substitute. Default: "openai_api_key". */
  secretKey?: string;
  /**
   * Per-session auth token. When set (non-empty), every request except
   * `/health` must carry it in the `x-blindfold-token` header — so only the
   * process that was handed this token (the agent Blindfold wraps) can use the
   * proxy, not just any co-resident local process. Falls back to the
   * `BLINDFOLD_PROXY_TOKEN` env var. Omit/empty ⇒ no auth (back-compat).
   */
  token?: string;
  /**
   * Bind a unix-domain socket at this filesystem path instead of a TCP port.
   * The socket file is created with 0600 permissions, so only processes running
   * as the same OS user can even connect — closing the "any local process can
   * reach 127.0.0.1" gap at the OS level. When set, `port` is ignored.
   * (Client support: `curl --unix-socket <path>`; SDK-over-socket is a follow-up.)
   */
  socket?: string;
}

// Cap the proxied request body so a huge upload can't exhaust proxy memory.
const MAX_BODY_BYTES = Number(process.env.BLINDFOLD_MAX_BODY_BYTES) || 5 * 1024 * 1024;
class PayloadTooLargeError extends Error {}

/** Constant-time string compare (avoids leaking the token via timing). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const PROXY_TOKEN_HEADER = "x-blindfold-token";

export interface ProxyHandle {
  url: string;
  port: number;
  /** The active per-session token, if auth is enabled (else undefined). */
  token?: string;
  /** The unix-domain socket path, if bound to one instead of a TCP port. */
  socket?: string;
  close: () => Promise<void>;
}

export async function startProxy(opts: ProxyOpts = {}): Promise<ProxyHandle> {
  const env = loadBlindfoldEnv();
  const port = opts.port ?? env.port ?? 8787;
  const secretKey = opts.secretKey ?? "openai_api_key";
  const token = (opts.token ?? process.env.BLINDFOLD_PROXY_TOKEN ?? "").trim() || undefined;
  const socketPath = opts.socket?.trim() || undefined;
  const t3 = await openT3Client(env);

  const server = http.createServer((req, res) => {
    handle(req, res, t3, secretKey, env, token).catch((e) => {
      if (e instanceof PayloadTooLargeError) {
        if (!res.headersSent) res.writeHead(413, { "content-type": "text/plain", "connection": "close" });
        res.end("request body too large");
        req.destroy();
        return;
      }
      safeLog("error", { msg: "proxy_unhandled", error: (e as Error).message });
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal proxy error");
    });
  });

  return await new Promise<ProxyHandle>((resolve, reject) => {
    server.once("error", reject);

    const onListening = () => {
      let url: string;
      let bound = 0;
      if (socketPath) {
        // Restrict the socket to the owner: only same-user processes can connect.
        try { fs.chmodSync(socketPath, 0o600); } catch { /* best-effort */ }
        url = `unix:${socketPath}`;
      } else {
        bound = (server.address() as AddressInfo).port;
        url = `http://127.0.0.1:${bound}`;
      }
      safeLog("info", { msg: "proxy_listening", url, mock: env.mock });
      resolve({
        url,
        port: bound,
        token,
        socket: socketPath,
        close: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          if (socketPath) { try { fs.rmSync(socketPath, { force: true }); } catch { /* ignore */ } }
          await t3.close();
        },
      });
    };

    if (socketPath) {
      // Remove a stale socket file from a previous run, then bind.
      try { fs.rmSync(socketPath, { force: true }); } catch { /* ignore */ }
      server.listen(socketPath, onListening);
    } else {
      server.listen(port, "127.0.0.1", onListening);
    }
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t3: T3ClientHandle,
  secretKey: string,
  env: BlindfoldEnv,
  token?: string,
): Promise<void> {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mock: env.mock, auth: Boolean(token) }));
    return;
  }

  // Per-session auth: when a token is configured, only a caller that presents it
  // may use the proxy. This gates *use* by a co-resident local process — the
  // enclave still guarantees the key can never be *stolen* either way.
  if (token) {
    const provided = String(req.headers[PROXY_TOKEN_HEADER] ?? "");
    if (!provided || !tokenMatches(provided, token)) {
      safeLog("warn", { msg: "proxy_unauthorized", path: req.url });
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`unauthorized: missing or invalid ${PROXY_TOKEN_HEADER} header`);
      return;
    }
  }

  const provider = resolveProvider(req.url ?? "/");
  if (!provider) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`no upstream mapping for ${req.url}`);
    return;
  }
  const upstream = provider.upstream;
  // Per-provider sealed secret. LLM providers fall back to the proxy default
  // (preserves the original single-key behaviour); Stripe/Twilio/AWS/etc. each
  // name their own sealed secret.
  const providerSecretKey = provider.secretKey ?? secretKey;

  const body = await readBody(req, MAX_BODY_BYTES);
  // Build the headers we'll send to the contract. Any Authorization the agent
  // sent is discarded. For bearer providers we plant the sentinel for the
  // enclave to swap; for basic/sigv4 the enclave BUILDS the Authorization from
  // the sealed secret, so we send no auth header at all.
  const agentSuppliedAuth = Object.keys(req.headers).some((k) => k.toLowerCase() === "authorization");
  const headers = forwardableHeaders(req.headers);
  if (provider.auth.scheme === "bearer") {
    // Discard whatever the agent sent; plant the sentinel where this provider
    // expects its key (Authorization: Bearer … by default, or e.g. Gemini's
    // x-goog-api-key). The enclave swaps the sentinel for the real secret.
    const sh = provider.sentinelHeader ?? { name: "authorization", prefix: "Bearer " };
    removeHeader(headers, "authorization");
    ensureHeader(headers, sh.name, `${sh.prefix}${SENTINEL}`);
  } else {
    // basic/sigv4: the enclave computes the whole Authorization from the sealed
    // secret; strip any agent-sent one so nothing stale rides along.
    removeHeader(headers, "authorization");
  }

  // Inject this provider's real required headers (e.g. GitHub's mandatory
  // User-Agent, Anthropic's anthropic-version, Stripe's pinned API version) —
  // only when the agent didn't set them, so the agent can still override. This
  // is what makes each provider a real integration rather than a bare host.
  for (const [name, value] of Object.entries(provider.defaultHeaders ?? {})) {
    if (!headers.some(([k]) => k.toLowerCase() === name.toLowerCase())) {
      headers.push([name, value]);
    }
  }

  // Work around the T3 host egress parsing every request body as JSON (a raw
  // form-encoded body fails with `http.parse_payload: expected value…`).
  // Form-encoded APIs (Stripe, Twilio, AWS query APIs) accept the same params
  // in the query string, so move a form body into the URL and send no body.
  // The agent's code is unchanged — it can POST a normal form and this adapts
  // it. JSON bodies are left untouched (the host parses those fine).
  let outboundUrl = upstream;
  let outboundBody: string | undefined = body.length ? body.toString("utf8") : undefined;
  const contentType = (headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "").toLowerCase();
  // Skip the form→query rewrite for webhook providers: the URL is the sentinel
  // (the enclave substitutes the real URL), so it isn't parseable here.
  if (provider.auth.scheme !== "webhook" && outboundBody && contentType.includes("application/x-www-form-urlencoded")) {
    const u = new URL(outboundUrl);
    for (const [k, v] of new URLSearchParams(outboundBody)) u.searchParams.append(k, v);
    outboundUrl = u.toString();
    outboundBody = undefined;
    safeLog("info", { msg: "form_body_to_query", provider: provider.id });
  }

  const forwardReq: ForwardRequest = {
    method: req.method ?? "GET",
    url: outboundUrl,
    headers,
    body: outboundBody,
    secret_key: providerSecretKey,
    auth: provider.auth,
  };

  safeLog("info", {
    msg: "proxy_forward",
    method: forwardReq.method,
    upstream: upstream.replace(/\?.*$/, ""),
  });

  const startedAt = Date.now();
  let result;
  try {
    result = await t3.invokeForward(forwardReq);
  } catch (e) {
    // Surface the REAL enclave/host error (egress denied, rate limit, secrets
    // ACL, payload parse) with an actionable hint — not a generic 500.
    const { status, body } = explainForwardError(e as Error);
    safeLog("error", { msg: "proxy_forward_failed", status, provider: provider.id, error: (e as Error).message });
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
    return;
  }
  const latency = Date.now() - startedAt;

  // Record non-sensitive telemetry. Never the body, never the header values.
  logUsage({
    t: new Date().toISOString(),
    mode: env.mock ? "mock" : "real",
    provider: provider.id || providerForUpstream(upstream),
    method: forwardReq.method,
    path: req.url ?? "/",
    upstream: upstream.replace(/\?.*$/, ""),
    status: result.status,
    latency_ms: latency,
    agent_supplied_auth: agentSuppliedAuth,
    auth_scheme: provider.auth.scheme,
    sentinel_in_outbound: forwardReq.headers.some(([k, v]) => k.toLowerCase() === "authorization" && v.includes(SENTINEL)),
    via: "proxy",
    secret_key: providerSecretKey,
  });

  res.writeHead(result.status, headersFromTuple(result.headers));
  const bodyBytes = typeof result.body === "string" ? Buffer.from(result.body, "utf8") : Buffer.from(result.body);
  res.end(bodyBytes);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        // Stop accumulating; the handler sends 413 then destroys the socket.
        aborted = true;
        reject(new PayloadTooLargeError(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!aborted) reject(e); });
  });
}

const STRIPPED = new Set(["host", "content-length", "connection", "transfer-encoding"]);

function forwardableHeaders(h: http.IncomingHttpHeaders): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (STRIPPED.has(k.toLowerCase())) continue;
    out.push([k, Array.isArray(v) ? v.join(", ") : v]);
  }
  return out;
}

function ensureHeader(h: Array<[string, string]>, name: string, value: string): void {
  const lower = name.toLowerCase();
  const idx = h.findIndex(([k]) => k.toLowerCase() === lower);
  if (idx >= 0) h[idx] = [name, value];
  else h.push([name, value]);
}

function removeHeader(h: Array<[string, string]>, name: string): void {
  const lower = name.toLowerCase();
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]![0].toLowerCase() === lower) h.splice(i, 1);
  }
}

function headersFromTuple(t: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of t) out[k] = v;
  return out;
}

/**
 * Turn a raw T3 forward error into a real HTTP status + a JSON body that names
 * the cause and how to fix it. The enclave/host errors look like:
 *   HTTP 400: Invalid params ({"code":"bad_request","detail":"…","request_id":"…"})
 * These are the exact failures that cost real diagnosis time when hidden behind
 * a generic "internal proxy error".
 */
function explainForwardError(err: Error): { status: number; body: string } {
  const msg = err?.message ?? String(err);
  if (err instanceof T3TimeoutError) {
    return {
      status: 504,
      body: JSON.stringify({
        error: "blindfold_forward_failed",
        status: 504,
        code: "t3_timeout",
        detail: msg,
        hint: "The T3 node did not respond within the deadline (BLINDFOLD_T3_TIMEOUT_MS). It may be slow or unreachable; retry, or point T3_BASE_URL at a healthy node.",
      }, null, 2),
    };
  }
  let status = Number(msg.match(/HTTP (\d{3})/)?.[1]) || 502;
  let code = "";
  let detail = msg;
  let requestId = "";
  const jsonM = msg.match(/\((\{.*\})\)\s*$/);
  if (jsonM && jsonM[1]) {
    try {
      const o = JSON.parse(jsonM[1]) as Record<string, string>;
      code = o.code ?? "";
      detail = o.detail ?? detail;
      requestId = o.request_id ?? "";
    } catch {
      /* keep the raw message */
    }
  }

  let hint = "";
  if (/egress_denied|authorised_hosts|allowlist/i.test(detail)) {
    const host = detail.match(/host '([^']+)'/)?.[1];
    hint = `Egress is not authorized${host ? ` for '${host}'` : ""}. Run: blindfold grant --host ${host ?? "<host>"} — list every host you use in ONE command (grant replaces the allowlist unless merged).`;
    if (status < 400) status = 403;
  } else if (/fuel_per_minute|too_many_requests|rate limit/i.test(detail)) {
    hint = "Rate limited by the testnet per-minute compute quota (fuel_per_minute). Retry in ~60s and space calls out — this is not an outage.";
    status = 429;
  } else if (/cannot read map|:secrets/i.test(detail)) {
    hint = "The contract isn't authorized to read your secrets map (common right after publishing a new contract id). Run: blindfold init (re-grants the secrets read ACL).";
  } else if (/parse_payload|expected value at line/i.test(detail)) {
    hint = "The T3 host egress parses request bodies as JSON. For form-encoded APIs (Stripe/Twilio), send params in the query string with an empty body.";
    if (status < 400) status = 400;
  } else if (/secret .* not found|not found in the secrets map/i.test(detail)) {
    hint = "That sealed secret name doesn't exist. Seal it: blindfold register --name <name> --from-env <ENV_VAR>.";
  }

  const payload = {
    error: "blindfold_forward_failed",
    status,
    code: code || undefined,
    detail,
    request_id: requestId || undefined,
    hint: hint || undefined,
  };
  return { status, body: JSON.stringify(payload, null, 2) };
}
