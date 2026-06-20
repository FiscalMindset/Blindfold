/**
 * Append-only ledger of "what's sealed in the enclave right now".
 *
 * SAFETY: metadata only — never the value. Each line records the key
 * name, its source, its byte-length (so you can sanity-check after
 * sealing), the tenant DID + map name (so you know exactly which
 * enclave + map holds it), and when. No plaintext, ever.
 *
 * Default path: ./.blindfold/sealed.jsonl  (override via BLINDFOLD_SEALED_LOG)
 */
import fs from "node:fs";
import path from "node:path";

export interface SealedEntry {
  t: string;           // ISO timestamp
  name: string;        // KV key inside z:<tid>:secrets
  source: string;      // "stdin" | "env:VAR" | "explicit"
  length: number;      // byte-count of the value (NOT the value)
  mode: "real" | "mock";
  tenant_did: string;
  map_name: string;    // z:<tid>:secrets
}

export function defaultSealedLogPath(): string {
  return process.env.BLINDFOLD_SEALED_LOG ?? path.join(process.cwd(), ".blindfold", "sealed.jsonl");
}

export function recordSealed(entry: SealedEntry): void {
  const p = defaultSealedLogPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch {
    /* never let logging crash the seal */
  }
}

export function readSealed(): SealedEntry[] {
  const p = defaultSealedLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l) as SealedEntry; } catch { return null; } })
    .filter((e): e is SealedEntry => e !== null);
}
