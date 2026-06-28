/**
 * Live proof of the pure enclave-egress path (#3): the contract itself makes
 * the outbound HTTPS call from inside the TDX enclave, substituting the sealed
 * github_token in-enclave. The plaintext never reaches this machine.
 *
 * Flow: publish (idempotent) → grant secrets read-ACL to the contract →
 * authorize egress to api.github.com → execute forward (dry-run, then real).
 *
 *   npx tsx scripts/test-enclave-egress.ts [contract_id] [secret] [host] [path]
 *   # e.g. github (defaults):  ... 458
 *   #      digitalocean:       ... 458 digital_ocean_api_key api.digitalocean.com /v2/account
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";
import { CONTRACT_VERSION } from "../packages/blindfold/src/constants.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");
const SECRET = process.argv[3] ?? "github_token";
const HOST = process.argv[4] ?? "api.github.com";
const REQ_PATH = process.argv[5] ?? "/user";

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
  const didHex = env.did.replace(/^did:t3n:/, "");

  // 1. publish (idempotent) + grant secrets read-ACL to the contract.
  console.log(`→ publish/ensure contract v${CONTRACT_VERSION}`);
  let contractId: number | null = null;
  try {
    const r = await tenant.contracts.register({ tail: "blindfold-proxy", version: CONTRACT_VERSION, wasm: new Uint8Array(fs.readFileSync(WASM)) });
    contractId = Number(r.contract_id ?? r.contractId);
    console.log(`  ✓ contract_id=${contractId}`);
  } catch (e) {
    console.log(`  ℹ ${(e as Error).message.slice(0, 120)} (already published — continuing)`);
  }
  // Fallback to a known/passed contract id when the version is already current.
  if (!contractId && process.argv[2]) contractId = Number(process.argv[2]);
  try {
    if (contractId) { await tenant.maps.update("secrets", { readers: { only: [contractId] } }); console.log(`  ✓ secrets read-ACL → contract ${contractId}`); }
    else { console.log(`  ℹ no contract id (pass it as arg: npx tsx scripts/test-enclave-egress.ts <id>)`); }
  } catch (e) { console.log(`  ℹ ACL: ${(e as Error).message.slice(0, 100)}`); }

  // 2. authorize egress to api.github.com.
  console.log(`\n→ authorize egress to ${HOST}`);
  let ucv = "0.1.0";
  if (typeof sdk.getScriptVersion === "function") {
    try { const v = await sdk.getScriptVersion(baseUrl, "tee:user/contracts"); if (typeof v === "string" && /^\d/.test(v)) ucv = v; console.log(`  · tee:user/contracts v${ucv}`); } catch {}
  }
  try {
    await t3n.execute({
      script_name: "tee:user/contracts", script_version: ucv, function_name: "agent-auth-update",
      input: { agents: [{ agentDid: env.did, scripts: [{ scriptName: `z:${didHex}:blindfold-proxy`, versionReq: `>=${CONTRACT_VERSION}`, functions: ["forward", "release-to-tenant"], allowedHosts: [HOST] }] }] },
    });
    console.log(`  ✓ egress grant accepted`);
  } catch (e) { console.log(`  ✖ egress grant: ${(e as Error).message.slice(0, 200)}`); }

  const URL = `https://${HOST}${REQ_PATH}`;

  // 3a. dry-run: proves in-enclave secret read + substitution, no outbound call.
  console.log(`\n→ forward dry-run (in-enclave substitution proof) for "${SECRET}"`);
  try {
    const r = await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION, functionName: "forward",
      input: { method: "GET", url: URL, headers: [["Authorization", "Bearer __BLINDFOLD__"]], secret_key: SECRET, dry_run: true },
    }) as Record<string, unknown>;
    console.log(`  ✓ ${JSON.stringify(r)}  (length = "Bearer " (7) + secret length)`);
  } catch (e) { console.log(`  ✖ ${(e as Error).message.slice(0, 200)}`); }

  // 3b. real: the enclave makes the call itself.
  console.log(`\n→ forward REAL → ${URL} (enclave makes the call)`);
  try {
    const r = await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION, functionName: "forward",
      input: { method: "GET", url: URL, headers: [["Authorization", "Bearer __BLINDFOLD__"], ["User-Agent", "blindfold-enclave"], ["Accept", "application/json"]], secret_key: SECRET },
    }) as Record<string, unknown>;
    console.log(`  code=${r.code} length=${r.length}`);
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    const id = (body.match(/"(login|email|name|uuid)"\s*:\s*"([^"]+)"/) || [])[2];
    if (Number(r.code) >= 200 && Number(r.code) < 300) {
      console.log(`  🎉 ENCLAVE-EGRESS WORKS — ${HOST} authenticated (${id ?? "see body"}).`);
      console.log(`     The sealed secret NEVER left the enclave.`);
    } else {
      console.log(`  body: ${body.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`  ✖ ${(e as Error).message.slice(0, 250)}`);
    console.log(`     (If this is host/http.egress_denied wrapped as 500, the grant above didn't take —`);
    console.log(`      that's a T3-side authorization outcome, not a contract bug.)`);
  }
}

main().catch((e) => { console.error("unhandled:", e); process.exit(1); });
