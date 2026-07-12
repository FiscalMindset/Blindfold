/** CLI command group (auto-split from the dispatcher; bodies unchanged). */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadBlindfoldEnv, configPath, homeDir, stateDir } from "../src/env.ts";
import { keychainAvailable, keychainBackend, keychainSet, keychainDelete } from "../src/keychain.ts";
import { readSecretLine, readLine } from "../src/prompt.ts";
import { registerSecret, registerContract } from "../src/register.ts";
import { startProxy } from "../src/proxy.ts";
import { attest, attestationGate, writePinnedRtmr3 } from "../src/attest.ts";
import { startDashboard } from "../src/dashboard.ts";
import { clearUsage, defaultLogPath, readUsage } from "../src/usage-log.ts";
import { runInit, runVerify } from "../src/init.ts";
import { runCompat } from "../src/compat.ts";
import { defaultSealedLogPath, readSealed, verifyLedgerChain } from "../src/sealed-ledger.ts";
import { type Argv, die, assetPath, fingerprint, resolveEnvVar } from "./cli-shared.ts";
import { c, head, ok } from "../src/color.ts";

/**
 * Persist tenant credentials the way `login` does: DID + settings into the
 * 0600 config file, the tenant key into the OS keychain (or the config file as
 * a 0600 fallback). Shared by `login` and `signup`.
 */
function saveTenantCredentials(
  did: string,
  key: string,
  env: "testnet" | "production",
  forceFile: boolean,
): { inKeychain: boolean; triedKeychain: boolean; cfg: string } {
  const cfg = configPath();
  let existing: Record<string, string> = {};
  try { if (fs.existsSync(cfg)) existing = JSON.parse(fs.readFileSync(cfg, "utf8")); } catch { /* overwrite */ }
  const merged: Record<string, string> = { ...existing, DID: did, BLINDFOLD_T3_ENV: env };
  const triedKeychain = !forceFile && keychainAvailable();
  const inKeychain = triedKeychain && keychainSet(did, key);
  if (inKeychain) {
    merged.T3N_API_KEY_STORE = "keychain";
    delete merged.T3N_API_KEY;
  } else {
    merged.T3N_API_KEY = key;
    merged.T3N_API_KEY_STORE = "file";
  }
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify(merged, null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfg, 0o600); } catch { /* best effort */ }
  return { inKeychain, triedKeychain, cfg };
}

