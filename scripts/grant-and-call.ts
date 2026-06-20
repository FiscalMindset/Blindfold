/**
 * The actual T3 egress grant + real call. Per T3 dev team:
 *
 *   userClient.execute({
 *     script_name: "tee:user/contracts",
 *     function_name: "agent-auth-update",
 *     input: { agents: [{ agentDid, scripts: [{ scriptName, versionReq,
 *                          functions, allowedHosts }] }] },
 *   })
 *
 * For self-grant: agentDid = tenant's own DID. Authorizes the named
 * contract functions to call the listed hosts. Without this, T3 returns
 * host/http.egress_denied; the docs say it surfaces as an opaque 500 in
 * our SDK path.
 *
 * After granting, this script builds + publishes the contract (if newer)
 * and calls forward() through to https://api.x.ai/v1/models — a real
 * outbound HTTPS call with the sealed Grok key substituted IN-ENCLAVE.
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
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  console.log("\n═══ Real call: agent → contract → in-enclave http::call → api.x.ai ═══\n");

  // --- Publish v0.5.0 (kv + http; egress about to be authorized) ---
  console.log(`→ publish contract v${CONTRACT_VERSION}`);
  let contractId: number | null = null;
  try {
    const r = await tenant.contracts.register({ tail: "blindfold-proxy", version: CONTRACT_VERSION, wasm: new Uint8Array(fs.readFileSync(WASM)) });
    contractId = Number(r.contract_id ?? r.contractId);
    console.log(`  ✓ contract_id=${contractId}`);
    await tenant.maps.update("secrets", { readers: { only: [contractId] } });
    console.log(`  ✓ secrets ACL granted to contract ${contractId}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not higher|already|exists/i.test(msg)) {
      console.log(`  ℹ already at v${CONTRACT_VERSION} — proceeding`);
    } else {
      console.log("  ✖", msg.slice(0, 250));
      process.exit(1);
    }
  }

  // --- THE FIX: egress grant via tee:user/contracts / agent-auth-update ---
  console.log(`\n→ authorise contract egress to api.x.ai (the missing step)`);
  // Look up the current version of tee:user/contracts on this node.
  let userContractsVersion = "0.1.0";
  if (typeof sdk.getScriptVersion === "function") {
    try {
      const v = await sdk.getScriptVersion(baseUrl, "tee:user/contracts");
      console.log(`  · tee:user/contracts version: ${v}`);
      if (typeof v === "string" && /^\d/.test(v)) userContractsVersion = v;
    } catch (e) { console.log(`  · getScriptVersion failed: ${(e as Error).message.slice(0, 80)}`); }
  }
  try {
    const grant = await t3n.execute({
      script_name: "tee:user/contracts",
      script_version: userContractsVersion,
      function_name: "agent-auth-update",
      input: {
        agents: [{
          agentDid: env.did,            // self-grant: tenant authorises itself
          scripts: [{
            scriptName: `z:${env.did.replace(/^did:t3n:/, "")}:blindfold-proxy`,
            versionReq: `>=${CONTRACT_VERSION}`,
            functions: ["forward", "release-to-tenant"],
            allowedHosts: ["api.x.ai"],
          }],
        }],
      },
    });
    console.log(`  ✓ accepted: ${String(grant).slice(0, 200)}`);
  } catch (e) {
    console.log("  ✖", (e as Error).message.slice(0, 300));
    console.log("     If this is the missing step, every shape variant I tried earlier was wrong (executeControl instead of execute).");
  }

  // --- Make the actual http::call from inside the enclave ---
  console.log(`\n→ execute forward → api.x.ai/v1/models with sealed grok_api_key`);
  try {
    const r = await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION,
      functionName: "forward",
      input: {
        method: "GET",
        url: "https://api.x.ai/v1/models",
        headers: [["Authorization", "Bearer __BLINDFOLD__"], ["Content-Type", "application/json"]],
        secret_key: "grok_api_key",
      },
    }) as { status: number; headers: Array<[string, string]>; body: string };
    console.log(`  ✓ STATUS ${r.status}`);
    console.log(`    body (first 500 bytes):\n    ${String(r.body).slice(0, 500).replace(/\n/g, "\n    ")}`);
    if (r.status >= 200 && r.status < 300) {
      console.log(`\n  🎉 FULL ENCLAVE PIPELINE WORKS — sealed key never left the enclave.`);
    }
  } catch (e) {
    console.log("  ✖", (e as Error).message.slice(0, 300));
    console.log("\n→ pulling contract logs for context …");
    try {
      const logs = await tenant.contracts.logs("blindfold-proxy", { limit: 30 });
      if (!logs?.entries?.length) console.log("  (no entries)");
      else for (const l of logs.entries) console.log(`  [${l.level}] ${l.message}`);
    } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
