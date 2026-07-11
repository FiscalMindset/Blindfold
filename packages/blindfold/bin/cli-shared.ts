/**
 * Shared CLI helpers used by the command modules (bin/cmd-*.ts) and the
 * dispatcher (bin/blindfold.ts). Kept in bin/ so the `../src/` import paths in
 * the command modules don't change.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const PKG_ROOT = path.resolve(HERE, ".."); // packages/blindfold (or the installed package root)

/** Resolve an asset needed by skill/publish: prefer the repo source (dev), else
 *  the copy bundled in the package's assets/ (standalone/global install). */
export function assetPath(repoRelative: string, assetName: string): string {
  const repoPath = path.join(REPO_ROOT, ...repoRelative.split("/"));
  if (fs.existsSync(repoPath)) return repoPath;
  return path.join(PKG_ROOT, "assets", assetName);
}

export type Argv = { _: string[]; flags: Record<string, string | boolean> };

export function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags[key] = next;
        i += 1;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Non-reversible fingerprint of a secret — for verification without exposure. */
export function fingerprint(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Known CLI tools → the env var they read their credential from. */
const TOOL_ENV: Record<string, string> = {
  gh: "GH_TOKEN", git: "GH_TOKEN", glab: "GITLAB_TOKEN",
  psql: "PGPASSWORD", pg_dump: "PGPASSWORD", mysql: "MYSQL_PWD",
  aws: "AWS_SECRET_ACCESS_KEY", stripe: "STRIPE_API_KEY",
  vercel: "VERCEL_TOKEN", npm: "NPM_TOKEN", docker: "DOCKER_PASSWORD",
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
  doctl: "DIGITALOCEAN_ACCESS_TOKEN", heroku: "HEROKU_API_KEY",
  cloudflared: "CLOUDFLARE_API_TOKEN", wrangler: "CLOUDFLARE_API_TOKEN",
};

/** Pick the env-var name for `use`: explicit --as, else infer from the tool, else NAME upper-cased. */
export function resolveEnvVar(asFlag: string | undefined, command: string | undefined, name: string): string {
  if (asFlag) return asFlag;
  if (command && TOOL_ENV[command]) return TOOL_ENV[command];
  return name.toUpperCase();
}

export function die(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(2);
}
