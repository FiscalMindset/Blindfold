/**
 * One-shot script: ensure tenant maps exist, then seal blogger_api_key.
 *   npm run seal:blogger
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv, loadEnvFromFile, pluckSecret } from "../packages/blindfold/src/env.ts";
import { recordSealed } from "../packages/blindfold/src/sealed-ledger.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, "..", ".env");

async function main(): Promise<void> {
  loadEnvFromFile(ENV_PATH);
  const env = loadBlindfoldEnv();

  if (env.mock) {
    console.error("Running in MOCK mode — T3N_API_KEY + DID required.");
    process.exit(1);
  }

  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const wasmComponent = await sdk.loadWasmComponent();

  const t3n = new sdk.T3nClient({
    baseUrl,
    wasmComponent,
    handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) },
  });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));

  const tenant = new sdk.TenantClient({
    environment: env.t3Env,
    baseUrl,
    tenantDid: env.did,
    t3n,
  });

  // Step 1 — ensure the secrets map exists (idempotent)
  for (const tail of ["secrets", "authorised-hosts"]) {
    try {
      await tenant.maps.create({ tail, visibility: "private", writers: "all" });
      console.log(`  · Created map "${tail}"`);
    } catch (e: any) {
      console.log(`  · Map "${tail}" already exists`);
    }
  }

  // Step 2 — seal blogger_api_key
  const value = pluckSecret("blogger_api_key");
  console.log(`\n  Sealing blogger_api_key (${value.length} bytes) …`);

  await tenant.executeControl("map-entry-set", {
    map_name: tenant.canonicalName("secrets"),
    key: "blogger_api_key",
    value,
  });

  recordSealed({
    t: new Date().toISOString(),
    name: "blogger_api_key",
    source: "env:blogger_api_key",
    length: value.length,
    mode: "real",
    tenant_did: env.did,
    map_name: `z:${env.did.replace(/^did:t3n:/, "")}:secrets`,
  });

  console.log("  ✓ blogger_api_key sealed — safe to delete from .env.");
  console.log(`\n  Verify with: npm run blindfold -- sealed`);
}

main().catch((e) => {
  console.error("✗ Failed:", (e as Error).message);
  process.exit(1);
});
