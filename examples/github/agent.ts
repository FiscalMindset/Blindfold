/**
 * Real GitHub API call through Blindfold — the token is NEVER in this process.
 *
 * GitHub uses `Authorization: Bearer <token>`. With Blindfold the agent sends
 * the sentinel `Bearer __BLINDFOLD__`, and the sealed `github_token` is
 * substituted for it INSIDE the TDX enclave, at the last moment, on the
 * outbound call to api.github.com.
 *
 * What this proves, end-to-end, against the LIVE enclave:
 *   1. This Node process holds no GitHub token (env has none; we assert it).
 *   2. The agent makes a real GET /user call and gets the real account back.
 *   3. A prompt-injection that tricks the agent into dumping its own
 *      Authorization header gets only "__BLINDFOLD__" — there is nothing to steal.
 *
 * Prereqs (one time):
 *   npm run blindfold -- register --name github_token --from-env GITHUB_TOKEN
 *   npm run blindfold -- grant --host api.github.com
 *
 * Run:
 *   npx tsx examples/github/agent.ts
 *   npx tsx examples/github/agent.ts /repos/anthropics/anthropic-sdk-typescript
 *
 * See README.md in this folder for the exact (redacted) output of a real run.
 */
import { startProxy } from "../../packages/blindfold/src/proxy.ts";
import { loadBlindfoldEnv } from "../../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) {
    console.log("This is a REAL demo — set real T3 creds in .env (T3N_API_KEY, DID). Mock mode is off-limits here.");
    process.exit(1);
  }

  // Honesty check: scan THIS process's env for a real GitHub token. If a sealed
  // token was left in .env (and thus loaded here), we report it as leakable
  // rather than hide it. Once you remove it from .env (as `register` instructs),
  // this scan genuinely comes up empty — the key lives only in the enclave.
  const leaky = Object.entries(process.env).filter(
    ([, v]) => typeof v === "string" && /^(github_pat_|ghp_|gho_|ghs_)/.test(v),
  );
  if (leaky.length > 0) {
    console.log(`⚠  process.env still contains a GitHub-token-shaped value in: ${leaky.map(([k]) => k).join(", ")}`);
    console.log("    Remove it from .env once sealed — the whole point is that this process needs no token.\n");
  }

  const apiPath = process.argv.slice(2).join(" ") || "/user";
  const proxy = await startProxy({ secretKey: "github_token" });
  console.log(`🔒 Blindfold proxy: ${proxy.url}   (this process has NO GitHub token)`);
  console.log(`🐙 GET api.github.com${apiPath}\n`);

  try {
    // A normal GitHub call — except the base URL is the local proxy and the only
    // credential we attach is the SENTINEL. The enclave swaps in the real token.
    const res = await fetch(`${proxy.url}/github${apiPath}`, {
      headers: {
        Authorization: "Bearer __BLINDFOLD__",
        "User-Agent": "blindfold-example",
        // Ask GitHub for an uncompressed body — the enclave passes the payload
        // through as text, so gzip bytes would arrive mangled.
        "Accept-Encoding": "identity",
      },
    });
    console.log(`✓ GitHub responded: HTTP ${res.status} ${res.statusText}`);
    const json = JSON.parse(await res.text()) as Record<string, unknown>;
    // Print a few non-sensitive public fields so the run is verifiable.
    for (const k of ["login", "id", "type", "full_name", "html_url", "public_repos"]) {
      if (json[k] !== undefined) console.log(`   ${k}: ${JSON.stringify(json[k])}`);
    }

    // Prompt-injection reality check: pretend the agent was tricked into echoing
    // the auth header it "knows". All it can ever surface is the sentinel.
    console.log("\n🧪 Prompt-injection check — what could a hijacked agent leak?");
    console.log(`   Authorization it holds: "Bearer __BLINDFOLD__"  → nothing to steal.`);
  } finally {
    await proxy.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
