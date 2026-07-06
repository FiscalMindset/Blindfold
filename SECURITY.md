# Blindfold — Security

> The threat model, the trust model, the audit invariant, and the chatbot-specific security notes. If you only read one security doc, read [`CONTRIBUTING.md`](CONTRIBUTING.md) "two invariants" and §"The audit model" in this file.

This document is original to the Blindfold project. For the deep technical analysis of why agent APIs leak and what existing fixes miss, see [`docs/01-problem-analysis.md`](docs/01-problem-analysis.md).

---

## 1. The threat model in one paragraph

A blind, semi-trusted language model has access to untrusted text (web pages, emails, PDFs, search results). The attacker controls some of that text. The attacker wants the model's process to exfiltrate any API keys it holds. The agent's process is the attack surface.

The structural fix is to ensure the API key **never enters the agent's process** — so there's nothing for the attacker to steal because there's nothing in the agent's machine to steal.

---

## 2. What we trust, what we don't

### Trusted (with caveats)

| Party | Reason | Caveat |
|---|---|---|
| **Intel TDX** | The CPU primitive is well-vetted and Intel-root-key attested. | A CPU-level backdoor would let any TD read any other's RAM. Intel's attestation catches published hardware bugs. |
| **Terminal 3 (operator)** | Hosts the boxes; runs the hypervisor; can deny service. **Cannot read TD RAM.** | Could rate-limit, log metadata (host, size, latency). Cannot read sealed values. |
| **Your discipline** | The unsealed secret before register is on your box. | Once it's in Slack scrollback, it's gone. Blindfold doesn't fix paste-leaks. |
| **Blindfold maintainers** | We wrote the contract, the proxy, the CLI, the dashboard, and the chatbot. We ship signed versions. | Pin your version. Read the one plaintext file (`register.ts`) on upgrades. |

### NOT trusted

- ❌ **Your AI agent runtime** — the runtime has only the sentinel.
- ❌ **Other tenants** on the same T3 hardware — TDs are hardware-isolated.
- ❌ **Blindfold maintainers with your plaintext** — they never have it post-register.
- ❌ **The prompt-injected text** the agent reads — attacker-controlled.

---

## 3. The audit invariant

> Read **one file** to verify the security property: `packages/blindfold/src/register.ts`.

That file:

1. reads the value from `process.env` (or stdin / explicit arg);
2. passes it as the `value` field of a single `seedSecret` call;
3. returns — the local binding `value` goes out of scope.

That is the only place plaintext is **sealed in**. Everywhere else deals in *names*, *sentinels*, or *request shapes*. The local binding is never assigned to module state, never logged, never written to disk.

### Residual risk — the tenant key and the release path

Two paths do handle plaintext, and you must understand them:

- **Proxy / `forward`** — the un-leakable path. The agent only ever holds the sentinel `__BLINDFOLD__`; substitution happens **inside** the enclave. The agent process never sees the real key.
- **Release broker** (`blindfold use` / `export` / `rotate` / `rollback`, and `release()`) — by design **returns plaintext into the local process** so a broker can use it for one call. Protection here rests entirely on **`T3N_API_KEY` not being reachable by the agent**.

