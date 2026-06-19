/**
 * LangChain summarizer — fetches a URL, asks GPT to summarize it.
 *
 * The Blindfold integration is exactly the `configuration: { baseURL }`
 * + `apiKey: "__BLINDFOLD__"` lines in the ChatOpenAI constructor. Strip
 * those two lines and you're back to a stock LangChain agent.
 *
 * Usage:
 *   node --import tsx summarize.ts https://news.ycombinator.com
 */
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const target = process.argv[2] ?? "https://news.ycombinator.com";

const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY ?? "__BLINDFOLD__",
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

console.log(reply.content);
