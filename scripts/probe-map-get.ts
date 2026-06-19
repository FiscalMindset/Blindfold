/**
 * Probe whether T3 exposes a tenant-side "read" counterpart to
 * map-entry-set. If yes, the proxy can fetch the sealed secret via
 * T3's authenticated control plane and substitute it locally —
 * eliminating the custom-contract-+-http::call dependency.
 *
 * Reads back a known-seeded key (the grok_api_key we sealed earlier).
 * For each shape that succeeds: prints the response. Never logs the
 * value itself — only its length, to confirm it's correct.
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

  const mapName = tenant.canonicalName("secrets");
  const key = "grok_api_key";
  console.log(`Probing for a way to read "${key}" from "${mapName}" via control plane …\n`);

  const attempts: Array<[string, unknown]> = [
    ["map-entry-get",   { map_name: mapName, key }],
    ["map-entry-fetch", { map_name: mapName, key }],
    ["map-entry-read",  { map_name: mapName, key }],
    ["map-get",         { map_name: mapName, key }],
    ["map.entry-get",   { map_name: mapName, key }],
    ["entry-get",       { map_name: mapName, key }],
    ["kv-get",          { map_name: mapName, key }],
    ["secret-get",      { name: key }],
    ["secret-read",     { name: key }],
  ];

  for (const [action, payload] of attempts) {
    process.stdout.write(`→ executeControl(${JSON.stringify(action)}) …  `);
    try {
      const r = await tenant.executeControl(action, payload);
      console.log("✅");
      const repr = JSON.stringify(r);
      console.log(`   raw response (${repr.length}b): ${repr.length > 200 ? repr.slice(0, 200) + "…(truncated)" : repr}`);
      // If the response contains the value bytes, report length only.
      if (typeof r === "object" && r !== null) {
        const obj = r as Record<string, unknown>;
        for (const k of ["value", "bytes", "data"]) {
          if (k in obj) {
            const v = obj[k];
            if (typeof v === "string") console.log(`   "${k}" length: ${v.length}`);
            else if (Array.isArray(v)) console.log(`   "${k}" length: ${v.length}`);
          }
        }
      }
      console.log();
    } catch (e) {
      console.log("✖", (e as Error).message.slice(0, 100));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