The core residual risk: `T3N_API_KEY` is *not* sealed (it can't be — it's the key that unseals everything), so it lives in plaintext in `.env`. **Anything that can read that file and run `blindfold use` can release every sealed secret.** Sealing raises the bar (keys aren't sitting in `OPENAI_API_KEY`), but it does not by itself guarantee "the agent never sees plaintext."

**Mitigation:** keep `T3N_API_KEY` out of any environment a prompt-injectable agent can read — e.g. hold it terminal-side / in the human operator's shell, not in the working directory the agent operates in. Treat `blindfold use --url` as key-bearing: it now refuses non-https targets (localhost excepted) unless you pass `--allow-insecure`.

An auditor can grep the entire codebase to verify:

```bash
# All places the sentinel is mentioned (plant sites + swap sites only)
grep -rn "__BLINDFOLD__" packages/ blindfold contract

# All uses of safeLog (redacts header values)
grep -rn "safeLog" packages/blindfold/src

# No plaintext logging paths
grep -rn "console.log" packages/blindfold/src
```

The result of these greps is the audit answer. They should show exactly:

- 1× `constants.ts` (the definition)
- 1× `register.ts` (the forbidden-value check)
- 1× `wrap.ts` (the in-process default)
- 1× `proxy.ts` (the plant site)
- 1× `forward.rs` (the swap site)

---

## 4. The end-to-end attack surface

### What an attacker can do

If the attacker controls text your agent reads, they can:

- Make the agent call tools (the usual prompt-injection payload).
- Suggest arguments to tools, including URL parameters and headers.
- Trigger outbound HTTP calls.
- Read the agent's process memory (if they have local code execution).

### What they cannot do (after Blindfold is set up)

- ❌ Read any API key from the agent's process — there is no API key there.
- ❌ Read any API key from `.env` — the line has been deleted.
- ❌ Read any API key from the agent's outbound headers — they're the sentinel.
- ❌ Read any API key from the chat logs — the sentinel is not sensitive.
- ❌ Force the enclave to reveal the key — the TD's CPU-internal key is destroyed on context switch.

### What they CAN still do

- ⚠️ **Make the agent take actions** under its own authority. Mitigation: scoped tools, allowlisted URLs, request rate limits, your usual agent safety.
- ⚠️ **Trigger an `http_get` to a host you've granted egress to** with arbitrary URLs. Mitigation: the enclave makes the call, not the agent, so the attacker's URL still goes through your allowlist — but Blindfold doesn't filter URLs, you do.
- ⚠️ **Side channels.** Don't write code that emits "yes / no" faster when the secret matches a specific value. TDX mitigates known bugs but doesn't make timing analysis impossible.

---

## 5. Operational checklist

### Before going to production

- [ ] `npm run blindfold -- doctor` — tenant is healthy, contract is published, secrets ACL granted, egress allowlisted.
- [ ] `npm run blindfold -- verify` — round-trip succeeds.
- [ ] `BLINDFOLD_MOCK=1 npm run test:report` — 9/9 passes.
- [ ] `npm run demo` — Agent B neutralises the attack.
- [ ] `.env` has no API keys (only `T3N_API_KEY` + `DID`).
- [ ] `git log --all -p | grep -E 'sk-[A-Za-z0-9]{20,}'` returns nothing.
- [ ] Audit log shows every register event in `.blindfold/sealed-ledger.json`.
- [ ] Egress allowlist contains **only** the hosts you actually call.
- [ ] For CI / production: `BLINDFOLD_T3_ENV=production`, separate `T3N_API_KEY` per environment.

### On every dependency upgrade

- [ ] Read the diff for `packages/blindfold/src/register.ts` — if it grew, the invariant changed.
- [ ] Read the diff for `contract/src/forward.rs` — if it grew, the in-enclave behaviour changed.
- [ ] `CONTRACT_VERSION` bumped? (T3 rejects re-publishing the same or lower version.)
- [ ] `npm run blindfold -- init` if the contract changed (re-grants secrets ACL).

### Quarterly

- [ ] `blindfold rotate --name <each>` — rotate every sealed key.
- [ ] Review `.blindfold/sealed-ledger.json` — entries that should no longer exist?
- [ ] Review `usage-log.json` — unexpected providers or call volumes?
- [ ] `git log -- docs/` — KB refresh triggered?

---

## 6. Reporting a vulnerability

**Please do not open a public issue.** Email the maintainer (see `TEAMS.md`). Include:

1. A description of the issue.
2. Reproduction steps (if possible, with `BLINDFOLD_MOCK=1`).
3. Threat-model impact: which invariant does this weaken?
4. Suggested fix (optional).

Security fixes jump the queue. We'll coordinate disclosure timing with you.

---

## 7. Chatbot-specific notes

The chatbot adds one more node to the trust graph. The default (rule-based only) path **never sees a plaintext API key** — it has no LLM call to make.

### The LLM fallback path

When `BLINDFOLD_CHATBOT_API_KEY` is set, the chatbot makes LLM fallback calls. Two configurations:

**Configuration A — direct env (simple)**

```bash
export BLINDFOLD_CHATBOT_API_KEY=sk-...
```

What the chatbot does:

- Holds the key in one local binding for the duration of one `fetch()` call to the LLM provider.
- **Scrubs the request** before sending — `sk-…`, `sk_live_…`, `AKIA…`, `ghp_…` become `__BLINDFOLD__`.
- Holds the key in zero places otherwise. Not in the KB. Not in the engine. Not in the logs.

**Configuration B — Blindfold proxy (recommended)**

```bash
blindfold register --name chatbot_api_key --from-env BLINDFOLD_CHATBOT_API_KEY
blindfold proxy &
export BLINDFOLD_CHATBOT_API_KEY=__BLINDFOLD__
export BLINDFOLD_CHATBOT_BASE_URL=http://127.0.0.1:8787/v1
npx tsx packages/chatbot/bin/chatbot.ts serve
```

What the chatbot does:

- Holds `__BLINDFOLD__` only.
- The proxy substitutes the real value inside the enclave.
- The chatbot's process never sees the plaintext, even briefly.

Configuration B is the canonical "two invariants" form applied to the chatbot itself.

### Defensive measures in the chatbot

| Layer | What it does |
|---|---|
| **Request scrubbing** (`llm-fallback.ts::scrub`) | Redacts `sk-…`, `sk_live_…`, `AKIA…`, `ghp_…` before any LLM call. |
| **Balanced-brace JSON extractor** (`llm-fallback.ts::parseCitations`) | Parses the citation block from the model output without `eval`. |
| **Think-block stripper** | Removes `<think>…</think>` blocks before parsing. |
| **Response not logged** | The LLM response is built into the message and returned; not echoed to stdout. |
| **Stats are counts only** | `EngineStats` exposes intent/audience counts, fallback count, average confidence — never request/response content. |

### What an attacker can do against the chatbot

- ❌ **Steal the API key from the chatbot's response** — the rule-based path has no API key; the fallback path scrubs before sending.
- ❌ **Prompt-inject the chatbot into revealing keys** — the rule-based path has nothing to reveal; the fallback is grounded in KB entries only.
- ✅ **Confuse the chatbot** with malformed input — handled by `extractJSON` and the fallback's "no confident answer" path.
- ✅ **DOS the chatbot** — handled by Blindfold's rate limit (`fuel_per_minute`).

### What the chatbot does NOT do

- ❌ Echo `Authorization: Bearer …` headers anywhere.
- ❌ Persist any conversation history to disk (REPL history is in-memory only; web history is in-browser localStorage-shaped transient state).
- ❌ Send user messages to a third party other than the configured LLM endpoint.
- ❌ Make outbound calls to any host other than the configured LLM (and the proxy, if used).

---

## 8. See also

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the two invariants, audit invariant
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system architecture
- [`CHATBOT.md`](CHATBOT.md) — chatbot-specific docs
- [`docs/01-problem-analysis.md`](docs/01-problem-analysis.md) — full problem analysis
- `packages/blindfold/src/register.ts` — the one plaintext file
- `contract/src/forward.rs` — the in-enclave substitution