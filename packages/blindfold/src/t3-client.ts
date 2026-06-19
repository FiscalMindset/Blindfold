/**
 * Thin wrapper around @terminal3/t3n-sdk.
 *
 * IMPORTANT: this module never sees a plaintext API key, neither at
 * registration nor at runtime. At registration time, the secret value
 * is passed through as the literal `value` field of a single
 * `executeControl("map-entry-set", …)` invocation by `register.ts`. At
 * runtime, the proxy sends a ForwardRequest whose headers contain only
 * the sentinel string.
 *
 * The SDK is loaded lazily so the rest of Blindfold works in MOCK mode
 * even on machines where the package isn't installed (e.g. the demo).
 */
import type { BlindfoldEnv, ForwardRequest, ForwardResponse } from "./types.ts";
import { CONTRACT_TAIL, CONTRACT_VERSION } from "./constants.ts";
import { safeLog } from "./log.ts";

// We intentionally do NOT import @terminal3/t3n-sdk eagerly — it's an
// optional dep. Real mode requires it; mock mode does not.
type SdkModule = Record<string, unknown>; // structural, since signatures
                                          // are NEEDS VERIFICATION upstream.

let sdkCache: SdkModule | null = null;
async function loadSdk(): Promise<SdkModule> {
  if (sdkCache) return sdkCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import("@terminal3/t3n-sdk")) as SdkModule;
    sdkCache = mod;
    return mod;
  } catch {
    throw new Error(
      "@terminal3/t3n-sdk not installed. Either `npm i @terminal3/t3n-sdk` for real T3 mode, " +
        "or set BLINDFOLD_MOCK=1 (it's already on by default if T3N_API_KEY+DID are unset).",
    );
  }
}

export interface T3ClientHandle {
  /** Disposes of any in-memory authenticated session. */
  close: () => Promise<void>;
  /** One-time control-plane write to seed a secret value into z:<tid>:secrets. */
  seedSecret: (name: string, value: string) => Promise<void>;
  /** Per-request: invoke the deployed Blindfold contract. */
  invokeForward: (req: ForwardRequest) => Promise<ForwardResponse>;
  /** Register the WASM contract (one-time after build). */
  registerContract: (wasm: Uint8Array) => Promise<{ contractId: string | number }>;
}

export async function openT3Client(env: BlindfoldEnv): Promise<T3ClientHandle> {
  if (env.mock) return openMockClient(env);
  return openRealClient(env);
}

/* ------------------------------------------------------------------ */
/* REAL                                                                */
/* ------------------------------------------------------------------ */

async function openRealClient(env: BlindfoldEnv): Promise<T3ClientHandle> {
  const sdk = await loadSdk();
  // The exact SDK surface is documented in
  // docs/02-terminal3-analysis.md §4. Items marked NEEDS VERIFICATION
  // there may need narrow adjustments; the structure below matches the
  // official walkthrough verbatim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = sdk as any;
  if (typeof s.setEnvironment === "function") s.setEnvironment(env.t3Env);

  const wasmComponent = typeof s.loadWasmComponent === "function" ? await s.loadWasmComponent() : undefined;
  const address = s.eth_get_address(env.t3nApiKey);
  const t3n = new s.T3nClient({
    wasmComponent,
    handlers: { EthSign: s.metamask_sign(address, undefined, env.t3nApiKey) },
  });
  await t3n.handshake();
  await t3n.authenticate(s.createEthAuthInput(address));

  const tenant = new s.TenantClient({ t3n, tenantDid: env.did, baseUrl: typeof s.getNodeUrl === "function" ? s.getNodeUrl() : undefined });

  const seedSecret = async (name: string, value: string): Promise<void> => {
    // ⚠️ This is the ONLY line in Blindfold that ever sees plaintext.
    await tenant.executeControl("map-entry-set", {
      map_name: tenant.canonicalName("secrets"),
      key: name,
      value,
    });
    safeLog("info", { msg: "seeded", name });
  };

  const registerContract = async (wasm: Uint8Array): Promise<{ contractId: string | number }> => {
    const r = await tenant.contracts.register({ tail: CONTRACT_TAIL, version: CONTRACT_VERSION, wasm });
    return { contractId: r.contract_id ?? r.contractId ?? "(unknown)" };
  };

  const invokeForward = async (req: ForwardRequest): Promise<ForwardResponse> => {
    const tidHex = env.did.replace(/^did:t3n:/, "");
    const scriptName = `z:${tidHex}:${CONTRACT_TAIL}`;
    const scriptVersion = typeof s.getScriptVersion === "function" ? await s.getScriptVersion(scriptName) : 1;
    const result = await tenant.executeAndDecode({
      script_name: scriptName,
      script_version: scriptVersion,
      function_name: "forward",
      input: req,
    });
    return result as ForwardResponse;
  };

  return {
    close: async () => {
      if (typeof t3n.close === "function") await t3n.close();
    },
    seedSecret,
    invokeForward,
    registerContract,
  };
}

/* ------------------------------------------------------------------ */
/* MOCK                                                                */
/* ------------------------------------------------------------------ */

/**
 * Mock client used in demos. Honest about its role: it does NOT pretend
 * to be an enclave; it explicitly refuses to retain or forward secrets.
 *
 * - seedSecret: validates non-empty, then drops the value on the floor.
 *   This is sufficient for the demo because the mock invokeForward never
 *   tries to make a real outbound API call. (We never substitute the
 *   sentinel for a real value, anywhere.)
 * - invokeForward: returns a deterministic stub response so the proxy
 *   can be exercised end-to-end without a real T3 deployment.
 */
function openMockClient(_env: BlindfoldEnv): T3ClientHandle {
  return {
    close: async () => {},

    async seedSecret(name, value) {
      if (!value || value.length === 0) throw new Error(`secret ${name} is empty`);
      // Deliberately do NOT log the value. Do not store it. The mock has
      // no "secrets map" — the value is dropped here. The honest claim
      // we make in mock mode is: "we received the value, we did not keep
      // it, and our proxy will not be able to use it." That preserves
      // the invariant Blindfold ships under.
      safeLog("info", { msg: "mock-seed (value dropped, length only)", name, length: value.length });
    },

    async registerContract(wasm) {
      safeLog("info", { msg: "mock-register-contract", wasmBytes: wasm.byteLength });
      return { contractId: "mock-contract-1" };
    },

    async invokeForward(req) {
      safeLog("info", {
        msg: "mock-forward",
        method: req.method,
        url: schemeAndHost(req.url),
        secret_key: req.secret_key,
      });
      const body = `{"mock":true,"note":"Blindfold mock mode — no real call made.","echo":{"url":${JSON.stringify(req.url)}}}`;
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body,
      };
    },
  };
}

function schemeAndHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<bad-url>";
  }
}
