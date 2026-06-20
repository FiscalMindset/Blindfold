// Test if v0.5.0 (with http import) can do release-to-tenant — which
// doesn't need egress. If THIS works, only http::call is gated by the
// egress grant. If it ALSO 500s, the http import itself is breaking
// the contract again.
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
  console.log(`testing v${CONTRACT_VERSION} release-to-tenant (no egress needed)`);
  try {
    const r = await tenant.contracts.execute("blindfold-proxy", { version: CONTRACT_VERSION, functionName: "release-to-tenant", input: { secret_key: "grok_api_key" } });
    console.log("RAW:", JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log("ERR:", (e as Error).message.slice(0, 250));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
