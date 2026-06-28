/**
 * release() — short-lived secret retrieval from the T3 enclave.
 *
 * for short-lived use — drop the returned value from scope as soon as the call is done.
 *
 * This is the canonical one-liner alternative to the ~30-line release-broker
 * pattern shown in examples/grok-via-blindfold.ts. It opens a T3 client,
 * calls the "release-to-tenant" contract function, returns the plaintext
 * value, then closes the client. The caller is responsible for not persisting
 * the returned string.
 *
 * SECURITY NOTE: the returned value is a plaintext secret. Treat it like a
 * raw API key — do not log it, do not store it on disk, drop it from scope
 * as soon as the outbound call it enables completes.
 */
import { loadBlindfoldEnv } from "./env.ts";
import { CONTRACT_TAIL, CONTRACT_VERSION } from "./constants.ts";
import { openT3Client } from "./t3-client.ts";
import { logUsage } from "./usage-log.ts";
import type { BlindfoldEnv } from "./types.ts";

export interface ReleaseOpts {
  /** Override the T3 client env (useful in tests). If omitted, loadBlindfoldEnv() is used. */
  env?: BlindfoldEnv;
  /** How this release was triggered — recorded in the usage log ("release" | "use" | "export"). */
  via?: string;
}

/**
 * Release a sealed secret from the T3 enclave by name and return its
 * plaintext value.
 *
 * for short-lived use — drop the returned value from scope as soon as the call is done.
 *
 * @param name  The secret name passed to `registerSecret` when the key was sealed.
 * @param opts  Optional overrides (env, t3Client).
 * @returns     The plaintext secret value.
 */
export async function release(name: string, opts?: ReleaseOpts): Promise<string> {
  const env = opts?.env ?? loadBlindfoldEnv();
  const t3 = await openT3Client(env);
  const startedAt = Date.now();
  try {
    const value = await t3.releaseSecret(name);
    // Record the release in the usage log (metadata only — never the value) so
    // the dashboard reflects ALL secret use, not just proxy traffic.
    logUsage({
      t: new Date().toISOString(),
      mode: env.mock ? "mock" : "real",
      provider: "(enclave)",
      method: "RELEASE",
      path: name,
      upstream: "t3-enclave",
      status: 200,
      latency_ms: Date.now() - startedAt,
      agent_supplied_auth: false,
      sentinel_in_outbound: false,
      via: opts?.via ?? "release",
      secret_key: name,
    });
    return value;
  } finally {
    await t3.close();
  }
}
