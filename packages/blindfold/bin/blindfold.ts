#!/usr/bin/env node
/**
 * blindfold CLI
 *
 *   blindfold register --name <KV_KEY> --from-env <ENV_VAR>
 *   blindfold proxy   [--port 8787] [--secret openai_api_key]
 *   blindfold publish [--wasm path/to/blindfold_proxy.wasm]
 *   blindfold doctor
 *
 * Designed to be obvious to a security auditor — every action prints
 * what it did, but never prints any secret value.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const PKG_ROOT = path.resolve(HERE, ".."); // packages/blindfold (or the installed package root)

/** Resolve an asset needed by skill/publish: prefer the repo source (dev), else
 *  the copy bundled in the package's assets/ (standalone/global install). */
function assetPath(repoRelative: string, assetName: string): string {
  const repoPath = path.join(REPO_ROOT, ...repoRelative.split("/"));
  if (fs.existsSync(repoPath)) return repoPath;
  return path.join(PKG_ROOT, "assets", assetName);
}

type Argv = { _: string[]; flags: Record<string, string | boolean> };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags[key] = next;
        i += 1;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Non-reversible fingerprint of a secret — for verification without exposure. */
function fingerprint(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Known CLI tools → the env var they read their credential from. */
const TOOL_ENV: Record<string, string> = {
  gh: "GH_TOKEN", git: "GH_TOKEN", glab: "GITLAB_TOKEN",
  psql: "PGPASSWORD", pg_dump: "PGPASSWORD", mysql: "MYSQL_PWD",
  aws: "AWS_SECRET_ACCESS_KEY", stripe: "STRIPE_API_KEY",
  vercel: "VERCEL_TOKEN", npm: "NPM_TOKEN", docker: "DOCKER_PASSWORD",
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
  doctl: "DIGITALOCEAN_ACCESS_TOKEN", heroku: "HEROKU_API_KEY",
  cloudflared: "CLOUDFLARE_API_TOKEN", wrangler: "CLOUDFLARE_API_TOKEN",
};

/** Pick the env-var name for `use`: explicit --as, else infer from the tool, else NAME upper-cased. */
function resolveEnvVar(asFlag: string | undefined, command: string | undefined, name: string): string {
  if (asFlag) return asFlag;
  if (command && TOOL_ENV[command]) return TOOL_ENV[command];
  return name.toUpperCase();
}

async function main(): Promise<void> {
  // Split on a bare `--` so `blindfold use --name X -- <command...>` keeps the
  // child command intact (parseArgv would otherwise swallow it).
  const raw = process.argv.slice(2);
  const ddIdx = raw.indexOf("--");
  const cmdArgs = ddIdx >= 0 ? raw.slice(ddIdx + 1) : [];
  const argv = parseArgv(ddIdx >= 0 ? raw.slice(0, ddIdx) : raw);
  const cmd = argv._[0] ?? "help";

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

    case "register": {
      const name = String(argv.flags.name ?? "");
      const fromEnv = argv.flags["from-env"] ? String(argv.flags["from-env"]) : undefined;
      if (!name) {
        die("usage: blindfold register --name <KV_KEY> [--from-env <ENV_VAR>]");
      }
      // Attestation gate (no-op unless a measurement is pinned): don't seal into
      // an enclave that doesn't verify.
      const sealGate = await attestationGate({ skip: !!argv.flags["no-attest"] });
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

    case "rotate": {
      const name = String(argv.flags.name ?? "");
      const fromEnv = argv.flags["from-env"] ? String(argv.flags["from-env"]) : undefined;
      if (!name) {
        die("usage: blindfold rotate --name <secret> [--from-env <ENV_VAR>]");
      }
      const env = loadBlindfoldEnv();
      const { openT3Client } = await import("../src/t3-client.ts");
      const { recordVersion, versionKeyFor } = await import("../src/versions.ts");
      const client = await openT3Client(env);
      try {
        // Snapshot the current value into the enclave (for rollback) before overwriting.
        try {
          const old = await client.releaseSecret(name);
          const vKey = versionKeyFor(name, Date.now());
          await client.seedSecret(vKey, old);
          recordVersion({ t: new Date().toISOString(), name, versionKey: vKey, length: old.length, fingerprint: fingerprint(old) });
          console.log(`  before:  "${name}"  ${old.length} B  fp=${fingerprint(old)}  (snapshot saved — rollback available)`);
        } catch {
          console.log(`  before:  (no existing value for "${name}" — sealing fresh)`);
        }
        await registerSecret({ name, fromEnv }); // overwrites the live entry + records the ledger
        const now = await client.releaseSecret(name);
        console.log(`✓ Rotated "${name}"  →  ${now.length} B  fp=${fingerprint(now)}  (mode=real)`);
        console.log(`  Every place that uses "${name}" now gets the new value — no code/config change.`);
        console.log(`  Made a mistake? \`blindfold rollback --name ${name}\``);
        if (fromEnv) console.log(`  You can now DELETE ${fromEnv} from your .env.`);
      } finally {
        await client.close();
      }
      return;
    }

    case "rollback": {
      const name = String(argv.flags.name ?? "");
      if (!name) die("usage: blindfold rollback --name <secret> [--to <iso-ts | fingerprint>]");
      const { readVersions, isValidVersionKey } = await import("../src/versions.ts");
      const versions = readVersions(name);
      if (versions.length === 0) {
        die(`no saved versions for "${name}". \`blindfold rotate\` creates them; \`blindfold versions --name ${name}\` lists them.`);
      }
      const want = argv.flags.to ? String(argv.flags.to) : "";
      let target = versions[versions.length - 1]!; // most recent snapshot
      if (want) {
        const sel = versions.find((v) => v.t === want || v.fingerprint === want || v.fingerprint.startsWith(want));
        if (!sel) die(`no version of "${name}" matches --to ${want} (see \`blindfold versions --name ${name}\`)`);
        target = sel;
      }
      // Integrity guard: versions.jsonl is local and could be tampered with to
      // point `versionKey` at an arbitrary enclave key. A legitimate key always
      // matches __bfver__<name>__<ts>; reject anything else before releasing.
      if (!isValidVersionKey(name, target.versionKey)) {
        die(`refusing rollback: version key "${target.versionKey}" is not a valid snapshot key for "${name}" (tampered versions.jsonl?)`);
      }
      const env = loadBlindfoldEnv();
      const { openT3Client } = await import("../src/t3-client.ts");
      const client = await openT3Client(env);
      try {
        const before = await client.verifySecret(name);
        const restored = await client.releaseSecret(target.versionKey);
        // And verify the released value matches the fingerprint recorded when the
        // snapshot was taken — catches a versionKey swapped to a different value.
        if (fingerprint(restored) !== target.fingerprint) {
          die(`refusing rollback: released snapshot fingerprint ${fingerprint(restored)} ≠ recorded ${target.fingerprint} (tampered versions.jsonl?)`);
        }
        await client.seedSecret(name, restored);
        console.log(`✓ Rolled back "${name}"`);
        console.log(`  ${before.present ? `fp ${before.fingerprint} (${before.length} B)` : "(no current value)"}  →  fp ${fingerprint(restored)} (${restored.length} B)`);
        console.log(`  restored the snapshot from ${target.t}.`);
      } finally {
        await client.close();
      }
      return;
    }

    case "versions": {
      const name = argv.flags.name ? String(argv.flags.name) : undefined;
      const { readVersions } = await import("../src/versions.ts");
      const list = readVersions(name);
      if (list.length === 0) {
        console.log(name ? `No saved versions for "${name}".` : "No saved versions yet. `blindfold rotate` creates them.");
        return;
      }
      console.log(`Saved versions${name ? ` for "${name}"` : ""} (newest last):\n`);
      console.log("  WHEN                  NAME                   BYTES  FINGERPRINT");
      console.log("  ────                  ────                   ─────  ───────────");
      for (const v of list) {
        const when = v.t.replace("T", " ").slice(0, 19);
        console.log(`  ${when}   ${v.name.padEnd(22)} ${String(v.length).padStart(5)}  ${v.fingerprint}`);
      }
      console.log(`\n  Restore the newest:  blindfold rollback --name <name>`);
      console.log(`  Restore a specific:  blindfold rollback --name <name> --to <fingerprint>`);
      return;
    }

    case "migrate": {
      const { planMigration, runMigrate } = await import("../src/migrate.ts");
      const dryRun = !!argv.flags["dry-run"];
      const keep = !!argv.flags.keep;
      const plan = planMigration();
      const toSeal = plan.filter((p) => p.action === "seal");

      console.log(dryRun ? "🔍 blindfold migrate --dry-run (no changes will be made)\n" : "🚚 blindfold migrate\n");
      console.log("  Plan:");
      for (const p of plan) {
        if (p.action === "seal") console.log(`    SEAL  ${p.envVar.padEnd(26)} → ${p.sealName}  (${p.bytes} B)`);
        else console.log(`    skip  ${p.envVar.padEnd(26)} — ${p.reason}`);
      }
      if (toSeal.length === 0) {
        console.log("\n  Nothing to seal (no secret-looking vars found).");
        return;
      }
      if (dryRun) {
        console.log(`\n  Would seal ${toSeal.length} secret(s), then ${keep ? "comment out" : "remove"} their .env lines (a .env backup is kept either way).`);
        console.log("  Re-run without --dry-run to do it.");
        return;
      }

      console.log(`\n  Sealing ${toSeal.length} secret(s) …`);
      const results = await runMigrate({ keep });
      console.log("");
      let ok = 0, fail = 0;
      for (const r of results) {
        if (r.action !== "seal") continue;
        if (r.sealed) { ok++; console.log(`    ✓ ${r.sealName} sealed (${r.bytes} B) — .env line ${keep ? "commented" : "removed"}`); }
        else { fail++; console.log(`    ✖ ${r.sealName}: ${(r.error ?? "").slice(0, 100)}`); }
      }
      console.log(`\n  Done: ${ok} sealed, ${fail} failed.  (.env backup saved alongside .env)`);
      if (ok > 0) console.log(`  Use any of them with no code:  blindfold use --name <name> -- <command>`);
      if (fail > 0) { console.log(`  Failed seals kept their .env line. Check \`blindfold doctor\`.`); process.exitCode = 1; }
      return;
    }

    case "grant": {
      // Authorize the contract to make outbound calls to one or more hosts.
      const hosts: string[] = [];
      if (argv.flags.host) hosts.push(...String(argv.flags.host).split(",").map((h) => h.trim()).filter(Boolean));
      if (argv.flags.hosts) hosts.push(...String(argv.flags.hosts).split(",").map((h) => h.trim()).filter(Boolean));
      if (hosts.length === 0) {
        die("usage: blindfold grant --host <host>[,<host2>...]   (e.g. --host api.openai.com)");
      }
      const replace = !!argv.flags.replace;
      const env = loadBlindfoldEnv();
      const { openT3Client } = await import("../src/t3-client.ts");
      const client = await openT3Client(env);
      try {
        // T3 replaces the allowlist on every update, so grant is additive by
        // default (merges with previously-granted hosts). Use --replace to reset.
        const authorized = await client.grantEgress(hosts, { replace });
        console.log(`✓ Egress granted for: ${hosts.join(", ")}${replace ? "  (replaced allowlist)" : ""}`);
        console.log(`  Contract is now authorized to call ALL of: ${authorized.join(", ")}`);
        console.log(`  Run \`blindfold publish\` first if you haven't — the grant targets the published contract.`);
      } finally {
        await client.close();
      }
      return;
    }

    case "share": {
      // Authorize a teammate's agent to USE this tenant's sealed keys (via the
      // in-enclave forward path) for specific hosts — they never receive the key.
      const to = String(argv.flags.to ?? "");
      const hosts: string[] = [];
      if (argv.flags.host) hosts.push(...String(argv.flags.host).split(",").map((h) => h.trim()).filter(Boolean));
      if (argv.flags.hosts) hosts.push(...String(argv.flags.hosts).split(",").map((h) => h.trim()).filter(Boolean));
      if (!to || hosts.length === 0) {
        die("usage: blindfold share --to <agent-did> --host <host>[,host2]   (e.g. --to did:t3n:… --host api.openai.com)");
      }
      const env = loadBlindfoldEnv();
      const { openT3Client } = await import("../src/t3-client.ts");
      const client = await openT3Client(env);
      try {
        await client.setAgentGrant(to, hosts, ["forward"]); // forward only — least privilege, no plaintext extraction
        console.log(`✓ Shared access with ${to}`);
        console.log(`  authorized: forward → ${hosts.join(", ")}  (they can USE the key via the enclave; they never receive the plaintext)`);
        console.log(`  Revoke any time:  blindfold revoke --to ${to}`);
      } finally {
        await client.close();
      }
      return;
    }

    case "revoke": {
      const to = String(argv.flags.to ?? "");
      if (!to) die("usage: blindfold revoke --to <agent-did>");
      const env = loadBlindfoldEnv();
      const { openT3Client } = await import("../src/t3-client.ts");
      const client = await openT3Client(env);
      try {
        await client.setAgentGrant(to, [], []); // empty scripts → remove all authorization
        console.log(`✓ Revoked all contract access for ${to}`);
        console.log(`  Nobody holds the raw key, so revocation is immediate and complete — there's no leaked copy to chase.`);
      } finally {
        await client.close();
      }
      return;
    }

    case "proxy": {
      const port = argv.flags.port ? Number(argv.flags.port) : undefined;
      const secret = argv.flags.secret ? String(argv.flags.secret) : undefined;
      // Per-session auth: `--token <t>` supplies one; `--auth` mints a random
      // one. Without either, the proxy stays open to any local process (the key
      // still can't be stolen — this only gates *use* by co-resident processes).
      let token = argv.flags.token ? String(argv.flags.token) : undefined;
      if (!token && argv.flags.auth) token = randomBytes(24).toString("hex");
      // `--socket [path]` binds a unix-domain socket (0600) instead of a TCP
      // port, so only same-user processes can connect. Bare `--socket` defaults
      // to <stateDir>/proxy.sock.
      let socket: string | undefined;
      if (argv.flags.socket !== undefined) {
        socket = typeof argv.flags.socket === "string" && argv.flags.socket.length > 0
          ? String(argv.flags.socket)
          : path.join(stateDir(), "proxy.sock");
      }
      // Attestation gate (no-op unless a measurement is pinned): don't route
      // secrets through an enclave that doesn't verify.
      const proxyGate = await attestationGate({ skip: !!argv.flags["no-attest"] });
      if (proxyGate.enforced && !proxyGate.ok) {
        die(`attestation gate: ${proxyGate.message}. Refusing to start the proxy against an unverified enclave. (bypass: --no-attest, or clear the pin)`);
      }
      if (proxyGate.enforced) console.log("✓ enclave attestation verified");
      const handle = await startProxy({ port, secretKey: secret, token, socket });
      console.log(`✓ Blindfold proxy listening at ${handle.url}`);
      if (handle.socket) {
        console.log(`  Unix socket (0600) — only your user's processes can connect.`);
        console.log(`  Call it with:          curl --unix-socket ${handle.socket} http://localhost/v1/...`);
      } else {
        console.log(`  Point your agent at:   OPENAI_BASE_URL=${handle.url}/v1`);
      }
      if (handle.token) {
        console.log(`  Auth ON — every request must send header:`);
        console.log(`    x-blindfold-token: ${handle.token}`);
        console.log(`  Only a process given this token can use the proxy. Set it for your agent, e.g.:`);
        console.log(`    export BLINDFOLD_PROXY_TOKEN=${handle.token}   # then wrap()/curl -H "x-blindfold-token: $BLINDFOLD_PROXY_TOKEN"`);
      } else {
        console.log(`  Auth OFF — add --auth to require a per-session token (recommended on shared machines).`);
      }
      console.log(`  Health check:          ${handle.url}/health`);
      // long-running: don't close until SIGINT
      process.on("SIGINT", async () => {
        await handle.close();
        process.exit(0);
      });
      return;
    }

    case "attest": {
      // Verify the T3 enclave cluster's TDX attestation (chains to Intel's root
      // CA). Optionally pin RTMR3 (the running code/config measurement).
      const expectRtmr3 = argv.flags["expect-rtmr3"] ? String(argv.flags["expect-rtmr3"]) : undefined;
      const r = await attest({ expectRtmr3 });
      if (argv.flags.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      if (!r.available) {
        console.log(`ℹ️  ${r.nodeUrl} publishes no attestation (mock signer or still bootstrapping).`);
        return;
      }
      console.log(`Attestation for ${r.nodeUrl}`);
      console.log(`  chain to Intel root:  ${r.valid ? "✅ valid" : "✖ INVALID"}${r.error ? ` (${r.error})` : ""}`);
      console.log(`  quotes verified:      ${r.validCount}/${r.expectedCount}`);
      for (const m of r.rtmr3s) console.log(`  RTMR3 (code measure): ${m}`);
      if (expectRtmr3) {
        console.log(`  RTMR3 pin:            ${r.pinned ? "✅ matches expected" : "✖ DID NOT MATCH"}`);
      } else if (r.rtmr3s.length) {
        console.log(`  Tip: pin it next time → blindfold attest --expect-rtmr3 ${r.rtmr3s[0]}`);
      }
      // `--pin` persists the measurement so seal/proxy auto-gate on it hereafter.
      if (argv.flags.pin) {
        const toPin = expectRtmr3 ?? r.rtmr3s[0];
        if (r.valid && toPin) {
          writePinnedRtmr3(toPin);
          console.log(`  ✓ pinned — \`seal\` and \`proxy\` will now verify this measurement first.`);
        } else {
          console.log(`  ✗ not pinning: attestation must pass first.`);
        }
      }
      if (!r.valid || (expectRtmr3 && !r.pinned)) process.exitCode = 1;
      return;
    }

    case "publish": {
      const wasmPath =
        (argv.flags.wasm as string | undefined) ??
        assetPath("contract/target/wasm32-wasip2/release/blindfold_proxy.wasm", "blindfold_proxy.wasm");
      if (!fs.existsSync(wasmPath)) {
        die(`no wasm found at ${wasmPath} — run scripts/build-contract.sh first`);
      }
      const wasm = fs.readFileSync(wasmPath);
      const r = await registerContract(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
      console.log(`✓ Published contract. contract_id=${r.contractId}`);
      return;
    }

    case "init": {
      const seedFlag = argv.flags.seed;
      const seedArr = Array.isArray(seedFlag) ? (seedFlag as string[]) : seedFlag ? [String(seedFlag)] : [];
      await runInit({
        skipBuild: !!argv.flags["skip-build"],
        skipPublish: !!argv.flags["skip-publish"],
        seed: seedArr,
        yes: !!argv.flags.yes,
        start: !!argv.flags.start,
      });
      return;
    }

    case "verify": {
      await runVerify();
      return;
    }

    case "compat": {
      await runCompat({ json: !!argv.flags.json });
      return;
    }

    case "dashboard": {
      const port = argv.flags.port ? Number(argv.flags.port) : undefined;
      const handle = await startDashboard({ port });
      console.log(`✓ Blindfold dashboard at ${handle.url}`);
      console.log(`  Reading: ${defaultLogPath()}`);
      console.log(`  (open in your browser; auto-refreshes every 2s)`);
      process.on("SIGINT", async () => { await handle.close(); process.exit(0); });
      return;
    }

    case "stats": {
      const events = readUsage();
      if (events.length === 0) {
        console.log("No usage recorded yet. Reads from " + defaultLogPath());
        return;
      }
      const byProvider: Record<string, number> = {};
      let ok = 0, bad = 0, totalLat = 0, sentinel = 0;
      for (const e of events) {
        byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
        if (e.status >= 200 && e.status < 300) ok++;
        else if (e.status >= 400) bad++;
        totalLat += e.latency_ms;
        if (e.sentinel_in_outbound) sentinel++;
      }
      const total = events.length;
      console.log("Blindfold usage stats (source: " + defaultLogPath() + ")");
      console.log(`  Total requests:     ${total}`);
      console.log(`  2xx / 4xx+:         ${ok} / ${bad}`);
      console.log(`  Sentinel substituted: ${sentinel}/${total}  (should equal total)`);
      console.log(`  Avg latency:        ${total ? Math.round(totalLat / total) : 0} ms`);
      console.log(`  By provider:        ${Object.entries(byProvider).map(([k, v]) => `${k}×${v}`).join("  ")}`);
      console.log(`  Recent (last 5):`);
      for (const e of events.slice(-5)) {
        console.log(`    ${e.t}  ${e.method.padEnd(6)} ${e.path}  → ${e.status} (${e.latency_ms}ms, ${e.provider}, ${e.mode})`);
      }
      return;
    }

    case "stats:clear": {
      clearUsage();
      console.log("✓ Cleared " + defaultLogPath());
      return;
    }

    case "sealed": {
      // List sealed keys (metadata only) for the current ledger.
      const entries = readSealed();
      if (entries.length === 0) {
        console.log(`No sealed-keys ledger yet at ${defaultSealedLogPath()}.`);
        console.log(`Seal one with:  blindfold register --name <KV_KEY>`);
        return;
      }
      console.log(`Sealed keys  (source: ${defaultSealedLogPath()})\n`);
      console.log("  WHEN                  NAME                       BYTES  MODE   WHERE");
      console.log("  ────                  ────                       ─────  ────   ─────");
      for (const e of entries) {
        const when = e.t.replace("T", " ").slice(0, 19);
        const where = e.map_name.length > 60 ? e.map_name.slice(0, 57) + "…" : e.map_name;
        console.log(`  ${when}   ${e.name.padEnd(26)}  ${String(e.length).padStart(5)}  ${e.mode.padEnd(5)}  ${where}/${e.name}`);
      }
      console.log("\n  (values are NOT stored in this ledger — only metadata. The canonical copy lives in the enclave.)");
      return;
    }

    case "audit": {
      // (1) Tamper-evidence: verify the local ledger's hash-chain.
      // (2) Reconcile against the enclave — the actual source of truth.
      console.log("🔍 Blindfold audit\n");
      const chain = verifyLedgerChain();
      console.log("  1. Ledger integrity (tamper-evidence)");
      if (chain.total === 0) {
        console.log("     (ledger is empty)");
      } else if (chain.ok) {
        const chained = chain.total - chain.legacy;
        console.log(`     ✅ hash-chain intact — ${chained} chained entr${chained === 1 ? "y" : "ies"}${chain.legacy ? `, ${chain.legacy} legacy (pre-chain, unverifiable)` : ""}`);
      } else {
        console.log(`     ✖ TAMPERED — the chain breaks at entry #${chain.firstBrokenIndex} (a line was edited or removed after it was written)`);
        process.exitCode = 1;
      }

      const env = loadBlindfoldEnv();
      if (env.mock) {
        console.log("\n  2. Enclave reconciliation: skipped (MOCK mode)");
        return;
      }
      const realEntries = readSealed().filter((e) => e.mode === "real");
      const latest = new Map<string, (typeof realEntries)[number]>();
      for (const e of realEntries) latest.set(e.name, e); // last write wins
      console.log(`\n  2. Enclave reconciliation — the enclave is the source of truth (${latest.size} secret${latest.size === 1 ? "" : "s"})`);
      if (latest.size === 0) {
        console.log("     (nothing sealed)");
        return;
      }
      const { openT3Client } = await import("../src/t3-client.ts");
      const client = await openT3Client(env);
      let okCount = 0, drift = 0, missing = 0;
      try {
        for (const e of latest.values()) {
          const v = await client.verifySecret(e.name);
          if (!v.present) {
            missing++;
            console.log(`     ✖ ${e.name.padEnd(22)} MISSING in enclave  (ledger claims ${e.length} B)`);
          } else if (v.length !== e.length) {
            drift++;
            console.log(`     ⚠ ${e.name.padEnd(22)} length drift: enclave ${v.length} B vs ledger ${e.length} B  fp=${v.fingerprint}`);
          } else {
            okCount++;
            console.log(`     ✅ ${e.name.padEnd(22)} present (${v.length} B, fp=${v.fingerprint})`);
          }
        }
      } finally {
        await client.close();
      }
      console.log(`\n  Summary: ${okCount} verified · ${drift} drift · ${missing} missing · ledger ${chain.ok ? "intact" : "TAMPERED"}`);
      if (drift > 0 || missing > 0 || !chain.ok) process.exitCode = 1;
      return;
    }

    case "status": {
      // One-glance overview: health + sealed inventory + what to do next.
      const env = loadBlindfoldEnv();
      console.log("🛡️  Blindfold status\n");
      console.log(`  mode:    ${env.mock ? "MOCK (BLINDFOLD_MOCK=1)" : "REAL"}   ·   T3 env: ${env.t3Env}`);
      if (env.t3BaseUrl) console.log(`  node:    ${env.t3BaseUrl}  (override)`);
      if (!env.mock) {
        try {
          const { openT3Client } = await import("../src/t3-client.ts");
          const client = await openT3Client(env);
          const info = await client.me();
          console.log(`  tenant:  ✅ ${info.tenant}  (status=${info.status ?? "?"})`);
        } catch (e) {
          console.log(`  tenant:  ✖ ${(e as Error).message.slice(0, 90)}`);
          console.log(`           → run \`blindfold doctor\` for a full diagnosis.`);
          process.exitCode = 1;
        }
      }
      const entries = readSealed();
      const latest = new Map<string, (typeof entries)[number]>();
      for (const e of entries) latest.set(e.name, e); // last write wins
      console.log(`\n  Sealed secrets (${latest.size}):`);
      if (latest.size === 0) {
        console.log(`    (none yet)   seal one:  blindfold register --name <X> --from-env <X>`);
      } else {
        for (const e of latest.values()) {
          console.log(`    • ${e.name.padEnd(22)} ${String(e.length).padStart(4)} B   ${e.mode}`);
        }
      }
      console.log(`\n  Next:  blindfold use --name <secret> -- <command>     (use it, no code)`);
      return;
    }

    case "doctor": {
      const env = loadBlindfoldEnv();
      console.log("Blindfold doctor:");
      console.log(`  mode:               ${env.mock ? "MOCK (BLINDFOLD_MOCK=1)" : "REAL (T3)"}`);
      console.log(`  T3N_API_KEY set:    ${env.t3nApiKey ? "yes" : "NO ✖"}`);
      console.log(`  DID set:            ${env.did ? "yes" : "NO ✖"}`);
      console.log(`  T3 environment:     ${env.t3Env}`);
      console.log(`  node URL:           ${env.t3BaseUrl || `(SDK default for ${env.t3Env})`}`);
      console.log(`  default proxy port: ${env.port}`);
      if (!env.mock && (!env.t3nApiKey || !env.did)) {
        console.log("");
        console.log(`  ⚠  REAL mode is selected but credentials are missing.`);
        console.log(`     Claim them: https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens`);
        console.log(`     Or run \`npm run setup\` and the wizard will walk you through it.`);
        process.exitCode = 1;
        return;
      }
      if (env.mock) return;

      // LIVE check: authenticate, then read the tenant behind the key. This is
      // what catches the painful "key authenticates but has no tenant" case,
      // which the server otherwise reports only as a bare HTTP 500.
      console.log("");
      console.log("  Live check (handshake + authenticate + me) …");
      const { openT3Client } = await import("../src/t3-client.ts");
      let client;
      try {
        client = await openT3Client(env);
        console.log(`  auth:               ✅ handshake + authenticate OK`);
      } catch (e) {
        console.log(`  auth:               ✖ ${(e as Error).message}`);
        console.log(`     → Check T3N_API_KEY is a 0x 32-byte hex private key and DID looks like did:t3n:<hex>.`);
        process.exitCode = 1;
        return;
      }
      try {
        const info = await client.me();
        console.log(`  tenant:             ✅ ${info.tenant}  (status=${info.status ?? "?"})`);
        const didHex = env.did.replace(/^did:t3n:/, "").toLowerCase();
        const meHex = info.tenant.replace(/^did:t3n:/, "").toLowerCase();
        if (meHex && didHex && meHex !== didHex) {
          console.log("");
          console.log(`  ⚠  DID MISMATCH: your .env DID (${env.did}) is not this key's tenant.`);
          console.log(`     The tenant DID is server-assigned, not derived from the key address.`);
          console.log(`     Fix: set  DID=${info.tenant}  in .env  (writes/seals target this tenant).`);
          process.exitCode = 1;
        } else if (info.status && info.status !== "active") {
          console.log(`  ⚠  tenant status is "${info.status}" (not active) — seals/writes may fail.`);
          process.exitCode = 1;
        } else {
          console.log(`  ✅ Ready to seal & use secrets on this tenant.`);
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.log(`  tenant:             ✖ ${msg}`);
        console.log("");
        if (/InsufficientCredit|forbidden|403/i.test(msg)) {
          console.log(`  ⚠  This key has a tenant but NO CREDITS. Seals/writes need credit.`);
          console.log(`     Fix: request testnet credits / claim tokens, then re-run \`blindfold doctor\`:`);
          console.log(`       https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens`);
        } else if (/500|internal_error/i.test(msg)) {
          console.log(`  ⚠  This key AUTHENTICATES but its tenant is unusable: a read-only me()`);
          console.log(`     returns a server error. Every seal/write with it will also 500.`);
          console.log(`     Fix one of:`);
          console.log(`       • switch .env to a key whose tenant is active (check with this doctor),`);
          console.log(`       • point at a healthy node:  T3_BASE_URL=<leader-node-url>  (if the node itself is unhealthy), or`);
          console.log(`       • ask Terminal 3 to provision/claim a tenant for this key.`);
        } else {
          console.log(`  ⚠  Could not read the tenant behind this key — seals/writes will likely fail.`);
          console.log(`     Verify the key is provisioned, or switch to a key that passes this doctor.`);
        }
        process.exitCode = 1;
      }
      return;
    }

    case "skill": {
      const sub = argv._[1] ?? "help";
      const skillSource = assetPath(".claude/skills/blindfold/SKILL.md", "SKILL.md");
      if (!fs.existsSync(skillSource)) {
        die(`skill source not found at ${skillSource} — reinstall Blindfold or run from the repo.`);
      }
      const skillContent = fs.readFileSync(skillSource, "utf-8");

      if (sub === "install") {
        const targets: { label: string; dir: string }[] = [];
        const global = !!argv.flags.global;
        const cursor = !!argv.flags.cursor;
        const opencode = !!argv.flags.opencode;
        const cline = !!argv.flags.cline;
        const all = !!argv.flags.all;

        if (global || all) targets.push({ label: "global (all Claude Code sessions)", dir: path.join(process.env.HOME ?? "~", ".claude", "skills", "blindfold") });
        if (cursor || all) targets.push({ label: "Cursor", dir: path.resolve(".cursor", "rules") });
        if (opencode || all) targets.push({ label: "OpenCode", dir: path.resolve(".opencode", "skills", "blindfold") });
        if (cline || all) targets.push({ label: "Cline", dir: path.resolve(".cline", "rules") });
        if (!global && !cursor && !opencode && !cline && !all) {
          targets.push({ label: "this project (Claude Code)", dir: path.resolve(".claude", "skills", "blindfold") });
        }

        for (const t of targets) {
          fs.mkdirSync(t.dir, { recursive: true });
          const dest = path.join(t.dir, t.dir.includes("rules") ? "blindfold.md" : "SKILL.md");
          fs.writeFileSync(dest, skillContent);
          console.log(`  ✓ ${t.label} → ${dest}`);
        }
        console.log(`\n✓ Blindfold skill installed (${targets.length} target${targets.length > 1 ? "s" : ""})`);
        console.log(`  Your coding agent will now handle secrets safely — try asking it to "seal my API key".`);
      } else if (sub === "uninstall") {
        const locations = [
          path.resolve(".claude", "skills", "blindfold", "SKILL.md"),
          path.join(process.env.HOME ?? "~", ".claude", "skills", "blindfold", "SKILL.md"),
          path.resolve(".cursor", "rules", "blindfold.md"),
          path.resolve(".opencode", "skills", "blindfold", "SKILL.md"),
          path.resolve(".cline", "rules", "blindfold.md"),
        ];
        let removed = 0;
        for (const loc of locations) {
          if (fs.existsSync(loc)) { fs.unlinkSync(loc); console.log(`  ✓ removed ${loc}`); removed++; }
        }
        console.log(removed ? `\n✓ Removed ${removed} skill file(s).` : "  No skill files found to remove.");
      } else {
        console.log(`blindfold skill — install the Blindfold agent skill for your coding agent.

  blindfold skill install                   Install for this project (Claude Code auto-discovers it)
  blindfold skill install --global          Install globally (~/.claude/skills/, all sessions)
  blindfold skill install --cursor          Install for Cursor (.cursor/rules/)
  blindfold skill install --opencode        Install for OpenCode (.opencode/skills/)
  blindfold skill install --cline           Install for Cline (.cline/rules/)
  blindfold skill install --all             Install for all of the above at once

  blindfold skill uninstall                 Remove all installed skill files

What it does: teaches your coding agent to seal keys safely — no pasting secrets
into chat, release-broker pattern in generated code, fingerprint-only verification.`);
      }
      return;
    }

    default:
      printHelp();
  }
}

function printHelp(): void {
  console.log(`Blindfold — protect your AI agent's API keys with Terminal 3 enclaves.

Commands:
  init     [--seed KV:ENV]... [--start]             One-command zero-knowledge setup. Walks through .env, build, auth, publish, seed; can auto-launch the proxy.
  verify                                            Handshake + auth against T3 (smoke test).
  compat   [--json]                                 Scan this machine for AI agent tools/SDKs and print the exact env-var swap for each.
  register --name <KV_KEY> [--from-env <ENV_VAR>]  Seal a secret into the enclave (one-time). With --from-env: reads process.env. Without: prompts the terminal with no echo (preferred — never touches disk/history). Also accepts piped stdin.
  use      --name <secret> [--as <ENV>] -- <cmd>   USE a sealed secret: release it and run <cmd> with it injected as $ENV for that command only — never back in your env. --as is auto-detected for known tools (gh→GH_TOKEN, psql→PGPASSWORD, …). Or  --url <https>  for a quick auth check.
  rotate   --name <secret> [--from-env <ENV_VAR>]  Replace a sealed secret's value (snapshots the old value for rollback; shows before/after fingerprints, never the value).
  export   --name <secret> [--as <ENV_VAR>]         CI-only: release a sealed secret into $GITHUB_ENV for later steps (masked in logs). Used by the Blindfold GitHub Action.
  rollback --name <secret> [--to <fp|iso-ts>]      Restore a previous value snapshotted by rotate (most recent by default).
  versions [--name <secret>]                        List the snapshots available to roll back to (metadata only).
  migrate  [--dry-run] [--keep]                     Seal EVERY secret in your .env in one shot, then remove the plaintext lines (backup kept). --dry-run previews; --keep comments lines instead of deleting. Skips T3 creds + config.
  status                                             One-glance overview: mode, tenant health, and the list of sealed secrets.
  sealed                                             List sealed keys — metadata only (name, byte-length, when, where). Never the value.
  audit                                              Verify the ledger's tamper-evident hash-chain AND reconcile it against the enclave (the source of truth) — flags drift/missing/tampering.
  proxy    [--port 8787] [--auth] [--socket [path]] Run the local OpenAI-shaped proxy. --auth mints a per-session token; --socket binds a 0600 unix socket (only your OS user can connect).
  attest   [--expect-rtmr3 <b64>] [--pin] [--json]  Verify the enclave's TDX attestation (chains to Intel's root CA). --pin records the RTMR3 so seal/proxy auto-verify it first.
  publish  [--wasm path/to/blindfold_proxy.wasm]   Publish the Rust→WASM contract (one-time).
  grant    --host <host>[,<host2>...]              Authorize the contract to call these hosts (required before the proxy / in-enclave path can reach them). E.g. --host api.openai.com
  share    --to <agent-did> --host <host>[,...]    Let a teammate's agent USE your sealed keys for those hosts via the enclave — they never receive the plaintext (forward only, least privilege).
  revoke   --to <agent-did>                         Remove a teammate's access. Immediate and complete — nobody holds a raw key copy.

  skill    install [--global|--cursor|--opencode|--cline|--all]   Install the Blindfold agent skill so your coding agent handles secrets safely. Default: this project.
  skill    uninstall                                Remove all installed skill files.

  dashboard [--port 8799]                           Live HTML dashboard of proxy usage.
  stats                                             CLI summary of proxy usage.
  stats:clear                                       Wipe the usage log.
  doctor                                            Show current mode + config.

The friendliest path is just:  blindfold init

Quick start:
  1) ./scripts/build-contract.sh             # build the Rust contract (REAL mode only)
  2) blindfold publish                        # register the contract on T3
  3) blindfold register --name openai_api_key --from-env OPENAI_API_KEY
  4) blindfold proxy                          # then point your agent at it
`);
}

function die(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(2);
}

main().catch((e) => {
  console.error("✖", (e as Error).message);
  process.exit(1);
});
