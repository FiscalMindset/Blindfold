#!/usr/bin/env node
/**
 * blindfold CLI — thin dispatcher. Command logic lives in ./cmd-*.ts, shared
 * helpers in ./cli-shared.ts. Every action prints what it did, never a secret.
 */
import { type Argv, parseArgv } from "./cli-shared.ts";
import { handleAuth } from "./cmd-auth.ts";
import { handleSecrets } from "./cmd-secrets.ts";
import { handleLifecycle } from "./cmd-lifecycle.ts";
import { handleTenant } from "./cmd-tenant.ts";
import { handleServe } from "./cmd-serve.ts";
import { handleEnclave } from "./cmd-enclave.ts";

type Handler = (cmd: string, argv: Argv, cmdArgs: string[]) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  login: handleAuth, logout: handleAuth, whoami: handleAuth,
  register: handleSecrets, use: handleSecrets, export: handleSecrets,
  rotate: handleLifecycle, rollback: handleLifecycle, versions: handleLifecycle, migrate: handleLifecycle,
  grant: handleTenant, share: handleTenant, revoke: handleTenant,
  proxy: handleServe, attest: handleServe, dashboard: handleServe, stats: handleServe, "stats:clear": handleServe,
  publish: handleEnclave, init: handleEnclave, verify: handleEnclave, compat: handleEnclave,
  sealed: handleEnclave, audit: handleEnclave, status: handleEnclave, doctor: handleEnclave, skill: handleEnclave,
};

async function main(): Promise<void> {
  // Split on a bare `--` so `blindfold use --name X -- <command...>` keeps the
  // child command intact (parseArgv would otherwise swallow it).
  const raw = process.argv.slice(2);
  const ddIdx = raw.indexOf("--");
  const cmdArgs = ddIdx >= 0 ? raw.slice(ddIdx + 1) : [];
  const argv = parseArgv(ddIdx >= 0 ? raw.slice(0, ddIdx) : raw);
  const cmd = argv._[0] ?? "help";
  const handler = ROUTES[cmd];
  if (handler) await handler(cmd, argv, cmdArgs);
  else printHelp();
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

main().catch((e) => {
  console.error("✖", (e as Error).message);
  process.exit(1);
});
