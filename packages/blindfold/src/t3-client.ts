/**
 * Thin wrapper around @terminal3/t3n-sdk (v3.x).
 *
 * SECURITY INVARIANT: this module never sees a plaintext API key,
 * neither at registration nor at runtime.
 *   - At registration time, `register.ts` passes the value as the literal
 *     `value` field of one `executeControl("map-entry-set", …)` call.
 *   - At runtime, the proxy sends headers whose Authorization is the
 *     sentinel string; the contract substitutes inside the enclave.
 *
 * The SDK is loaded lazily so MOCK mode works on machines that haven't
 * installed it. REAL mode requires `@terminal3/t3n-sdk` (optionalDep).
 */
import type { BlindfoldEnv, ForwardRequest, ForwardResponse } from "./types.ts";
import { CONTRACT_TAIL, CONTRACT_VERSION } from "./constants.ts";
import { assertRealReady } from "./env.ts";
import { safeLog } from "./log.ts";

/** Loaded SDK module shape (subset of the real @terminal3/t3n-sdk exports). */
interface T3Sdk {
  setEnvironment: (env: "testnet" | "production") => void;
  loadWasmComponent: () => Promise<unknown>;
  eth_get_address: (privKey: string) => string;
  metamask_sign: (address: string, _: undefined, privKey: string) => unknown;
  createEthAuthInput: (address: string) => unknown;
  T3nClient: new (cfg: unknown) => {
    handshake: () => Promise<unknown>;
    authenticate: (input: unknown) => Promise<unknown>;
  };
  TenantClient: new (cfg: unknown) => {
    canonicalName: (tail: string) => string;
    executeControl: (functionName: string, input: unknown) => Promise<unknown>;
    contracts: {
      register: (input: { tail: string; version: string; wasm: Uint8Array }) => Promise<unknown>;
      execute: (tail: string, input: { version: string; functionName: string; input?: unknown }) => Promise<unknown>;
      enable: (tail: string) => Promise<unknown>;
      disable: (tail: string) => Promise<unknown>;
      unregister: (tail: string) => Promise<unknown>;
    };
  };
  NODE_URLS: { testnet: string; production: string };
}

let sdkCache: T3Sdk | null = null;
async function loadSdk(): Promise<T3Sdk> {
  if (sdkCache) return sdkCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import("@terminal3/t3n-sdk")) as unknown as T3Sdk;
    sdkCache = mod;
    return mod;
  } catch {
    throw new Error(
      "@terminal3/t3n-sdk not installed. Run `npm install @terminal3/t3n-sdk` " +
        "for REAL T3 mode, or set BLINDFOLD_MOCK=1 to keep using mock mode.",
    );
  }
}

export interface T3ClientHandle {
  close: () => Promise<void>;
  seedSecret: (name: string, value: string) => Promise<void>;
  invokeForward: (req: ForwardRequest) => Promise<ForwardResponse>;
  registerContract: (wasm: Uint8Array) => Promise<{ contractId: string | number }>;
  /**
   * Release a sealed secret from the enclave by name.
   * for short-lived use — drop the returned value from scope as soon as the call is done.
   */
  releaseSecret: (name: string) => Promise<string>;
  /**
   * Linearizable read of the tenant behind the current key. Throws if the key
   * has no provisioned tenant (the failure mode that surfaces as a bare 500).
   */
  me: () => Promise<{ tenant: string; status?: string }>;
  /**
   * Authorize the blindfold-proxy contract's forward/release-to-tenant
   * functions to make outbound calls to the given hosts (the egress grant the
   * proxy + in-enclave http::call path require).
   */
  grantEgress: (hosts: string[]) => Promise<void>;
  /** True if a real T3 round-trip happened during construction. */
  isReal: boolean;
}

export async function openT3Client(env: BlindfoldEnv): Promise<T3ClientHandle> {
  if (env.mock) return openMockClient();
  assertRealReady(env);
  return openRealClient(env);
}

/* ------------------------------------------------------------------ */
/* REAL — @terminal3/t3n-sdk v3.x                                      */
/* ------------------------------------------------------------------ */

