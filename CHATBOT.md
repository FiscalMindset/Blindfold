# Blindfold Chatbot — full documentation

> The rule-based Q&A system that lives at `packages/chatbot/`. Audience-aware, source-cited, MIT-licensed. See [`packages/chatbot/README.md`](packages/chatbot/README.md) for the quick start; this doc goes deeper.

---

## 1. Design principles

The chatbot was built against four non-negotiables from the parent project's [`CONTRIBUTING.md`](CONTRIBUTING.md):

| Principle | What it means here |
|---|---|
| **EASY to adopt** | One command to start the REPL; one command to start the server; one command to (re-)build the KB. No multi-step ritual, no API key required for the rule-based path. |
| **ZERO ADDED RISK** | The chatbot never holds a plaintext secret outside of the same single-function binding that the rest of Blindfold uses. The fallback LLM key is held in one local binding for the duration of one HTTP call, or — better — routed through the Blindfold proxy with the sentinel. |
| **No fake knowledge** | Every answer cites the file / doc it came from. If the rule-based engine can't find a confident match, it says so plainly (or, with the user's explicit opt-in, falls back to a single LLM call that's also grounded in the KB). |
| **No AI-generated UI** | The web UI is hand-crafted. Dark, dense, terminal-aesthetic. No purple gradients, no rounded chat bubbles, no auto-typing indicators pretending to be a person. |

These principles show up as code:

- [`packages/chatbot/src/responder.ts`](packages/chatbot/src/responder.ts) always includes `### Sources` and (when applicable) `related` suggestions.
- [`packages/chatbot/src/llm-fallback.ts`](packages/chatbot/src/llm-fallback.ts) re-scrubs the request for any key-shaped tokens before sending.
- [`packages/chatbot/src/public/assets/styles.css`](packages/chatbot/src/public/assets/styles.css) — see the comment at the top.

---

## 2. The pipeline, in detail

```
                              ┌─────────────────────────────────┐
                              │  ChatRequest                     │
                              │   - message                      │
                              │   - audience?                   │
                              │   - history?                    │
                              └────────────┬────────────────────┘
                                           │
                                           ▼
                ┌──────────────────────────────────────────────────────┐
                │  normalize (lowercase, smart-quotes, whitespace)       │
                └────────────┬─────────────────────────────────────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
   ┌────────────────────────┐    ┌────────────────────────┐
   │ classify(input,         │    │ detectAudience(...)     │
   │   INTENT_PATTERNS)      │    │   user / dev / founder  │
   │   4 pattern types:      │    │   / enterprise /        │
   │     regex | phrase |     │    │   researcher / general  │
   │     keyword | exact      │    │                         │
   │   weighted sum           │    │                         │
   └─────────────┬─────────────┘    └────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────────────────────┐
   │ extractEntities(input)                                │
   │   providers[] secrets[] files[] urls[] commands[]     │
   │   topics[]                                            │
   └─────────────┬────────────────────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────────────────────┐
   │ KB lookup                                             │
   │   1. findByIntent(kb, intent) → audience-filtered     │
   │   2. findByQuestionMatch(kb, input, top-5)           │
   │      (token overlap × entry.confidence)              │
   └─────────────┬────────────────────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────────────────────┐
   │ confidence =                                          │
   │   0.5 × pattern_score + 0.4 × KB.confidence           │
   │   + 0.1 (audience matches)                            │
   │                                                      │
   │   if confidence ≥ 0.45 → KB answer                   │
   │   elif enableLLMFallback → LLM call (scrubbed)        │
   │   else → honest "I don't have a confident answer"     │
   └─────────────┬────────────────────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────────────────────┐
   │ buildResponse(entry, audience, …)                     │
   │   - header: question + shortAnswer                    │
   │   - longAnswer (verbatim from KB)                     │
   │   - codeSnippets (verbatim)                           │
   │   - sources footer                                    │
   │   - audience-tail note                                │
   └─────────────┬────────────────────────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────────────────────────┐
   │ ChatResponse                                          │
   │   message, intent, audience, confidence,              │
   │   sources, related, usedFallback, debug               │
   └──────────────────────────────────────────────────────┘
```

Every step is **deterministic** given the same input. There is no temperature anywhere in the rule-based path. The optional LLM fallback is the only non-deterministic step, and it returns `usedFallback: true` so callers can downgrade its weight in their own logic.

---

## 3. Audiences

The chatbot is audience-aware end-to-end. Audiences are surfaced in three places:

