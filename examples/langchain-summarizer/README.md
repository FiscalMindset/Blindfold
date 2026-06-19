# LangChain summarizer (Node)

A small LangChain agent that fetches a webpage and summarizes it.

It also serves an "evil" page (with a prompt-injection that tries to exfiltrate the OpenAI API key) — when run with Blindfold, the injection only leaks the sentinel; when run without, it leaks the real key.

```bash
cd examples/langchain-summarizer
npm install
npm start
```

The Blindfold integration is a single object on line ~15 of `summarize.ts`:

```ts
const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: "__BLINDFOLD__",
  configuration: { baseURL: "http://127.0.0.1:8787/v1" },
});
```

That's it. The rest of the agent code is stock LangChain.
