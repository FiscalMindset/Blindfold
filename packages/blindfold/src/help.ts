/**
 * Command registry + help renderers. Drives both the grouped `blindfold help`
 * overview (with per-command usage) and the detailed `blindfold <cmd> --help`
 * (usage + flags + examples). All output reflows to the terminal width.
 */
import { c } from "./color.ts";
import { termWidth, vlen, wrapText, pad, bannerBox, boxLines, rule } from "./tui.ts";

interface CmdDef {
  name: string;
  group: string;
  usage: string; // args/flags after the command name, e.g. "[--email <addr>]"
  summary: string;
  flags?: Array<[string, string]>;
  examples?: string[];
  notes?: string;
  aliases?: string[];
}

const GROUP_ORDER = [
  "🚀 Get started",
  "🔑 Secrets",
  "🌐 Proxy & serve",
  "👥 Team & sharing",
  "📦 Enclave & admin",
  "👤 Account",
  "🤖 Agent skill",
];

export const COMMANDS: CmdDef[] = [
  // ── Get started ──────────────────────────────────────────────────────────
  {
    name: "signup", group: "🚀 Get started",
    usage: "[--email <addr>] [--first <name>] [--last <name>]",
    summary: "Self-serve: mint a funded Terminal 3 testnet tenant (key generated locally, email-verified).",
    flags: [
      ["--email <addr>", "Email for the tenant; a verification code is sent there. Prompts if omitted."],
      ["--first <name>", "First name for the profile (default: from the email local-part)."],
      ["--last <name>", "Last name for the profile (default: \"Tenant\")."],
      ["--otp <code>", "Supply the emailed code non-interactively (for scripts)."],
    ],
    examples: ["blindfold signup --email you@example.com"],
    notes: "Testnet-only. One email binds to one tenant — Gmail +aliases give fresh identities. Already have credentials? Use `blindfold login`.",
  },
  {
    name: "init", group: "🚀 Get started",
    usage: "[--seed <KV:ENV>]... [--start]",
    summary: "Guided zero-knowledge setup: .env, build, auth, publish, seed; can auto-start the proxy.",
    flags: [
      ["--seed <KV:ENV>", "Seal <ENV>'s value into secret <KV> as the last setup step (repeatable)."],
      ["--start", "Launch the proxy when setup finishes."],
    ],
    examples: ["blindfold init", "blindfold init --seed openai_api_key:OPENAI_API_KEY --start"],
  },
  { name: "doctor", group: "🚀 Get started", usage: "", summary: "Show mode + config and run a live tenant health check (handshake + authenticate + me).", examples: ["blindfold doctor"] },
  {
    name: "credit", group: "🚀 Get started", usage: "[--json]", aliases: ["balance"],
    summary: "Show the tenant's Terminal 3 token balance (costs nothing; works even at zero).",
    flags: [["--json", "Print the raw balance object instead of the formatted view."]],
    examples: ["blindfold credit"],
  },
  { name: "verify", group: "🚀 Get started", usage: "", summary: "Handshake + authenticate against Terminal 3 (a smoke test).", examples: ["blindfold verify"] },

  // ── Secrets ──────────────────────────────────────────────────────────────
  {
    name: "register", group: "🔑 Secrets",
    usage: "--name <KEY> [--from-env <ENV>]",
    summary: "Seal a secret into the enclave (one-time). Hidden prompt by default — never touches disk.",
    flags: [
      ["--name <KEY>", "Logical name for the sealed secret (required)."],
      ["--from-env <ENV>", "Read the value from process.env.<ENV> instead of prompting."],
    ],
    examples: ["blindfold register --name openai_api_key", "echo \"$KEY\" | blindfold register --name openai_api_key"],
    notes: "Without --from-env it prompts with no echo (preferred). Piped stdin also works.",
  },
  {
    name: "use", group: "🔑 Secrets",
    usage: "--name <secret> [--as <ENV>] -- <cmd...>   |   --name <secret> --url <https>",
    summary: "Release a sealed secret into ONE command as $ENV — never back in your environment.",
    flags: [
      ["--name <secret>", "The sealed secret to release (required)."],
      ["--as <ENV>", "Env var to inject it as. Auto-detected for known tools (gh→GH_TOKEN, psql→PGPASSWORD…)."],
      ["--url <https>", "Instead of running a command, do a quick authenticated GET to this URL."],
    ],
    examples: ["blindfold use --name gh_token -- gh api user", "blindfold use --name openai_api_key --as OPENAI_API_KEY -- node agent.js"],
  },
  {
    name: "export", group: "🔑 Secrets", usage: "--name <secret> [--as <ENV>]",
    summary: "CI: release a sealed secret into $GITHUB_ENV for later steps (masked in logs).",
    flags: [["--name <secret>", "The sealed secret to export (required)."], ["--as <ENV>", "Env var name to write (default: the secret name upper-cased)."]],
    examples: ["blindfold export --name openai_api_key --as OPENAI_API_KEY"],
  },
  {
    name: "rotate", group: "🔑 Secrets", usage: "--name <secret> [--from-env <ENV>]",
    summary: "Replace a sealed secret's value; snapshots the old one for rollback (fingerprints only).",
    flags: [["--name <secret>", "The sealed secret to rotate (required)."], ["--from-env <ENV>", "Read the new value from an env var instead of prompting."]],
    examples: ["blindfold rotate --name stripe_secret_key"],
  },
  {
    name: "rollback", group: "🔑 Secrets", usage: "--name <secret> [--to <fp|iso-ts>]",
    summary: "Restore a previous value snapshotted by rotate (most recent by default).",
    flags: [["--name <secret>", "The sealed secret to roll back (required)."], ["--to <fp|iso-ts>", "Target a specific snapshot by fingerprint or timestamp."]],
    examples: ["blindfold rollback --name stripe_secret_key"],
  },
  { name: "versions", group: "🔑 Secrets", usage: "[--name <secret>]", summary: "List the snapshots available to roll back to (metadata only).", flags: [["--name <secret>", "Limit to one secret."]], examples: ["blindfold versions --name stripe_secret_key"] },
  {
    name: "migrate", group: "🔑 Secrets", usage: "[--dry-run] [--keep]",
    summary: "Seal every secret in .env at once, then remove the plaintext lines (backup kept).",
    flags: [["--dry-run", "Preview what would be sealed, change nothing."], ["--keep", "Comment out the .env lines instead of deleting them."]],
    examples: ["blindfold migrate --dry-run", "blindfold migrate"],
    notes: "Skips T3 creds + config (T3N_API_KEY / DID).",
  },

  // ── Proxy & serve ────────────────────────────────────────────────────────
  {
    name: "proxy", group: "🌐 Proxy & serve", usage: "[--port <n>] [--auth] [--socket [path]]",
    summary: "Run the local sentinel proxy your agent points at. Substitution happens in the enclave.",
    flags: [
      ["--port <n>", "TCP port to listen on (default 8787)."],
      ["--auth", "Mint a per-session token so only the wrapped agent can use the proxy."],
      ["--socket [path]", "Bind a 0600 unix-domain socket (only your OS user can connect)."],
    ],
    examples: ["blindfold proxy", "blindfold proxy --auth", "blindfold proxy --socket"],
    notes: "Point your agent at http://127.0.0.1:8787 and send Authorization: Bearer __BLINDFOLD__.",
  },
  {
    name: "attest", group: "🌐 Proxy & serve", usage: "[--expect-rtmr3 <b64>] [--pin] [--json]",
    summary: "Verify the enclave's TDX attestation (chains to Intel's root CA).",
    flags: [
      ["--expect-rtmr3 <b64>", "Assert the code measurement equals this value."],
      ["--pin", "Record the RTMR3 so seal/proxy auto-verify the enclave first."],
      ["--json", "Machine-readable output."],
    ],
    examples: ["blindfold attest", "blindfold attest --pin"],
  },
  { name: "dashboard", group: "🌐 Proxy & serve", usage: "[--port <n>]", summary: "Live HTML dashboard of proxy usage (default :8799).", flags: [["--port <n>", "Port for the dashboard (default 8799)."]], examples: ["blindfold dashboard"] },
  { name: "stats", group: "🌐 Proxy & serve", usage: "", summary: "CLI summary of proxy usage. `stats:clear` wipes the log.", examples: ["blindfold stats", "blindfold stats:clear"] },

  // ── Team & sharing ───────────────────────────────────────────────────────
  {
    name: "grant", group: "👥 Team & sharing", usage: "--host <host>[,<host2>...]",
    summary: "Allow the enclave to reach an API's server. Do this once per API before the proxy can call it — e.g. allow api.openai.com so a sealed OpenAI key can be used.",
    flags: [["--host <host,...>", "The API hostname(s) to allow, comma-separated. Each grant adds to the list."]],
    examples: ["blindfold grant --host api.openai.com", "blindfold grant --host api.github.com,api.stripe.com"],
    notes: "Why it's needed: the enclave refuses to call any host you haven't allowed (deny-by-default). Grant the host of each API whose key you've sealed.",
  },
  {
    name: "share", group: "👥 Team & sharing", usage: "--to <agent-did> --host <host>[,...]",
    summary: "Let a teammate use your sealed key for an API — they can make calls but never see the key itself.",
    flags: [["--to <agent-did>", "The teammate's agent DID (their Terminal 3 identity)."], ["--host <host,...>", "Which API hosts they're allowed to reach through your enclave."]],
    examples: ["blindfold share --to did:t3n:abc… --host api.openai.com"],
  },
  { name: "revoke", group: "👥 Team & sharing", usage: "--to <agent-did>", summary: "Take back a teammate's access you granted with `share` — immediate and complete.", flags: [["--to <agent-did>", "The teammate's agent DID to cut off."]], examples: ["blindfold revoke --to did:t3n:abc…"] },

  // ── Enclave & admin ──────────────────────────────────────────────────────
  { name: "publish", group: "📦 Enclave & admin", usage: "[--wasm <path>]", summary: "Publish the Rust→WASM contract to your tenant (one-time).", flags: [["--wasm <path>", "Path to blindfold_proxy.wasm (defaults to the bundled build)."]], examples: ["blindfold publish"] },
  { name: "status", group: "📦 Enclave & admin", usage: "", summary: "One-glance overview: mode, tenant health, and the list of sealed secrets.", examples: ["blindfold status"] },
  { name: "sealed", group: "📦 Enclave & admin", usage: "", summary: "List sealed keys — metadata only (name, byte-length, when, where). Never the value.", examples: ["blindfold sealed"] },
  { name: "audit", group: "📦 Enclave & admin", usage: "", summary: "Verify the ledger hash-chain and reconcile it against the enclave (flags drift/tampering).", examples: ["blindfold audit"] },
  { name: "compat", group: "📦 Enclave & admin", usage: "[--json]", summary: "Scan this machine for AI agent tools and print the exact env-var swap for each.", flags: [["--json", "Machine-readable output."]], examples: ["blindfold compat"] },
  { name: "update", group: "📦 Enclave & admin", usage: "[--from <path>]", aliases: ["upgrade"], summary: "Update the global install (from npm, or a local repo with --from).", flags: [["--from <path>", "Build + install from a local repo checkout instead of npm."]], examples: ["blindfold update"] },

  // ── Account ──────────────────────────────────────────────────────────────
  {
    name: "login", group: "👤 Account", usage: "[--did <did>] [--key <0x…>] [--env <net>] [--file]",
    summary: "Store EXISTING Terminal 3 credentials (tenant key → OS keychain).",
    flags: [
      ["--did <did>", "Tenant DID (prompts if omitted)."],
      ["--key <0x…>", "Tenant key (prompts hidden if omitted)."],
      ["--env <net>", "testnet (default) or production."],
      ["--file", "Force a 0600 config file instead of the OS keychain."],
    ],
    examples: ["blindfold login", "blindfold login --did did:t3n:… --env testnet"],
  },
  { name: "logout", group: "👤 Account", usage: "", summary: "Remove stored credentials (keychain entry + config file).", examples: ["blindfold logout"] },
  { name: "whoami", group: "👤 Account", usage: "", summary: "Show tenant, env, and key source — never the value.", examples: ["blindfold whoami"] },

  // ── Agent skill ──────────────────────────────────────────────────────────
  {
    name: "skill", group: "🤖 Agent skill", usage: "install [--global|--cursor|--opencode|--cline|--all]  |  uninstall",
    summary: "Install the Blindfold agent skill so your coding agent handles secrets safely.",
    flags: [
      ["--global", "Install for every Claude Code session on this machine."],
      ["--cursor / --opencode / --cline", "Install for that agent instead of Claude Code."],
      ["--all", "Install everywhere at once."],
    ],
    examples: ["blindfold skill install", "blindfold skill install --all"],
  },
];

