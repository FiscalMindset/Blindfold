/**
 * Thin wrapper around @terminal3/t3n-sdk (v3.x).
 *
 * SECURITY MODEL — read carefully, the paths differ:
 *   - PROXY/FORWARD path: plaintext is substituted INSIDE the enclave. The
 *     proxy sends the sentinel string as Authorization; this module never sees
 *     the plaintext key for forwarded calls. This is the un-leakable path.
 *   - SEED path (registration): `seedSecret()` DOES handle the plaintext once,
 *     passing it as the `value` of a single `map-entry-set` call. It is dropped
 *     immediately and never logged.
 *   - RELEASE path: `releaseSecret()` RETURNS plaintext to the local process by
 *     design (broker use/export/rotate/rollback). Protection here rests on the
 *     tenant key (T3N_API_KEY) not being reachable by the agent — see SECURITY.md.
 *
 * The SDK is loaded lazily so MOCK mode works on machines that haven't
 * installed it. REAL mode requires `@terminal3/t3n-sdk` (optionalDep).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BlindfoldEnv, ForwardRequest, ForwardResponse } from "./types.ts";
import { CONTRACT_TAIL, CONTRACT_VERSION } from "./constants.ts";
import { assertRealReady, stateDir, withFileLockSync } from "./env.ts";
import { safeLog } from "./log.ts";

/** Deadline wrapper so a stalled T3 node can't hang an agent request forever. */
const T3_TIMEOUT_MS = Number(process.env.BLINDFOLD_T3_TIMEOUT_MS) || 30_000;
export class T3TimeoutError extends Error {}
function withDeadline<T>(promise: Promise<T>, label: string, ms = T3_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new T3TimeoutError(`T3 ${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/* ---- egress allowlist cache -------------------------------------------------
 * T3 REPLACES the contract's egress allowlist on every agent-auth update, so a
 * grant must send the FULL desired set each time. We remember previously-granted
 * hosts per tenant in .blindfold/egress-hosts.json and union new hosts in, so
 * `grant` becomes additive instead of clobbering earlier grants.
 * ---------------------------------------------------------------------------- */
function egressCachePath(): string {
  return process.env.BLINDFOLD_EGRESS_CACHE ?? path.join(stateDir(), "egress-hosts.json");
}
export function loadEgressHosts(did: string): string[] {
  try {
    const all = JSON.parse(fs.readFileSync(egressCachePath(), "utf8")) as Record<string, string[]>;
    return Array.isArray(all[did]) ? all[did] : [];
  } catch {
    return [];
  }
}
function saveEgressHosts(did: string, hosts: string[]): void {
  const p = egressCachePath();
  // Lock + re-read + union so two concurrent grants can't clobber each other's
  // hosts (T3 replaces the whole allowlist, so a dropped host = lost egress).
  withFileLockSync(p, () => {
    let all: Record<string, string[]> = {};
    try {
      all = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string[]>;
    } catch {
      /* fresh file */
    }
    const existing = Array.isArray(all[did]) ? all[did] : [];
    all[did] = Array.from(new Set([...existing, ...hosts])).sort();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(all, null, 2));
  });
}

/** Loaded SDK module shape (the subset of @terminal3/t3n-sdk that Blindfold
 *  actually calls). Exported so init.ts shares the same typed boundary instead
 *  of casting the dynamic import to `any`. */
export interface T3Sdk {
  setEnvironment: (env: "testnet" | "production") => void;
  loadWasmComponent: () => Promise<unknown>;
  eth_get_address: (privKey: string) => string;
  metamask_sign: (address: string, _: undefined, privKey: string) => unknown;
  createEthAuthInput: (address: string) => unknown;
  /** Optional control-plane helper; present on newer SDKs, guarded at the call site. */
  getScriptVersion?: (baseUrl: string, scriptPath: string) => Promise<unknown>;
  T3nClient: new (cfg: unknown) => {
    handshake: () => Promise<unknown>;
    authenticate: (input: unknown) => Promise<unknown>;
    execute: (input: unknown) => Promise<unknown>;
  };
  TenantClient: new (cfg: unknown) => {
    canonicalName: (tail: string) => string;
    executeControl: (functionName: string, input: unknown) => Promise<unknown>;
    tenant: { me: () => Promise<unknown> };
    token: { getUsage: (opts?: unknown) => Promise<{ balance?: Record<string, unknown> }> };
    maps: {
      create: (input: unknown) => Promise<unknown>;
      update: (name: string, input: unknown) => Promise<unknown>;
    };
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
  grantEgress: (hosts: string[], opts?: { replace?: boolean }) => Promise<string[]>;
  /**
   * Authorize an arbitrary agent DID (a teammate) to call this tenant's
   * contract functions for the given hosts. Empty hosts+functions revokes.
   */
  setAgentGrant: (agentDid: string, hosts: string[], functions: string[]) => Promise<void>;
  /**
   * Confirm a sealed secret still exists in the enclave. Returns its byte
   * length + a non-reversible fingerprint (never the value) so an audit can
   * reconcile the local ledger against the enclave (the source of truth).
   */
  verifySecret: (name: string) => Promise<{ present: boolean; length: number; fingerprint: string }>;
  /**
   * Read the tenant's token/credit balance (a session-authed read that costs no
   * credit — works even when the account is exhausted). Powers `blindfold credit`.
   */
  getBalance: () => Promise<CreditBalance>;
  /** True if a real T3 round-trip happened during construction. */
  isReal: boolean;
}

/** Tenant credit balance (base units; 1 token = 1,000,000 base units). */
export interface CreditBalance {
  available: number;
  reserved: number;
  creditExhausted: boolean;
  storageDeposit?: number;
  mock?: boolean;
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
    t3n,
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
    const raw = (await withDeadline(tenant.contracts.execute(CONTRACT_TAIL, {
      version: CONTRACT_VERSION,
      functionName: "forward",
      input: req,
    }), "forward")) as { ok?: boolean; code?: number; body?: string; status?: number; headers?: Array<[string, string]> };
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
      const r = (await withDeadline(tenant.contracts.execute(CONTRACT_TAIL, {
        version: CONTRACT_VERSION,
        functionName: "release-to-tenant",
        input: { secret_key: name },
      }), "release-to-tenant")) as { ok?: boolean; value?: string };
      if (r && r.ok && r.value) return r.value;
    } catch (e) {
      if (e instanceof T3TimeoutError) throw e; // don't mask a hang as "not published"
      /* contract not published on this tenant — fall through to direct read */
    }
    // Fallback: the tenant owner reads its own secrets map directly. Same trust
    // boundary (the holder of the tenant key can always release its secrets),
    // but works without a published contract.
    const direct = decodeSecret(
      await withDeadline(tenant.executeControl("map-entry-get", {
        map_name: tenant.canonicalName("secrets"),
        key: name,
      }), "map-entry-get"),
    );
    if (!direct) throw new Error(`secret "${name}" not found in the secrets map`);
    return direct;
  };

  const me = async (): Promise<{ tenant: string; status?: string }> => {
    const info = (await tenant.tenant.me()) as Record<string, unknown>;
    return { tenant: String(info.tenant ?? ""), status: info.status as string | undefined };
  };

  // Shared agent-auth grant. Authorizes `agentDid` (self or a teammate) to call
  // this tenant's contract functions for the given hosts. Empty functions+hosts
  // means revoke (scripts: []).
  const agentAuthUpdate = async (agentDid: string, hosts: string[], functions: string[]): Promise<void> => {
    let ucv = "0.1.0";
    if (typeof sdk.getScriptVersion === "function") {
      try {
        const v = await sdk.getScriptVersion(baseUrl, "tee:user/contracts");
        if (typeof v === "string" && /^\d/.test(v)) ucv = v;
      } catch {
        /* fall back to 0.1.0 */
      }
    }
    const didHex = env.did.replace(/^did:t3n:/, "");
    // T3 rejects an empty scripts array, so "revoke" is expressed as a script
    // entry that authorizes the function with NO allowed hosts → it can't reach
    // anything, which is an effective revocation.
    const revoking = functions.length === 0 && hosts.length === 0;
    const scripts = [{
      scriptName: `z:${didHex}:${CONTRACT_TAIL}`,
      versionReq: `>=${CONTRACT_VERSION}`,
      functions: revoking ? ["forward"] : functions,
      allowedHosts: revoking ? [] : hosts,
    }];
    await t3n.execute({
      script_name: "tee:user/contracts",
      script_version: ucv,
      function_name: "agent-auth-update",
      input: { agents: [{ agentDid, scripts }] },
    });
  };

  const grantEgress = async (hosts: string[], opts?: { replace?: boolean }): Promise<string[]> => {
    const prev = opts?.replace ? [] : loadEgressHosts(env.did);
    const merged = Array.from(new Set([...prev, ...hosts])).sort();
    await agentAuthUpdate(env.did, merged, ["forward", "release-to-tenant"]);
    saveEgressHosts(env.did, merged);
    return merged;
  };

  const setAgentGrant = (agentDid: string, hosts: string[], functions: string[]): Promise<void> =>
    agentAuthUpdate(agentDid, hosts, functions);

  const verifySecret = async (name: string): Promise<{ present: boolean; length: number; fingerprint: string }> => {
    try {
      const value = await releaseSecret(name); // contract path, or control-plane fallback
      return { present: true, length: value.length, fingerprint: createHash("sha256").update(value).digest("hex").slice(0, 8) };
    } catch {
      return { present: false, length: 0, fingerprint: "" };
    }
  };

  const getBalance = async (): Promise<CreditBalance> => {
    const page = await withDeadline(tenant.token.getUsage(), "token.getUsage");
    const b = (page.balance ?? {}) as Record<string, unknown>;
    return {
      available: Number(b.available ?? 0),
      reserved: Number(b.reserved ?? 0),
      creditExhausted: Boolean(b.credit_exhausted),
      storageDeposit: b.storage_deposit != null ? Number(b.storage_deposit) : undefined,
    };
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
    setAgentGrant,
    verifySecret,
    getBalance,
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
      return hosts;
    },
    async setAgentGrant(agentDid, hosts, functions) {
      safeLog("info", { msg: "mock-set-agent-grant", agentDid, hosts, functions });
    },
    async verifySecret(name) {
      return { present: true, length: 0, fingerprint: `mock-${name}`.slice(0, 8) };
    },
    async getBalance() {
      return { available: 1_000_000_000, reserved: 0, creditExhausted: false, mock: true };
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
