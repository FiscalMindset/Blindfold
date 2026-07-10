/**
 * attest() — client-side remote attestation of the Terminal 3 enclave cluster.
 *
 * Trust upgrade: instead of *trusting* Terminal 3 to run a genuine TDX enclave,
 * we cryptographically VERIFY it before trusting it with a secret. The T3 node
 * publishes a DKG attestation bundle at `${nodeUrl}/status`:
 *   - one raw TDX v4 quote per cluster node (base64),
 *   - an attestation message binding the quotes to the cluster's ML-KEM key.
 *
 * The SDK's `verifyDkgAttestation()` does the full cryptographic check in WASM:
 *   1. the attestation message starts with the ML-KEM encaps key (the node
 *      can't swap the key it's attesting to),
 *   2. every quote's ECDSA-P256 signature chains to Intel's SGX root CA,
 *   3. every quote's report_data == keccak512(attestation message),
 *   4. (optional) RTMR3 pinning — the measurement of the code/config running
 *      inside the enclave matches an expected value you pin.
 *
 * If (1)–(3) pass, the enclave is genuine Intel TDX silicon. If you also pin
 * RTMR3, you additionally prove it's running the exact code you expect —
 * "verify the hardware", not "trust the operator".
 *
 * This does not need the tenant key; it reads the node's public /status.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBlindfoldEnv, configPath, withFileLockSync } from "./env.ts";
import type { BlindfoldEnv } from "./types.ts";

const PIN_FIELD = "expectedRtmr3";

/** The RTMR3 measurement pinned in config.json, if any. */
export function readPinnedRtmr3(): string | undefined {
  try {
    const obj = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    const v = obj[PIN_FIELD];
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Persist a pinned RTMR3 in config.json (preserving other fields, 0600).
 *  Locked read-modify-write so a concurrent `login` can't clobber it (M4). */
export function writePinnedRtmr3(value: string): void {
  const cfg = configPath();
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  withFileLockSync(cfg, () => {
    let obj: Record<string, unknown> = {};
    try { obj = JSON.parse(fs.readFileSync(cfg, "utf8")) as Record<string, unknown>; } catch { /* new file */ }
    obj[PIN_FIELD] = value;
    fs.writeFileSync(cfg, JSON.stringify(obj, null, 2), { mode: 0o600 });
    try { fs.chmodSync(cfg, 0o600); } catch { /* best effort */ }
  });
}

/** Subset of the @terminal3/t3n-sdk attestation surface we rely on. */
interface AttestSdk {
  setEnvironment: (env: "testnet" | "production") => void;
  setNodeUrl: (url: string | null) => void;
  getNodeUrl: (baseUrl?: string) => string;
  fetchDkgAttestation: (baseUrl?: string) => Promise<
    { peer_ids: string[]; quotes: Record<string, string>; attestation_msg: string } | undefined
  >;
  fetchMlKemPublicKey: (baseUrl?: string) => Promise<string>;
  verifyDkgAttestation: (
    encapsKeyB64: string,
    attestationMsgB64: string,
    peerIds: string[],
    quotes: Record<string, string>,
    expectedRtmr3B64?: string,
  ) => Promise<{
    valid: boolean;
    valid_count: number;
    expected_count: number;
    error?: string;
    results: { peer_id: string; valid: boolean; error?: string; rtmr3?: string }[];
  }>;
}

export interface AttestResult {
  /** False when the node publishes no attestation (mock signer / bootstrapping). */
  available: boolean;
  nodeUrl: string;
  valid: boolean;
  validCount: number;
  expectedCount: number;
  /** Distinct RTMR3 measurements observed across the cluster's quotes. */
  rtmr3s: string[];
  /** True only when an expected RTMR3 was supplied and every quote matched it. */
  pinned: boolean;
  error?: string;
}

export interface AttestOpts {
  env?: BlindfoldEnv;
  /** Base64 48-byte RTMR3 to pin (fail unless every quote matches it). */
  expectRtmr3?: string;
  /** Skip the short-lived result cache and force a fresh fetch+verify. */
  noCache?: boolean;
}

// Quotes/RTMR3 are stable between enclave restarts, so a fresh fetch + full
// ECDSA WASM verify on every gate call is wasteful (S3). Cache per
// env+node+pin for a short TTL; the CLI `attest` command bypasses it (noCache).
const ATTEST_TTL_MS = Number(process.env.BLINDFOLD_ATTEST_TTL_MS) || 300_000;
const attestCache = new Map<string, { at: number; result: AttestResult }>();

async function loadAttestSdk(): Promise<AttestSdk> {
  try {
    return (await import("@terminal3/t3n-sdk")) as unknown as AttestSdk;
  } catch {
    throw new Error(
      "@terminal3/t3n-sdk not installed — attestation needs the real SDK. Run `npm install @terminal3/t3n-sdk`.",
    );
  }
}

export async function attest(opts: AttestOpts = {}): Promise<AttestResult> {
  const env = opts.env ?? loadBlindfoldEnv();
  if (env.mock) {
    throw new Error("attestation is unavailable in mock mode (BLINDFOLD_MOCK=1) — it needs a real T3 node.");
  }

  const cacheKey = `${env.t3Env}|${env.t3BaseUrl}|${opts.expectRtmr3 ?? ""}`;
  if (!opts.noCache) {
    const hit = attestCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ATTEST_TTL_MS) return hit.result;
  }

  const sdk = await loadAttestSdk();
  sdk.setEnvironment(env.t3Env);
  if (env.t3BaseUrl) sdk.setNodeUrl(env.t3BaseUrl);
  const nodeUrl = sdk.getNodeUrl(env.t3BaseUrl || undefined);

  const bundle = await sdk.fetchDkgAttestation(nodeUrl);
  if (!bundle) {
    const unavailable: AttestResult = { available: false, nodeUrl, valid: false, validCount: 0, expectedCount: 0, rtmr3s: [], pinned: false };
    attestCache.set(cacheKey, { at: Date.now(), result: unavailable });
    return unavailable;
  }

  const encapsKey = await sdk.fetchMlKemPublicKey(nodeUrl);
  const r = await sdk.verifyDkgAttestation(
    encapsKey,
    bundle.attestation_msg,
    bundle.peer_ids,
    bundle.quotes,
    opts.expectRtmr3,
  );

  const rtmr3s = [...new Set(r.results.map((p) => p.rtmr3).filter((x): x is string => Boolean(x)))];
  const result: AttestResult = {
    available: true,
    nodeUrl,
    valid: r.valid,
    validCount: r.valid_count,
    expectedCount: r.expected_count,
    rtmr3s,
    pinned: Boolean(opts.expectRtmr3) && r.valid,
    error: r.error,
  };
  attestCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

export interface GateResult {
  /** True when attestation was actually required (a pin exists or was forced). */
  enforced: boolean;
  /** True when not enforced, or enforced and verified. */
  ok: boolean;
  message?: string;
  /** Non-fatal caveat the caller should print loudly (e.g. bypass / no-pin). */
  warning?: string;
}

/**
 * Attestation gate for sensitive operations (seal, proxy). It is a no-op unless
 * the user has pinned an RTMR3 (`attest --pin`) or set `BLINDFOLD_REQUIRE_ATTEST=1`
 * — so it's opt-in and back-compat. When enforced, it verifies the live enclave
 * (and RTMR3 pin) and returns ok=false with a reason if it doesn't check out.
 * Skipped entirely in mock mode or when `skip` is set (`--no-attest`).
 */
export async function attestationGate(
  opts: { env?: BlindfoldEnv; skip?: boolean; requirePin?: boolean } = {},
): Promise<GateResult> {
  const env = opts.env ?? loadBlindfoldEnv();
  const pinned = readPinnedRtmr3();
  const required = Boolean(pinned) || process.env.BLINDFOLD_REQUIRE_ATTEST === "1";

  // --no-attest: honor it, but make the bypass LOUD when a gate was in force (H6).
  if (opts.skip) {
    return {
      enforced: false,
      ok: true,
      warning: required ? "attestation gate BYPASSED via --no-attest — the enclave was NOT verified" : undefined,
    };
  }
  // Mock mode: refuse when attestation is required, rather than silently no-op (M5).
  if (env.mock) {
    if (required) {
      return { enforced: true, ok: false, message: "refusing to run in mock mode while attestation is required (a pin or BLINDFOLD_REQUIRE_ATTEST is set) — mock mode never touches a real enclave" };
    }
    return { enforced: false, ok: true };
  }
  if (!required) return { enforced: false, ok: true };

  let r: AttestResult;
  try {
    r = await attest({ env, expectRtmr3: pinned });
  } catch (e) {
    return { enforced: true, ok: false, message: (e as Error).message };
  }
  if (!r.available) return { enforced: true, ok: false, message: `node published no attestation (${r.nodeUrl})` };

  // A pin proves "runs MY code"; valid-without-pin only proves "genuine TDX
  // silicon" — insufficient to seal a NEW secret to (H4).
  if (opts.requirePin && !pinned) {
    return {
      enforced: true,
      ok: false,
      message: "refusing: this operation requires a pinned RTMR3 (run `blindfold attest --pin`). Unpinned attestation only proves it's a TDX enclave, not that it runs your expected code.",
    };
  }

  const ok = r.valid && (!pinned || r.pinned);
  const warning = ok && !pinned
    ? "attestation valid but NO RTMR3 pinned — proves genuine TDX silicon, not that the enclave runs your expected code. Pin it: `blindfold attest --pin`."
    : undefined;
  return {
    enforced: true,
    ok,
    warning,
    message: ok ? undefined : `enclave attestation failed${pinned ? " (RTMR3 pin mismatch)" : ""} at ${r.nodeUrl}`,
  };
}
