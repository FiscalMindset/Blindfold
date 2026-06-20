// Test if v0.5.1's release-to-tenant returns the sealed plaintext.
// REDACTED — only prints length + first/last 3 chars, never the full value.
//
//   npx tsx scripts/test-v5-release.ts [secret_name]    (default: grok_api_key)
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";
import { CONTRACT_VERSION } from "../packages/blindfold/src/constants.ts";

function fingerprint(s: string): string {
  if (s.length <= 8) return `<${s.length}B>`;
  return `${s.slice(0, 3)}…${s.slice(-2)}  (${s.length} bytes)`;
}

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  const secret_key = process.argv[2] || "grok_api_key";
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  console.log(`testing v${CONTRACT_VERSION} release-to-tenant for "${secret_key}" (no egress needed)`);
  try {
    const r = (await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION,
      functionName: "release-to-tenant",
      input: { secret_key },
    })) as { ok: boolean; value: string; length: number };
    if (!r.ok) {
      console.log("  ⚠ contract returned ok=false:", JSON.stringify(r));
      return;
    }
    const lengthMatches = r.length === r.value.length;
    console.log(`  ✓ released: ${fingerprint(r.value)}  ·  reported length=${r.length}  ·  match=${lengthMatches}`);
    console.log(`  (full plaintext NOT printed; if you need to inspect, do it in a non-shared terminal)`);
  } catch (e) {
    console.log("  ✖", (e as Error).message.slice(0, 250));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
