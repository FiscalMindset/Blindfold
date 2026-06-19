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
      const fromEnv = String(argv.flags["from-env"] ?? "");
      if (!name || !fromEnv) {
        die("usage: blindfold register --name <KV_KEY> --from-env <ENV_VAR>");
      }
      await registerSecret({ name, fromEnv });
      console.log(`✓ Registered "${name}" (value read from ${fromEnv} once, then dropped).`);
      console.log(`  You can now DELETE ${fromEnv} from your .env.`);
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

    case "doctor": {
      const env = loadBlindfoldEnv();
      console.log("Blindfold doctor:");
      console.log(`  mode:               ${env.mock ? "MOCK (T3 not reachable / not configured)" : "REAL (T3 testnet/prod)"}`);
      console.log(`  T3N_API_KEY set:    ${env.t3nApiKey ? "yes" : "no"}`);
      console.log(`  DID set:            ${env.did ? "yes" : "no"}`);
      console.log(`  T3 environment:     ${env.t3Env}`);
      console.log(`  default proxy port: ${env.port}`);
      return;
    }

    default:
      printHelp();
  }
}

function printHelp(): void {
  console.log(`Blindfold — protect your AI agent's API keys with Terminal 3 enclaves.

Commands:
  register --name <KV_KEY> --from-env <ENV_VAR>    Seal a secret into the enclave (one-time).
  proxy    [--port 8787] [--secret openai_api_key] Run the local OpenAI-shaped proxy.
  publish  [--wasm path/to/blindfold_proxy.wasm]   Publish the Rust→WASM contract (one-time).
  doctor                                            Show current mode + config.

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
