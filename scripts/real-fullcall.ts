/**
 * The real end-to-end Blindfold call: agent → contract → in-enclave
 * secret read → in-enclave substitution → real https://api.x.ai call.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";
import { CONTRACT_VERSION } from "../packages/blindfold/src/constants.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(sdk.eth_get_address(env.t3nApiKey), undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(sdk.eth_get_address(env.t3nApiKey)));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  console.log("→ ensure authorised-hosts has api.x.ai");
  try {
    await tenant.maps.create({ tail: "authorised-hosts", visibility: "private", writers: "all" });
    console.log("  (created)");
  } catch (e) { console.log("  (already exists)"); }
  await tenant.executeControl("map-entry-set", { map_name: tenant.canonicalName("authorised-hosts"), key: "api.x.ai", value: "1" });
  console.log("  ✅ api.x.ai → 1");

  console.log("\n→ publish v" + CONTRACT_VERSION);
  let contractId: number;
  try {
    const r = await tenant.contracts.register({ tail: "blindfold-proxy", version: CONTRACT_VERSION, wasm: new Uint8Array(fs.readFileSync(WASM)) });
    contractId = Number(r.contract_id ?? r.contractId);
    console.log(`  ✅ contract_id=${contractId}`);
  } catch (e) {
    console.log("  ✖", (e as Error).message.slice(0, 200));
    process.exit(1);
  }

  console.log("\n→ grant contract read access to secrets + authorised-hosts");
  await tenant.maps.update("secrets", { readers: { only: [contractId] } });
  console.log("  ✅ secrets");
  try {
    await tenant.maps.update("authorised-hosts", { readers: { only: [contractId] } });
    console.log("  ✅ authorised-hosts");
  } catch (e) {
    console.log("  (auth-hosts grant attempt:", (e as Error).message.slice(0, 80), ")");
  }

  console.log("\n→ execute(forward) — real call to api.x.ai");
  try {
    const r = await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION,
      functionName: "forward",
      input: {
        method: "GET",
        url: "https://api.x.ai/v1/models",
        headers: [["Authorization", "Bearer __BLINDFOLD__"]],
        secret_key: "grok_api_key",
      },
    });
    console.log("  ✅ RESPONSE:");
    const r2 = r as { status: number; body: string };
    console.log("    status:", r2.status);
    console.log("    body (first 400b):", String(r2.body).slice(0, 400));
  } catch (e) {
    console.log("  ✖", (e as Error).message);
    console.log("\n  ⚠ pulling contract logs …");
    try {
      const logs = await tenant.contracts.logs("blindfold-proxy", { limit: 30 });
      if (!logs?.entries?.length) console.log("    (no log entries)");
      else for (const l of logs.entries) console.log(`    [${l.level}] ${l.message}`);
    } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
