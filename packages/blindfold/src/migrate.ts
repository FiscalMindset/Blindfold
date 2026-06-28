/**
 * `blindfold migrate` — one command to move a whole .env into the enclave.
 *
 * Scans .env, seals every recognized SECRET (skipping config + T3 root creds),
 * then rewrites .env to remove (or comment out) the sealed lines — with a backup.
 * After this, the agent's environment holds zero plaintext API keys.
 *
 * SECURITY: this module never logs a secret value. It only reads names from
 * .env and delegates the single plaintext touch to registerSecret (the one
 * audit-critical path). The .env rewrite operates on line text, not values.
 */
import fs from "node:fs";
import { defaultEnvPath, loadEnvFromFile } from "./env.ts";
import { registerSecret } from "./register.ts";

/** Vars that must NEVER be sealed (root creds / config the runtime needs). */
const NEVER_SEAL = new Set([
  "T3N_API_KEY", "DID",
  "BLINDFOLD_MOCK", "BLINDFOLD_PORT", "BLINDFOLD_T3_ENV", "BLINDFOLD_DASHBOARD_PORT", "BLINDFOLD_BASE_URL",
]);

/** Looks like config, not a secret (host/url/port/email/region/env). */
function isConfigName(k: string): boolean {
  return /(_HOST|_URL|_PORT|_EMAIL|_ENV|_REGION|_BASE_URL|_USER|_USERNAME)$/i.test(k)
    || /^(NODE_ENV|PORT|HOST|PATH|HOME|USER|SHELL|LANG|PWD)$/i.test(k);
}

/** Alternate T3 team keys/DIDs (t1_*, t2_*, …) — these are root creds, skip. */
function isAltT3(k: string): boolean {
  return /^t\d+_/i.test(k) || /_DID$/i.test(k);
}

/** Name indicates a credential worth sealing. */
function looksSecret(k: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|_API|API_|_PAT|CREDENTIAL|ACCESS|PRIVATE)/i.test(k);
}

export interface MigratePlanItem {
  envVar: string;
  sealName: string;
  bytes: number;
  action: "seal" | "skip";
  reason?: string;
}

/** Parse .env into ordered [key, rawLineIndex] without exposing values. */
function readEnvVars(envPath: string): { keys: string[]; lines: string[] } {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const keys: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    keys.push(line.slice(0, eq).trim());
  }
  return { keys, lines };
}

/** Build the migration plan: which vars get sealed, which are skipped and why. */
export function planMigration(envPath = defaultEnvPath()): MigratePlanItem[] {
  loadEnvFromFile(envPath); // populate process.env so we can read lengths
  const { keys } = readEnvVars(envPath);
  const seen = new Set<string>();
  const plan: MigratePlanItem[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    const val = process.env[k] ?? "";
    const base: MigratePlanItem = { envVar: k, sealName: k.toLowerCase(), bytes: val.length, action: "skip" };
    if (NEVER_SEAL.has(k)) plan.push({ ...base, reason: "root cred / config — must stay in .env" });
    else if (isAltT3(k)) plan.push({ ...base, reason: "T3 team key/DID — root cred" });
    else if (isConfigName(k)) plan.push({ ...base, reason: "config, not a secret" });
    else if (!val) plan.push({ ...base, reason: "empty" });
    else if (!looksSecret(k)) plan.push({ ...base, reason: "name doesn't look like a secret (seal manually if it is)" });
    else plan.push({ ...base, action: "seal" });
  }
  return plan;
}

export interface MigrateResult extends MigratePlanItem {
  sealed?: boolean;
  error?: string;
}

/**
 * Execute the plan: seal each "seal" item, then rewrite .env.
 * @param opts.keep  comment the line out (prefix `# sealed→enclave: `) instead of deleting it.
 */
export async function runMigrate(opts: { envPath?: string; keep?: boolean } = {}): Promise<MigrateResult[]> {
  const envPath = opts.envPath ?? defaultEnvPath();
  const plan = planMigration(envPath);
  const results: MigrateResult[] = [];
  const sealedVars = new Set<string>();

  for (const item of plan) {
    if (item.action !== "seal") { results.push(item); continue; }
    try {
      await registerSecret({ name: item.sealName, fromEnv: item.envVar });
      sealedVars.add(item.envVar);
      results.push({ ...item, sealed: true });
    } catch (e) {
      results.push({ ...item, sealed: false, error: (e as Error).message });
    }
  }

  // Rewrite .env (backup first) — drop/comment the successfully-sealed lines.
  if (sealedVars.size > 0) {
    const original = fs.readFileSync(envPath, "utf8");
    fs.writeFileSync(`${envPath}.bak.${Math.floor(Date.now() / 1000)}`, original);
    const out: string[] = [];
    for (const raw of original.split(/\r?\n/)) {
      const eq = raw.indexOf("=");
      const key = eq > 0 ? raw.slice(0, eq).trim() : "";
      if (key && sealedVars.has(key) && !raw.trim().startsWith("#")) {
        if (opts.keep) out.push(`# sealed→enclave: ${key}  (value lives in T3, use \`blindfold use --name ${key.toLowerCase()}\`)`);
        // else: drop the line entirely
      } else {
        out.push(raw);
      }
    }
    fs.writeFileSync(envPath, out.join("\n"));
  }

  return results;
}
