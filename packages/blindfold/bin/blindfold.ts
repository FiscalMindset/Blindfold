#!/usr/bin/env node
/**
 * blindfold CLI — thin dispatcher. Command logic lives in ./cmd-*.ts, shared
 * helpers in ./cli-shared.ts. Every action prints what it did, never a secret.
 */
import { type Argv, parseArgv } from "./cli-shared.ts";
import { c, bad } from "../src/color.ts";
import { nearest } from "../src/tui.ts";
import { renderMainHelp, renderCommandHelp, findCommand } from "../src/help.ts";
import { handleAuth } from "./cmd-auth.ts";
import { handleSecrets } from "./cmd-secrets.ts";
import { handleLifecycle } from "./cmd-lifecycle.ts";
import { handleTenant } from "./cmd-tenant.ts";
import { handleServe } from "./cmd-serve.ts";
import { handleEnclave } from "./cmd-enclave.ts";

type Handler = (cmd: string, argv: Argv, cmdArgs: string[]) => Promise<void>;

const ROUTES: Record<string, Handler> = {
  signup: handleAuth, login: handleAuth, logout: handleAuth, whoami: handleAuth,
  register: handleSecrets, use: handleSecrets, export: handleSecrets, delete: handleSecrets, remove: handleSecrets,
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

  // `blindfold help` / `blindfold help <cmd>`
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    const sub = String(argv._[1] ?? "");
    console.log(sub && findCommand(sub) ? renderCommandHelp(sub) : renderMainHelp());
    return;
  }
  // `blindfold <cmd> --help` / `-h` → per-command help instead of running it.
  if ((argv.flags.help || argv.flags.h) && findCommand(cmd)) {
    console.log(renderCommandHelp(cmd));
    return;
  }

  const handler = ROUTES[cmd];
  if (handler) await handler(cmd, argv, cmdArgs);
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

main().catch((e) => {
  console.error("✖", (e as Error).message);
  process.exit(1);
});
