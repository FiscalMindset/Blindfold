/**
 * Web server for the Blindfold Chatbot.
 *
 * Serves:
 *   GET  /            — hand-crafted UI (no AI-generated look)
 *   GET  /assets/*    — CSS, JS, favicon
 *   GET  /api/health  — JSON health
 *   GET  /api/stats   — JSON engine stats
 *   GET  /api/audit   — list all KB entries (questions, intents, audiences)
 *   POST /api/chat    — JSON in / out, single message
 *
 * The web UI is intentionally NOT an AI-generated chat widget. It's a
 * plain, dense, terminal-aesthetic interface designed to look like an
 * extension of the Blindfold CLI — the same audience that uses the proxy
 * and the CLI uses the chatbot.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChatbotEngine } from "./engine.js";
import { loadKB } from "./knowledge.js";
import type { ChatRequest, ChatResponse } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "public");

// --- Request limits (overridable via env) ---
const MAX_BODY_BYTES = Number(process.env.BLINDFOLD_CHATBOT_MAX_BODY_BYTES) || 64 * 1024;
const MAX_MESSAGE_LEN = Number(process.env.BLINDFOLD_CHATBOT_MAX_MESSAGE_LEN) || 8000;
const MAX_HISTORY_LEN = Number(process.env.BLINDFOLD_CHATBOT_MAX_HISTORY_LEN) || 50;

// --- Per-IP rate limiting for /api/chat (fixed window) ---
const RATE_MAX = Number(process.env.BLINDFOLD_CHATBOT_RATE_MAX) || 30;
const RATE_WINDOW_MS = Number(process.env.BLINDFOLD_CHATBOT_RATE_WINDOW_MS) || 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// --- Concurrency cap on the paid LLM fallback ---
const MAX_CONCURRENT_FALLBACKS = Number(process.env.BLINDFOLD_CHATBOT_MAX_FALLBACKS) || 4;
let inFlightFallbacks = 0;

// Global spend budget on the paid fallback: concurrency alone does NOT bound
// total cost (H7). Cap the number of metered calls per rolling window.
const MAX_FALLBACKS_PER_WINDOW = Number(process.env.BLINDFOLD_CHATBOT_MAX_FALLBACKS_PER_WINDOW) || 120;
const FALLBACK_WINDOW_MS = Number(process.env.BLINDFOLD_CHATBOT_FALLBACK_WINDOW_MS) || 60_000;
let fallbackWindowStart = Date.now();
let fallbackWindowCount = 0;
/** True (and consumes one unit) if the global fallback budget allows another call. */
function fallbackBudgetOk(): boolean {
  const now = Date.now();
  if (now - fallbackWindowStart >= FALLBACK_WINDOW_MS) { fallbackWindowStart = now; fallbackWindowCount = 0; }
  if (fallbackWindowCount >= MAX_FALLBACKS_PER_WINDOW) return false;
  fallbackWindowCount++;
  return true;
}

// Only trust X-Forwarded-For behind a known proxy (else it's client-spoofable,
// defeating rate limits, H7). Opt in with BLINDFOLD_CHATBOT_TRUST_PROXY=1.
const TRUST_PROXY = process.env.BLINDFOLD_CHATBOT_TRUST_PROXY === "1";

function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) return (xff.split(",")[0] ?? "").trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Returns null if allowed, or the seconds to wait if rate-limited. */
function rateLimit(ip: string): number | null {
  const now = Date.now();
  // Opportunistically prune expired buckets so the map can't grow unbounded.
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
  }
  let b = rateBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count++;
  if (b.count > RATE_MAX) return Math.ceil((b.resetAt - now) / 1000);
  return null;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  enableLLMFallback?: boolean;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  /** When true, allow CORS from any origin. Useful for the web demo. */
  cors?: boolean;
}

