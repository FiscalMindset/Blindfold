#!/usr/bin/env node
/**
 * blindfold CLI — thin dispatcher. Command logic lives in ./cmd-*.ts, shared
 * helpers in ./cli-shared.ts. Every action prints what it did, never a secret.
 */
import { type Argv, parseArgv } from "./cli-shared.ts";
import { c, bad } from "../src/color.ts";
import { bannerBox, commandBox, nearest } from "../src/tui.ts";
import { handleAuth } from "./cmd-auth.ts";
import { handleSecrets } from "./cmd-secrets.ts";
import { handleLifecycle } from "./cmd-lifecycle.ts";
import { handleTenant } from "./cmd-tenant.ts";
import { handleServe } from "./cmd-serve.ts";
import { handleEnclave } from "./cmd-enclave.ts";

type Handler = (cmd: string, argv: Argv, cmdArgs: string[]) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  signup: handleAuth, login: handleAuth, logout: handleAuth, whoami: handleAuth,
  register: handleSecrets, use: handleSecrets, export: handleSecrets,
  rotate: handleLifecycle, rollback: handleLifecycle, versions: handleLifecycle, migrate: handleLifecycle,
  grant: handleTenant, share: handleTenant, revoke: handleTenant,
  proxy: handleServe, attest: handleServe, dashboard: handleServe, stats: handleServe, "stats:clear": handleServe,
  publish: handleEnclave, init: handleEnclave, verify: handleEnclave, compat: handleEnclave,
  sealed: handleEnclave, audit: handleEnclave, status: handleEnclave, doctor: handleEnclave, skill: handleEnclave,
  credit: handleEnclave, balance: handleEnclave,
  update: handleEnclave, upgrade: handleEnclave,
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
  else if (cmd === "help" || cmd === "--help" || cmd === "-h") printHelp();
  else printUnknown(cmd);
}

/** Unknown command: a concise error with a "did you mean" suggestion — not the
 *  full help dump (which used to appear on any typo). */
function printUnknown(cmd: string): void {
  const all = [...Object.keys(ROUTES), "help"];
  const guess = nearest(cmd, all);
  console.error(
    bad(`✖ Unknown command: ${cmd}`) +
    (guess ? `  ${c.gray("— did you mean")} ${c.cyan(guess)}${c.gray("?")}` : ""),
  );
  console.error(c.gray("  Run ") + c.cyan("blindfold help") + c.gray(" to see all commands."));
  process.exit(1);
}

function printHelp(): void {
  const groups: Array<[string, Array<[string, string]>]> = [
    ["🚀 Get started", [
      ["signup", "Self-serve: mint a funded Terminal 3 testnet tenant (key generated locally, email-verified)."],
      ["init", "Guided zero-knowledge setup: .env, build, auth, publish, seed; can auto-start the proxy."],
      ["doctor", "Show mode + config and run a live tenant health check."],
      ["credit", "Show the tenant's Terminal 3 token balance (costs nothing)."],
      ["verify", "Handshake + authenticate against T3 (smoke test)."],
    ]],
    ["🔑 Secrets", [
      ["register", "Seal a secret into the enclave (hidden prompt; never touches disk)."],
      ["use", "Release a sealed secret into one command as $ENV — never back in your env."],
      ["export", "CI: release a sealed secret into $GITHUB_ENV (masked in logs)."],
      ["rotate", "Replace a sealed secret's value (snapshots the old one for rollback)."],
      ["rollback", "Restore a previous value snapshotted by rotate."],
      ["versions", "List the snapshots available to roll back to (metadata only)."],
      ["migrate", "Seal every secret in .env at once, then remove the plaintext lines."],
    ]],
    ["🌐 Proxy & serve", [
      ["proxy", "Run the local sentinel proxy. --auth mints a session token; --socket binds a 0600 unix socket."],
      ["attest", "Verify the enclave's TDX attestation (Intel root CA). --pin gates seal/proxy on the code measurement."],
      ["dashboard", "Live HTML dashboard of proxy usage (default :8799)."],
      ["stats", "CLI summary of proxy usage (stats:clear wipes it)."],
    ]],
    ["👥 Team & sharing", [
      ["grant", "Authorize the contract to call these hosts (e.g. --host api.openai.com)."],
      ["share", "Let a teammate's agent USE your sealed keys for a host — forward only, no plaintext."],
      ["revoke", "Remove a teammate's access — immediate and complete."],
    ]],
    ["📦 Enclave & admin", [
      ["publish", "Publish the Rust→WASM contract to your tenant (one-time)."],
      ["status", "One-glance: mode, tenant health, and sealed secrets."],
      ["sealed", "List sealed keys — metadata only, never the value."],
      ["audit", "Verify the ledger hash-chain and reconcile it against the enclave."],
      ["compat", "Scan this machine for AI agent tools + print the env-var swap for each."],
      ["update", "Update the global install (from npm, or --from <repo>)."],
    ]],
    ["👤 Account", [
      ["login", "Store existing Terminal 3 credentials (key → OS keychain)."],
      ["logout", "Remove stored credentials."],
      ["whoami", "Show tenant, env, and key source (never the value)."],
    ]],
    ["🤖 Agent skill", [
      ["skill", "install [--global|--cursor|--opencode|--cline|--all] / uninstall — the agent skill for your coding agent."],
    ]],
  ];

  const out: string[] = [
    "",
    bannerBox("🛡️  Blindfold", "Protect your AI agent's API keys with Terminal 3 enclaves. The agent only ever holds a placeholder — the real key is substituted inside the TDX enclave."),
    "",
  ];
  for (const [title, rows] of groups) {
    out.push(commandBox(title, rows));
    out.push("");
  }
  out.push(
    c.bold("Quick start"),
    `  ${c.cyan("blindfold signup --email you@x.com")}   ${c.gray("# create a funded testnet tenant")}`,
    `  ${c.cyan("blindfold register --name openai_api_key")}`,
    `  ${c.cyan("blindfold proxy")}                        ${c.gray("# point your agent at http://127.0.0.1:8787")}`,
    "",
    `${c.gray("Docs:")} ${c.cyan("https://www.npmjs.com/package/@fiscalmindset/blindfold")}   ${c.gray("·")}   ${c.gray("Run")} ${c.cyan("blindfold <command> --help")} ${c.gray("for details")}`,
    "",
  );
  console.log(out.join("\n"));
}

main().catch((e) => {
  console.error("✖", (e as Error).message);
  process.exit(1);
});
