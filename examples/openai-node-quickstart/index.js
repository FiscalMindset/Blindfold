// Smallest possible Blindfolded OpenAI call.
// The only Blindfold-specific lines are the two SDK options below.

import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8787/v1",
  apiKey:  process.env.OPENAI_API_KEY  ?? "__BLINDFOLD__",
});

const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are a concise assistant." },
    { role: "user",   content: "In one sentence, what is Terminal 3?" },
  ],
});

console.log(response.choices[0]?.message?.content ?? "(no content)");
