/**
 * The real demo: send an email WITH Blindfold. The SMTP password is
 * NOT in process.env — it lives only in the T3 enclave. This script
 * fetches it from the contract just before login, uses it for one
 * send, drops it.
 *
 *   npm run demo:smtp-blindfold algsoch@gmail.com
 *
 * Pipeline:
 *   1. Authenticate to T3 (tenant key).
 *   2. Ensure secrets map exists + contract is registered + ACLs granted.
 *   3. tenant.contracts.execute("release_to_tenant", { secret_key: "smtp_password" })
 *      → contract reads from z:<tid>:secrets in TDX, returns plaintext over
 *        the T3-encrypted tenant session.
 *   4. nodemailer.sendMail using that plaintext.
 *   5. Local binding is dropped at function exit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";
import { CONTRACT_VERSION } from "../packages/blindfold/src/constants.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");

async function main(): Promise<void> {
  const to = process.argv[2] ?? "algsoch@gmail.com";
  const env = loadBlindfoldEnv();
  if (env.mock) { console.log("Set T3 creds in .env first."); process.exit(1); }

  console.log("\n═══ SMTP send WITH Blindfold ═══");
  console.log(`  process.env.smtp_password: ${process.env.smtp_password ? "PRESENT (huh?)" : "absent ✓ — value lives in enclave"}`);

  // --- 1. T3 auth ---
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });
  console.log("  ✓ authenticated to T3");

  // --- 2. ensure contract is at v0.4.0 + ACL ---
  let contractId: number | null = null;
  try {
    const r = await tenant.contracts.register({ tail: "blindfold-proxy", version: CONTRACT_VERSION, wasm: new Uint8Array(fs.readFileSync(WASM)) });
    contractId = Number(r.contract_id ?? r.contractId);
    console.log(`  ✓ published v${CONTRACT_VERSION} as contract_id=${contractId}`);
    await tenant.maps.update("secrets", { readers: { only: [contractId] } });
    console.log(`  ✓ granted contract ${contractId} read access to z:tid:secrets`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/version.*not higher|already/i.test(msg)) {
      console.log(`  ℹ contract already at v${CONTRACT_VERSION} — proceeding (existing grants assumed)`);
    } else {
      console.log("  ✖ register failed:", msg.slice(0, 200));
      process.exit(1);
    }
  }

  // --- 3. release_to_tenant ---
  let smtpPassword: string;
  try {
    const r = await tenant.contracts.execute("blindfold-proxy", {
      version: CONTRACT_VERSION,
      functionName: "release-to-tenant",
      input: { secret_key: "smtp_password" },
    }) as { ok: boolean; value: string; length: number };
    if (!r.ok || typeof r.value !== "string") throw new Error("release returned no value");
    smtpPassword = r.value;
    console.log(`  ✓ released from enclave: length=${r.length}`);
  } catch (e) {
    console.log("  ✖ release failed:", (e as Error).message.slice(0, 200));
    process.exit(1);
  }

  // --- 4. send the email ---
  const transporter = nodemailer.createTransport({
    host: process.env.smtp_host ?? "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: process.env.smtp_email ?? "npdimagine@gmail.com", pass: smtpPassword },
  });
  try {
    const info = await transporter.sendMail({
      from: `"${process.env.smtp_email ?? "npdimagine@gmail.com"}" <${process.env.smtp_email ?? "npdimagine@gmail.com"}>`,
      to,
      subject: `Blindfold SMTP test 2/2 — WITH Blindfold (sealed + used) — ${new Date().toISOString().slice(11, 19)}`,
      text: `Test 2 of 2. This email was sent by code that did NOT have smtp_password in process.env.\n\nThe password lives inside T3's TDX enclave at z:<tid>:secrets/smtp_password. It was just-in-time released to this process by the contract over T3's authenticated session, used for one SMTP login, and dropped.\n\nSealed + used. The point of Blindfold.`,
    });
    console.log(`\n  ✓ SENT  messageId=${info.messageId}`);
    if (info.response) console.log(`  server response: ${info.response}`);
  } catch (e) {
    console.log("  ✖ send failed:", (e as Error).message);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
