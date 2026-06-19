import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";
import { CONTRACT_VERSION } from "../packages/blindfold/src/constants.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  console.log("→ try forward (known-working shape)");
  try {
    const r = await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION,
      functionName: "forward",
      input: { method: "GET", url: "https://api.x.ai/v1/models", headers: [["Authorization", "Bearer __BLINDFOLD__"]], secret_key: "smtp_password" },
    });
    console.log("  forward ok:", JSON.stringify(r).slice(0, 200));
  } catch (e) { console.log("  forward err:", (e as Error).message.slice(0, 200)); }

  for (const fn of ["release-to-tenant", "release_to_tenant", "releaseToTenant"]) {
    console.log(`\n→ try ${fn}`);
    try {
      const r = await tenant.contracts.execute("blindfold-proxy", { version: CONTRACT_VERSION, functionName: fn, input: { secret_key: "smtp_password" } });
      console.log("  ok:", JSON.stringify(r).slice(0, 400));
    } catch (e) { console.log("  err:", (e as Error).message.slice(0, 200)); }
  }

  console.log("\nContract logs (newest tenant supports logging):");
  try {
    const logs = await tenant.contracts.logs("blindfold-proxy", { limit: 30 });
    if (!logs?.entries?.length) console.log("  (none)");
    else for (const l of logs.entries) console.log(`  [${l.level}] ${l.message}`);
  } catch (e) { console.log("  logs err:", (e as Error).message.slice(0, 150)); }
}

main().catch(e => { console.error(e); process.exit(1); });
