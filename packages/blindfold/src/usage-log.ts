/**
 * Append-only usage log for the Blindfold proxy.
 *
 * SAFETY: this module records ONLY non-sensitive metadata. It never
 * writes request bodies, response bodies, or any header values to disk.
 * The dashboard and stats commands read from the same file and inherit
 * this constraint by construction.
 *
 * Default path: ./.blindfold/usage.jsonl   (overridable via env BLINDFOLD_USAGE_LOG)
 *
 * Format: one JSON object per line (JSONL). Schema below.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./env.ts";

export interface UsageEvent {
  /** ISO-8601 timestamp */
  t: string;
  /** "real" if a T3 contract was called, "mock" if the local stub responded */
  mode: "real" | "mock";
  /** Provider derived from the URL, e.g. "openai", "anthropic" */
  provider: string;
  /** HTTP method the agent used */
  method: string;
  /** Path the agent hit on the proxy (e.g. /v1/chat/completions) */
  path: string;
  /** Upstream URL the contract was asked to call */
  upstream: string;
  /** Response status code */
  status: number;
  /** End-to-end latency through the proxy (ms) */
  latency_ms: number;
  /** True if the agent supplied any Authorization header at all (interesting telemetry: did it think it had a key?) */
  agent_supplied_auth: boolean;
  /** True iff the outbound request carries the Blindfold sentinel — proof the proxy did its job */
  sentinel_in_outbound: boolean;
  /** Auth scheme the enclave applied: "bearer" | "basic" | "sigv4". Optional for back-compat. */
  auth_scheme?: string;
  /** How the secret was used: "proxy" (HTTP proxy) | "release"/"use"/"export" (broker paths). Optional for back-compat. */
  via?: string;
  /** The sealed secret name involved (for the per-secret view). */
  secret_key?: string;
}

export function defaultLogPath(): string {
  return process.env.BLINDFOLD_USAGE_LOG ?? path.join(stateDir(), "usage.jsonl");
}

const USAGE_MAX_BYTES = Number(process.env.BLINDFOLD_USAGE_MAX_BYTES) || 10 * 1024 * 1024;

/** Rotate usage.jsonl → .1 → .2 when it grows past the size cap. */
function rotateIfNeeded(p: string): void {
  try {
    const size = fs.statSync(p).size;
    if (size < USAGE_MAX_BYTES) return;
    if (fs.existsSync(`${p}.1`)) fs.renameSync(`${p}.1`, `${p}.2`);
    fs.renameSync(p, `${p}.1`);
  } catch {
    /* stat/rename failures must not break the request path */
  }
}

export function logUsage(event: UsageEvent): void {
  const p = defaultLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfNeeded(p);
    fs.appendFileSync(p, JSON.stringify(event) + "\n");
  } catch {
    // Logging is never allowed to throw and crash a request path.
  }
}

export function readUsage(): UsageEvent[] {
  const p = defaultLogPath();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as UsageEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is UsageEvent => e !== null);
}

/**
 * Read only the last `n` events (byte-tail read), so a polled server never
 * loads a multi-hundred-MB log into memory. Falls back to whole-file only for
 * small files.
 */
export function readUsageTail(n = 500): UsageEvent[] {
  const p = defaultLogPath();
  if (!fs.existsSync(p)) return [];
  const fd = fs.openSync(p, "r");
  try {
    const size = fs.fstatSync(fd).size;
    // Read at most ~2KB per requested event from the end of the file.
    const readLen = Math.min(size, Math.max(64 * 1024, n * 2048));
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    let text = buf.toString("utf8");
    if (readLen < size) {
      // Drop a possibly-partial first line.
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as UsageEvent; } catch { return null; } })
      .filter((e): e is UsageEvent => e !== null);
    return events.slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

export function clearUsage(): void {
  const p = defaultLogPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function providerForUpstream(upstream: string): string {
  try {
    const u = new URL(upstream);
    const h = u.hostname;
    if (h.endsWith("openai.com")) return "openai";
    if (h.endsWith("anthropic.com")) return "anthropic";
    if (h.endsWith("googleapis.com")) return "google";
    if (h.endsWith("x.ai")) return "xai";
    if (h.endsWith("groq.com")) return "groq";
    return h;
  } catch {
    return "unknown";
  }
}
