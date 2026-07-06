# Blindfold — Changelog

> What shipped, when, and what changed. Format: dated sections, newest first.

---

## [Unreleased]

### Added
- **`packages/chatbot/`** — a rule-based chatbot for the Blindfold project.
  - 481 KB entries curated from the actual docs and source code.
  - Rule-based intent classifier (regex / phrase / keyword / exact).
  - Audience detection (user / developer / founder / enterprise / researcher) with shape-based heuristics and explicit override.
  - Entity extraction (providers, file paths, CLI commands, URLs, topics).
  - Audience-aware responder with founder / enterprise / researcher tail notes.
  - Optional LLM fallback (opt-in via env) with key-shaped-token scrubbing before sending.
  - CLI modes: `repl`, `ask`, `serve`, `audit`, `stats`, `extract`.
  - Plain `http` web server (no framework) + hand-crafted UI (terminal-aesthetic).
  - **Knowledge extraction pipeline** — `bin/extract-knowledge.ts` walks `docs/` and `src/`, calls the configured model for Q&A pairs per chunk, merges into the KB by intent with confidence-weighted dedup. Cache makes re-runs idempotent.
  - KB refreshed by `npm run chatbot -- extract`. Built fresh from 487 source chunks via the configured model (`MiniMax-M3` via `samagama.in/platform/proxy/v1`).
- **`CHATBOT.md`** — full chatbot documentation.
- **`KNOWLEDGE.md`** — KB schema, contributor workflow, extraction pipeline docs.
- **`ARCHITECTURE.md`** — system-wide architecture (proxy + contract + chatbot + dashboard).
- **`SECURITY.md`** — threat model + audit invariant + chatbot-specific security notes.
- **`ROADMAP.md`** — what shipped, what's next, what's deliberately not happening.

### Changed
- **`packages/blindfold/src/register.ts`** — the canonical audit-critial file is unchanged. The invariant holds: one file, one function, one binding, out of scope.
- **`packages/blindfold/src/providers.ts`** — unchanged. The provider registry still holds 12 first-class integrations across 6 industries.

### Security
- The chatbot does not introduce new plaintext paths. The LLM fallback holds the API key in one local binding for the duration of one `fetch()`, identical to `registerSecret`. Or — better — routes through the Blindfold proxy with the sentinel, so the chatbot's process only ever sees `__BLINDFOLD__`.
- The request is scrubbed of `sk-…`, `sk_live_…`, `AKIA…`, `ghp_…` before any LLM call.
- The response is parsed with a balanced-brace JSON extractor; no `eval`.

---

## [Earlier]

The project history before this changelog lives in:

- [`explain.md`](explain.md) — long-form explainer with running status.
- [`current_status.md`](current_status.md) — the living status file.
- [`docs/03-architecture.md`](docs/03-architecture.md) — the original architecture doc.
- Git history.

Highlights of what shipped before this release:

- TDX + Rust + WASM contract with in-enclave substitution.
- TS SDK + CLI with `register` / `use` / `proxy` / `publish` / `doctor` / `verify` / `migrate` / `rotate` / `rollback` / `grant` / `init` / `dashboard` / `compat` / `export`.
- 12 first-class providers across 6 industries: OpenAI, Anthropic, xAI/Grok, Groq, Gemini, Stripe, GitHub, SendGrid, Slack, Twilio, AWS SES, AWS S3.
- Three in-enclave auth schemes: bearer, basic (Twilio), sigv4 (AWS).
- Side-by-side attack demo (`demo/`).
- Mock mode (`BLINDFOLD_MOCK=1`) for CI and onboarding.
- Live proof: `scripts/test-enclave-egress.ts` demonstrates a real GitHub call made from inside the TDX enclave, with the plaintext token never crossing the boundary.
- Runnable examples in `examples/` for every supported provider.

---

## See also

- [`ROADMAP.md`](ROADMAP.md) — what's next
- [`SECURITY.md`](SECURITY.md) — security model and audit checklist
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to add to this changelog