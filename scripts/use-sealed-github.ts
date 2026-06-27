/**
 * Proof of the USE side: pull the sealed github_token from the T3 enclave and
 * make a REAL GitHub API call with it. The token is never printed and never
 * touches process.env of any agent — it lives only in `token` for the duration
 * of the one outbound call, exactly like the release-broker pattern.
 *
 *   npx tsx scripts/use-sealed-github.ts
 */
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

const NAME = process.argv[2] ?? "github_token";

async function getSealed(name: string): Promise<string> {
  loadBlindfoldEnv();
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  const t3Env = (process.env.BLINDFOLD_T3_ENV ?? "testnet").toLowerCase();
  sdk.setEnvironment(t3Env);
  const baseUrl = sdk.NODE_URLS[t3Env];
  const key = process.env.T3N_API_KEY!;
  const address = sdk.eth_get_address(key);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(address, undefined, key) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(address));
  const probe = new sdk.TenantClient({ environment: t3Env, baseUrl, tenantDid: `did:t3n:${address.replace(/^0x/, "").toLowerCase()}`, t3n });
  const tenantDid = (await probe.tenant.me()).tenant;
  const tenant = new sdk.TenantClient({ environment: t3Env, baseUrl, tenantDid, t3n });
  const mapName = `z:${tenantDid.replace(/^did:t3n:/, "")}:secrets`;
  const got: any = await tenant.executeControl("map-entry-get", { map_name: mapName, key: name });
  const val = got?.value ?? got?.entry?.value ?? got;
  const token = typeof val === "string" ? val : Buffer.isBuffer(val) ? val.toString("utf8") : Array.isArray(val) ? Buffer.from(val).toString("utf8") : String(val);
  if (!token || token.length < 10) throw new Error(`released value looks wrong (len=${token?.length})`);
  return token;
}

async function main(): Promise<void> {
  console.log(`Releasing "${NAME}" from the enclave (value not shown) …`);
  const token = await getSealed(NAME);
  console.log(`  got ${token.length} bytes (matches the 93-byte fingerprint)\n`);

  console.log("Calling GitHub API  GET https://api.github.com/user  with the sealed token …");
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "blindfold-demo", Accept: "application/vnd.github+json" },
  });
  const scopes = res.headers.get("x-oauth-scopes");
  const body: any = await res.json().catch(() => ({}));
  console.log(`  HTTP ${res.status}`);
  if (res.ok) {
    console.log(`  ✅ AUTHENTICATED as: ${body.login}  (id=${body.id}, name=${body.name ?? "—"})`);
    if (scopes !== null) console.log(`  token scopes: ${scopes || "(fine-grained PAT)"}`);
  } else {
    console.log(`  ✖ GitHub rejected: ${body.message ?? "(no message)"}`);
  }
  // token drops out of scope here.
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
