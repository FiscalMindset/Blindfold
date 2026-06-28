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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv } from "../src/env.ts";
import { registerSecret, registerContract } from "../src/register.ts";
import { startProxy } from "../src/proxy.ts";
import { startDashboard } from "../src/dashboard.ts";
import { clearUsage, defaultLogPath, readUsage } from "../src/usage-log.ts";
import { runInit, runVerify } from "../src/init.ts";
import { runCompat } from "../src/compat.ts";
import { defaultSealedLogPath, readSealed } from "../src/sealed-ledger.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

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
    case "register": {
      const name = String(argv.flags.name ?? "");
      const fromEnv = argv.flags["from-env"] ? String(argv.flags["from-env"]) : undefined;
      if (!name) {
        die("usage: blindfold register --name <KV_KEY> [--from-env <ENV_VAR>]");
      }
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
      const value = await release(name); // plaintext, kept local; never printed

      // Mode A: quick auth test against an HTTPS endpoint with Bearer auth.
      if (argv.flags.url) {
        const url = String(argv.flags.url);
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

    case "rotate": {
      const name = String(argv.flags.name ?? "");
      const fromEnv = argv.flags["from-env"] ? String(argv.flags["from-env"]) : undefined;
      if (!name) {
        die("usage: blindfold rotate --name <secret> [--from-env <ENV_VAR>]");
      }
      const { release } = await import("../src/release.ts");
      // Show the current fingerprint (best-effort) so you can confirm it changed.
      try {
        const old = await release(name);
        console.log(`  before:  "${name}"  ${old.length} B  fp=${fingerprint(old)}`);
      } catch {
        console.log(`  before:  (no existing value for "${name}" — sealing fresh)`);
      }
      await registerSecret({ name, fromEnv }); // overwrites the same map entry
      const now = await release(name);
      console.log(`✓ Rotated "${name}"  →  ${now.length} B  fp=${fingerprint(now)}  (mode=real)`);
      console.log(`  Every place that uses "${name}" now gets the new value — no code/config change.`);
      if (fromEnv) console.log(`  You can now DELETE ${fromEnv} from your .env.`);
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

    case "proxy": {
      const port = argv.flags.port ? Number(argv.flags.port) : undefined;
      const secret = argv.flags.secret ? String(argv.flags.secret) : undefined;
      const handle = await startProxy({ port, secretKey: secret });
      console.log(`✓ Blindfold proxy listening at ${handle.url}`);
      console.log(`  Point your agent at:   OPENAI_BASE_URL=${handle.url}/v1`);
      console.log(`  Health check:          ${handle.url}/health`);
      // long-running: don't close until SIGINT
      process.on("SIGINT", async () => {
        await handle.close();
        process.exit(0);
      });
      return;
    }

    case "publish": {
      const wasmPath =
        (argv.flags.wasm as string | undefined) ??
        path.join(REPO_ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");
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

    case "status": {
      // One-glance overview: health + sealed inventory + what to do next.
      const env = loadBlindfoldEnv();
      console.log("🛡️  Blindfold status\n");
      console.log(`  mode:    ${env.mock ? "MOCK (BLINDFOLD_MOCK=1)" : "REAL"}   ·   T3 env: ${env.t3Env}`);
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
          console.log(`       • switch .env to a key whose tenant is active (check with this doctor), or`);
          console.log(`       • ask Terminal 3 to provision/claim a tenant for this key.`);
        } else {
          console.log(`  ⚠  Could not read the tenant behind this key — seals/writes will likely fail.`);
          console.log(`     Verify the key is provisioned, or switch to a key that passes this doctor.`);
        }
        process.exitCode = 1;
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
  rotate   --name <secret> [--from-env <ENV_VAR>]  Replace a sealed secret's value (shows before/after fingerprints; never the value). Everything using that name picks up the new value automatically.
  migrate  [--dry-run] [--keep]                     Seal EVERY secret in your .env in one shot, then remove the plaintext lines (backup kept). --dry-run previews; --keep comments lines instead of deleting. Skips T3 creds + config.
  status                                             One-glance overview: mode, tenant health, and the list of sealed secrets.
  sealed                                             List sealed keys — metadata only (name, byte-length, when, where). Never the value.
  proxy    [--port 8787] [--secret openai_api_key] Run the local OpenAI-shaped proxy.
  publish  [--wasm path/to/blindfold_proxy.wasm]   Publish the Rust→WASM contract (one-time).
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
