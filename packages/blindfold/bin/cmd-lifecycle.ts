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

export async function handleLifecycle(cmd: string, argv: Argv, cmdArgs: string[]): Promise<void> {
  switch (cmd) {
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
  }
}
