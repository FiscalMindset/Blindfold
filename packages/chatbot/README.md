# Blindfold Chatbot — `packages/chatbot`

> A **rule-based** chatbot that answers any question about [Blindfold](../README.md) — for users, founders, enterprise owners, developers, and researchers. Knowledge base is curated directly from the actual Blindfold documentation and source code; no fabrication, no hallucination.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│   user question                                               │
│       │                                                       │
│       ▼                                                       │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐      │
│   │  classifier  │ → │   entity     │ → │   audience   │      │
│   │ (regex/      │   │ (provider/   │   │ (user/dev/   │      │
│   │  keyword/    │   │  file/cmd/   │   │  founder/    │      │
│   │  phrase/     │   │  topic)      │   │  enterprise/ │      │
│   │  exact)      │   │              │   │  researcher) │      │
│   └──────┬───────┘   └──────────────┘   └──────────────┘      │
│          │                                                     │
│          ▼                                                     │
│   ┌──────────────────────────────────────────────────────┐    │
│   │     knowledge base lookup  (481 entries, MIT-LICENSED)│   │
│   │     — best intent match + audience-fit scoring        │    │
│   │     — confidence = pattern + KB confidence + audience │    │
│   └──────┬───────────────────────────────────────────────┘    │
│          │                                                     │
│          ▼                                                     │
│   ┌──────────────────────────────────────────────────────┐    │
│   │     responder (audience-aware markdown, cited sources) │    │
│   └──────┬───────────────────────────────────────────────┘    │
│          │                                                     │
│          ▼                                                     │
│   confidence ≥ 0.45  → answer (KB hit)                         │
│   confidence < 0.45  → optional LLM fallback (env opt-in)      │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## Why rule-based

The user wanted **no fake knowledge and no AI-generated UI**. That constraint maps to a rule-based engine with a curated knowledge base — deterministic, auditable, source-cited, audience-aware. An LLM is only used as a **last-resort fallback** (opt-in via env) when the rule-based confidence falls below a threshold; it never sees a plaintext API key — the key is held in a single local binding for the duration of one HTTP call, exactly like `register.ts`.

The chatbot is itself a Blindfold user: it can be configured to call a sealed API key via the same proxy/wrap pattern that protects every other AI agent.

## Quick start

```bash
# 1. Install (already done if you ran `npm install` at repo root)
npm install

# 2. Try it (no API key needed for KB-only mode)
npx tsx packages/chatbot/bin/chatbot.ts
# ┌─ Blindfold Chatbot ───────────────────────────────────────────┐
# │ Ask anything about Blindfold. Type /help for commands.       │
# └───────────────────────────────────────────────────────────────┘
# ❯ what is the sentinel?

# 3. Or run as a web server
npx tsx packages/chatbot/bin/chatbot.ts serve --port 8788 --cors
# → http://127.0.0.1:8788

# 4. Or single-shot from a script
npx tsx packages/chatbot/bin/chatbot.ts ask "How does the proxy work?"

# 5. Or with LLM fallback (uses API key from env, sealed if you like)
export BLINDFOLD_CHATBOT_API_KEY=__BLINDFOLD__      # if you've sealed it
export BLINDFOLD_CHATBOT_BASE_URL=http://127.0.0.1:8787/v1   # or use your proxy
export BLINDFOLD_CHATBOT_MODEL=gpt-4o-mini
npx tsx packages/chatbot/bin/chatbot.ts serve
```

## How it uses Blindfold itself

The chatbot is a perfect demo of Blindfold's pattern. To seal the LLM API key for the fallback path:

```bash
# 1. Seal it (one-time)
blindfold register --name chatbot_api_key --from-env BLINDFOLD_CHATBOT_API_KEY

# 2. Start the Blindfold proxy
blindfold proxy

# 3. Point the chatbot at the proxy + sealed name
export BLINDFOLD_CHATBOT_API_KEY=__BLINDFOLD__
export BLINDFOLD_CHATBOT_BASE_URL=http://127.0.0.1:8787/v1
export BLINDFOLD_CHATBOT_MODEL=gpt-4o-mini
npx tsx packages/chatbot/bin/chatbot.ts serve
# → The chatbot now makes LLM fallback calls through Blindfold.
#   The API key never enters the chatbot's process — only the sentinel does.
```

That's the whole loop closed. The chatbot talks about Blindfold while being protected by Blindfold.

## Architecture (30-second tour)

| File | Role |
|---|---|
| `src/engine.ts` | Orchestrator. Takes a `ChatRequest`, runs the pipeline, returns a `ChatResponse`. |
| `src/classifier.ts` | Rule-based intent classification. Regex / phrase / keyword / exact patterns, weighted. |
| `src/audiences.ts` | Detects user / developer / founder / enterprise / researcher. Pin via `--audience` or explicit "I'm a …". |
| `src/entities.ts` | Pulls provider names (openai, stripe, etc.), file paths, URLs, CLI commands. |
| `src/intents.ts` | Intent pattern table — add new intents here without touching the engine. |
| `src/knowledge.ts` | Loads `data/knowledge.json`, finds by intent or by question-token overlap. |
| `src/responder.ts` | Audience-aware markdown formatter. Adds a tail note specific to founder / enterprise / researcher. |
| `src/llm-fallback.ts` | Optional last-resort LLM call. Redacts any key-shaped tokens before sending. |
| `src/server.ts` | Plain `http` web server. Serves the UI + JSON API. No framework. |
| `src/public/*` | Hand-crafted UI — terminal aesthetic, no AI-generated look. |
| `bin/chatbot.ts` | CLI. Modes: `repl`, `ask`, `serve`, `audit`, `stats`, `extract`. |
| `bin/extract-knowledge.ts` | Walks the Blindfold repo, asks the configured model for Q&A pairs per chunk, merges into the KB. |
| `data/knowledge.json` | Curated KB. 481 entries. Refreshed by `npm run chatbot -- extract`. |

