/**
 * Real xAI/Grok API call WITHOUT the API key being in this process's env.
 * The key lives only in T3's TDX enclave. `release()` fetches it just-in-time,
 * makes ONE outbound call, then the value drops out of scope.
 *
 *   npx tsx examples/grok-via-blindfold.ts                    # GET /v1/models
 *   npx tsx examples/grok-via-blindfold.ts "explain TDX in 2 sentences"
 *
 * SAFETY: the plaintext key (1) is fetched over T3's authenticated
 * tenant session (encrypted), (2) lives in this process for the duration
 * of one fetch call, (3) is never logged, never persisted, never echoed.
 */
import { release } from "../packages/blindfold/src/release.ts";
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) { console.log("Need REAL T3 creds in .env."); process.exit(1); }

  if (process.env.GROK_API_KEY || process.env.XAI_API_KEY) {
    console.log("⚠  process.env has GROK_API_KEY / XAI_API_KEY set.");
    console.log("    This script proves the key is NOT NEEDED in env — please unset/delete it,");
    console.log("    seal it via `npm run blindfold -- register --name grok_api_key`, then re-run.");
    process.exit(2);
  }

  // One line to get the key from the enclave — drop it as soon as the call completes.
  const grokKey = await release("grok_api_key");
  console.log(`✓ released grok_api_key from enclave (${grokKey.length} bytes)`);

  const prompt = process.argv[2] ?? "";
  const url = prompt ? "https://api.x.ai/v1/chat/completions" : "https://api.x.ai/v1/models";
  const init: RequestInit = prompt
    ? {
        method: "POST",
        headers: { Authorization: `Bearer ${grokKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "grok-2-latest", messages: [{ role: "user", content: prompt }] }),
      }
    : { headers: { Authorization: `Bearer ${grokKey}` } };

  try {
    const res = await fetch(url, init);
    console.log(`✓ xAI responded: HTTP ${res.status}`);
    const text = await res.text();
    if (prompt) {
      try {
        const json = JSON.parse(text);
        const msg = json.choices?.[0]?.message?.content;
        if (msg) console.log("\n" + msg + "\n");
        else console.log(text.slice(0, 800));
      } catch { console.log(text.slice(0, 800)); }
    } else {
      console.log("  (models endpoint)\n  " + text.slice(0, 600).replace(/\n/g, "\n  "));
    }
  } finally {
    /* grokKey out of scope */
  }
}

main().catch(e => { console.error(e); process.exit(1); });
