/**
 * blindfold init — the zero-knowledge bootstrap wizard.
 *
 * Goal: a developer with no Rust or Terminal 3 knowledge can run one
 * command, answer a couple of prompts, and end up with a working
 * REAL-mode Blindfold setup.
 *
 * The wizard NEVER asks for a secret on the command line. Secrets are
 * always read from environment variables that the developer already
 * has in their .env. When a step fails, the wizard prints exactly what
 * went wrong and what to try next — no stack traces, no jargon.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv, pluckSecret } from "./env.ts";
import { openT3Client } from "./t3-client.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const WASM_PATH = path.join(REPO_ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");

/* ─── tiny styling helpers (no deps) ─────────────────────────────── */
const colour = process.stdout.isTTY ? (c: string, s: string) => `\x1b[${c}m${s}\x1b[0m` : (_: string, s: string) => s;
const bold = (s: string) => colour("1", s);
const green = (s: string) => colour("32", s);
const yellow = (s: string) => colour("33", s);
const red = (s: string) => colour("31", s);
const dim = (s: string) => colour("2", s);
const cyan = (s: string) => colour("36", s);

function header(n: number, total: number, title: string): void {
  process.stdout.write(`\n${dim(`[${n}/${total}]`)} ${bold(title)}\n`);
}
function ok(line: string): void { process.stdout.write(`  ${green("✓")} ${line}\n`); }
function info(line: string): void { process.stdout.write(`  ${dim("·")} ${line}\n`); }
function warn(line: string): void { process.stdout.write(`  ${yellow("!")} ${line}\n`); }
function fail(line: string, fixHint?: string): void {
  process.stdout.write(`  ${red("✖")} ${line}\n`);
  if (fixHint) process.stdout.write(`    ${dim("→")} ${cyan(fixHint)}\n`);
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const o: Buffer[] = [];
    const e: Buffer[] = [];
    child.stdout.on("data", (c) => o.push(c));
    child.stderr.on("data", (c) => e.push(c));
    child.on("close", (code) => resolve({ code: code ?? -1, out: Buffer.concat(o).toString("utf8"), err: Buffer.concat(e).toString("utf8") }));
    child.on("error", (err) => resolve({ code: -1, out: "", err: err.message }));
  });
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

export interface InitOpts {
  skipBuild?: boolean;
  skipPublish?: boolean;
  /** If set, seed this secret after publish. Format: "<KV_KEY>:<ENV_VAR>". Can pass multiple. */
  seed?: string[];
  /** Non-interactive — fail rather than ask. */
  yes?: boolean;
}

