/**
 * HTTP Basic auth computed INSIDE the enclave (the Twilio scheme), proven live.
 *
 * Twilio authenticates with HTTP Basic: `base64(AccountSID:AuthToken)`. That
 * base64 can only be computed AFTER the secret is joined — so a generic
 * "swap the sentinel" proxy cannot do it. Blindfold computes it inside TDX.
 *
 * This demo proves that end-to-end WITHOUT needing a Twilio account: it seals a
 * known password, sends NO credential from the agent, and calls
 * httpbin.org/basic-auth/<user>/<pass>, which returns 200 ONLY if the enclave's
 * base64 is exactly right. Twilio uses the identical mechanism.
 *
 * Real Twilio mode: seal your Auth Token and set your Account SID, then call the
 * /twilio/ route through the proxy (see README).
 *
 * Prereqs for this proof (one time):
 *   httpbin_basic_pass='s3cr3t-basic-test' \
 *     npm run blindfold -- register --name httpbin_basic_pass --from-env httpbin_basic_pass
 *   npm run blindfold -- grant --host httpbin.org,<your other hosts...>
 *
 * Run:
 *   npx tsx examples/twilio/agent.ts
 */
import { loadBlindfoldEnv } from "../../packages/blindfold/src/env.ts";
import { openT3Client } from "../../packages/blindfold/src/t3-client.ts";

const USER = "blindfold";
const KNOWN_PASS = "s3cr3t-basic-test"; // the value sealed as httpbin_basic_pass

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) {
    console.log("This is a REAL demo — set real T3 creds in .env. Mock mode is off-limits here.");
    process.exit(1);
  }
  const t3 = await openT3Client(env);
  console.log("🔒 HTTP Basic auth — computed inside the TDX enclave, proven against httpbin.\n");
  try {
    // The agent supplies NO password. The enclave joins user:secret and base64s
    // it into `Authorization: Basic …` on the outbound call.
    const res = await t3.invokeForward({
      method: "GET",
      url: `https://httpbin.org/basic-auth/${USER}/${KNOWN_PASS}`,
      headers: [],
      secret_key: "httpbin_basic_pass",
      auth: { scheme: "basic", username: USER },
    });
    const body = typeof res.body === "string" ? res.body : Buffer.from(res.body as number[]).toString("utf8");

    if (res.status === 200 && /"authenticated":\s*true/.test(body)) {
      console.log(`✅ httpbin validated the credential: HTTP ${res.status}`);
      console.log(`   ${body.slice(0, 120).replace(/\s+/g, " ")}`);
      console.log("\n   The enclave built Basic base64(user:secret) correctly — the agent never");
      console.log("   had the password. This is exactly how Twilio auth is computed in TDX.");
    } else {
      console.log(`✗ Unexpected: HTTP ${res.status} — ${body.slice(0, 160)}`);
      console.log("   (Seal httpbin_basic_pass='s3cr3t-basic-test' and grant --host httpbin.org first.)");
      process.exitCode = 1;
    }
  } finally {
    await t3.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
