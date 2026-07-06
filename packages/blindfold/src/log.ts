/**
 * Logging utilities that never leak secret values.
 *
 * Rule: `safeLog` is the ONLY logger used across Blindfold. It scrubs
 * any header named authorization-ish before printing. CI greps for any
 * `console.log` containing the substring "Bearer " — that should never
 * appear in source.
 */

const HEADER_BLOCKLIST = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
]);

export type Loggable = Record<string, unknown> | string;

export function safeLog(level: "info" | "warn" | "error", obj: Loggable): void {
  const safe = typeof obj === "string" ? { msg: obj } : redact(obj);
  const line = JSON.stringify({ t: new Date().toISOString(), level, ...safe });
  process.stderr.write(line + "\n");
}

export function redact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "headers" && v && typeof v === "object") {
      out[k] = redactHeaders(v as Record<string, unknown> | Array<[string, string]>);
    } else if (HEADER_BLOCKLIST.has(k.toLowerCase())) {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactHeaders(
  h: Record<string, unknown> | Array<[string, string]>,
): Record<string, string> | Array<[string, string]> {
  if (Array.isArray(h)) {
    return h.map(([k, v]): [string, string] => [k, HEADER_BLOCKLIST.has(k.toLowerCase()) ? "[redacted]" : v]);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = HEADER_BLOCKLIST.has(k.toLowerCase()) ? "[redacted]" : String(v);
  }
  return out;
}
