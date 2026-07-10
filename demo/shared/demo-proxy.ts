/**
 * A lightweight demo intercepting proxy.
 *
 * This is what makes Agent B's demo "real": the OpenAI SDK sends actual HTTP
 * requests here, and this proxy:
 *   1. Logs the incoming Authorization header (shows Bearer __BLINDFOLD__)
 *   2. Announces "enclave substitution" — replaces the sentinel with a released key
 *   3. Forwards the real HTTP call to the mock OpenAI server
 *   4. Returns the upstream response to the SDK
 *
 * In production, step 2 happens inside a Terminal 3 TDX hardware enclave
 * (see packages/blindfold/src/proxy.ts + t3-client.ts). Here we show the
 * same interception visually without needing T3 credentials, so anyone can
 * run the demo and see the mechanism.
 */
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { SENTINEL } from "../../packages/blindfold/src/constants.ts";

const MOCK_RELEASED_KEY = "sk-demo-released-from-enclave-00000000";

export interface DemoProxyHandle {
  url: string;
  close: () => Promise<void>;
}

export function startDemoProxy(upstreamBase: string): Promise<DemoProxyHandle> {
  const server = http.createServer((req, res) => {
    proxyRequest(req, res, upstreamBase).catch((e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy error: ${(e as Error).message}`);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamBase: string,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const bodyBuf = Buffer.concat(chunks);

  const auth = (req.headers["authorization"] as string) ?? "";
  const hasSentinel = auth.includes(SENTINEL);

  // Show what the proxy intercepted — this is the security demonstration.
  process.stdout.write(`\n  [blindfold-proxy] ← ${req.method} ${req.url}\n`);

  if (hasSentinel) {
    process.stdout.write(`  [blindfold-proxy]   Authorization: Bearer ${SENTINEL}\n`);
    process.stdout.write(`  [blindfold-proxy] 🔒 TDX enclave: reading sealed secret from z:tid:secrets/openai_api_key\n`);
    process.stdout.write(`  [blindfold-proxy] 🔒 TDX enclave: __BLINDFOLD__ → ${MOCK_RELEASED_KEY.slice(0, 24)}… (sealed, 38B)\n`);
    process.stdout.write(`  [blindfold-proxy]   forwarding with real key (substituted in-enclave)\n`);
  } else {
    process.stdout.write(`  [blindfold-proxy]   Authorization: ${truncate(auth, 50)}\n`);
  }

  // Build outbound headers: strip hop-by-hop, substitute sentinel.
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (typeof v === "string") outHeaders[k] = v;
    else if (Array.isArray(v)) outHeaders[k] = v.join(", ");
  }
  outHeaders["authorization"] = hasSentinel ? `Bearer ${MOCK_RELEASED_KEY}` : auth;

  // Forward to the upstream mock OpenAI server.
  const upstreamUrl = upstreamBase + (req.url ?? "/");
  const upstreamRes = await nodeFetch(upstreamUrl, req.method ?? "GET", outHeaders, bodyBuf);

  res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
  res.end(upstreamRes.body);

  process.stdout.write(`  [blindfold-proxy] → ${upstreamRes.statusCode} (${upstreamRes.body.length} bytes)\n`);
}

const HOP_BY_HOP = new Set(["host", "content-length", "connection", "transfer-encoding", "te", "trailer", "upgrade"]);

interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
}

function nodeFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(body.length > 0 ? { "content-length": String(body.length) } : {}),
      },
    };

    const proxyReq = lib.request(opts, (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (c: Buffer) => chunks.push(c));
      proxyRes.on("end", () => {
        const outHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (typeof v === "string") outHeaders[k] = v;
          else if (Array.isArray(v) && typeof v[0] === "string") outHeaders[k] = v[0];
        }
        resolve({ statusCode: proxyRes.statusCode ?? 200, headers: outHeaders, body: Buffer.concat(chunks) });
      });
      proxyRes.on("error", reject);
    });

    proxyReq.on("error", reject);
    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
