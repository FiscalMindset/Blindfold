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

export async function handleServe(cmd: string, argv: Argv, cmdArgs: string[]): Promise<void> {
  switch (cmd) {
    case "proxy": {
      const port = argv.flags.port ? Number(argv.flags.port) : undefined;
      const secret = argv.flags.secret ? String(argv.flags.secret) : undefined;
      // Per-session auth: `--token <t>` supplies one; `--auth` mints a random
      // one. Without either, the proxy stays open to any local process (the key
      // still can't be stolen — this only gates *use* by co-resident processes).
      let token = argv.flags.token ? String(argv.flags.token) : undefined;
      if (!token && argv.flags.auth) token = randomBytes(24).toString("hex");
      // `--socket [path]` binds a unix-domain socket (0600) instead of a TCP
      // port, so only same-user processes can connect. Bare `--socket` defaults
      // to <stateDir>/proxy.sock.
      let socket: string | undefined;
      if (argv.flags.socket !== undefined) {
        socket = typeof argv.flags.socket === "string" && argv.flags.socket.length > 0
          ? String(argv.flags.socket)
          : path.join(stateDir(), "proxy.sock");
      }
      // Attestation gate (no-op unless a measurement is pinned): don't route
      // secrets through an enclave that doesn't verify.
      const proxyGate = await attestationGate({ skip: !!argv.flags["no-attest"] });
      if (proxyGate.warning) console.error(`⚠️  ${proxyGate.warning}`);
      if (proxyGate.enforced && !proxyGate.ok) {
        die(`attestation gate: ${proxyGate.message}. Refusing to start the proxy against an unverified enclave. (bypass: --no-attest, or clear the pin)`);
      }
      if (proxyGate.enforced) console.log("✓ enclave attestation verified");
      if (socket && !token) {
        console.error("⚠️  --socket without --auth: access is gated only by the socket's 0600 owner permission. Add --auth for a per-process token too.");
      }
      const handle = await startProxy({ port, secretKey: secret, token, socket });
      console.log(`✓ Blindfold proxy listening at ${handle.url}`);
      if (handle.socket) {
        console.log(`  Unix socket (0600) — only your user's processes can connect.`);
        console.log(`  Call it with:          curl --unix-socket ${handle.socket} http://localhost/v1/...`);
      } else {
        console.log(`  Point your agent at:   OPENAI_BASE_URL=${handle.url}/v1`);
      }
      if (handle.token) {
        // Print auth material to STDERR (not stdout) so it doesn't land in piped
        // logs, and warn that env/argv are readable by other same-user processes.
        console.error(`  Auth ON — every request must send header:`);
        console.error(`    x-blindfold-token: ${handle.token}`);
        console.error(`  Give it to your agent via BLINDFOLD_PROXY_TOKEN or wrap({ token }).`);
        console.error(`  NOTE: env vars and argv are readable by same-user processes — on a shared`);
        console.error(`        machine prefer --socket (OS-enforced) over the token alone.`);
        if (argv.flags.token) {
          console.error(`  ⚠️  --token on the command line is visible in \`ps\`/proc; prefer --auth (mints one) or BLINDFOLD_PROXY_TOKEN.`);
        }
      } else {
        console.log(`  Auth OFF — add --auth to require a per-session token (recommended on shared machines).`);
      }
      console.log(`  Health check:          ${handle.url}/health`);
      // long-running: don't close until SIGINT
      process.on("SIGINT", async () => {
        await handle.close();
        process.exit(0);
      });
      return;
    }
    case "attest": {
      // Verify the T3 enclave cluster's TDX attestation (chains to Intel's root
      // CA). Optionally pin RTMR3 (the running code/config measurement).
      const expectRtmr3 = argv.flags["expect-rtmr3"] ? String(argv.flags["expect-rtmr3"]) : undefined;
      const r = await attest({ expectRtmr3, noCache: true }); // CLI check is always fresh
      if (argv.flags.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      if (!r.available) {
        console.log(`ℹ️  ${r.nodeUrl} publishes no attestation (mock signer or still bootstrapping).`);
        return;
      }
      console.log(`Attestation for ${r.nodeUrl}`);
      console.log(`  chain to Intel root:  ${r.valid ? "✅ valid" : "✖ INVALID"}${r.error ? ` (${r.error})` : ""}`);
      console.log(`  quotes verified:      ${r.validCount}/${r.expectedCount}`);
      for (const m of r.rtmr3s) console.log(`  RTMR3 (code measure): ${m}`);
      if (expectRtmr3) {
        console.log(`  RTMR3 pin:            ${r.pinned ? "✅ matches expected" : "✖ DID NOT MATCH"}`);
      } else if (r.rtmr3s.length) {
        console.log(`  Tip: pin it next time → blindfold attest --expect-rtmr3 ${r.rtmr3s[0]}`);
      }
      // `--pin` persists the measurement so seal/proxy auto-gate on it hereafter.
      if (argv.flags.pin) {
        const toPin = expectRtmr3 ?? r.rtmr3s[0];
        if (r.valid && toPin) {
          // TOFU caveat: pinning what the node reported only helps if that value
          // matches your reproducible enclave build. Warn unless the user
          // supplied the expected value explicitly (--expect-rtmr3).
          if (!expectRtmr3) {
            console.error(`  ⚠️  Pinning the measurement the node just reported (trust-on-first-use).`);
            console.error(`      Cross-check ${toPin} against your enclave's published/reproducible build hash;`);
            console.error(`      if this first contact was with a malicious node, you'd be pinning its measurement.`);
          }
          writePinnedRtmr3(toPin);
          console.log(`  ✓ pinned — \`seal\` and \`proxy\` will now verify this measurement first.`);
        } else {
          console.log(`  ✗ not pinning: attestation must pass first.`);
        }
      }
      if (!r.valid || (expectRtmr3 && !r.pinned)) process.exitCode = 1;
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
  }
}
