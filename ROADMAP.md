# Blindfold — Roadmap

> Where the project is going, what's next, and how to influence the direction. The roadmap is a living document — last edit wins, but anything on this list is open to community discussion via GitHub Issues.

---

## 1. Now (shipped)

- ✅ **Published on npm** — [`@fiscalmindset/blindfold`](https://www.npmjs.com/package/@fiscalmindset/blindfold) (`npm i -g`), MIT.
- ✅ **Self-serve onboarding** — `blindfold signup` mints a funded Terminal 3 testnet tenant (key generated locally, email-verified, self-admitted), no manual token claim. Verified live on a second machine.
- ✅ **TDX + Rust + WASM contract** with in-enclave substitution (`contract/src/forward.rs`).
- ✅ **TypeScript SDK + CLI** (`packages/blindfold/`).
- ✅ **OpenAI-shaped local proxy** with 12 first-class providers across 6 industries.
- ✅ **Three in-enclave auth schemes** — bearer, basic (Twilio), sigv4 (AWS SES / S3).
- ✅ **One-line adoption**: `OPENAI_BASE_URL=... OPENAI_API_KEY=__BLINDFOLD__`.
- ✅ **`blindfold use --name X -- <cmd>`** for zero-code CLI use.
- ✅ **`wrap()` and `release()`** for in-process use.
- ✅ **`migrate`, `rotate`, `rollback`** for bulk + lifecycle management.
- ✅ **Live attack demo** — Agent A leaks, Agent B doesn't.
- ✅ **Mock mode** for CI and onboarding without T3 credentials.
- ✅ **Rule-based chatbot** (`packages/chatbot/`) — 481 KB entries, audience-aware, source-cited, hand-crafted UI.
- ✅ **Knowledge extraction pipeline** — the chatbot refreshes itself from the docs and code.

---

## 2. Next (this quarter)

### 2.1 Streaming responses

The LLM fallback returns a single response today. Streaming (Server-Sent Events) gives:

- Faster perceived first-byte for long answers.
- Real "typing" indicator in the web UI (driven by server data, not fake CSS animation).
- The user can cancel mid-response — kills the upstream fetch.

### 2.2 Conversation memory with redaction

The REPL today keeps a 20-message history. Next:

- Persist across sessions (browser localStorage; REPL `.chatbot_history`).
- Redact any user-pasted key-shaped tokens in stored history.
- Per-intent memory: when the user says "I'm a founder" once, every subsequent answer in the session is audience=founder.

### 2.3 Embeddable widget

A small JS snippet that drops the chatbot into any docs site:

```html
<script src="https://your-chatbot-host/widget.js" data-endpoint="https://your-chatbot/api/chat"></script>
<blindfold-chatbot></blindfold-chatbot>
```

This is the "easy to adopt" invariant applied to the chatbot itself.

### 2.4 Per-provider question routing

A user question like *"how do I use this with Stripe + GitHub in CI?"* should resolve to **two** answers stitched together:

- `how_to_proxy` (the cross-cutting workflow)
- `provider_stripe` + `provider_github` (the per-provider specifics)

Today the engine picks the single highest-scoring intent. The next iteration picks the top-k, dedups by overlap, and renders them as linked cards.

### 2.5 Eval harness

A test battery that measures:

- intent classification accuracy against a held-out test set
- KB coverage (how many audit-listed questions get a confident match)
- audience detection accuracy
- LLM fallback usage rate (lower is better; the KB should cover the long tail)

The harness runs in CI and fails the build if any metric regresses.

---

## 3. Later (this half)

### 3.1 Cross-tenant sealed sharing

Today a sealed secret is owned by one tenant. The roadmap item: share a sealed secret with a specific other tenant's contract, with a per-secret ACL. Useful for:

- Multi-tenant SaaS where one customer's keys are used by another customer's agent.
- Federated setups where keys live in a "vault" tenant and are consumed by "agent" tenants.

### 3.2 Time-boxed release

`release(name)` returns the plaintext for one call. The roadmap item: `release(name, { ttl: "30s" })` returns a *short-lived token* that's valid only for the next N seconds. The enclave enforces the TTL — even a buggy agent can't reuse the token past expiry.

### 3.3 Provider discovery from the runtime

`blindfold init` could detect OpenAI / Anthropic / etc. usage in the agent's source and auto-suggest the providers to grant egress for. Today you have to know which hosts you'll call.

### 3.4 Per-provider rate limiting

The T3 host's `fuel_per_minute` is the only rate limit today. The roadmap item: client-side rate limiting per provider (e.g. "no more than 50 calls/minute to OpenAI") with backoff and a clear hint to the agent.

### 3.5 Attestation report parser

A small tool that takes the T3 attestation quote for a contract and produces a human-readable audit report:

- What's the contract hash?
- When was it published?
- Is it the version in this repo?
- Is the WIT surface exactly what we expect?

### 3.6 Secret rotation scheduler

Today `rotate` is manual. A scheduler (`blindfold rotate --cron "0 0 1 * *"`) rotates on a schedule, snapshots the old value for rollback, and notifies via webhook.

---

## 4. Maybe (open questions)

These are bigger bets with uncertain payoff. Discussion welcome.

- **Multi-TEE support.** Today: TDX-only. Could add SEV-SNP, AWS Nitro Enclaves, etc. via the same `kv::get` + `http::call` pattern. Trade-off: more WITs to maintain.
- **Hardware-attested TDX-only chatbots.** The chatbot becomes a sealed-mode tool too — its own prompts and KB are sealed into the enclave, so the operator (T3) can't read the user's KB either.
- **LangChain / LlamaIndex adapters.** A drop-in `BlindfoldLLM` that wraps any LangChain / LlamaIndex agent. Today the user has to do the `wrap(new OpenAI(...))` step themselves.
- **Cooperative billing.** Multi-tenant SaaS where the SaaS pays T3 fuel on behalf of its customers. Today each customer needs their own T3 credentials.

---

## 5. Won't (deliberate non-goals)

- ❌ **A vault.** Vaults solve a different problem (storage). Blindfold complements them.
- ❌ **A general secrets manager UI.** Out of scope. Use `usage-log.json` + the dashboard.
- ❌ **A web-based agent IDE.** Out of scope. Build agents in your stack of choice.
- ❌ **A multi-cloud secret store.** Out of scope. T3 is the trust root; adding other clouds weakens the model.

---

## 6. How to influence

- **Open an issue** with the `roadmap` label.
- **Comment on existing roadmap items** — disagree, refine, contribute.
- **Send a PR** that moves one of the items forward. The maintainer will help you scope it.
- **Sponsor a T3 fuel grant** for production-tier testing of a specific roadmap item.

---

## 7. See also

- [`CHANGELOG.md`](CHANGELOG.md) — what shipped
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute
- [`SECURITY.md`](SECURITY.md) — what's stable vs experimental
- [`CHATBOT.md`](CHATBOT.md) — chatbot-specific roadmap (next-iteration items)
- [`docs/`](docs/) — design docs for the deeper architectural bets