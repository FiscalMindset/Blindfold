/**
 * blindfold init — the zero-knowledge bootstrap wizard.
 *
 * Goal: a developer with no Rust or Terminal 3 knowledge can run one
 * command, answer a couple of prompts, and end up with a working
 * REAL-mode Blindfold setup.
 *
 * The wizard NEVER asks for an API-style secret on the command line
 * (the T3N_API_KEY for the T3 account itself is a one-off bootstrap
 * value and is written to .env). When a step fails, the wizard prints
 * exactly what went wrong and what to try next.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadBlindfoldEnv, loadEnvFromFile, pluckSecret } from "./env.ts";
import { recordSealed } from "./sealed-ledger.ts";
import { openT3Client } from "./t3-client.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");
const WASM_PATH = path.join(REPO_ROOT, "contract", "target", "wasm32-wasip2", "release", "blindfold_proxy.wasm");
const T3_CLAIM_URL = "https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens";

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
  if (fixHint) {
    for (const ln of fixHint.split("\n")) process.stdout.write(`    ${dim("→")} ${cyan(ln)}\n`);
  }
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
  /** Seed a secret. Format: "<KV_KEY>:<ENV_VAR>". May appear many times. */
  seed?: string[];
  /** Non-interactive — fail rather than ask. */
  yes?: boolean;
  /** After success, exec into `blindfold proxy` rather than just printing. */
  start?: boolean;
}

