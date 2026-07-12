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
import { c, ok, bad, warn, head } from "../src/color.ts";
import { boxLines, rule } from "../src/tui.ts";

export async function handleEnclave(cmd: string, argv: Argv, cmdArgs: string[]): Promise<void> {
  switch (cmd) {
    case "credit":
    case "balance": {
      // Show the tenant's token/credit balance (a session-authed read that costs
      // no credit — works even when exhausted). Avoids discovering "0 credits"
      // only when a seal/forward fails with a 403.
      const env = loadBlindfoldEnv();
      const BASE = 1_000_000; // 1 token = 1,000,000 base units
      const { openT3Client } = await import("../src/t3-client.ts");
      const client = await openT3Client(env);
      try {
        const b = await client.getBalance();
        const tok = (n: number) => (n / BASE).toLocaleString(undefined, { maximumFractionDigits: 6 });
        if (argv.flags.json) { console.log(JSON.stringify(b, null, 2)); return; }
        const lines = [
          c.gray(`${env.did || "(no tenant)"}  ·  ${env.mock ? "MOCK" : env.t3Env}`),
          "",
          `available:  ${c.bold(c.green(tok(b.available) + " tokens"))}  ${c.gray("(" + b.available.toLocaleString() + " base units)")}`,
          `reserved:   ${b.reserved.toLocaleString()} base units`,
          `status:     ${b.creditExhausted ? warn("⚠ EXHAUSTED") : ok("✅ ok")}`,
        ];
        if (b.creditExhausted) {
          lines.push("", c.yellow("Top up testnet credits, then re-check with `blindfold credit`:"),
            c.cyan("  https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens"));
          process.exitCode = 1;
        }
        console.log(boxLines("💳 Terminal 3 credit", lines));
      } finally {
        await client.close();
      }
      return;
    }

    case "update":
    case "upgrade": {
      // Update the globally-installed blindfold. Prefer the repo SOURCE if one is
      // reachable (dev). Otherwise fall back to the SCOPED npm package
      // (@fiscalmindset/blindfold) — never the bare `blindfold` name, which is an
      // UNRELATED package. Source resolution: --from, BLINDFOLD_SRC, repo at cwd.
      const PKG = "@fiscalmindset/blindfold";
      const { spawnSync } = await import("node:child_process");
      const run = (cmd: string, args: string[], cwd?: string) =>
        spawnSync(cmd, args, { stdio: "inherit", cwd });
      let from = argv.flags.from ? String(argv.flags.from) : (process.env.BLINDFOLD_SRC || "");
      if (!from) {
        for (const cand of [path.resolve(process.cwd(), "packages", "blindfold"), process.cwd()]) {
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(cand, "package.json"), "utf8"));
            if ((pkg.name === PKG || pkg.name === "blindfold") && pkg.bin?.blindfold) { from = cand; break; }
          } catch { /* not the package dir */ }
        }
      }
      if (!from) {
        // No local source → update from the published scoped package.
        console.log(head("↻ Updating global blindfold from npm") + c.gray(` (${PKG}@latest)…`));
        const r = run("npm", ["install", "-g", `${PKG}@latest`]);
        if (r.status !== 0) {
          console.log("");
          console.log(bad("npm update failed") + c.gray(" — not published yet, or offline."));
          console.log("  Update from your repo checkout instead — one of:");
          console.log(c.cyan("    blindfold update --from /path/to/packages/blindfold"));
          console.log(c.cyan("    cd <repo> && blindfold update"));
          console.log(c.gray("    (or export BLINDFOLD_SRC=/path/to/packages/blindfold)"));
          process.exitCode = 1;
          return;
        }
        console.log(ok("✓ blindfold updated to the latest published version."));
        return;
      }
      console.log(head(`↻ Updating global blindfold`) + c.gray(` from ${from}`));
      if (run("npm", ["run", "build"], from).status !== 0) die("build failed");
      const pack = spawnSync("npm", ["pack"], { cwd: from, encoding: "utf8" });
      const tgz = (pack.stdout || "").trim().split("\n").pop() || "";
      if (!tgz) die("npm pack produced no tarball");
      const tgzPath = path.join(from, tgz);
      const inst = run("npm", ["install", "-g", tgzPath]);
      try { fs.rmSync(tgzPath, { force: true }); } catch { /* ignore */ }
      if (inst.status !== 0) die("global install failed");
      console.log(ok(`✓ blindfold updated.`) + c.gray(" Open a NEW shell if the command still looks stale."));
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
    case "sealed": {
      // List sealed keys (metadata only) for the current ledger.
      const entries = readSealed();
      if (entries.length === 0) {
        console.log(`No sealed-keys ledger yet at ${defaultSealedLogPath()}.`);
        console.log(`Seal one with:  blindfold register --name <KV_KEY>`);
        return;
      }
      console.log(boxLines("🔐 Sealed keys", [c.gray(`source: ${defaultSealedLogPath()}`)]));
      console.log("");
      console.log(c.gray("  WHEN                  NAME                       BYTES  MODE   WHERE"));
      console.log(c.gray("  ────                  ────                       ─────  ────   ─────"));
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
      console.log(boxLines("🔍 Blindfold audit", [c.gray("ledger hash-chain + reconciliation against the enclave")]));
      console.log("");
      const chain = verifyLedgerChain();
      console.log(c.bold("  1. Ledger integrity (tamper-evidence)"));
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
      const lines: string[] = [];
      lines.push(`mode:    ${env.mock ? "MOCK (BLINDFOLD_MOCK=1)" : "REAL"}   ·   T3 env: ${env.t3Env}`);
      if (env.t3BaseUrl) lines.push(`node:    ${env.t3BaseUrl}  (override)`);
      if (!env.mock) {
        try {
          const { openT3Client } = await import("../src/t3-client.ts");
          const client = await openT3Client(env);
          const info = await client.me();
          lines.push(`tenant:  ${ok("✅ " + info.tenant)}  (status=${info.status ?? "?"})`);
        } catch (e) {
          lines.push(`tenant:  ${bad("✖ " + (e as Error).message.slice(0, 90))}`);
          lines.push(`         ${c.gray("→ run `blindfold doctor` for a full diagnosis.")}`);
          process.exitCode = 1;
        }
      }
      const entries = readSealed();
      const latest = new Map<string, (typeof entries)[number]>();
      for (const e of entries) latest.set(e.name, e); // last write wins
      lines.push("", c.bold(`Sealed secrets (${latest.size})`));
      if (latest.size === 0) {
        lines.push(`  ${c.gray("(none yet)  seal one:")}  ${c.cyan("blindfold register --name <X>")}`);
      } else {
        for (const e of latest.values()) {
          lines.push(`  ${c.green("•")} ${c.cyan(e.name.padEnd(22))} ${String(e.length).padStart(4)} B   ${c.gray(e.mode)}`);
        }
      }
      lines.push("", c.gray("Next:  ") + c.cyan("blindfold use --name <secret> -- <command>") + c.gray("   (use it, no code)"));
      console.log(boxLines("🛡️  Blindfold status", lines));
      return;
    }
    case "doctor": {
      const env = loadBlindfoldEnv();
      console.log(boxLines("🩺 Blindfold doctor", [
        `mode:          ${env.mock ? "MOCK (BLINDFOLD_MOCK=1)" : "REAL (T3)"}`,
        `T3N_API_KEY:   ${env.t3nApiKey ? ok("set") : bad("NOT set ✖")}`,
        `DID:           ${env.did ? ok("set") : bad("NOT set ✖")}`,
        `T3 env:        ${env.t3Env}`,
        `node URL:      ${env.t3BaseUrl || c.gray(`(SDK default for ${env.t3Env})`)}`,
        `proxy port:    ${env.port}`,
      ]));
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
      console.log("\n" + rule("Live check — handshake + authenticate + me"));
      const { openT3Client } = await import("../src/t3-client.ts");
      let client;
      try {
        client = await openT3Client(env);
        console.log(`  auth:               ${ok("✅ handshake + authenticate OK")}`);
      } catch (e) {
        console.log(`  auth:               ${bad("✖ " + (e as Error).message)}`);
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
          console.log(`  ${ok("✅ Ready to seal & use secrets on this tenant.")}`);
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
  }
}
