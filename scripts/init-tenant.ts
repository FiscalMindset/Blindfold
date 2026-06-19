/**
 * One-time tenant initialisation for a freshly-claimed T3 testnet account.
 * Does claim(), then probes a few map-create shapes for the secrets map.
 */
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) { console.log("REAL mode needed."); process.exit(1); }

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
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  /* 1. Claim — sets up default tenant scaffolding (probably idempotent). */
  console.log("→ tenant.tenant.claim() …");
  try {
    const r = await tenant.tenant.claim();
    console.log("  ✅", JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log("  ⚠", (e as Error).message.slice(0, 200));
  }

  /* 2. me() — see what state we're in. */
  console.log("\n→ tenant.tenant.me() …");
  try {
    const r = await tenant.tenant.me();
    console.log("  ✅", JSON.stringify(r, null, 2).slice(0, 600));
  } catch (e) {
    console.log("  ⚠", (e as Error).message.slice(0, 200));
  }

  /* 3. Probe map-create shapes for "secrets". */
  const attempts: Array<[string, unknown]> = [
    ["visibility:private + writers:all", { tail: "secrets", visibility: "private", writers: "all" }],
    ["visibility:tenant + writers:all", { tail: "secrets", visibility: "tenant", writers: "all" }],
    ["visibility:Private + writers:All", { tail: "secrets", visibility: "Private", writers: "All" }],
    ["visibility:'' + writers:all", { tail: "secrets", visibility: "", writers: "all" }],
  ];
  for (const [label, input] of attempts) {
    console.log(`\n→ tenant.maps.create  (${label})`);
    try {
      const r = await tenant.maps.create(input);
      console.log("  ✅", JSON.stringify(r).slice(0, 300));
      console.log("\n   Created. Now re-run `npm run test:real`.");
      return;
    } catch (e) {
      console.log("  ✖", (e as Error).message.slice(0, 220));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
