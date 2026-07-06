/**
 * Grant the blindfold-proxy contract READ access to the tenant's
 * secrets map. The error from execute() told us this was the missing
 * piece. We try several MapUpdateInput shapes until one is accepted.
 */
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) { console.log("Need REAL mode."); process.exit(1); }

  const contractIdArg = process.argv[2];
  if (!contractIdArg) { console.log("Usage: tsx grant-secrets-read.ts <contract_id>"); process.exit(2); }

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
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent, handlers: { EthSign: sdk.metamask_sign(address, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(address));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  const contractDid = `${env.did}/${contractIdArg}`;
  const idNum = Number(contractIdArg);

  // SECURITY: only scoped grants (limited to this contract id) are attempted.
  // A `readers: "all"` fallback would authorize EVERY principal to read the
  // sealed-secrets map — never use it. If all scoped shapes are rejected, this
  // script errors out rather than silently opening the map to the world.
  const attempts: Array<[string, unknown]> = [
    ["readers: only [<contract_id>]", { readers: { only: [idNum] } }],
    ["readers: Only [<contract_id>] (capitalized)", { readers: { Only: [idNum] } }],
    ["extraReadGrants: [<contract_did>]", { extraReadGrants: [contractDid] }],
    ["extraReadGrants: [<contract_id_string>]", { extraReadGrants: [String(idNum)] }],
  ];

  for (const [label, patch] of attempts) {
    process.stdout.write(`\n→ trying  ${label}\n`);
    try {
      const r = await tenant.maps.update("secrets", patch);
      console.log("  ✅ accepted:", JSON.stringify(r).slice(0, 300));
      console.log("\nSuccess — re-run `npm run test:real` to retry execute.");
      return;
    } catch (e) {
      console.log("  ✖", (e as Error).message.slice(0, 240));
    }
  }
  console.log("\nNone of the shapes were accepted. The maps.update RPC may use different field names than the d.ts suggests.");
}

main().catch((e) => { console.error(e); process.exit(1); });
