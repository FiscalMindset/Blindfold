/**
 * Loads runtime env vars. NEVER logs any value — only field names.
 *
 * .env is parsed with a minimal hand-rolled loader so we don't pull in
 * dotenv as a runtime dep. Lines are KEY=VALUE; surrounding quotes are
 * stripped; lines starting with # are comments.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlindfoldEnv } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Source-relative fallback: HERE = <repo>/packages/blindfold/src → 3 ".." to root.
const SRC_RELATIVE_ROOT = path.resolve(HERE, "..", "..", "..");

let _repoRoot: string | null = null;
/**
 * Resolve the project root. Walks up from the current working directory looking
 * for a `.env` / `.blindfold` / `.git` marker so the tool works from a
 * subdirectory and when installed under `node_modules`; falls back to the
 * source-relative path for the in-repo layout.
 */
export function repoRoot(): string {
  if (_repoRoot) return _repoRoot;
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (
      fs.existsSync(path.join(dir, ".env")) ||
      fs.existsSync(path.join(dir, ".blindfold")) ||
      fs.existsSync(path.join(dir, ".git"))
    ) {
      _repoRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _repoRoot = SRC_RELATIVE_ROOT;
  return _repoRoot;
}

/** The product's home directory for state + config: ~/.blindfold (v0.2+). */
export function homeDir(): string {
  return path.join(os.homedir(), ".blindfold");
}

/** Absolute path to the user-level config file (tenant DID + settings). */
export function configPath(): string {
  return path.join(homeDir(), "config.json");
}

/**
 * Directory holding Blindfold's runtime state (ledger, usage log, egress cache,
 * config). As of v0.2 this defaults to ~/.blindfold so the tool is installable
 * and runs from any directory — independent of the repo checkout. On first run
 * it migrates a legacy in-repo `.blindfold/` (so existing grants/ledger carry
 * over). Overridable via BLINDFOLD_STATE_DIR.
 */
export function stateDir(): string {
  const override = process.env.BLINDFOLD_STATE_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  const home = homeDir();
  if (!fs.existsSync(home)) {
    // One-time migration from the old repo-anchored location, if present.
    try {
      const legacy = path.join(repoRoot(), ".blindfold");
      if (fs.existsSync(legacy) && fs.statSync(legacy).isDirectory()) {
        fs.cpSync(legacy, home, { recursive: true });
      } else {
        fs.mkdirSync(home, { recursive: true });
      }
    } catch {
      try { fs.mkdirSync(home, { recursive: true }); } catch { /* best effort */ }
    }
  }
  return home;
}

/**
 * Validate a user-supplied base-URL override. Requires https (localhost may use
 * http) so a mis-set env var can't route tenant-key auth / released secrets to
 * an attacker-controlled plaintext host. Throws on anything invalid.
 */
export function assertSafeOverrideUrl(raw: string, label: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${raw}`);
  }
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !isLocal) {
    throw new Error(`${label} must be https (got ${u.protocol}//${u.hostname}); refusing to trust an insecure endpoint`);
  }
}

/**
 * Run `fn` while holding an exclusive lock on `<target>.lock`, so concurrent
 * processes can't corrupt append-only state (ledger fork, egress-allowlist
 * clobber). Spins briefly; reclaims a lock older than 10s as stale.
 */
export async function withFileLock<T>(target: string, fn: () => T | Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + 10_000;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Acquire.
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // Stale-lock reclaim.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 10_000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* lock vanished; retry acquire */ }
      if (Date.now() > deadline) throw new Error(`timed out acquiring lock ${lockPath}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/** Synchronous variant of withFileLock, for code paths that must stay sync. */
export function withFileLockSync<T>(target: string, fn: () => T): T {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + 10_000;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const sleep = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* fallback: busy noop */ } };
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 10_000) { fs.rmSync(lockPath, { force: true }); continue; }
      } catch { /* lock vanished; retry */ }
      if (Date.now() > deadline) throw new Error(`timed out acquiring lock ${lockPath}`);
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

/** Absolute path to the project's .env file (repo root). */
export function defaultEnvPath(): string {
  return path.join(repoRoot(), ".env");
}

export function loadEnvFromFile(envPath = path.join(repoRoot(), ".env")): void {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Load user-level config from ~/.blindfold/config.json (and ~/.blindfold/.env),
 * filling any env vars not already set. This is the installed-product source of
 * creds — populated by `blindfold login` — so the CLI works with the repo `.env`
 * absent (e.g. run from any directory, or installed globally). Repo `.env` still
 * takes precedence when present (dev convenience).
 */
export function loadHomeConfig(): void {
  try {
    const cfg = configPath();
    if (fs.existsSync(cfg)) {
      const obj = JSON.parse(fs.readFileSync(cfg, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && process.env[k] === undefined) process.env[k] = v;
      }
    }
  } catch { /* malformed config must not crash the CLI */ }
  loadEnvFromFile(path.join(homeDir(), ".env"));
}

export function loadBlindfoldEnv(): BlindfoldEnv {
  loadEnvFromFile();      // repo .env (dev) — wins when present
  loadHomeConfig();       // ~/.blindfold/config.json (installed product) — fallback
  const t3nApiKey = process.env.T3N_API_KEY ?? "";
  const did = process.env.DID ?? "";
  const port = Number.parseInt(process.env.BLINDFOLD_PORT ?? "8787", 10);
  const t3EnvRaw = (process.env.BLINDFOLD_T3_ENV ?? "testnet").toLowerCase();
  const t3Env = t3EnvRaw === "production" ? "production" : "testnet";
  // Optional node-URL override — point at a healthy/leader node when the SDK's
  // default node is unhealthy (the failure mode behind days of phantom 500s).
  const t3BaseUrl = (process.env.T3_BASE_URL ?? process.env.BLINDFOLD_BASE_URL ?? "").trim();
  if (t3BaseUrl) {
    assertSafeOverrideUrl(t3BaseUrl, process.env.T3_BASE_URL ? "T3_BASE_URL" : "BLINDFOLD_BASE_URL");
  }
  // MOCK is opt-in only — used by the standalone demo and CI tests. The
  // production path is REAL. If T3 creds are missing in REAL mode, callers
  // must surface a clear error (not silently fall back to mock).
  const mock = process.env.BLINDFOLD_MOCK === "1";
  return { t3nApiKey, did, port, t3Env, t3BaseUrl, mock };
}

/** Throw a friendly error if REAL mode is requested but creds are missing. */
export function assertRealReady(env: BlindfoldEnv): void {
  if (env.mock) return;
  const missing: string[] = [];
  if (!env.t3nApiKey) missing.push("T3N_API_KEY");
  if (!env.did) missing.push("DID");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env: ${missing.join(", ")}. ` +
        `Claim them at https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens, ` +
        `then put them in .env. Or set BLINDFOLD_MOCK=1 to use mock mode for the demo only.`,
    );
  }
}

/** Pull a plaintext value out of env. Returns the value AND the env name
 *  it came from (so callers can produce errors without quoting the value). */
export function pluckSecret(envName: string): string {
  const v = process.env[envName];
  if (!v) {
    throw new Error(`environment variable ${envName} is unset or empty`);
  }
  return v;
}