export async function runInit(opts: InitOpts = {}): Promise<void> {
  const total = 5;
  process.stdout.write(`\n${bold("🛡️  Blindfold — first-time setup")}\n${dim("This wizard sets up REAL T3 mode end-to-end. It never asks for a secret on screen — values come from your .env.")}\n`);

  /* 1. preflight */
  header(1, total, "Preflight");
  const env = loadBlindfoldEnv();
  if (env.mock) {
    fail("Blindfold is in MOCK mode — T3N_API_KEY or DID is missing.", "Edit .env and set both, then re-run `blindfold init`.");
    throw new Error("preflight failed");
  }
  ok(`T3 ${env.t3Env} · tenant ${dim(env.did)}`);

  const haveSdk = await isSdkInstalled();
  if (!haveSdk) {
    fail("@terminal3/t3n-sdk is not installed.", "Run: npm install @terminal3/t3n-sdk");
    throw new Error("sdk missing");
  }
  ok("@terminal3/t3n-sdk present");

  if (!opts.skipBuild) {
    const cargo = await run("which", ["cargo"]);
    if (cargo.code !== 0) {
      fail("cargo (Rust toolchain) not found.", "Install rust: https://rustup.rs  ·  then re-run `blindfold init`");
      throw new Error("cargo missing");
    }
    const targets = await run("rustup", ["target", "list", "--installed"]);
    if (!targets.out.includes("wasm32-wasip2")) {
      info("Installing wasm32-wasip2 target …");
      const add = await run("rustup", ["target", "add", "wasm32-wasip2"]);
      if (add.code !== 0) {
        fail("Could not install wasm32-wasip2.", "Run manually: rustup target add wasm32-wasip2");
        throw new Error("wasm target missing");
      }
    }
    ok("Rust toolchain + wasm32-wasip2 target ready");
  }

  /* 2. build contract */
  if (!opts.skipBuild) {
    header(2, total, "Build contract  (Rust → WASM)");
    info("cargo build --target wasm32-wasip2 --release");
    const build = await run("cargo", ["build", "--target", "wasm32-wasip2", "--release"], {
      cwd: path.join(REPO_ROOT, "contract"),
    });
    if (build.code !== 0) {
      fail("Contract build failed.", `Inspect: cd contract && cargo build --target wasm32-wasip2 --release\nstderr tail:\n${build.err.slice(-800)}`);
      throw new Error("contract build failed");
    }
    if (!existsSync(WASM_PATH)) {
      fail(`Build succeeded but artifact missing at ${WASM_PATH}.`, "Did the package name change?");
      throw new Error("artifact missing");
    }
    const wasmBytes = readFileSync(WASM_PATH);
    ok(`Built ${WASM_PATH} (${wasmBytes.byteLength.toLocaleString()} bytes)`);
  } else {
    header(2, total, "Build contract  (skipped)");
    info("Skipping --skip-build was passed.");
  }

  /* 3. authenticate */
  header(3, total, "Authenticate to T3");
  let t3;
  try {
    t3 = await openT3Client(env);
    if (!t3.isReal) throw new Error("Mock client returned — env probably misconfigured.");
    ok("Handshake + authenticate succeeded ✨");
  } catch (e) {
    fail("Could not connect to T3.", `Error: ${(e as Error).message}\nCheck your T3N_API_KEY + DID match a real T3 account (testnet / production matches BLINDFOLD_T3_ENV).`);
    throw e;
  }

  /* 4. publish contract */
  if (!opts.skipPublish) {
    header(4, total, "Publish the wrapper contract to your tenant");
    try {
      const wasm = readFileSync(WASM_PATH);
      const r = await t3.registerContract(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
      ok(`Published "blindfold-proxy" v0.1.0  ·  contract_id=${r.contractId}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/version.*not higher/i.test(msg)) {
        warn(`Already published at v0.1.0 — skipping. (${msg})`);
      } else {
        fail("Publish failed.", `Error: ${msg}\nIf this is a "tenant suspended" error, contact T3 support. Otherwise, retry with --skip-build to avoid rebuilding.`);
        throw e;
      }
    }
  } else {
    header(4, total, "Publish (skipped)");
  }

  /* 5. seed secrets */
  header(5, total, "Seal a secret into the enclave");
  const toSeed = collectSeedPlan(opts);
  if (toSeed.length === 0) {
    info("No --seed given. Run later with:  blindfold register --name openai_api_key --from-env OPENAI_API_KEY");
  }
  for (const { name, fromEnv } of toSeed) {
    try {
      const value = pluckSecret(fromEnv);
      await t3.seedSecret(name, value);
      ok(`Sealed ${bold(name)} (read from ${fromEnv}, then dropped). You can now delete ${fromEnv} from .env.`);
    } catch (e) {
      fail(`Could not seal "${name}".`, `Error: ${(e as Error).message}\nMake sure ${fromEnv} is set in .env (it will be removed by you after sealing).`);
    }
  }

  await t3.close();

  process.stdout.write(`\n${green(bold("✓ All done."))}\n`);
  process.stdout.write(`${dim("Next steps:")}\n`);
  process.stdout.write(`  ${cyan("npm run blindfold -- proxy")}        ${dim("# leave this running")}\n`);
  process.stdout.write(`  ${cyan("npm run dashboard")}                 ${dim("# open http://127.0.0.1:8799 in a browser")}\n`);
  process.stdout.write(`  ${dim("Then point your agent at:")}  ${cyan("OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=__BLINDFOLD__")}\n`);
}

function collectSeedPlan(opts: InitOpts): Array<{ name: string; fromEnv: string }> {
  const seeds = opts.seed ?? [];
  return seeds
    .map((s) => {
      const [name, fromEnv] = s.split(":");
      if (!name || !fromEnv) {
        warn(`Ignoring --seed "${s}" (expected KV_KEY:ENV_VAR, e.g. openai_api_key:OPENAI_API_KEY)`);
        return null;
      }
      return { name, fromEnv };
    })
    .filter((x): x is { name: string; fromEnv: string } => x !== null);
}

async function isSdkInstalled(): Promise<boolean> {
  try {
    await import("@terminal3/t3n-sdk");
    return true;
  } catch {
    return false;
  }
}

export async function runVerify(): Promise<void> {
  process.stdout.write(`\n${bold("🛡️  Blindfold — verify")}\n`);
  const env = loadBlindfoldEnv();
  info(`mode: ${env.mock ? red("MOCK") : green("REAL")}  ·  T3 env: ${env.t3Env}`);
  if (env.mock) {
    warn("MOCK mode — there's nothing to verify on the T3 side. Set T3N_API_KEY + DID.");
    return;
  }
  process.stdout.write(`  ${dim("·")} attempting handshake + authenticate against T3 …\n`);
  try {
    const t3 = await openT3Client(env);
    if (t3.isReal) ok("REAL T3 round-trip succeeded.");
    await t3.close();
  } catch (e) {
    fail("REAL T3 connection failed.", `Error: ${(e as Error).message}`);
    process.exitCode = 1;
  }

  // (Optional) write to a JSONL log under .blindfold/verify.jsonl so the
  // user can see verification history.
  try {
    const p = path.join(REPO_ROOT, ".blindfold", "verify.jsonl");
    const dir = path.dirname(p);
    if (!existsSync(dir)) require("node:fs").mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), mode: env.mock ? "mock" : "real", t3Env: env.t3Env, ok: !process.exitCode });
    writeFileSync(p, line + "\n", { flag: "a" });
  } catch {
    /* non-fatal */
  }
}
