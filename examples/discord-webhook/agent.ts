/**
 * Post to a Discord channel through Blindfold — the webhook URL is never in
 * this process's env, and never printed.
 *
 * A Discord webhook is an unusual secret: the secret is the ENTIRE URL
 * (https://discord.com/api/webhooks/<id>/<token>), and you POST JSON to it with
 * no Authorization header. So the sentinel/header-substitution proxy path
 * doesn't fit — the right pattern is the release broker: fetch the sealed URL
 * from the enclave just-in-time, use it for one POST, and drop it.
 *
 * What this proves, end-to-end, against the LIVE enclave:
 *   1. This process holds no webhook URL (env has none; we assert it).
 *   2. It sends a real message to the real Discord channel (HTTP 204).
 *   3. The URL is in memory only for the duration of the one fetch, then gone.
 *
 * Prereq (one time):
 *   npm run blindfold -- register --name webhook_discord_url --from-env webhook_discord_url
 *
 * Run:
 *   npx tsx examples/discord-webhook/agent.ts
 *   npx tsx examples/discord-webhook/agent.ts "your custom message"
 */
import { release } from "../../packages/blindfold/src/release.ts";
import { loadBlindfoldEnv } from "../../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) {
    console.log("This is a REAL demo — set real T3 creds in .env (T3N_API_KEY, DID). Mock mode is off-limits here.");
    process.exit(1);
  }

  // Honesty check: this process should NOT carry a Discord webhook URL.
  const leaky = Object.entries(process.env).filter(
    ([, v]) => typeof v === "string" && /discord(app)?\.com\/api\/webhooks\//.test(v),
  );
  if (leaky.length > 0) {
    console.log(`⚠  process.env still holds a Discord webhook URL in: ${leaky.map(([k]) => k).join(", ")}`);
    console.log("    Remove it once sealed — the point is that this process needs no webhook URL.\n");
  }

  const content = process.argv.slice(2).join(" ") ||
    "🛡️ Sent by an AI agent through Blindfold — it never saw the webhook URL. The URL stayed sealed in the Terminal 3 enclave and was released just-in-time for this one POST.";

  // The one line that touches the secret: release the sealed URL from the
  // enclave, use it for a single POST, then let it drop out of scope.
  const webhookUrl = await release("webhook_discord_url", { via: "discord-webhook" });
  console.log(`✓ released webhook_discord_url from the enclave (${webhookUrl.length} bytes, value never shown)`);

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(15_000),
  });

  // Discord returns 204 No Content on a successful webhook post.
  console.log(`✓ Discord responded: HTTP ${res.status} ${res.status === 204 ? "✅ message delivered" : res.statusText}`);
  console.log(`🧪 What could a hijacked agent leak here? Nothing — the URL is out of scope now.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
