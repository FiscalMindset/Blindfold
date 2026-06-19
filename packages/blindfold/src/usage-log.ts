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
}

export function defaultLogPath(): string {
  return process.env.BLINDFOLD_USAGE_LOG ?? path.join(process.cwd(), ".blindfold", "usage.jsonl");
}

export function logUsage(event: UsageEvent): void {
  const p = defaultLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
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
    return h;
  } catch {
    return "unknown";
  }
}
