// Smallest possible Blindfolded Anthropic call.
// Run the Blindfold proxy first (see this folder's README).

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8788/anthropic",
  apiKey:  process.env.ANTHROPIC_API_KEY  ?? "__BLINDFOLD__",
});

const msg = await anthropic.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 256,
  messages: [
    { role: "user", content: "In one sentence, what is Terminal 3?" },
  ],
});

console.log(msg.content[0]?.text ?? "(no content)");
