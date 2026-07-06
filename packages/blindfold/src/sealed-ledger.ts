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
import { createHash, createHmac, randomBytes } from "node:crypto";
import { stateDir, withFileLockSync } from "./env.ts";

export interface SealedEntry {
  t: string;           // ISO timestamp
  name: string;        // KV key inside z:<tid>:secrets
  source: string;      // "stdin" | "env:VAR" | "explicit"
  length: number;      // byte-count of the value (NOT the value)
  mode: "real" | "mock";
  tenant_did: string;
  map_name: string;    // z:<tid>:secrets
  prev?: string;       // hash of the previous chained entry ("" for the first)
  hash?: string;       // HMAC(key, prev + "\n" + core) — tamper-evidence
  alg?: string;        // "hmac-sha256" for keyed entries; absent = legacy sha256
}

export function defaultSealedLogPath(): string {
  return process.env.BLINDFOLD_SEALED_LOG ?? path.join(stateDir(), "sealed.jsonl");
}

/**
 * Local HMAC key for the ledger chain. Unlike the previous plain sha256 chain
 * (which anyone could recompute), this key is not derivable from the ledger, so
 * an attacker who edits a line cannot forge a valid chain. Persisted to
 * .blindfold/ledger.key (0600), generated on first use. Returns null if the key
 * can't be obtained — callers then fall back to the legacy sha256 chain.
 */
function ledgerKey(): Buffer | null {
  try {
    const keyPath = path.join(stateDir(), "ledger.key");
    if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const key = randomBytes(32);
    fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
    return key;
  } catch {
    return null;
  }
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

function chainHash(key: Buffer | null, prev: string, core: string): { hash: string; alg?: string } {
  if (key) return { hash: createHmac("sha256", key).update(`${prev}\n${core}`).digest("hex"), alg: "hmac-sha256" };
  return { hash: sha(`${prev}\n${core}`) }; // legacy fallback
}

/** Efficiently read the last non-empty line without parsing the whole file. */
function readLastLine(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  const fd = fs.openSync(p, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const readLen = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
    return lines.length ? lines[lines.length - 1]! : null;
  } finally {
    fs.closeSync(fd);
  }
}

export function recordSealed(entry: SealedEntry): void {
  const p = defaultSealedLogPath();
  try {
    // Serialize read-tail + append under an exclusive lock so two concurrent
    // sealers can't read the same prevHash and fork the chain (false "TAMPERED").
    withFileLockSync(p, () => {
      let prevHash = "";
      const last = readLastLine(p);
      if (last) {
        try { prevHash = (JSON.parse(last) as SealedEntry).hash ?? ""; } catch { prevHash = ""; }
      }
      const { hash, alg } = chainHash(ledgerKey(), prevHash, coreString(entry));
      const chained: SealedEntry = { ...entry, prev: prevHash, hash, ...(alg ? { alg } : {}) };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, JSON.stringify(chained) + "\n");
    });
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
  const key = ledgerKey();
  let runningPrev = "";
  let legacy = 0;
  let firstBrokenIndex = -1;
  entries.forEach((e, i) => {
    if (!e.hash) { legacy++; return; } // no hash at all — pre-chain, unverifiable
    if (e.alg === "hmac-sha256") {
      // Keyed entry — real tamper detection (requires the local key).
      const expected = key ? createHmac("sha256", key).update(`${runningPrev}\n${coreString(e)}`).digest("hex") : null;
      if (firstBrokenIndex < 0 && (e.prev !== runningPrev || (expected !== null && e.hash !== expected))) {
        firstBrokenIndex = i;
      }
      if (expected === null) legacy++; // key unavailable → can't verify, don't cry tamper
    } else {
      // Legacy plain-sha256 entry: recomputable by anyone, so treat as
      // unverifiable rather than authoritative. The enclave (blindfold audit)
      // remains the source of truth for these.
      legacy++;
    }
    runningPrev = e.hash;
  });
  return { ok: firstBrokenIndex < 0, total: entries.length, legacy, firstBrokenIndex };
}
