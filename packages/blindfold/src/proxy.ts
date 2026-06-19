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
 * The path the agent uses (e.g. /v1/chat/completions) is mapped 1:1
 * onto api.openai.com. Other providers can be added by extending the
 * `upstreamForPath` switch below.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SENTINEL } from "./constants.ts";
import { loadBlindfoldEnv } from "./env.ts";
import { safeLog } from "./log.ts";
import { openT3Client, type T3ClientHandle } from "./t3-client.ts";
import type { ForwardRequest } from "./types.ts";
import { logUsage, providerForUpstream } from "./usage-log.ts";

export interface ProxyOpts {
  port?: number;
  /** Logical name of the secret to substitute. Default: "openai_api_key". */
  secretKey?: string;
}

export interface ProxyHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startProxy(opts: ProxyOpts = {}): Promise<ProxyHandle> {
  const env = loadBlindfoldEnv();
  const port = opts.port ?? env.port ?? 8787;
  const secretKey = opts.secretKey ?? "openai_api_key";
  const t3 = await openT3Client(env);

  const server = http.createServer((req, res) => {
    handle(req, res, t3, secretKey).catch((e) => {
      safeLog("error", { msg: "proxy_unhandled", error: (e as Error).message });
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal proxy error");
    });
  });

  return await new Promise<ProxyHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${bound}`;
      safeLog("info", { msg: "proxy_listening", url, mock: env.mock });
      resolve({
        url,
        port: bound,
        close: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          await t3.close();
        },
      });
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  t3: T3ClientHandle,
  secretKey: string,
): Promise<void> {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mock: loadBlindfoldEnv().mock }));
    return;
  }

  const upstream = upstreamForPath(req.url ?? "/");
  if (!upstream) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`no upstream mapping for ${req.url}`);
    return;
  }

  const body = await readBody(req);
  // Build the headers we'll send to the contract. Any Authorization the
  // agent sent is replaced with the sentinel — the agent's bearer value
  // is never forwarded.
  const agentSuppliedAuth = Object.keys(req.headers).some((k) => k.toLowerCase() === "authorization");
  const headers = forwardableHeaders(req.headers);
  ensureHeader(headers, "authorization", `Bearer ${SENTINEL}`);

  const forwardReq: ForwardRequest = {
    method: req.method ?? "GET",
    url: upstream,
    headers,
    body: body.length ? body.toString("utf8") : undefined,
    secret_key: secretKey,
  };

  safeLog("info", {
    msg: "proxy_forward",
    method: forwardReq.method,
    upstream: upstream.replace(/\?.*$/, ""),
  });

  const startedAt = Date.now();
  const result = await t3.invokeForward(forwardReq);
  const latency = Date.now() - startedAt;

  // Record non-sensitive telemetry. Never the body, never the header values.
  logUsage({
    t: new Date().toISOString(),
    mode: loadBlindfoldEnv().mock ? "mock" : "real",
    provider: providerForUpstream(upstream),
    method: forwardReq.method,
    path: req.url ?? "/",
    upstream: upstream.replace(/\?.*$/, ""),
    status: result.status,
    latency_ms: latency,
    agent_supplied_auth: agentSuppliedAuth,
    sentinel_in_outbound: forwardReq.headers.some(([k, v]) => k.toLowerCase() === "authorization" && v.includes(SENTINEL)),
  });

  res.writeHead(result.status, headersFromTuple(result.headers));
  const bodyBytes = typeof result.body === "string" ? Buffer.from(result.body, "utf8") : Buffer.from(result.body);
  res.end(bodyBytes);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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

function headersFromTuple(t: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of t) out[k] = v;
  return out;
}

/**
 * Map a proxy path to a real upstream URL. The path the agent sends is
 * preserved verbatim; only the scheme+host changes.
 *
 * Add more providers by extending this switch. The contract is generic;
 * no contract-side change is required.
 */
function upstreamForPath(path: string): string | null {
  if (path.startsWith("/v1/")) return `https://api.openai.com${path}`;
  if (path.startsWith("/openai/")) return `https://api.openai.com${path.replace("/openai", "")}`;
  if (path.startsWith("/anthropic/")) return `https://api.anthropic.com${path.replace("/anthropic", "")}`;
  return null;
}
