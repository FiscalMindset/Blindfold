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

export async function handleTenant(cmd: string, argv: Argv, cmdArgs: string[]): Promise<void> {
  switch (cmd) {
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
  }
}