/** Look up a command by name or alias. */
export function findCommand(name: string): CmdDef | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/** The grouped overview: `blindfold help`. */
export function renderMainHelp(): string {
  const w = termWidth();
  const out: string[] = [
    "",
    bannerBox("🛡️  Blindfold", "Protect your AI agent's API keys with Terminal 3 enclaves. The agent only ever holds a placeholder — the real key is substituted inside the TDX enclave."),
    "",
  ];

  const nameW = Math.min(12, COMMANDS.reduce((m, cmd) => Math.max(m, vlen(cmd.name)), 0));
  const descW = Math.max(16, w - 4 - nameW - 2);
  const fit = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s);

  for (const group of GROUP_ORDER) {
    const cmds = COMMANDS.filter((cmd) => cmd.group === group);
    const lines: string[] = [];
    for (const [idx, cmd] of cmds.entries()) {
      if (idx > 0) lines.push(""); // breathing room between commands
      const dl = wrapText(cmd.summary, descW);
      // command name (bright) + summary
      lines.push(pad(c.bold(c.cyan(cmd.name)), nameW) + "  " + (dl[0] ?? ""));
      for (let i = 1; i < dl.length; i++) lines.push(pad("", nameW) + "  " + (dl[i] ?? ""));
      const gutter = pad("", nameW) + "  ";
      // the shape — with <placeholders> — so you learn the pattern (only if it takes args)
      if (cmd.usage) {
        lines.push(gutter + c.gray(pad("usage", 5)) + " " + c.cyan(fit(`blindfold ${cmd.name} ${cmd.usage}`, descW - 6)));
      }
      // one concrete example — the fastest way to "get" the command
      const ex = fit(cmd.examples?.[0] ?? `blindfold ${cmd.name}`, descW - 6);
      lines.push(gutter + c.gray(pad("e.g.", 5)) + " " + c.green(ex));
    }
    out.push(boxLines(group, lines));
    out.push("");
  }

  out.push(
    c.bold(c.magenta("▶ Quick start")),
    `  ${c.green("blindfold signup --email you@x.com")}         ${c.gray("# create a funded testnet tenant")}`,
    `  ${c.green("blindfold register --name openai_api_key")}   ${c.gray("# seal a key (hidden prompt)")}`,
    `  ${c.green("blindfold proxy")}                            ${c.gray("# point your agent at http://127.0.0.1:8787")}`,
    "",
    `${c.gray("Full flags + more examples for any command:")}  ${c.cyan("blindfold <command> --help")}`,
    `${c.gray("Docs:")} ${c.cyan("npmjs.com/package/@fiscalmindset/blindfold")}`,
    "",
  );
  return out.join("\n");
}

