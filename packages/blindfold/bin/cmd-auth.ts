/** CLI command group (auto-split from the dispatcher; bodies unchanged). */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadBlindfoldEnv, configPath, homeDir, stateDir } from "../src/env.ts";
import { keychainAvailable, keychainBackend, keychainSet, keychainDelete } from "../src/keychain.ts";
import { readSecretLine } from "../src/prompt.ts";
import { registerSecret, registerContract } from "../src/register.ts";
import { startProxy } from "../src/proxy.ts";
import { attest, attestationGate, writePinnedRtmr3 } from "../src/attest.ts";
import { startDashboard } from "../src/dashboard.ts";
import { clearUsage, defaultLogPath, readUsage } from "../src/usage-log.ts";
import { runInit, runVerify } from "../src/init.ts";
import { runCompat } from "../src/compat.ts";
import { defaultSealedLogPath, readSealed, verifyLedgerChain } from "../src/sealed-ledger.ts";
import { type Argv, die, assetPath, fingerprint, resolveEnvVar } from "./cli-shared.ts";

export async function handleAuth(cmd: string, argv: Argv, cmdArgs: string[]): Promise<void> {
  switch (cmd) {
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
      const cfg = configPath();
      let existing: Record<string, string> = {};
      try { if (fs.existsSync(cfg)) existing = JSON.parse(fs.readFileSync(cfg, "utf8")); } catch { /* overwrite */ }

      // Prefer the OS keychain for the tenant key; the config file then holds
      // only non-secret DID + settings. Fall back to a 0600 file when no
      // keychain exists OR the keychain write fails (e.g. err 1312 in a
      // non-interactive session). --file forces the file path.
      const merged: Record<string, string> = { ...existing, DID: did, BLINDFOLD_T3_ENV: env };
      const triedKeychain = !argv.flags.file && keychainAvailable();
      const inKeychain = triedKeychain && keychainSet(did, key);
      if (inKeychain) {
        merged.T3N_API_KEY_STORE = "keychain";
        delete merged.T3N_API_KEY; // ensure no stale plaintext key lingers in the file
      } else {
        merged.T3N_API_KEY = key;
        merged.T3N_API_KEY_STORE = "file";
      }
      fs.mkdirSync(homeDir(), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify(merged, null, 2), { mode: 0o600 });
      try { fs.chmodSync(cfg, 0o600); } catch { /* best effort */ }
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
      console.log(`config:  ${cfg}${fs.existsSync(cfg) ? "" : "  (not present)"}`);
      console.log(`tenant:  ${env.did || "(none — run `blindfold login`)"}`);
      console.log(`env:     ${env.t3Env}   ·   key: ${keySource}`);
      return;
    }
  }
}
