# LangChain summarizer (Node)

A small LangChain agent that fetches a webpage and summarizes it — through Blindfold, so **this process never holds the OpenAI key** (only the `__BLINDFOLD__` sentinel; the real key is substituted inside the enclave).

> Want the prompt-injection contrast (agent A leaks the key, agent B leaks only the sentinel)? That's the top-level `npm run demo` — this folder is the minimal LangChain integration.

## Prerequisites

- A real OpenAI API key (LangChain makes a genuine call to `api.openai.com`).
- A healthy T3 tenant — check with `npm run blindfold -- doctor`.

## Setup (one-time, from the repo root)

```bash
npm run blindfold -- init                                   # build + publish the contract + grant the secrets ACL
blindfold register --name openai_api_key --from-env OPENAI_API_KEY   # seal your key, then delete it from .env
blindfold grant --host api.openai.com                       # authorize the contract to call OpenAI  ← required
```

## Run it

```bash
npm run blindfold -- proxy            # terminal 1 — leave running → http://127.0.0.1:8787

cd examples/langchain-summarizer      # terminal 2
npm install
npm start                             # or: node --import tsx summarize.ts https://example.com
```

## Expected output

```
🔒 ChatOpenAI apiKey = "__BLINDFOLD__"  (the real key is in the enclave)

- <bullet 1>
- <bullet 2>
- <bullet 3>

✅ Summary produced with a key this process never held.
```

## What this proves

The Blindfold integration is two lines in the `ChatOpenAI({…})` constructor:

```ts
const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: "__BLINDFOLD__",                                  // sentinel, not a secret
  configuration: { baseURL: "http://127.0.0.1:8787/v1" },  // route through Blindfold
});
```

Everything else is stock LangChain. The agent fetches and summarizes a page while holding only the sentinel — a prompt-injection or leaked `.env` gets nothing, yet the summary is real because the request flows proxy → contract → in-enclave `http::call`, where the sealed key replaces the sentinel.

> No proxy/egress setup? `blindfold use --name openai_api_key -- node --import tsx summarize.ts` releases the key for one run with no publish/grant. See [../../EXAMPLES.md](../../EXAMPLES.md).