async function openRealClient(env: BlindfoldEnv): Promise<T3ClientHandle> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.t3nApiKey)) {
    throw new Error("T3N_API_KEY must be a 0x-prefixed 32-byte hex (secp256k1 private key).");
  }
  if (!/^did:t3n:[0-9a-fA-F]+$/.test(env.did)) {
    throw new Error('DID must look like "did:t3n:<hex>".');
  }

  const sdk = await loadSdk();
  sdk.setEnvironment(env.t3Env);
  // Prefer an explicit override (T3_BASE_URL) so the user can point at a
  // healthy/leader node when the SDK's default node is an unhealthy follower.
  const baseUrl = env.t3BaseUrl || sdk.NODE_URLS[env.t3Env];

  const wasmComponent = await sdk.loadWasmComponent();
  const address = sdk.eth_get_address(env.t3nApiKey);

  const t3n = new sdk.T3nClient({
    baseUrl,
    wasmComponent,
    handlers: { EthSign: sdk.metamask_sign(address, undefined, env.t3nApiKey) },
  });

  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(address));

  const tenant = new sdk.TenantClient({
    environment: env.t3Env,
    baseUrl,
    tenantDid: env.did,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    t3n: t3n as any,
  });

  const seedSecret = async (name: string, value: string): Promise<void> => {
    // ⚠️ The ONLY line in Blindfold that ever sees plaintext.
    await tenant.executeControl("map-entry-set", {
      map_name: tenant.canonicalName("secrets"),
      key: name,
      value,
    });
    safeLog("info", { msg: "seeded", name });
  };

  const registerContract = async (wasm: Uint8Array): Promise<{ contractId: string | number }> => {
    const r = (await tenant.contracts.register({
      tail: CONTRACT_TAIL,
      version: CONTRACT_VERSION,
      wasm,
    })) as Record<string, unknown>;
    return {
      contractId: (r.contract_id as string | number | undefined) ?? (r.contractId as string | number | undefined) ?? "(unknown)",
    };
  };

  const invokeForward = async (req: ForwardRequest): Promise<ForwardResponse> => {
    // The contract's forward() returns { ok, code, body, length } — the
    // canonical T3 http.response has a status code + payload but NO response
    // headers. Adapt that to the proxy's ForwardResponse shape.
    const raw = (await tenant.contracts.execute(CONTRACT_TAIL, {
      version: CONTRACT_VERSION,
      functionName: "forward",
      input: req,
    })) as { ok?: boolean; code?: number; body?: string; status?: number; headers?: Array<[string, string]> };
    // Tolerate both the new shape (code/body) and any legacy shape (status/headers).
    if (typeof raw.status === "number" && Array.isArray(raw.headers)) {
      return { status: raw.status, headers: raw.headers, body: raw.body ?? "" };
    }
    return {
      status: raw.code ?? 502,
      headers: [["content-type", "application/json"]],
      body: raw.body ?? "",
    };
  };

  const decodeSecret = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return Buffer.from(v as number[]).toString("utf8");
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.value === "string") return o.value;
      if (Array.isArray(o.value)) return Buffer.from(o.value as number[]).toString("utf8");
      const entry = o.entry as Record<string, unknown> | undefined;
      if (entry && typeof entry.value === "string") return entry.value;
    }
    return "";
  };

  const releaseSecret = async (name: string): Promise<string> => {
    // Preferred path: the contract's `release-to-tenant` (access gated by the
    // contract's read-ACL on the secrets map). Requires the contract published
    // on this tenant.
    try {
      const r = (await tenant.contracts.execute(CONTRACT_TAIL, {
        version: CONTRACT_VERSION,
        functionName: "release-to-tenant",
        input: { secret_key: name },
      })) as { ok?: boolean; value?: string };
      if (r && r.ok && r.value) return r.value;
    } catch {
      /* contract not published on this tenant — fall through to direct read */
    }
    // Fallback: the tenant owner reads its own secrets map directly. Same trust
    // boundary (the holder of the tenant key can always release its secrets),
    // but works without a published contract.
    const direct = decodeSecret(
      await tenant.executeControl("map-entry-get", {
        map_name: tenant.canonicalName("secrets"),
        key: name,
      }),
    );
    if (!direct) throw new Error(`secret "${name}" not found in the secrets map`);
    return direct;
  };

  const me = async (): Promise<{ tenant: string; status?: string }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (await (tenant as any).tenant.me()) as Record<string, unknown>;
    return { tenant: String(info.tenant ?? ""), status: info.status as string | undefined };
  };

  const grantEgress = async (hosts: string[]): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anySdk = sdk as any;
    let ucv = "0.1.0";
    if (typeof anySdk.getScriptVersion === "function") {
      try {
        const v = await anySdk.getScriptVersion(baseUrl, "tee:user/contracts");
        if (typeof v === "string" && /^\d/.test(v)) ucv = v;
      } catch {
        /* fall back to 0.1.0 */
      }
    }
    const didHex = env.did.replace(/^did:t3n:/, "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (t3n as any).execute({
      script_name: "tee:user/contracts",
      script_version: ucv,
      function_name: "agent-auth-update",
      input: {
        agents: [{
          agentDid: env.did,
          scripts: [{
            scriptName: `z:${didHex}:${CONTRACT_TAIL}`,
            versionReq: `>=${CONTRACT_VERSION}`,
            functions: ["forward", "release-to-tenant"],
            allowedHosts: hosts,
          }],
        }],
      },
    });
  };

  return {
    close: async () => {
      /* SDK has no close()  */
    },
    seedSecret,
    invokeForward,
    registerContract,
    releaseSecret,
    me,
    grantEgress,
    isReal: true,
  };
}

/* ------------------------------------------------------------------ */
/* MOCK                                                                */
/* ------------------------------------------------------------------ */

function openMockClient(): T3ClientHandle {
  return {
    close: async () => {},
    async seedSecret(name, value) {
      if (!value || value.length === 0) throw new Error(`secret ${name} is empty`);
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
      return { status: 200, headers: [["content-type", "application/json"]], body };
    },
    async releaseSecret(name) {
      safeLog("info", { msg: "mock-release", name });
      return `mock-released:${name}`;
    },
    async me() {
      return { tenant: "did:t3n:mock", status: "active" };
    },
    async grantEgress(hosts) {
      safeLog("info", { msg: "mock-grant-egress", hosts });
    },
    isReal: false,
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
