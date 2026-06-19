/**
 * Real end-to-end test against live T3 testnet.
 *
 *   npm run test:real
 *
 * Performs three operations against the real network:
 *   1. Handshake + authenticate (already known to work via `verify`).
 *   2. Seal a uniquely-named test secret via executeControl("map-entry-set", …).
 *   3. (Best-effort) Publish the WASM contract via tenant.contracts.register.
 *   4. (Best-effort) Execute the contract against https://httpbin.org/anything,
 *      a public echo endpoint. Expected to fail with `host/http.egress_denied`
 *      unless egress for httpbin.org has been granted — which is itself
 *      informative ("the wire works; the grant doesn't include this host").
 *
 * Every operation captures the exact T3 response (success or error) and
 * appends a block to `output_analysis.md` so you have a permanent record.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";
import { openT3Client } from "../packages/blindfold/src/t3-client.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPORT = path.join(ROOT, "output_analysis.md");
const WASM_PATH = path.join(ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");
const HEAD_MARK = "<!-- TEST_RUNS_BELOW -->";

interface StepResult {
  step: string;
  status: "ok" | "skipped" | "error";
  detail: string;
}

const results: StepResult[] = [];

function log(msg: string): void { process.stdout.write(msg + "\n"); }
function record(step: string, status: StepResult["status"], detail: string): void {
  results.push({ step, status, detail });
  const mark = status === "ok" ? "✅" : status === "error" ? "🚨" : "⚠️ ";
  log(`  ${mark}  ${step}  ${detail.slice(0, 140)}`);
}

async function main(): Promise<void> {
  log("\n═══ Blindfold REAL end-to-end test (live T3) ═══\n");

  const env = loadBlindfoldEnv();
  if (env.mock) {
    log("✖ This script needs REAL mode. Set T3N_API_KEY + DID in .env first.");
    process.exit(1);
  }
  log(`  T3 env:       ${env.t3Env}`);
  log(`  tenant DID:   ${env.did}`);
  log("");

  /* 1. Auth */
  let t3;
  try {
    t3 = await openT3Client(env);
    if (!t3.isReal) throw new Error("Got mock client; env misconfigured.");
    record("S1 — handshake + authenticate", "ok", "round-trip succeeded");
  } catch (e) {
    record("S1 — handshake + authenticate", "error", (e as Error).message);
    await flushReport();
    process.exit(1);
  }

  /* 2. Seal test secret */
  const secretName = `blindfold_test_${Math.floor(Date.now() / 1000)}`;
  const secretValue = `TEST-VALUE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  try {
    await t3.seedSecret(secretName, secretValue);
    record(
      "S2 — executeControl(map-entry-set)",
      "ok",
      `wrote key="${secretName}" len=${secretValue.length} (value never logged)`,
    );
  } catch (e) {
    record("S2 — executeControl(map-entry-set)", "error", (e as Error).message);
  }

  // We need the raw SDK + tenant client for the inter-step grant call.
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
  const sdkBaseUrl = sdk.NODE_URLS[env.t3Env];
  const sdkAddr = sdk.eth_get_address(env.t3nApiKey);
  const sdkT3n = new sdk.T3nClient({ baseUrl: sdkBaseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(sdkAddr, undefined, env.t3nApiKey) } });
  await sdkT3n.handshake();
  await sdkT3n.authenticate(sdk.createEthAuthInput(sdkAddr));
  const rawTenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl: sdkBaseUrl, tenantDid: env.did, t3n: sdkT3n });

  /* 3. Register the WASM contract */
  let publishOk = false;
  let contractIdNum: number | null = null;
  if (!existsSync(WASM_PATH)) {
    record("S3 — contracts.register", "skipped", `WASM artifact missing — run \`cargo build --target wasm32-wasip2 --release\` in contract/ first`);
  } else {
    try {
      const wasm = readFileSync(WASM_PATH);
      const r = await t3.registerContract(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
      record("S3 — contracts.register", "ok", `contract_id=${r.contractId}; wasm=${wasm.byteLength.toLocaleString()}B`);
      publishOk = true;
      contractIdNum = Number(r.contractId);
    } catch (e) {
      const msg = (e as Error).message;
      const alreadyAt = msg.match(/current version (\d+)/i);
      if (alreadyAt) {
        contractIdNum = Number(alreadyAt[1]);
        record("S3 — contracts.register", "ok", `already at version (idempotent); contract_id=${contractIdNum}`);
        publishOk = true;
      } else {
        record("S3 — contracts.register", "error", msg);
      }
    }
  }

  /* 3b. Grant the new contract read access to the secrets map */
  if (publishOk && contractIdNum) {
    try {
      await rawTenant.maps.update("secrets", { readers: { only: [contractIdNum] } });
      record("S3b — maps.update(secrets, readers: only)", "ok", `granted read for contract_id=${contractIdNum}`);
    } catch (e) {
      record("S3b — maps.update(secrets, readers: only)", "error", (e as Error).message.slice(0, 200));
    }
  }

  /* 4. Execute against httpbin echo endpoint */
  if (!publishOk) {
    record("S4 — contracts.execute", "skipped", "contract not published — can't exercise execute path");
  } else {
    try {
      // Contract reads the secret IN-ENCLAVE, substitutes the sentinel
      // in the Authorization header, returns proof (lengths, not value).
      // Proves Blindfold's security property end-to-end on T3 hardware.
      const expectedLen = "Bearer ".length + secretValue.length;
      const body = (await (rawTenant as any).contracts.execute("blindfold-proxy", {
        version: (await import("../packages/blindfold/src/constants.ts")).CONTRACT_VERSION,
        functionName: "forward",
        input: {
          secret_key: secretName,
          headers: [["Authorization", "Bearer __BLINDFOLD__"]],
        },
      })) as { ok: boolean; secret_len: number; authorization_header_len_after_substitution: number; dry_run: boolean };
      const correctSecretLen = body.secret_len === secretValue.length;
      const correctSubLen = body.authorization_header_len_after_substitution === expectedLen;
      const ok = body.ok === true && correctSecretLen && correctSubLen;
      record(
        "S4 — execute(forward) — in-enclave secret read + sentinel substitution",
        ok ? "ok" : "error",
        `secret_len=${body.secret_len}(want ${secretValue.length}); auth_len=${body.authorization_header_len_after_substitution}(want ${expectedLen}); ok=${body.ok}`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      const hint = /egress_denied/i.test(msg)
        ? " (expected if your tenant grant doesn't allowlist httpbin.org)"
        : "";
      record("S4 — contracts.execute (httpbin echo)", "error", msg + hint);
    }
  }

  await t3.close();
  await flushReport();

  log("");
  log(`Wrote results to ${path.relative(ROOT, REPORT)}.`);
  log(
    results.every((r) => r.status === "ok")
      ? "✅ Full REAL pipeline succeeded end-to-end."
      : "ℹ️  Partial — see the appended block for details.",
  );
}

async function flushReport(): Promise<void> {
  const date = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const block = [
    "",
    `### Real-T3 run ${date}`,
    "",
    `| # | Step | Status | Detail |`,
    `|---|------|--------|--------|`,
    ...results.map((r) => `| ${r.step.split(" — ")[0]} | ${r.step.split(" — ")[1] ?? r.step} | ${r.status === "ok" ? "✅" : r.status === "error" ? "🚨" : "⚠️"} | ${r.detail.replace(/\|/g, "\\|").slice(0, 240)} |`),
    "",
  ].join("\n");
  if (!existsSync(REPORT)) writeFileSync(REPORT, `# Blindfold — Output & Test Analysis\n\n## Test runs\n\n${HEAD_MARK}\n`);
  let report = readFileSync(REPORT, "utf8");
  if (!report.includes(HEAD_MARK)) report += "\n" + HEAD_MARK + "\n";
  report = report.replace(HEAD_MARK, HEAD_MARK + block);
  writeFileSync(REPORT, report);
}

main().catch((e) => {
  log("✖ unexpected: " + (e as Error).message);
  process.exit(1);
});
