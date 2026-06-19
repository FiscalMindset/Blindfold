/**
 * Pulls T3's own structured logs for the blindfold-proxy contract,
 * then attempts execute() one more time with extra verbosity. The
 * point is to get a concrete error message we can act on, instead
 * of the opaque "internal_error" we saw last time.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM_PATH = path.join(ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) {
    console.log("Set T3 creds in .env first.");
    process.exit(1);
  }

  console.log("Loading SDK …");
  const sdk = (await import("@terminal3/t3n-sdk")) as Record<string, unknown> & {
    setEnvironment: (e: string) => void;
    NODE_URLS: Record<string, string>;
    loadWasmComponent: () => Promise<unknown>;
    eth_get_address: (k: string) => string;
    metamask_sign: (a: string, _: undefined, k: string) => unknown;
    createEthAuthInput: (a: string) => unknown;
    T3nClient: new (cfg: unknown) => any;
    TenantClient: new (cfg: unknown) => any;
  };

  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const wasmComponent = await sdk.loadWasmComponent();
  const address = sdk.eth_get_address(env.t3nApiKey);

  const t3n = new sdk.T3nClient({
    baseUrl,
    wasmComponent,
    handlers: { EthSign: sdk.metamask_sign(address, undefined, env.t3nApiKey) },
  });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(address));

  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  /* 1. Fetch the contract's own debug logs from T3. */
  console.log("\n=== T3 contract logs (blindfold-proxy) ===");
  try {
    const logs = await tenant.contracts.logs("blindfold-proxy", { limit: 50 });
    if (!logs?.entries?.length) {
      console.log("(no entries — logs may be disabled for this tenant, or the contract never reached logging::info)");
    } else {
      for (const e of logs.entries) {
        console.log(`  ${new Date(e.ts_ms).toISOString()} [${e.level}] ${e.message}`);
      }
    }
    console.log(`(truncated=${logs?.truncated}, next_seq=${logs?.next_seq})`);
  } catch (e) {
    console.log("logs() failed:", (e as Error).message);
  }

  /* 2. Try execute again, capturing full error structure. */
  console.log("\n=== execute() ===");
  if (!existsSync(WASM_PATH)) {
    console.log("(no wasm; skipping)");
    return;
  }
  try {
    const CONTRACT_VERSION = process.argv[3] || (await import("../packages/blindfold/src/constants.ts")).CONTRACT_VERSION;
    const secretKey = process.argv[2] || "openai_api_key";
    console.log(`  asking contract to read secret_key="${secretKey}" from secrets map …`);
    const r = await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION,
      functionName: "forward",
      input: {
        method: "GET",
        url: "https://httpbin.org/anything",
        headers: [["Authorization", "Bearer __BLINDFOLD__"]],
        secret_key: secretKey,
      },
    });
    console.log("RAW response:", JSON.stringify(r, null, 2).slice(0, 2000));
  } catch (e) {
    const err = e as Error & { cause?: unknown; code?: string; data?: unknown };
    console.log("error class:", err.constructor.name);
    console.log("error message:", err.message);
    if (err.cause) console.log("cause:", JSON.stringify(err.cause).slice(0, 800));
    if (err.data) console.log("data:", JSON.stringify(err.data).slice(0, 800));
    if ((err as any).response) console.log("response:", JSON.stringify((err as any).response).slice(0, 800));
    for (const k of Object.keys(err)) {
      if (!["message", "stack", "cause", "data", "response"].includes(k)) {
        console.log(`  ${k}:`, JSON.stringify((err as any)[k]).slice(0, 400));
      }
    }
  }

  /* 3. Try logs() again post-execute. */
  console.log("\n=== T3 logs after execute ===");
  try {
    const logs = await tenant.contracts.logs("blindfold-proxy", { limit: 20 });
    if (!logs?.entries?.length) console.log("(still no log entries)");
    else for (const e of logs.entries) console.log(`  ${new Date(e.ts_ms).toISOString()} [${e.level}] ${e.message}`);
  } catch (e) {
    console.log("logs() failed:", (e as Error).message);
  }
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
