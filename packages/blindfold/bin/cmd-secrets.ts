/** CLI command group (auto-split from the dispatcher; bodies unchanged). */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadBlindfoldEnv, configPath, homeDir, stateDir } from "../src/env.ts";
import { keychainAvailable, keychainBackend, keychainSet, keychainDelete } from "../src/keychain.ts";
import { readSecretLine, readLine } from "../src/prompt.ts";
import { c, ok, warn } from "../src/color.ts";
import { registerSecret, registerContract } from "../src/register.ts";
import { startProxy } from "../src/proxy.ts";
import { attest, attestationGate, writePinnedRtmr3 } from "../src/attest.ts";
import { startDashboard } from "../src/dashboard.ts";
import { clearUsage, defaultLogPath, readUsage } from "../src/usage-log.ts";
import { runInit, runVerify } from "../src/init.ts";
import { runCompat } from "../src/compat.ts";
import { defaultSealedLogPath, readSealed, removeSealedEntry, verifyLedgerChain } from "../src/sealed-ledger.ts";
import { type Argv, die, assetPath, fingerprint, resolveEnvVar } from "./cli-shared.ts";

export async function handleSecrets(cmd: string, argv: Argv, cmdArgs: string[]): Promise<void> {
  switch (cmd) {
    case "register": {
      const name = String(argv.flags.name ?? "");
      const fromEnv = argv.flags["from-env"] ? String(argv.flags["from-env"]) : undefined;
      if (!name) {
        die("usage: blindfold register --name <KV_KEY> [--from-env <ENV_VAR>]");
      }
      // Attestation gate (no-op unless a measurement is pinned): don't seal into
      // an enclave that doesn't verify.
      const sealGate = await attestationGate({ skip: !!argv.flags["no-attest"], requirePin: true });
      if (sealGate.warning) console.error(`⚠️  ${sealGate.warning}`);
      if (sealGate.enforced && !sealGate.ok) {
        die(`attestation gate: ${sealGate.message}. Refusing to seal into an unverified enclave. (bypass: --no-attest, or clear the pin)`);
      }
      if (sealGate.enforced) console.log("✓ enclave attestation verified");
      await registerSecret({ name, fromEnv });
      if (fromEnv) {
        console.log(`✓ Registered "${name}" (value read from ${fromEnv} once, then dropped).`);
        console.log(`  You can now DELETE ${fromEnv} from your .env.`);
      } else {
        console.log(`✓ Registered "${name}" — value lives only in the enclave.`);
      }
      // The other half: tell the user how to actually USE what they just sealed.
      const asVar = name.toUpperCase();
      console.log("");
      console.log("  Use it (the plaintext never returns to your env):");
      console.log(`    blindfold use --name ${name} -- <your command>       # injects ${asVar} into that command only`);
      console.log(`    blindfold use --name ${name} --as ${asVar} -- <cmd>  # custom env-var name`);
      console.log(`    blindfold use --name ${name} --url <https url>       # quick "does it auth?" check`);
      console.log(`    proxy/SDK:  set the key to "__BLINDFOLD__" + route via \`blindfold proxy\`, or \`release("${name}")\` in code`);
      return;
    }
    case "delete":
    case "remove": {
      // Delete a sealed secret: empty its value in the enclave (current tenant)
      // AND remove it from the local ledger, re-chaining so `audit` stays valid.
      const name = String(argv.flags.name ?? argv._[1] ?? "");
      if (!name) die("usage: blindfold delete --name <secret>   [--yes to skip the prompt]");

      const inLedger = readSealed().some((e) => e.name === name);
      if (!inLedger) console.error(warn(`⚠ "${name}" isn't in the local ledger — will still try to empty it in the enclave.`));

      // Confirm (unless --yes/--force). Destructive.
      const skip = Boolean(argv.flags.yes || argv.flags.force || argv.flags.y);
      if (!skip) {
        const ans = (await readLine(`Delete sealed secret ${c.bold(name)}? This empties it in the enclave and removes it from the ledger. Type "yes": `)).trim().toLowerCase();
        if (ans !== "yes" && ans !== "y") { console.log("Aborted — nothing deleted."); return; }
      }

      // Enclave side (best-effort — a secret on a different/old tenant just won't be found).
      const env = loadBlindfoldEnv();
      let enclaveNote = "";
      try {
        const { openT3Client } = await import("../src/t3-client.ts");
        const client = await openT3Client(env);
        try {
          const how = await client.deleteSecret(name);
          enclaveNote = how === "deleted" ? "enclave entry deleted" : "enclave value emptied (key may remain)";
        } finally { await client.close(); }
      } catch (e) {
        enclaveNote = `enclave not updated (${(e as Error).message.slice(0, 80)}) — ledger still cleaned`;
      }

      const removed = removeSealedEntry(name);
      console.log(ok(`✓ Deleted "${name}".`));
      console.log(`  ${c.gray("ledger:")}  ${removed > 0 ? `removed ${removed} entr${removed === 1 ? "y" : "ies"} (re-chained; backup kept)` : "not present"}`);
      console.log(`  ${c.gray("enclave:")} ${enclaveNote}`);
      if (inLedger) console.log(c.gray(`  Verify: blindfold sealed   ·   blindfold audit`));
      return;
    }
    case "use": {
      const name = String(argv.flags.name ?? "");
      if (!name) {
        die("usage: blindfold use --name <secret> [--as <ENV_VAR>] -- <command...>\n" +
            "       blindfold use --name <secret> --url <https url>   (quick auth test)");
      }
      const { release } = await import("../src/release.ts");
      const value = await release(name, { via: "use" }); // plaintext, kept local; never printed

      // Mode 0: --check just confirms the secret is sealed + usable (no URL, no
      // command, no value printed). The dashboard's "copy command" uses this.
      if (argv.flags.check) {
        console.log(`✓ "${name}" is sealed and usable — ${value.length} bytes (value never shown)`);
        return;
      }

      // Mode A: quick auth test against an HTTPS endpoint with Bearer auth.
      if (argv.flags.url) {
        const url = String(argv.flags.url);
        // The released plaintext key is sent as a Bearer token to this URL.
        // Refuse a non-https target (localhost excepted) so a mistyped/hostile
        // URL can't exfiltrate the key. --allow-insecure overrides for testing.
        if (!argv.flags["allow-insecure"]) {
          let u: URL;
          try { u = new URL(url); } catch (e) { die(`invalid --url: ${(e as Error).message}`); return; }
          const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
          if (u.protocol !== "https:" && !isLocal) {
            die(`refusing to send the released key to a non-https URL (${u.protocol}//${u.hostname}). Use https, target localhost, or pass --allow-insecure to override.`);
            return;
          }
          // M3: gate --url behind the same egress allowlist the proxy uses, so a
          // hijacked agent can't POST the released key to an arbitrary https host.
          if (!isLocal) {
            const { loadEgressHosts } = await import("../src/t3-client.ts");
            const env = loadBlindfoldEnv();
            const granted = loadEgressHosts(env.did);
            const allowed = granted.some((h) => h === u.hostname || u.hostname.endsWith(`.${h}`));
            if (!allowed) {
              die(`refusing to send the released key to ${u.hostname}: host is not in the egress allowlist. Run \`blindfold grant --host ${u.hostname}\` first, or pass --allow-insecure to override.`);
              return;
            }
          }
        }
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${value}`, "User-Agent": "blindfold", Accept: "*/*" },
        });
        console.log(`✓ released "${name}" (${value.length} B, value not shown) → ${url}`);
        console.log(`  HTTP ${res.status} ${res.statusText}  ${res.ok ? "✅ accepted" : "✖ rejected"}`);
        return;
      }

      // Mode B: run any command with the secret injected as an env var, for
      // that subprocess only. The parent never persists the plaintext.
      if (cmdArgs.length === 0) {
        die("provide a command after `--` (e.g. `-- gh api user`), or pass --url <url> to test auth");
      }
      const asVar = resolveEnvVar(argv.flags.as ? String(argv.flags.as) : undefined, cmdArgs[0], name);
      console.error(`✓ released "${name}" (${value.length} B) → injecting $${asVar} into: ${cmdArgs.join(" ")}`);
      const child = spawn(cmdArgs[0]!, cmdArgs.slice(1), {
        stdio: "inherit",
        env: { ...process.env, [asVar]: value },
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      child.on("error", (e) => die(`failed to run "${cmdArgs[0]}": ${e.message}`));
      return;
    }
    case "export": {
      // CI-only: release a sealed secret into $GITHUB_ENV for later steps, and
      // mask it in the logs. Lets a GitHub Action pull keys from the enclave
      // instead of storing them as GitHub secrets.
      const name = String(argv.flags.name ?? "");
      if (!name) die("usage: blindfold export --name <secret> [--as <ENV_VAR>]   (for GitHub Actions / CI)");
      const ghEnv = process.env.GITHUB_ENV;
      if (!ghEnv) die("`export` writes to $GITHUB_ENV (GitHub Actions only). Use `blindfold use` locally.");
      const asVar = resolveEnvVar(argv.flags.as ? String(argv.flags.as) : undefined, undefined, name);
      const { release } = await import("../src/release.ts");
      const value = await release(name, { via: "export" });
      // ::add-mask:: tells the runner to redact this value everywhere in the logs.
      console.log(`::add-mask::${value}`);
      fs.appendFileSync(ghEnv, `${asVar}=${value}\n`);
      console.error(`✓ exported $${asVar} from sealed "${name}" (${value.length} B, masked in logs)`);
      return;
    }
  }
}
