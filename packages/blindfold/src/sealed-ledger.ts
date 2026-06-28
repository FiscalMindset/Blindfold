/**
 * Append-only, tamper-evident ledger of "what's sealed in the enclave right now".
 *
 * SAFETY: metadata only — never the value. Each line records the key
 * name, its source, its byte-length (so you can sanity-check after
 * sealing), the tenant DID + map name (so you know exactly which
 * enclave + map holds it), and when. No plaintext, ever.
 *
 * INTEGRITY: each entry carries a `prev` + `hash` forming a hash-chain, so
 * any edit or deletion of a past line is detectable (`verifyLedgerChain`).
 * The enclave remains the source of truth — `blindfold audit` reconciles this
 * ledger against it.
 *
 * Default path: ./.blindfold/sealed.jsonl  (override via BLINDFOLD_SEALED_LOG)
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface SealedEntry {
  t: string;           // ISO timestamp
  name: string;        // KV key inside z:<tid>:secrets
  source: string;      // "stdin" | "env:VAR" | "explicit"
  length: number;      // byte-count of the value (NOT the value)
  mode: "real" | "mock";
  tenant_did: string;
  map_name: string;    // z:<tid>:secrets
  prev?: string;       // hash of the previous chained entry ("" for the first)
  hash?: string;       // sha256(prev + "\n" + core) — tamper-evidence
}

export function defaultSealedLogPath(): string {
  return process.env.BLINDFOLD_SEALED_LOG ?? path.join(process.cwd(), ".blindfold", "sealed.jsonl");
}

/** Canonical serialization of the metadata fields (excludes prev/hash). */
function coreString(e: SealedEntry): string {
  return JSON.stringify({
    t: e.t, name: e.name, source: e.source, length: e.length,
    mode: e.mode, tenant_did: e.tenant_did, map_name: e.map_name,
  });
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function recordSealed(entry: SealedEntry): void {
  const p = defaultSealedLogPath();
  try {
    // Link to the last chained entry (legacy entries without a hash are skipped).
    const existing = readSealed();
    let prevHash = "";
    for (const e of existing) if (e.hash) prevHash = e.hash;
    const hash = sha(`${prevHash}\n${coreString(entry)}`);
    const chained: SealedEntry = { ...entry, prev: prevHash, hash };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(chained) + "\n");
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

export interface ChainResult {
  ok: boolean;
  total: number;
  legacy: number;       // entries with no hash (pre-chain) — unverifiable
  firstBrokenIndex: number; // -1 if intact
}

/**
 * Verify the hash-chain. A broken chain means a line was edited or removed
 * after it was written — the ledger has been tampered with.
 */
export function verifyLedgerChain(): ChainResult {
  const entries = readSealed();
  let runningPrev = "";
  let legacy = 0;
  let firstBrokenIndex = -1;
  entries.forEach((e, i) => {
    if (!e.hash) { legacy++; return; } // legacy entry, not part of the chain
    const expected = sha(`${runningPrev}\n${coreString(e)}`);
    if (firstBrokenIndex < 0 && (e.prev !== runningPrev || e.hash !== expected)) {
      firstBrokenIndex = i;
    }
    runningPrev = e.hash;
  });
  return { ok: firstBrokenIndex < 0, total: entries.length, legacy, firstBrokenIndex };
}
