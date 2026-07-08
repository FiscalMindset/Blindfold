# Knowledge Base

> **What's new (v0.2 / v0.3 + webhook):** installable global CLI (`npm i -g`, runs from any directory, state in `~/.blindfold`); `blindfold login` stores the tenant key in the **OS keychain** (not a plaintext file); Discord webhook support (release path + `/discord` proxy provider, contract v0.5.5). See `CHANGELOG.md`.


> The structured Q&A that powers the Blindfold chatbot. This doc covers the schema, the contributor workflow, the extraction pipeline, and the refresh policy.

The KB lives at `packages/chatbot/data/knowledge.json`. It is loaded by `packages/chatbot/src/knowledge.ts`, indexed by intent, and queried by `findByIntent` and `findByQuestionMatch`. The format is **deliberately boring JSON** so that:

- any contributor can edit it by hand;
- any LLM (or the extraction pipeline) can extend it;
- a security reviewer can `jq` over it without surprises.

---

## 1. Schema

```ts
interface KnowledgeBase {
  schemaVersion: "1.0.0";
  generatedAt: string;   // ISO date the file was last touched
  source: string;        // free-text provenance
  entries: KnowledgeEntry[];
}

interface KnowledgeEntry {
  id: string;            // "kb-001", "kb-extracted-471dbdc9", …
  intent: string;        // matches an intent in src/intents.ts
  audience: Audience[];  // at least one; usually ['general'] plus 1–3 specific roles
  question: string;      // canonical question form
  shortAnswer: string;   // 1–3 sentences
  longAnswer: string;    // markdown body, may include code blocks
  codeSnippets?: string[];       // runnable code blocks (verbatim)
  links?: Array<{ label: string; url: string; type: "doc" | "code" | "external" }>;
  sources?: string[];            // file paths the entry was sourced from
  confidence: number;            // 0..1 — 1.0 for hand-curated, lower for extracted
  lastVerified: string;          // ISO date
}

type Audience = "user" | "developer" | "founder" | "enterprise" | "researcher" | "general";
```

### Field-by-field

- **`id`** — `kb-NNN` for hand-curated entries, `kb-extracted-<hash8>` for entries produced by the extractor. The hash is the chunk content hash, not a UUID.
- **`intent`** — must match an intent in `packages/chatbot/src/intents.ts`. If it doesn't, the classifier will never route to it. Adding a new intent is a one-file edit (see [`CHATBOT.md`](CHATBOT.md) §4).
- **`audience`** — at least one. The engine prefers entries whose `audience` includes the detected/pinned audience. `["general"]` is the safe default.
- **`question`** — the canonical form. Used as the chat-side label, the audit endpoint label, and the history item. Keep it as a natural question (ends with `?`).
- **`shortAnswer`** — the line shown in topic lists and the audit endpoint. 1–3 sentences.
- **`longAnswer`** — markdown body. May include H2/H3 headers, lists, tables, code blocks, blockquotes. The responder renders it as-is.
- **`codeSnippets`** — optional. Each entry is rendered as its own code block at the bottom. Use these for the truly runnable examples; inline `\`code\`` is for identifiers.
- **`links`** — optional. Rendered as a "Sources" section. Type is one of `doc`, `code`, `external`.
- **`sources`** — the file paths the entry was sourced from. This is **provenance**, not a UI element. Always populated, even on hand-curated entries.
- **`confidence`** — 0..1. Hand-curated entries default to `1.0`. Extracted entries start at the model's reported confidence (clamped 0..1) and can be bumped by a curator after review.
- **`lastVerified`** — ISO date. Updated when an editor touches the entry.

---

## 2. How the KB is queried

### By intent (primary)

```ts
const entries = findByIntent(kb, "what_is_sentinel");
```

The classifier picks the top intent. The engine then:

1. Filters entries by intent.
2. Prefers entries whose `audience` includes the detected/pinned audience.
3. Falls back to the first matching entry.

### By question-token overlap (secondary)

```ts
const top5 = findByQuestionMatch(kb, "How is Blindfold different from Vault?", 5);
```

Used when the rule-based classification produces no match (or a low-confidence one). The scoring is:

```
score(entry) = Σ_{token in input} (
  2 if token in entry.question
  1 if token in entry.shortAnswer + entry.longAnswer
  3 if entry.intent contains token
) × entry.confidence
```

This is a deliberately cheap overlap. The top-1 by score is used as the fallback answer; the top-3 are passed to the LLM fallback as grounding context.

---

## 3. Contributing

### Add a hand-curated entry

