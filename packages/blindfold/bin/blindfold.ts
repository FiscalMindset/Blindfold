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
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv } from "../src/env.ts";
import { registerSecret, registerContract } from "../src/register.ts";
import { startProxy } from "../src/proxy.ts";
import { startDashboard } from "../src/dashboard.ts";
import { clearUsage, defaultLogPath, readUsage } from "../src/usage-log.ts";
import { runInit, runVerify } from "../src/init.ts";
import { runCompat } from "../src/compat.ts";

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

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
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
