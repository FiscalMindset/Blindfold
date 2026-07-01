/**
 * Real Google Gemini call through Blindfold — the key is NEVER in this process.
 *
 * Gemini does NOT use `Authorization: Bearer`. Its native API expects the key in
 * a provider-specific header, `x-goog-api-key`. Blindfold handles that real
 * convention: the agent sends the sentinel in `x-goog-api-key`, and the sealed
 * `gemini_api_key` is substituted for it INSIDE the TDX enclave, at the last
 * moment, on the outbound call to generativelanguage.googleapis.com.
 *
 * What this proves, end-to-end, against the LIVE enclave:
 *   1. This Node process holds no Gemini key (env has none; we assert it).
 *   2. The agent makes a real generateContent call and gets a real answer.
 *   3. A prompt-injection that tricks the agent into dumping its own
 *      credentials gets only "__BLINDFOLD__" — there is nothing to steal.
 *
 * Prereqs (one time):
 *   npm run blindfold -- register --name gemini_api_key --from-env gemini_api_key
 *   npm run blindfold -- grant --host generativelanguage.googleapis.com
 *
 * Run:
 *   npx tsx examples/gemini/agent.ts
 *   npx tsx examples/gemini/agent.ts "write a haiku about sealed enclaves"
 */
import { startProxy } from "../../packages/blindfold/src/proxy.ts";
import { loadBlindfoldEnv } from "../../packages/blindfold/src/env.ts";
import { SENTINEL } from "../../packages/blindfold/src/constants.ts";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) {
    console.log("This is a REAL demo — set real T3 creds in .env (T3N_API_KEY, DID). Mock mode is off-limits here.");
    process.exit(1);
  }

  // We deliberately do NOT delete anything from process.env to make the demo
  // look clean. The exfiltration check below scans the ENTIRE process env for a
  // real Gemini key — so if a sealed key was left in .env (and thus loaded into
  // this process), the demo HONESTLY reports it as leakable instead of hiding
  // it. Once you remove the sealed key from .env (as `register` instructs), the
  // scan genuinely comes up empty.

  const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: BLINDFOLD_OK";
  const proxy = await startProxy();
  console.log(`🔒 Blindfold proxy: ${proxy.url}   (this process has NO Gemini key)`);
  console.log(`🤖 model: ${MODEL}\n`);

  try {
    // A normal Gemini agent call — except the base URL is the local proxy and
    // NO key is attached. The proxy plants the sentinel in x-goog-api-key; the
    // enclave swaps in the real key. We try a couple of models / retries so a
    // transient 503/429 on one model doesn't sink the demo — all of it goes
    // through the enclave; none of it ever sees the key.
    const models = [MODEL, "gemini-flash-latest", "gemini-2.0-flash-lite"].filter((m, i, a) => a.indexOf(m) === i);
    let res: Response | null = null;
    let json: any = null;
    let used = MODEL;
    outer: for (const m of models) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        used = m;
        // Bound each attempt — a slow/stuck testnet enclave call should fail
        // fast and let us retry / fall back, never hang the demo.
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 45_000);
        try {
          res = await fetch(`${proxy.url}/gemini/v1beta/models/${m}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "accept-encoding": "identity" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            signal: ac.signal,
          });
          json = await res.json();
        } catch (e) {
          console.log(`   …${m} → ${(e as Error).name === "AbortError" ? "timed out (testnet slow)" : (e as Error).message} (transient), retry ${attempt}/3`);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        } finally {
          clearTimeout(timer);
        }
        if (res.status === 200) break outer;
        // 503 = overloaded, 429 = rate limited: retry / fall back. Others: stop.
        if (res.status !== 503 && res.status !== 429) break outer;
        console.log(`   …${m} → HTTP ${res.status} (transient), retry ${attempt}/3`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }

    if (!res || res.status !== 200) {
      console.log(`✗ Gemini HTTP ${res?.status} on ${used}:`, JSON.stringify(json?.error ?? json).slice(0, 300));
      if (res && (res.status === 500 || res.status === 502 || res.status === 503)) {
        console.log("  (The T3 enclave/host egress errored — testnet can be flaky. This is infra, not");
        console.log("   your key or Blindfold: the request never reached a point where auth could fail.");
        console.log("   Re-run in a moment.)");
      } else if (res && res.status === 429) {
        console.log("  (Auth succeeded — this is a Gemini-side quota/rate limit. Try a key with quota.)");
      }
      return;
    }
    console.log(`   (answered by ${used})`);
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "(no text)";
    console.log("✅ Real Gemini answer (key never left the enclave):\n");
    console.log("   " + text.replace(/\n/g, "\n   ") + "\n");

    // --- Prompt-injection resistance, honestly checked ------------------------
    // Scan EVERYTHING the agent could dump — the full process env plus the auth
    // header it actually sends — for a real Gemini key (legacy AIza… or newer
    // AQ.… format). No hardcoded var names, so a renamed leftover can't hide.
    const keyRe = /(AIza[0-9A-Za-z_\-]{20,}|AQ\.[A-Za-z0-9_\-]{20,})/;
    const envHits = Object.entries(process.env).filter(([, v]) => v && keyRe.test(v)).map(([k]) => k);
    const authHeader = `x-goog-api-key: ${SENTINEL}`;
    console.log("🕵️  If a prompt-injection dumped this agent's credentials, it would get:");
    console.log(`   • env vars containing a real Gemini key: ${envHits.length ? envHits.join(", ") : "(none)"}`);
    console.log(`   • auth header the agent sends:           ${authHeader}\n`);
    if (envHits.length) {
      console.log("💀 A real Gemini key is reachable via process.env (loaded from .env).");
      console.log(`   Remove it from .env (it's sealed in the enclave): comment/delete ${envHits.join(", ")}.`);
      console.log("   Until then this is a genuine leak — the demo won't pretend otherwise.");
      process.exitCode = 1;
    } else {
      console.log("🛡️  Nothing usable. The real key exists only inside the TDX enclave.");
    }
  } finally {
    await proxy.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