export async function startServer(opts: ServerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const port = opts.port ?? 8788;
  const host = opts.host ?? "127.0.0.1";

  const engine = new ChatbotEngine({
    enableLLMFallback: opts.enableLLMFallback,
    llmApiKey: opts.llmApiKey,
    llmBaseUrl: opts.llmBaseUrl,
    llmModel: opts.llmModel,
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (opts.cors) {
        // Prefer a specific allowlisted origin over `*` (M6): set
        // BLINDFOLD_CHATBOT_CORS_ORIGIN to a comma-list of allowed origins.
        const allow = (process.env.BLINDFOLD_CHATBOT_CORS_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const origin = String(req.headers.origin ?? "");
        if (allow.length === 0) {
          res.setHeader("Access-Control-Allow-Origin", "*");
        } else if (origin && allow.includes(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
        res.setHeader("Access-Control-Allow-Headers", "content-type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

      // Static UI
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return serveStatic(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
      }
      if (url.pathname.startsWith("/assets/")) {
        const filePath = path.join(PUBLIC_DIR, url.pathname);
        if (!filePath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const ct = contentTypeFor(filePath);
        return serveStatic(res, filePath, ct);
      }

      // JSON API
      if (url.pathname === "/api/health") {
        const kb = loadKB();
        return json(res, {
          ok: true,
          kbSize: kb.entries.length,
          intents: engine.getStats().intentCount,
          uptime_ms: Math.round(process.uptime() * 1000),
        });
      }
      if (url.pathname === "/api/stats") {
        return json(res, engine.getStats());
      }
      if (url.pathname === "/api/audit") {
        const kb = loadKB();
        const q = url.searchParams.get("q")?.toLowerCase() ?? "";
        const audience = url.searchParams.get("audience")?.toLowerCase();
        const list = kb.entries
          .filter((e) =>
            (!q || e.question.toLowerCase().includes(q) || e.intent.toLowerCase().includes(q)) &&
            (!audience || e.audience.includes(audience as any)),
          )
          .map((e) => ({
            id: e.id,
            intent: e.intent,
            question: e.question,
            audience: e.audience,
            confidence: e.confidence,
            sources: e.sources ?? [],
          }));
        return json(res, { count: list.length, entries: list });
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const retryAfter = rateLimit(clientIp(req));
        if (retryAfter !== null) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfter) });
          res.end(JSON.stringify({ error: "rate limit exceeded", retryAfterSeconds: retryAfter }));
          return;
        }
        const body = await readJson(req);
        const message = String(body.message ?? "").trim();
        if (!message) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "message is required" }));
          return;
        }
        if (message.length > MAX_MESSAGE_LEN) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `message exceeds ${MAX_MESSAGE_LEN} characters` }));
          return;
        }
        // Validate each history item (L6): keep only well-formed, length-capped
        // {role, content} entries so malformed/huge items don't reach downstream.
        const history = (Array.isArray(body.history) ? body.history : [])
          .slice(0, MAX_HISTORY_LEN)
          .filter((h: unknown): h is { role: string; content: string } =>
            !!h && typeof h === "object" && typeof (h as { content?: unknown }).content === "string")
          .map((h: { role?: unknown; content: string }) => ({
            role: h.role === "assistant" || h.role === "system" ? h.role : "user",
            content: h.content.slice(0, MAX_MESSAGE_LEN),
          }));
        const req_: ChatRequest = { message, audience: body.audience, history };
        // Cap concurrent paid LLM fallbacks AND enforce a global per-window spend
        // budget: when either is exceeded, force the deterministic KB answer.
        const fallbackAllowed = inFlightFallbacks < MAX_CONCURRENT_FALLBACKS && fallbackBudgetOk();
        if (fallbackAllowed) inFlightFallbacks++;
        try {
          const out: ChatResponse = await engine.ask(req_, { disableLLMFallback: !fallbackAllowed });
          return json(res, out);
        } finally {
          if (fallbackAllowed) inFlightFallbacks--;
        }
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "application/json", "connection": "close" });
          res.end(JSON.stringify({ error: "payload too large" }));
        }
        // Now that the response is flushing, stop the client's upload.
        req.destroy();
        return;
      }
      // Keep the detail in the server log only — don't leak internals (M7).
      safeLog("error", { msg: "server_error", error: (e as Error).message });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://${host}:${bound}`;
      console.log(`blindfold chatbot serving on ${url}`);
      resolve({
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function serveStatic(res: http.ServerResponse, filePath: string, contentType: string): void {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".css":  return "text/css; charset=utf-8";
    case ".js":   return "application/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg":  return "image/svg+xml";
    case ".ico":  return "image/x-icon";
    default:      return "application/octet-stream";
  }
}

function json(res: http.ServerResponse, obj: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj, null, 2));
}

class PayloadTooLargeError extends Error {}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating (bounds memory) but don't destroy the socket here —
        // the handler still needs to send a 413 response on it first.
        aborted = true;
        reject(new PayloadTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error(`bad JSON: ${(e as Error).message}`));
      }
    });
    req.on("error", (e) => { if (!aborted) reject(e); });
  });
}

function safeLog(level: string, obj: Record<string, unknown>): void {
  // Never log request bodies or paths that might contain secrets.
  const safe = { level, ...obj };
  if (level === "error") console.error(JSON.stringify(safe));
  else console.log(JSON.stringify(safe));
}