export async function handleAuth(cmd: string, argv: Argv, cmdArgs: string[]): Promise<void> {
  switch (cmd) {
    case "signup": {
      // Self-serve provisioning: create a fresh Terminal 3 testnet tenant with
      // no manual step on the T3 side. Generates a key locally, eth-auths,
      // proves the email via OTP, and self-admits (mints welcome credits).
      const env = String(argv.flags.env ?? "").toLowerCase() === "production" ? "production" : "testnet";
      if (env === "production") {
        die("signup (self-admit) is testnet-only. Production tenants are provisioned by Terminal 3 directly.");
      }
      const email = argv.flags.email
        ? String(argv.flags.email)
        : (await readLine("Email for your tenant (a verification code will be sent): ")).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die("Enter a valid email address (e.g. you@example.com).");

      console.log(`${head("blindfold signup")} — creating a Terminal 3 ${c.cyan("testnet")} tenant for ${c.cyan(email)}`);
      console.log(c.dim("  A fresh tenant key (secp256k1) is generated locally and stored in your keychain — never printed.\n"));

      // T3's Level-1 self-admit requires a first + last name on the profile.
      // Default from the email local part (minus any +tag) so signup stays a
      // single prompt; --first/--last override.
      const localPart = (email.split("@")[0] ?? "user").split("+")[0] ?? "user";
      const firstName = argv.flags.first ? String(argv.flags.first) : (localPart || "Blindfold");
      const lastName = argv.flags.last ? String(argv.flags.last) : "Tenant";

      const { signupTenant, SignupEmailTakenError } = await import("../src/t3-client.ts");
      // Allow a non-interactive OTP (for scripted/remote tests): --otp <code>.
      const presetOtp = argv.flags.otp ? String(argv.flags.otp).trim() : "";
      // Persisted by onKeyReady the moment the email verifies — captured here so
      // both the success and the post-verify-failure paths can report where the
      // key landed (and so a failed admit never strands an unrecoverable key).
      let saved: { inKeychain: boolean; cfg: string } | null = null;
      let res;
      try {
        res = await signupTenant({
          env,
          email,
          profile: { first_name: firstName, last_name: lastName },
          onKeyReady: (key, did) => {
            saved = saveTenantCredentials(did, key, env, Boolean(argv.flags.file));
          },
          getOtpCode: async () => {
            if (presetOtp) return presetOtp;
            process.stderr.write(c.yellow(`  A verification code was emailed to ${email}.\n`));
            return (await readLine("  Enter the code: ")).trim();
          },
        });
      } catch (e) {
        if (e instanceof SignupEmailTakenError) {
          console.error(c.red(`✖ ${e.message}`));
          console.error(c.dim("  This email already has a tenant. Either:"));
          console.error(c.dim(`    • log in with that tenant's key:  blindfold login --did ${e.existingDid}`));
          console.error(c.dim("    • or sign up with a different email (Gmail '+' aliases work: you+blindfold@gmail.com)."));
          process.exit(1);
        }
        // If the key was already saved (email verified, only the self-admit
        // failed), the tenant is recoverable — say so instead of implying loss.
        if (saved) {
          const s = saved as { inKeychain: boolean; cfg: string };
          console.error(c.red(`✖ Email verified and tenant key saved, but self-admit failed: ${(e as Error).message}`));
          console.error(c.dim(`  Your key + DID are stored in ${s.inKeychain ? `the ${keychainBackend()}` : `${s.cfg} (0600)`} — not lost.`));
          console.error(c.dim("  The tenant just wasn't funded. Check `blindfold credit`, or re-run `blindfold signup` with a fresh email for a new funded tenant."));
          process.exit(1);
        }
        die(`signup failed: ${(e as Error).message}`);
        return;
      }

      if (res.admitStatus === "refused") {
        die(`Terminal 3 refused self-admit (${res.refusedReason ?? "unknown"})${res.refusedDetail ? `: ${res.refusedDetail}` : ""}.`);
        return;
      }

      const { inKeychain, cfg } = saved ?? saveTenantCredentials(res.did, res.key, env, Boolean(argv.flags.file));
      const verb = res.admitStatus === "already-admitted" ? "confirmed (already registered)" : "created";
      console.log(ok(`\n✓ Tenant ${verb}: ${c.bold(res.did)}`));
      console.log(`  Tenant key stored in ${inKeychain ? `the ${keychainBackend()}` : `${cfg} (0600)`} — never printed.`);
      if (res.grantedCredits) {
        console.log(ok(`  Welcome credits minted: ${res.grantedCredits} base units.`));
      } else {
        console.log(c.yellow("  No welcome credits were minted (the testnet dial may be 0). Check `blindfold credit`."));
      }
      console.log(`\n  Next:`);
      console.log(`    ${c.bold("blindfold doctor")}    ${c.dim("# confirm T3 reachability")}`);
      console.log(`    ${c.bold("blindfold credit")}    ${c.dim("# see your token balance")}`);
      console.log(`    ${c.bold("blindfold register --name openai_key")}   ${c.dim("# seal your first secret")}`);
      return;
    }
    case "login": {
      // Store tenant credentials in ~/.blindfold/config.json so the CLI works
      // from any directory, installed globally, without a repo .env.
      const did = argv.flags.did
        ? String(argv.flags.did)
        : (await readSecretLine("Tenant DID (did:t3n:…): ")).trim();
      if (!/^did:t3n:[0-9a-fA-F]+$/.test(did)) die('DID must look like "did:t3n:<hex>".');
      const key = argv.flags.key
        ? String(argv.flags.key)
        : (await readSecretLine("T3N_API_KEY (0x…, hidden): ")).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die("T3N_API_KEY must be a 0x-prefixed 32-byte hex.");
      const env = String(argv.flags.env ?? "").toLowerCase() === "production" ? "production" : "testnet";

      // Prefer the OS keychain for the tenant key; the config file then holds
      // only non-secret DID + settings. Fall back to a 0600 file when no
      // keychain exists OR the keychain write fails (e.g. err 1312 in a
      // non-interactive session). --file forces the file path.
      const { inKeychain, triedKeychain, cfg } = saveTenantCredentials(did, key, env, Boolean(argv.flags.file));
      console.log(`✓ Saved tenant key to ${inKeychain ? `the ${keychainBackend()}` : `${cfg} (mode 0600)`}. Blindfold now works from any directory.`);
      console.log(`  Tenant: ${did}  ·  env: ${env}  ·  key: stored (never printed)`);
      if (!inKeychain && !argv.flags.file) {
        console.log(triedKeychain
          ? `  (Keychain write unavailable here — stored in a 0600 file. Run \`blindfold login\` in an interactive desktop session to use ${keychainBackend()}.)`
          : `  (No OS keychain found — stored in a 0600 file. On macOS/Linux/Windows an interactive session uses the OS credential store automatically.)`);
      }
      console.log(`  Verify: blindfold doctor`);
      return;
    }
    case "logout": {
      const cfg = configPath();
      let did = "";
      let store = "";
      try { if (fs.existsSync(cfg)) { const o = JSON.parse(fs.readFileSync(cfg, "utf8")); did = o.DID ?? ""; store = o.T3N_API_KEY_STORE ?? ""; } } catch { /* ignore */ }
      let removed = false;
      if (store === "keychain" && did && keychainAvailable()) { if (keychainDelete(did)) { console.log("✓ Removed tenant key from the OS keychain."); removed = true; } }
      if (fs.existsSync(cfg)) { fs.rmSync(cfg, { force: true }); console.log(`✓ Removed ${cfg}.`); removed = true; }
      if (!removed) console.log("Nothing to remove — no saved credentials at " + cfg);
      else console.log("Tenant credentials cleared from this machine.");
      return;
    }
    case "whoami": {
      const cfg = configPath();
      let store = "";
      try { if (fs.existsSync(cfg)) store = (JSON.parse(fs.readFileSync(cfg, "utf8")).T3N_API_KEY_STORE) ?? ""; } catch { /* ignore */ }
      const env = loadBlindfoldEnv();
      const keySource = !env.t3nApiKey ? "MISSING"
        : process.env.T3N_API_KEY && store === "keychain" ? `set (${keychainBackend()})`
        : store === "file" ? "set (config file, 0600)"
        : "set (env / repo .env)";
      console.log(`${c.bold("config:")}  ${c.gray(cfg)}${fs.existsSync(cfg) ? "" : "  (not present)"}`);
      console.log(`${c.bold("tenant:")}  ${c.cyan(env.did || "(none — run `blindfold login`)")}`);
      console.log(`${c.bold("env:")}     ${env.t3Env}   ·   key: ${c.green(keySource)}`);
      return;
    }
  }
}
