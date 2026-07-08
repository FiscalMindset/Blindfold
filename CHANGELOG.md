# Blindfold — Changelog

> What shipped, when, and what changed. Format: dated sections, newest first.

---

## [0.3.0] — Tenant key in the OS keychain

### Added
- `blindfold login` / `logout` / `whoami`. `login` stores the tenant key in the
  **OS keychain** (macOS `security` / Linux `secret-tool`); `config.json` keeps
  only the non-secret DID + settings.

### Security
- Closes the residual risk that a plaintext credentials file could be read by a
  prompt-injected agent — the tenant key is no longer a readable file.

## [0.2.0] — Installable, SSD-independent CLI

### Added
- Bundled CLI (`esbuild` → `dist/cli.mjs`); `npm i -g`-able, runs with plain
  `node` off the source drive.
- State + config moved to `~/.blindfold` (auto-migrated from the in-repo
  `.blindfold/`). Overridable via `BLINDFOLD_STATE_DIR`.
- Credentials via `blindfold login` (`~/.blindfold/config.json`), so the CLI
  works from any directory without a repo `.env`.

## [0.1.x] — Security/scale hardening + Discord webhook

### Added
- **Discord webhook support.** New `webhook` auth scheme in the contract
  (v0.5.5): the enclave substitutes the sealed URL *in the URL*. A `/discord`
  proxy provider + a release-path example (`examples/discord-webhook/`).
- **GitHub example** (`examples/github/`) with real, redacted runs.

### Fixed (security & scale audit)
- blindfold: HMAC-keyed tamper-evident ledger + file locking; 504 timeouts on
  enclave calls; dashboard tail + usage-log rotation; proxy body cap;
  egress-hosts lock+union; `rollback` fingerprint guard; removed the
  `readers:"all"` grant fallback; `migrate` backup written `0600`; `use --url`
  https guard.
- chatbot: KB cache fix + per-entry token index; request body cap + per-IP rate
  limit + LLM concurrency cap/timeout; `javascript:`-URI XSS guard; CORS opt-in.
- CI: removed the phantom `@blindfold/core` dependency that 404'd `npm install`.

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