Full deep-dive → [`ARCHITECTURE.md`](../../ARCHITECTURE.md). KB schema → [`KNOWLEDGE.md`](../../KNOWLEDGE.md).

## API

### `POST /api/chat`

```bash
curl -X POST http://127.0.0.1:8788/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the sentinel?","audience":"developer"}'
```

```json
{
  "message": "## What is the sentinel? …",
  "intent": "what_is_sentinel",
  "audience": "developer",
  "confidence": 0.97,
  "sources": [
    { "label": "packages/blindfold/src/constants.ts", "url": "...", "type": "code" }
  ],
  "related": [
    { "intent": "what_is_canonical_copy", "question": "What is the 'canonical copy' of a secret?" }
  ],
  "usedFallback": false,
  "debug": {
    "matchedPatterns": ["phrase:what is the sentinel"],
    "extractedEntities": { "providers": "", "topics": "security" }
  }
}
```

### `GET /api/audit?q=…&audience=…`

```bash
curl http://127.0.0.1:8788/api/audit?q=proxy | jq '.entries | length'
```

### `GET /api/stats`

Returns engine stats: total queries, intent/audience histograms, fallback count, avg confidence, KB size.

### `GET /api/health`

`{ ok, kbSize, intents, uptime_ms }`.

## CLI

```bash
blindfold-chatbot                              # REPL
blindfold-chatbot ask '<message>'              # one question, markdown
blindfold-chatbot ask '<message>' --json       # one question, JSON
blindfold-chatbot ask '<message>' --audience enterprise
blindfold-chatbot serve [--port 8788] [--cors]
blindfold-chatbot audit [filter]               # list KB entries
blindfold-chatbot stats
blindfold-chatbot extract                      # re-run KB extraction
```

REPL slash commands: `/help`, `/audience <role>`, `/stats`, `/audit [filter]`, `/clear`, `/exit`.

## Knowledge extraction pipeline

The KB is built by `bin/extract-knowledge.ts` from two sources:

1. **Documentation** — `README.md`, `FAQ.md`, `usage.md`, `EXAMPLES.md`, `CONTRIBUTING.md`, `TEAMS.md`, `docs/*.md`
2. **Code** — `packages/blindfold/src/*.ts`, `packages/blindfold/bin/*.ts`, `contract/src/*.rs`, `scripts/*.ts`

For each chunk the extractor sends the content to the configured model with a strict-JSON prompt, parses the response, and merges into the KB by intent. Confidence-weighted dedup keeps the highest-quality answer per intent. Cache (`data/.extract-cache.json`) makes re-runs idempotent.

```bash
# Mock (offline / CI)
BLINDFOLD_MOCK=1 npx tsx packages/chatbot/bin/extract-knowledge.ts

# Real — uses BLINDFOLD_CHATBOT_API_KEY + BLINDFOLD_CHATBOT_BASE_URL
BLINDFOLD_CHATBOT_API_KEY=__BLINDFOLD__ \
BLINDFOLD_CHATBOT_BASE_URL=http://127.0.0.1:8787/v1 \
BLINDFOLD_CHATBOT_MODEL=gpt-4o-mini \
  npx tsx packages/chatbot/bin/extract-knowledge.ts

# Or via Blindfold CLI proxy (recommended for production)
export BLINDFOLD_CHATBOT_API_KEY=$(blindfold use --name chatbot_api_key --check 2>&1 | awk '{print $4}')
```

## Security

The chatbot follows the **two invariants** from `CONTRIBUTING.md`:

1. **EASY** — adoption is `npm install && npx tsx packages/chatbot/bin/chatbot.ts`. No multi-step ritual.
2. **ZERO ADDED RISK** — the chatbot never holds a plaintext API key outside of:
   - the env binding for the lifetime of one HTTP call (`llm-fallback.ts`), or
   - Blindfold's sealed path (when you configure it that way).

Before any LLM fallback call, the request is **scrubbed** of key-shaped tokens (`sk-…`, `sk_live_…`, `AKIA…`, `ghp_…`). The response is parsed with a balanced-brace JSON extractor that strips `<think>` blocks. The original request and response are not logged; the engine stats expose counts only.

If you enable the proxy + sentinel pattern for the fallback API key, the LLM call is the same shape as any other Blindfold-protected call: the chatbot holds `__BLINDFOLD__`, the enclave substitutes the real value, the chatbot's process never sees it.

## License

MIT — same as the parent Blindfold project. See [`LICENSE`](../../LICENSE).

## See also

- [`CHATBOT.md`](../../CHATBOT.md) — full chatbot docs (audiences, intents, KB)
- [`KNOWLEDGE.md`](../../KNOWLEDGE.md) — KB schema, contributor workflow
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — the system in context
- [`SECURITY.md`](../../SECURITY.md) — threat model
- [`ROADMAP.md`](../../ROADMAP.md) — what's next
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — how to add intents / KB entries / providers