/** Detailed help for one command: `blindfold <cmd> --help`. */
export function renderCommandHelp(name: string): string {
  const cmd = findCommand(name);
  if (!cmd) return renderMainHelp();
  const w = termWidth();
  const out: string[] = ["", boxLines(`blindfold ${cmd.name}`, wrapText(cmd.summary, w - 4)), ""];

  out.push(rule("Usage"));
  out.push("  " + c.cyan(`blindfold ${cmd.name}${cmd.usage ? " " + cmd.usage : ""}`));
  if (cmd.aliases?.length) out.push("  " + c.gray(`alias: ${cmd.aliases.map((a) => "blindfold " + a).join(", ")}`));
  out.push("");

  if (cmd.flags?.length) {
    out.push(rule("Flags"));
    const flagW = Math.min(24, cmd.flags.reduce((m, [f]) => Math.max(m, vlen(f)), 0));
    const dW = Math.max(16, w - 2 - flagW - 2);
    for (const [flag, desc] of cmd.flags) {
      const dl = wrapText(desc, dW);
      out.push("  " + pad(c.yellow(flag), flagW) + "  " + (dl[0] ?? ""));
      for (let i = 1; i < dl.length; i++) out.push("  " + pad("", flagW) + "  " + c.gray(dl[i] ?? ""));
    }
    out.push("");
  }

  if (cmd.examples?.length) {
    out.push(rule("Examples"));
    for (const ex of cmd.examples) out.push("  " + c.cyan(ex));
    out.push("");
  }

  if (cmd.notes) {
    out.push(rule("Notes"));
    for (const nl of wrapText(cmd.notes, w - 2)) out.push("  " + c.gray(nl));
    out.push("");
  }

  out.push(c.gray("See all commands: ") + c.cyan("blindfold help"));
  return out.join("\n");
}
