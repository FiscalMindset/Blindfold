/**
 * Local index of secret versions for rollback.
 *
 * When you `rotate` a secret, the PREVIOUS value is snapshotted into the enclave
 * under a reserved key (`__bfver__<name>__<ts>`) — the value never leaves the
 * enclave; only this metadata index is local. `rollback` reads the snapshot back
 * and re-seals it under the live name.
 *
 * SAFETY: metadata only (name, the enclave version-key, byte-length, a
 * non-reversible fingerprint, timestamp). Never the value. The reserved version
 * keys are NOT recorded in the sealed-keys ledger, so `status`/`audit` ignore them.
 *
 * Default path: ./.blindfold/versions.jsonl (override via BLINDFOLD_VERSIONS_LOG)
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./env.ts";

export interface VersionEntry {
  t: string;            // ISO timestamp the snapshot was taken
  name: string;         // the live secret name this is a version of
  versionKey: string;   // reserved KV key holding the snapshot in the enclave
  length: number;       // byte-length of the snapshotted value
  fingerprint: string;  // sha256 prefix of the snapshotted value
}

export function defaultVersionsPath(): string {
  return process.env.BLINDFOLD_VERSIONS_LOG ?? path.join(stateDir(), "versions.jsonl");
}

/** Build the reserved enclave key for a new snapshot of `name`. */
export function versionKeyFor(name: string, stampMs: number): string {
  return `__bfver__${name}__${stampMs}`;
}

/**
 * Guard against a tampered versions.jsonl pointing `rollback` at an arbitrary
 * enclave key: a legitimate versionKey is always `__bfver__<name>__<digits>`.
 * (rollback additionally verifies the released value's fingerprint.)
 */
export function isValidVersionKey(name: string, versionKey: string): boolean {
  return new RegExp(`^__bfver__${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}__\\d+$`).test(versionKey);
}

export function recordVersion(entry: VersionEntry): void {
  const p = defaultVersionsPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch {
    /* never let version bookkeeping crash a rotate */
  }
}

/** All version entries (optionally for one name), oldest-first. */
export function readVersions(name?: string): VersionEntry[] {
  const p = defaultVersionsPath();
  if (!fs.existsSync(p)) return [];
  const all = fs.readFileSync(p, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l) as VersionEntry; } catch { return null; } })
    .filter((e): e is VersionEntry => e !== null);
  return name ? all.filter(e => e.name === name) : all;
}
