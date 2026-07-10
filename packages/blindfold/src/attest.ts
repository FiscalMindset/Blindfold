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
import { loadBlindfoldEnv } from "./env.ts";
import type { BlindfoldEnv } from "./types.ts";

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
}

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

  const sdk = await loadAttestSdk();
  sdk.setEnvironment(env.t3Env);
  if (env.t3BaseUrl) sdk.setNodeUrl(env.t3BaseUrl);
  const nodeUrl = sdk.getNodeUrl(env.t3BaseUrl || undefined);

  const bundle = await sdk.fetchDkgAttestation(nodeUrl);
  if (!bundle) {
    return { available: false, nodeUrl, valid: false, validCount: 0, expectedCount: 0, rtmr3s: [], pinned: false };
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
  return {
    available: true,
    nodeUrl,
    valid: r.valid,
    validCount: r.valid_count,
    expectedCount: r.expected_count,
    rtmr3s,
    pinned: Boolean(opts.expectRtmr3) && r.valid,
    error: r.error,
  };
}
