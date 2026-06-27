/**
 * Real seal using a provisioned/active team key (t1 or t2), with the key's
 * ACTUAL server-side tenant DID (from me()), not the key-address DID.
 * Reads GITHUB_TOKEN from env once; never prints the value.
 *
 *   npx tsx scripts/seal-via-working-key.ts t1 github_token GITHUB_TOKEN
 */
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  loadBlindfoldEnv();
  const which = (process.argv[2] ?? "t1").toLowerCase();
  const name = process.argv[3] ?? "github_token";
  const fromEnv = process.argv[4] ?? "GITHUB_TOKEN";

  const key = process.env[`${which}_T3N_API_KEY`];
  if (!key) throw new Error(`${which}_T3N_API_KEY not in env`);
  if (!process.env[fromEnv]) throw new Error(`${fromEnv} not in env`);

  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  const t3Env = (process.env.BLINDFOLD_T3_ENV ?? "testnet").toLowerCase();
  sdk.setEnvironment(t3Env);
  const baseUrl = sdk.NODE_URLS[t3Env];
  const address = sdk.eth_get_address(key);

  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(address, undefined, key) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(address));

  // Discover the REAL tenant DID for this key.
  const me = await t3n;
  let tenantDid = "";
  {
    const probe = new sdk.TenantClient({ environment: t3Env, baseUrl, tenantDid: `did:t3n:${address.replace(/^0x/, "").toLowerCase()}`, t3n });
    const info = await probe.tenant.me();
    tenantDid = info.tenant;
    console.log(`key ${which}: addr=${address.slice(0,8)}… → tenant ${tenantDid}  (status=${info.status})`);
  }

  const tenant = new sdk.TenantClient({ environment: t3Env, baseUrl, tenantDid, t3n });
  const didHex = tenantDid.replace(/^did:t3n:/, "");
  const mapName = `z:${didHex}:secrets`;

  // Ensure the secrets map exists (idempotent; ignore "already exists").
  try {
    await tenant.maps.create({ name: "secrets", visibility: "private" });
    console.log(`maps.create secrets: OK`);
  } catch (e) {
    console.log(`maps.create secrets: ${(e as Error).message.slice(0, 100)} (continuing)`);
  }

  const value = process.env[fromEnv]!;
  await tenant.executeControl("map-entry-set", { map_name: mapName, key: name, value });
  console.log(`✅ SEALED "${name}" (${value.length} bytes) → ${mapName}`);

  // Verify by reading back length only (never the value).
  try {
    const got = await tenant.executeControl("map-entry-get", { map_name: mapName, key: name });
    const len = got?.value ? String(got.value).length : (got?.length ?? "?");
    console.log(`verify: map-entry-get OK (stored length=${len})`);
  } catch (e) {
    console.log(`verify: ${(e as Error).message.slice(0, 100)}`);
  }
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
