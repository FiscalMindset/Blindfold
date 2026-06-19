/**
 * Probe: maybe T3's egress allowlist lives as a tenant-owned KV map
 * (e.g. z:<tid>:authorised-hosts) that the host consults at http::call
 * time. If a map with that name can be created and an entry written,
 * subsequent http::calls to that host might succeed.
 */
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const t3n = new sdk.T3nClient({ baseUrl: sdk.NODE_URLS[env.t3Env], wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(sdk.eth_get_address(env.t3nApiKey), undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(sdk.eth_get_address(env.t3nApiKey)));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl: sdk.NODE_URLS[env.t3Env], tenantDid: env.did, t3n });

  const candidates = ["authorised-hosts", "allowed-hosts", "egress", "hosts", "http-allowlist", "outbound-hosts"];

  for (const tail of candidates) {
    process.stdout.write(`→ maps.create({tail:"${tail}"}) … `);
    try {
      await tenant.maps.create({ tail, visibility: "private", writers: "all" });
      console.log("✅ created — testing entry-set …");
      try {
        await tenant.executeControl("map-entry-set", {
          map_name: tenant.canonicalName(tail),
          key: "api.x.ai",
          value: "1",
        });
        console.log(`   ✅ entry written: api.x.ai → 1`);
        console.log(`\n   Now try http::call from the contract to https://api.x.ai/v1/...`);
        return;
      } catch (e) {
        console.log(`   ✖ entry-set failed: ${(e as Error).message.slice(0, 120)}`);
      }
    } catch (e) {
      console.log(`✖ ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