1. The **`detectAudience` heuristic** (in `audiences.ts`) reads signals from the user's message:
   - **explicit** — `"I'm a founder"`, `"as a developer"` — highest precedence
   - **shape** — code-shaped phrasing defaults to `developer`; SOC-2-shaped phrasing to `enterprise`; investor-shaped phrasing to `founder`; TDX-paper phrasing to `researcher`
2. The **`audience` field in the KB entry** — every entry declares which audiences it serves.
3. The **responder tail note** — the same entry gets a different footer depending on audience (see [`responder.ts`](packages/chatbot/src/responder.ts) `audienceTail`).

| Role | Emphasises |
|---|---|
| `user` | what it is, why it matters, the one-line change |
| `developer` | code snippets, exact file paths, runnable commands |
| `founder` | positioning, market, pricing, moat vs incumbents |
| `enterprise` | trust model, audit checklist, compliance mapping |
| `researcher` | the TDX primitive, threat model, reproducible builds |
| `general` | the auto-detect fallback; audience-tail is omitted |

You can pin an audience:

```bash
# CLI
blindfold-chatbot ask "How does it work?" --audience enterprise

# REPL
❯ /audience founder

# Web UI — top-right select
# JSON API — { "message": "...", "audience": "developer" }
```

Pinning sticks for the REPL session; the API takes it per-request.

---

## 4. Intents

Intents are the unit of matching. Each intent is a set of weighted patterns over the normalized input. Adding a new intent is one file edit ([`intents.ts`](packages/chatbot/src/intents.ts)) — no other code changes.

Pattern types:

| Type | Use case | Example |
|---|---|---|
| `exact` | exact-string match | `"hi"` → greeting |
| `phrase` | substring match | `"how does blindfold work"` → how_does_it_work |
| `keyword` | word-boundary match | `anthropic` → provider_anthropic |
| `regex` | pattern match | `how do I register (a|my)? key` → how_to_register |

Pattern weights are summed across matches. The highest-scoring intent wins. Tie-breaks are deterministic (order in the array).

Adding a new intent:

```ts
// packages/chatbot/src/intents.ts
{
  intent: "how_to_install",
  patterns: [
    { type: "phrase", value: "how to install", weight: 5 },
    { type: "keyword", value: "install", weight: 2 },
  ],
  examples: ["how do I install blindfold?"],
},
```

Then add a KB entry with the same `intent` (`data/knowledge.json`). Done — no engine restart, no reindex.

---

## 5. The knowledge base

`packages/chatbot/data/knowledge.json` holds the structured Q&A. Each entry:

```ts
interface KnowledgeEntry {
  id: string;            // e.g. kb-001, kb-extracted-471dbdc9
  intent: Intent;        // matches an intent in INTENT_PATTERNS
  audience: Audience[];  // ['user', 'developer', ...] — at least one
  question: string;      // canonical question form
  shortAnswer: string;   // 1-3 sentences
  longAnswer: string;    // markdown, may include code blocks
  codeSnippets?: string[];  // runnable blocks (verbatim)
  links?: Array<{ label, url, type: 'doc'|'code'|'external' }>;
  sources?: string[];    // file paths the entry was sourced from
  confidence: number;    // 0..1
  lastVerified: string;  // ISO date
}
```

See [`KNOWLEDGE.md`](KNOWLEDGE.md) for the contributor workflow and the full schema.

### Stats (current build)

| Metric | Value |
|---|---|
| Total entries | ~481 (curated + extracted) |
| Intents | 70+ |
| Source files | 54 (docs + code) |
| Confidence floor (curated) | 1.0 |
| Confidence floor (extracted) | 0.5 |

### Refreshing

```bash
# Re-extract from docs + code, with the configured LLM
npx tsx packages/chatbot/bin/extract-knowledge.ts

# Or via the CLI wrapper
blindfold-chatbot extract
```

The extractor is **idempotent** — it caches by chunk-hash in `data/.extract-cache.json`. Re-running on the same source produces the same KB. The merge step keeps the highest-confidence entry per intent.

---

## 6. Web UI

Hand-crafted. See [`packages/chatbot/src/public/`](packages/chatbot/src/public/) for source.

Layout:

```
┌──────────────────────────────────────────────┬──────────────┐
│  header (title · audience picker · audit)    │              │
├──────────────────────────────────────────────┤              │
│                                              │              │
│  chat column                                 │  side panel  │
│  - messages (markdown, sources, related)     │  - topics    │
│  - composer (textarea + send button)         │  - history   │
│                                              │  - about     │
│                                              │              │
└──────────────────────────────────────────────┴──────────────┘
                                    ─ footer ─
                          floating quick-actions dock
```

Aesthetic choices that deliberately break the "AI chatbot" pattern:

