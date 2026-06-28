/**
 * Loads runtime env vars. NEVER logs any value — only field names.
 *
 * .env is parsed with a minimal hand-rolled loader so we don't pull in
 * dotenv as a runtime dep. Lines are KEY=VALUE; surrounding quotes are
 * stripped; lines starting with # are comments.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlindfoldEnv } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = <repo>/packages/blindfold/src   →   3 ".." up to repo root
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** Absolute path to the project's .env file (repo root). */
export function defaultEnvPath(): string {
  return path.join(REPO_ROOT, ".env");
}

export function loadEnvFromFile(envPath = path.join(REPO_ROOT, ".env")): void {
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

export function loadBlindfoldEnv(): BlindfoldEnv {
  loadEnvFromFile();
  const t3nApiKey = process.env.T3N_API_KEY ?? "";
  const did = process.env.DID ?? "";
  const port = Number.parseInt(process.env.BLINDFOLD_PORT ?? "8787", 10);
  const t3EnvRaw = (process.env.BLINDFOLD_T3_ENV ?? "testnet").toLowerCase();
  const t3Env = t3EnvRaw === "production" ? "production" : "testnet";
  // MOCK is opt-in only — used by the standalone demo and CI tests. The
  // production path is REAL. If T3 creds are missing in REAL mode, callers
  // must surface a clear error (not silently fall back to mock).
  const mock = process.env.BLINDFOLD_MOCK === "1";
  return { t3nApiKey, did, port, t3Env, mock };
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
