/**
 * ⚠️ AUDIT-CRITICAL FILE
 *
 * This is the ONLY file in Blindfold that ever has the plaintext API
 * key in scope. It exists so the auditor can read it end-to-end in one
 * sitting:
 *
 *   1. Read the value from process.env via the helper `pluckSecret`.
 *   2. Pass it as the `value` field of a single `seedSecret` call.
 *   3. Return.
 *
 * The value is not stored on disk, not echoed to logs, not returned by
 * this function, and not assigned to any module-level state. The local
 * binding `value` goes out of scope at function exit.
 *
 * Any change to this file should be reviewed against `docs/AGENTS.md`
 * invariant #2.
 */
import { loadBlindfoldEnv, pluckSecret } from "./env.ts";
import { safeLog } from "./log.ts";
import { readSecretLine } from "./prompt.ts";
import { openT3Client } from "./t3-client.ts";
import type { RegisterOpts } from "./types.ts";

export async function registerSecret(opts: RegisterOpts): Promise<void> {
  const env = loadBlindfoldEnv();
  const t3 = await openT3Client(env);

  try {
    // Resolve the plaintext exactly once. Three input modes, in priority:
    //   1. opts.value     — explicit (programmatic API)
    //   2. opts.fromEnv   — read process.env[<name>]
    //   3. interactive    — prompt the terminal with echo disabled
    // The local binding `value` exists here, is passed to seedSecret, then dropped.
    let source = "stdin";
    let value: string;
    if (opts.value !== undefined) {
      value = opts.value;
      source = "explicit";
    } else if (opts.fromEnv) {
      value = pluckSecret(opts.fromEnv);
      source = `env:${opts.fromEnv}`;
    } else {
      value = await readSecretLine(`  Value for "${opts.name}" (input is hidden): `);
      if (!value) throw new Error("empty value");
    }

    await t3.seedSecret(opts.name, value);
    safeLog("info", {
      msg: "registered",
      name: opts.name,
      source,
      length: value.length,
      mode: env.mock ? "mock" : "real",
    });
  } finally {
    await t3.close();
  }
}

export async function registerContract(wasm: Uint8Array): Promise<{ contractId: string | number }> {
  const env = loadBlindfoldEnv();
  const t3 = await openT3Client(env);
  try {
    return await t3.registerContract(wasm);
  } finally {
    await t3.close();
  }
}
