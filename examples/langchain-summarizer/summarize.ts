/**
 * LangChain summarizer — fetches a URL and asks GPT to summarize it, through
 * Blindfold. This process never holds the OpenAI key: it only carries the
 * `__BLINDFOLD__` sentinel, and the real key is substituted inside the enclave.
 *
 * The Blindfold integration is exactly the `apiKey` + `configuration.baseURL`
 * lines in the ChatOpenAI constructor. Strip them and you're back to a stock
 * LangChain agent.
 *
 * Usage:
 *   node --import tsx summarize.ts https://news.ycombinator.com
 */
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const target = process.argv[2] ?? "https://news.ycombinator.com";
const localKey = process.env.OPENAI_API_KEY ?? "__BLINDFOLD__";

// Prove the real key is NOT in this process — that's the whole point.
if (localKey !== "__BLINDFOLD__") {
  console.warn("⚠  A real-looking key is in OPENAI_API_KEY — that defeats Blindfold. Seal it + use the sentinel.");
}
console.log(`🔒 ChatOpenAI apiKey = ${JSON.stringify(localKey)}  (the real key is in the enclave)`);

const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: localKey,                       // ← a sentinel, not a secret
  configuration: {
    baseURL: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:8787/v1",
  },
});

const res = await fetch(target);
const html = await res.text();
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);

const reply = await llm.invoke([
  new SystemMessage("Summarize the page in 3 bullet points. Be terse."),
  new HumanMessage(`URL: ${target}\n\nPAGE TEXT:\n${text}`),
]);

console.log(`\n${reply.content}`);
console.log("\n✅ Summary produced with a key this process never held.");