- **No chat bubbles.** Each message is a labelled block (`user` / `assistant`) with a horizontal-rule separator.
- **Mono for chrome, sans for prose.** Terminal-style metadata, readable body.
- **Dark by default, light if the OS prefers.** No purple gradients.
- **Audience tags are colour-coded** but only as small inline labels, not background colors.
- **Quick-action dock** is a column of small monospace buttons in the bottom-right (hidden on mobile) — like CLI shortcuts, not a "try these prompts" carousel.
- **Sources and related** are always rendered below the message body. They are not collapsed / behind a click.

CSS lives at [`packages/chatbot/src/public/assets/styles.css`](packages/chatbot/src/public/assets/styles.css). JS is plain ES2022 with no framework — see [`packages/chatbot/src/public/assets/app.js`](packages/chatbot/src/public/assets/app.js).

---

## 7. LLM fallback

The rule-based engine is the **default** and **primary** path. The LLM fallback exists for the long tail of questions the KB doesn't cover.

Conditions for fallback:

1. **The user opted in.** `BLINDFOLD_CHATBOT_API_KEY` is set in the env (or `--enable-llm-fallback` flag, depending on the embedder).
2. **The rule-based confidence is below the threshold.** Default 0.45.
3. **The fallback call succeeds.** If the upstream errors, the engine returns the same "I don't have a confident answer" response.

What the fallback call does:

1. Takes the user's question + the top-3 KB entries by question-token overlap.
2. Sends to the configured model with a system prompt: *"Answer the question ONLY using information present in the KB entries. NEVER invent. NEVER paste keys."*
3. Strips `<think>` blocks from the response.
4. Splits off a trailing JSON citation block (`{ "citations": [...] }`).
5. Returns the text + the cited KB entry IDs.

Defensive measures:

- The request is scrubbed for `sk-…`, `sk_live_…`, `AKIA…`, `ghp_…` before sending.
- The response is parsed with a balanced-brace JSON extractor (no `eval`).
- `usedFallback: true` is set on the response so callers can prefer KB answers.
- The API key is held in one local binding for the duration of one `fetch()` call. If you want to go further, route the LLM call through the Blindfold proxy with the sentinel — the fallback then never holds the real key.

---

## 8. Embedding the chatbot

The engine is just a class:

```ts
import { ChatbotEngine } from "@blindfold/chatbot";

const engine = new ChatbotEngine({
  enableLLMFallback: !!process.env.OPENAI_API_KEY,
  llmApiKey: process.env.OPENAI_API_KEY,  // or "__BLINDFOLD__" + proxy baseUrl
  llmBaseUrl: process.env.OPENAI_BASE_URL,
  llmModel: "gpt-4o-mini",
});

const r = await engine.ask({ message: "What is the sentinel?" });
console.log(r.message);
```

You can also embed the HTTP server:

```ts
import { startServer } from "@blindfold/chatbot/server";

const server = await startServer({
  port: 8788,
  enableLLMFallback: true,
  llmApiKey: process.env.OPENAI_API_KEY,
});
// → http://127.0.0.1:8788
```

Or import individual pieces:

```ts
import { classify, detectAudience, extractEntities } from "@blindfold/chatbot";

const audience = detectAudience("I'm an enterprise — show me the audit checklist");
// → { audience: "enterprise", confidence: 0.95 }

const intents = classify("how does the proxy work?", INTENT_PATTERNS);
// → [{ intent: "how_does_it_work", score: 4, matchedPatterns: [...] }]
```

---

## 9. Performance

| Step | Typical cost |
|---|---|
| Normalize + tokenize | <1 ms |
| Classify (70 intents × ~6 patterns) | <1 ms |
| Detect audience | <1 ms |
| Extract entities | <1 ms |
| KB lookup | <2 ms (481 entries in memory) |
| Build response | <1 ms |
| **Total hot path** | **<10 ms** |
| LLM fallback (when triggered) | 1–3 s (network-bound) |

The web server is a single Node `http` instance with no external deps. It will easily handle thousands of QPS on commodity hardware.

---

## 10. Testing

```bash
# Smoke test (rule-based path)
npx tsx packages/chatbot/test-quick.mts    # see source for the question set

# With the full test battery (when implemented)
BLINDFOLD_MOCK=1 npm test --workspace=@blindfold/chatbot
```

---

## 11. Roadmap

See [`ROADMAP.md`](ROADMAP.md). Highlights:

- Streaming responses (Server-Sent Events) for the LLM fallback path
- Per-provider question routing (e.g. "Stripe + GitHub" in one query)
- Conversational memory across REPL turns with redaction
- Embeddable widget for non-Node environments

---

## 12. License

MIT — same as the parent Blindfold project. See [`LICENSE`](LICENSE).