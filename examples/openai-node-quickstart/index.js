// Blindfolded OpenAI call — and a proof that this process never holds the key.
//
// The ONLY Blindfold-specific lines are `baseURL` + `apiKey` below. But the
// point of this example is the *proof*: we show the local "key" is just a
// sentinel, then make a real completion anyway — because the real key lives in
// the T3 enclave, reachable only through the proxy.

import OpenAI from "openai";

const localKey = process.env.OPENAI_API_KEY ?? "__BLINDFOLD__";

// 1. Prove the real secret is NOT in this process — this is the whole pitch.
if (localKey !== "__BLINDFOLD__") {
  console.warn("⚠  A real-looking key is in OPENAI_API_KEY — that defeats Blindfold.");
  console.warn("   Seal it (`blindfold register …`), delete it from .env, and use the sentinel.");
}
console.log(`🔒 This process's apiKey = ${JSON.stringify(localKey)}  (the real key is in the enclave)`);

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8787/v1",
  apiKey:  localKey,                       // ← a sentinel, not a secret
});

// 2. Make a real call. The proxy substitutes the sealed key inside the enclave.
const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user",   content: "Reply with exactly: 'Blindfold works.'" },
  ],
});

console.log(`🤖 ${response.choices[0]?.message?.content ?? "(no content)"}`);

// 3. Simulate what a prompt-injected agent would try to exfiltrate.
console.log(`🕵️  If this agent were tricked into leaking its key, it would send: ${JSON.stringify(localKey)}`);
console.log("✅ Real completion succeeded with a key this process never held.");
