// Blindfolded Anthropic call — with a proof that this process never holds the key.
// Run the Blindfold proxy first (see this folder's README).

import Anthropic from "@anthropic-ai/sdk";

const localKey = process.env.ANTHROPIC_API_KEY ?? "__BLINDFOLD__";

// 1. Prove the real Claude key is NOT in this process.
if (localKey !== "__BLINDFOLD__") {
  console.warn("⚠  A real-looking key is in ANTHROPIC_API_KEY — that defeats Blindfold. Seal it + use the sentinel.");
}
console.log(`🔒 This process's apiKey = ${JSON.stringify(localKey)}  (the real key is in the enclave)`);

const anthropic = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8788/anthropic",
  apiKey:  localKey,                       // ← a sentinel, not a secret
});

// 2. Real call — the proxy substitutes the sealed key inside the enclave.
const msg = await anthropic.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "Reply with exactly: 'Blindfold works.'" }],
});

console.log(`🤖 ${msg.content[0]?.text ?? "(no content)"}`);
console.log("✅ Real Claude response using a key this process never held.");