1. Decide the **intent**. If it doesn't exist yet, add it to `packages/chatbot/src/intents.ts`.
2. Decide the **audience(s)**. When in doubt, start with `["general"]` and refine later.
3. Open `packages/chatbot/data/knowledge.json` and add an entry. Find the highest existing `kb-NNN` and increment.
4. Cite sources. The `sources` field is the audit trail.
5. Run `npx tsx packages/chatbot/bin/chatbot.ts audit` to verify it shows up.
6. Run `npx tsx packages/chatbot/bin/chatbot.ts ask "<the canonical question>"` to verify it answers.

### Add a new intent

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

Then add a KB entry with `intent: "how_to_install"`. Done — no engine restart, no rebuild.

### Refresh from docs and code

```bash
# Mock (offline / CI)
BLINDFOLD_MOCK=1 npx tsx packages/chatbot/bin/extract-knowledge.ts

# Real — uses BLINDFOLD_CHATBOT_API_KEY (or sentinel via Blindfold proxy)
BLINDFOLD_CHATBOT_API_KEY=__BLINDFOLD__ \
BLINDFOLD_CHATBOT_BASE_URL=http://127.0.0.1:8787/v1 \
BLINDFOLD_CHATBOT_MODEL=gpt-4o-mini \
  npx tsx packages/chatbot/bin/extract-knowledge.ts
```

The extractor walks the configured paths (see [`packages/chatbot/bin/extract-knowledge.ts`](packages/chatbot/bin/extract-knowledge.ts)):

| Source | Path |
|---|---|
| Docs | `README.md`, `FAQ.md`, `usage.md`, `EXAMPLES.md`, `CONTRIBUTING.md`, `TEAMS.md`, `integration-stack.md`, `docs/*.md` |
| Code (TS) | `packages/blindfold/src/*.ts`, `packages/blindfold/bin/*.ts`, `scripts/*.ts` |
| Code (Rust) | `contract/src/*.rs` |

For each chunk, the extractor calls the configured model with a strict-JSON prompt, parses the response (with balanced-brace JSON extraction and `<think>` block stripping), and merges into the KB by intent with confidence-weighted dedup. Re-runs are idempotent — the cache (`data/.extract-cache.json`) keys on chunk content hash.

### Reviewing extracted entries

Extracted entries arrive with `confidence < 1.0`. Review workflow:

1. Run the extractor.
2. Open `data/knowledge.json` and sort by `confidence` ascending.
3. For each low-confidence entry, decide: keep (with edits), keep as-is, or delete.
4. Bump confidence to `1.0` after manual review.
5. Commit with a clear changelog entry.

---

## 4. Quality bar

Every entry should pass this checklist before merge:

- [ ] **Intent exists** in `src/intents.ts`.
- [ ] **Question is natural** — reads as something a user would actually ask.
- [ ] **Short answer is 1–3 sentences** and stands on its own.
- [ ] **Long answer is markdown** with structure (H2/H3, lists, tables where useful).
- [ ] **No invented APIs, commands, env vars, or file paths.** Cross-check against the actual source.
- [ ] **No verbatim key values.** Any key-shaped token is `__BLINDFOLD__`.
- [ ] **Sources cited.** Every claim traces back to a file in the repo or an external doc.
- [ ] **Confidence assigned.** `1.0` for hand-curated; whatever the model reports (clamped 0..1) for extracted.
- [ ] **Audience is honest.** If the entry is deep TDX mechanics, audience should be `["researcher", "developer"]`, not `["user", "general"]`.

---

## 5. Stats

```bash
# Total / per-intent counts
npx tsx packages/chatbot/bin/chatbot.ts audit

# Engine stats (per-session)
npx tsx packages/chatbot/bin/chatbot.ts stats

# Live counts (when the server is up)
curl http://127.0.0.1:8788/api/audit | jq '.count'
curl http://127.0.0.1:8788/api/stats
```

Current snapshot (re-runs change this):

| Metric | Value |
|---|---|
| KB entries | ~481 |
| Intents | 70+ |
| Confidence ≥ 0.9 | majority (hand-curated) |
| Confidence < 0.7 | extracted, awaiting review |

---

## 6. Refresh policy

The KB is intended to be **continuously updated**, not versioned-and-frozen. The CI step is:

```bash
BLINDFOLD_MOCK=1 npx tsx packages/chatbot/bin/extract-knowledge.ts
npx tsx packages/chatbot/bin/chatbot.ts audit | wc -l   # expect non-zero
```

A PR that touches a doc or a code file is expected to refresh the KB. The reviewer's job is to:

1. Verify the new entries match the diff.
2. Verify confidence is honest.
3. Verify sources are cited.

---

## 7. See also

- [`CHATBOT.md`](CHATBOT.md) — chatbot pipeline, intents, audiences
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system architecture
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — full contribution flow
- [`SECURITY.md`](SECURITY.md) — security model for the chatbot's LLM fallback
- `packages/chatbot/data/knowledge.json` — the file itself
- `packages/chatbot/src/intents.ts` — the intent pattern table