export async function runInit(opts: InitOpts = {}): Promise<void> {
  const total = 5;
  process.stdout.write(`\n${bold("🛡️  Blindfold — first-time setup")}\n${dim("This wizard sets up REAL T3 mode end-to-end. Secrets are read from your .env, never typed onto the command line.")}\n`);

  /* ── Step 1: preflight (with interactive .env bootstrap) ──────── */
  header(1, total, "Preflight");

  // 1a. Ensure .env exists with T3 credentials.
  await ensureEnvOrPrompt(opts);
  // After this call, .env exists and we re-load it so loadBlindfoldEnv() sees fresh values.
  loadEnvFromFile(ENV_PATH);
  const env = loadBlindfoldEnv();
  if (!env.t3nApiKey || !env.did) {
    fail("Still missing T3N_API_KEY and/or DID after .env walkthrough.", "Open .env, paste the two values, and re-run `npm run setup`.");
    throw new Error("preflight failed");
  }
  ok(`T3 ${env.t3Env} · tenant ${dim(env.did)}`);

  // 1b. SDK present?
  const haveSdk = await isSdkInstalled();
  if (!haveSdk) {
    fail("@terminal3/t3n-sdk is not installed.", "Run: npm install @terminal3/t3n-sdk");
    throw new Error("sdk missing");
  }
  ok("@terminal3/t3n-sdk present");

  // 1c. Rust + wasm32-wasip2 (only if we plan to build).
  let canBuild = !opts.skipBuild;
  if (canBuild) {
    const cargo = await run("which", ["cargo"]);
    if (cargo.code !== 0) {
      warn("cargo (Rust toolchain) not found — auto-skipping contract build.");
      info(`Install rust at https://rustup.rs and re-run \`blindfold init\` to build the contract locally.`);
      canBuild = false;
    } else {
      const targets = await run("rustup", ["target", "list", "--installed"]);
      if (!targets.out.includes("wasm32-wasip2")) {
        info("Installing wasm32-wasip2 target …");
        const add = await run("rustup", ["target", "add", "wasm32-wasip2"]);
        if (add.code !== 0) {
          warn("Could not install wasm32-wasip2 automatically; skipping contract build.");
          info("Run manually: rustup target add wasm32-wasip2");
          canBuild = false;
        }
      }
      if (canBuild) ok("Rust toolchain + wasm32-wasip2 target ready");
    }
  }

  /* ── Step 2: build contract ───────────────────────────────────── */
  if (canBuild) {
    header(2, total, "Build contract  (Rust → WASM)");
    info("cargo build --target wasm32-wasip2 --release");
    const build = await run("cargo", ["build", "--target", "wasm32-wasip2", "--release"], {
      cwd: path.join(REPO_ROOT, "contract"),
    });
    if (build.code !== 0) {
      fail("Contract build failed.", `Inspect with: cd contract && cargo build --target wasm32-wasip2 --release\nstderr tail:\n${build.err.slice(-800)}`);
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
  }

  /* ── Step 3: authenticate ─────────────────────────────────────── */
  header(3, total, "Authenticate to T3");
  let t3;
  try {
    t3 = await openT3Client(env);
    if (!t3.isReal) throw new Error("Mock client returned — env misconfigured.");
    ok("Handshake + authenticate succeeded ✨");
  } catch (e) {
    fail("Could not connect to T3.", `Error: ${(e as Error).message}\nCheck T3N_API_KEY + DID match a real T3 account (and BLINDFOLD_T3_ENV matches their environment).`);
    throw e;
  }

  /* ── Step 4: publish contract + grant ACLs ────────────────────── */
  // Ensure tenant scaffolding (claim, create secrets + authorised-hosts maps) — idempotent.
  await ensureTenantScaffolding(env);

  if (!opts.skipPublish && canBuild) {
    header(4, total, "Publish the wrapper contract + grant ACLs");
    try {
      const wasm = readFileSync(WASM_PATH);
      const r = await t3.registerContract(new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength));
      const contractId = Number(r.contractId);
      ok(`Published "blindfold-proxy"  ·  contract_id=${contractId}`);
      await grantContractReads(env, contractId);
      ok(`Granted read access on z:tid:secrets to contract ${contractId}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/version.*not higher|already.*registered/i.test(msg)) {
        warn(`Already published at this version — skipping. (${msg.slice(0, 100)})`);
      } else {
        fail("Publish failed.", `Error: ${msg.slice(0, 300)}`);
        throw e;
      }
    }
  } else {
    header(4, total, opts.skipPublish ? "Publish (skipped: --skip-publish)" : "Publish (skipped: no contract built)");
  }

  /* ── Step 5: seed secrets ─────────────────────────────────────── */
  header(5, total, "Seal a secret into the enclave");
  const toSeed = collectSeedPlan(opts);
  if (toSeed.length === 0) {
    info("No --seed flag given.");
    info(`Later, after dropping an OPENAI_API_KEY into .env:  ${cyan("blindfold register --name openai_api_key --from-env OPENAI_API_KEY")}`);
  }
  for (const { name, fromEnv } of toSeed) {
    try {
      const value = pluckSecret(fromEnv);
      await t3.seedSecret(name, value);
      recordSealed({
        t: new Date().toISOString(),
        name,
        source: `env:${fromEnv}`,
        length: value.length,
        mode: env.mock ? "mock" : "real",
        tenant_did: env.did,
        map_name: `z:${env.did.replace(/^did:t3n:/, "")}:secrets`,
      });
      ok(`Sealed ${bold(name)} (read from ${fromEnv}, ${value.length} bytes, then dropped). You can DELETE ${fromEnv} from .env now.`);
    } catch (e) {
      fail(`Could not seal "${name}".`, `Error: ${(e as Error).message}\nMake sure ${fromEnv} is set in .env (you can delete it after sealing).`);
    }
  }

  await t3.close();

  /* ── Done — either auto-start or print copy-ready command ─────── */
  process.stdout.write(`\n${green(bold("✓ All done."))}\n`);

  if (opts.start) {
    process.stdout.write(`${dim("Starting the proxy now (Ctrl+C to stop) …")}\n`);
    // Exec into the proxy long-running command. We use spawn-with-stdio-inherited
    // so the dev sees its output directly and Ctrl+C reaches it.
    const proxy = spawn(process.execPath, [process.argv[1] ?? "", "proxy"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    proxy.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  process.stdout.write(`${dim("Next:")}\n`);
  process.stdout.write(`  ${cyan("npm run blindfold -- proxy")}        ${dim("# leave this running")}\n`);
  process.stdout.write(`  ${cyan("npm run dashboard")}                 ${dim("# open http://127.0.0.1:8799")}\n`);
  process.stdout.write(`  ${dim("Then point your agent at:")} ${cyan("OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=__BLINDFOLD__")}\n`);
  process.stdout.write(`${dim("Or re-run with")} ${cyan("--start")} ${dim("to launch the proxy automatically.")}\n`);
}

/* ─── helpers ─────────────────────────────────────────────────────── */

async function ensureEnvOrPrompt(opts: InitOpts): Promise<void> {
  loadEnvFromFile(ENV_PATH);
  const haveBoth = !!process.env.T3N_API_KEY && !!process.env.DID;
  if (haveBoth) return;

  // .env missing or incomplete. In --yes mode this is fatal; otherwise walk through.
  if (opts.yes) {
    fail(".env is missing T3N_API_KEY and/or DID.", `Claim them here: ${T3_CLAIM_URL}\nThen put them in .env and re-run.`);
    throw new Error("env missing");
  }

  if (!existsSync(ENV_PATH) && existsSync(ENV_EXAMPLE_PATH)) {
    const template = readFileSync(ENV_EXAMPLE_PATH, "utf8");
    writeFileSync(ENV_PATH, template);
    info("Created .env from .env.example.");
  }

  warn(".env is missing your T3 credentials.");
  info(`Claim them (free, takes 30 seconds): ${cyan(T3_CLAIM_URL)}`);
  const proceed = await ask(`  Paste them now? [Y/n] `);
  if (proceed.toLowerCase().startsWith("n")) {
    info("OK — open .env, paste both values, and re-run `npm run setup`.");
    process.exit(0);
  }

  const apiKey = await promptUntilMatches("  T3N_API_KEY  (0x… 32-byte hex): ", /^0x[0-9a-fA-F]{64}$/, "expected 0x followed by 64 hex chars");
  const did = await promptUntilMatches("  DID          (did:t3n:…):       ", /^did:t3n:[0-9a-fA-F]+$/, "expected did:t3n:<hex>");

  upsertEnvLines(ENV_PATH, { T3N_API_KEY: apiKey, DID: did });
  ok("Wrote .env (T3N_API_KEY + DID).");
  // Reload so the rest of the wizard sees the new values.
  loadEnvFromFile(ENV_PATH);
  process.env.T3N_API_KEY = apiKey;
  process.env.DID = did;
}

async function promptUntilMatches(prompt: string, re: RegExp, hint: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const v = await ask(prompt);
    if (re.test(v)) return v;
    warn(`That doesn't look right — ${hint}. Try again.`);
  }
  fail("Too many invalid attempts.", "Run the wizard again when you have the right values.");
  process.exit(1);
}

function upsertEnvLines(envPath: string, kv: Record<string, string>): void {
  let body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(body)) body = body.replace(re, `${k}=${v}`);
    else body += (body.endsWith("\n") || body === "" ? "" : "\n") + `${k}=${v}\n`;
  }
  writeFileSync(envPath, body);
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

/** Fresh-tenant scaffolding: claim, create secrets + authorised-hosts maps. Idempotent. */
async function ensureTenantScaffolding(env: ReturnType<typeof loadBlindfoldEnv>): Promise<void> {
  // Use raw SDK access since openT3Client doesn't expose maps/tenant.
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  for (const tail of ["secrets", "authorised-hosts"]) {
    try {
      await tenant.maps.create({ tail, visibility: "private", writers: "all" });
      info(`Created tenant map "${tail}"`);
    } catch {
      // Most often "map already exists" — fine.
    }
  }
}

async function grantContractReads(env: ReturnType<typeof loadBlindfoldEnv>, contractId: number): Promise<void> {
  const sdk = (await import("@terminal3/t3n-sdk")) as any;
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });
  await tenant.maps.update("secrets", { readers: { only: [contractId] } });
  try {
    await tenant.maps.update("authorised-hosts", { readers: { only: [contractId] } });
  } catch {
    /* optional */
  }
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

  try {
    const p = path.join(REPO_ROOT, ".blindfold", "verify.jsonl");
    mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), mode: env.mock ? "mock" : "real", t3Env: env.t3Env, ok: !process.exitCode });
    appendFileSync(p, line + "\n");
  } catch {
    /* non-fatal */
  }
}
