# Blindfold — Architecture

> **What's new (v0.2 / v0.3 + webhook):** installable global CLI (`npm i -g`, runs from any directory, state in `~/.blindfold`); `blindfold login` stores the tenant key in the **OS keychain** (not a plaintext file); Discord webhook support (release path + `/discord` proxy provider, contract v0.5.5). See `CHANGELOG.md`.


> Where every piece lives, where the key lives, where the key **never** lives, and the exact change a developer makes. This is the *whole* system in one document — the proxy, the contract, the chatbot, the dashboard, and the public surface.

This document is original to the Blindfold project and the chatbot that wraps it; for the canonical deep-dive on the runtime alone, see `docs/03-architecture.md` and `explain.md` in the repo.

---

## 1. The system at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Developer machine (UNTRUSTED)                      │
│                                                                          │
│   ┌─────────────┐   ┌─────────────────┐   ┌──────────────────────────┐   │
│   │  .env       │   │  Blindfold       │   │  @blindfold/chatbot      │   │
│   │ (no API     │   │  proxy / wrap    │   │   - rule-based engine    │   │
│   │  keys after │   │   - openai-shaped│   │   - audience-aware       │   │
│   │  register)  │   │   - per-provider │   │   - source-cited         │   │
│   └──────┬──────┘   │   - routes by    │   │   - 481 KB entries       │   │
│          │          │     longest      │   │   - REPL · web · API     │   │
│          │          │     prefix       │   └────────────┬─────────────┘   │
│          │          └────────┬─────────┘                │                 │
│          │                   │                          │                 │
│   ┌──────▼──────┐   ┌────────▼─────────┐                │                 │
│   │  AI agent   │   │  blindfold       │                │                 │
│   │  (no keys   │   │  CLI             │                │                 │
│   │  in env /   │   │   - register     │                │                 │
│   │  process /  │   │   - use / proxy  │                │                 │
│   │  context)   │   │   - publish      │                │                 │
│   └─────────────┘   │   - doctor       │                │                 │
│                     │   - migrate      │                │                 │
│                     │   - rotate       │                │                 │
│                     └──────────────────┘                │                 │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │   (authenticated T3 transport)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            🛡️ Terminal 3 node — Intel TDX trust domain                   │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │  contract/src/forward.rs (Rust → WASM)                           │ │
│   │   pub fn forward(req) -> Response:                                │ │
│   │     let secret = kv::get(req.secret_key)?;                        │ │
│   │     let headers = req.headers.replace(SENTINEL, &secret);         │ │
│   │     let resp = http::call(req.method, req.url, headers, body)?;    │ │
│   │     return resp;  // plaintext never crosses the boundary         │ │
│   └──────────────────────────────────────────────────────────────────┘ │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │  KV map: z:<tenant_did>:secrets                                  │ │
│   │    openai_api_key, github_token, twilio_auth_token, ...           │ │
│   │    (read-only view, encrypted at rest in TDX RAM)                 │ │
│   └──────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  Bearer / Basic / SigV4 header
                          api.openai.com (or Anthropic, GitHub, AWS, …)
```

The chatbot is a regular TS process. If you configure it with the LLM API key via Blindfold's proxy + sentinel pattern, it's structurally identical to any other Blindfold-protected agent.

---

## 2. The trust model

> What you trust, what you don't, and what changes when you add the chatbot.

### Trusted

| Party | Reason | Failure mode |
|---|---|---|
| **Intel TDX** | The CPU primitive is well-vetted and Intel-root-key attested. | A CPU-level backdoor would let any TD read any other's RAM; attestation catches published hardware bugs. |
| **Terminal 3 (operator)** | Hosts the boxes; runs the hypervisor; can deny service. **Cannot read TD RAM** (CPU-enforced). | Could rate-limit, log metadata (host, size, latency). Cannot read sealed values. |
| **Your discipline** | The unsealed secret before register is on your box, your paste buffer, your shell history. | Once it's in Slack scrollback, it's gone. Blindfold doesn't fix paste-leaks. |
| **Blindfold maintainers** | We wrote the contract, the proxy, the CLI, and the chatbot. We ship signed versions. | Pin your version. Read the one plaintext file (`register.ts`) on upgrades. |

### NOT trusted

- ❌ **Your AI agent runtime** — the runtime has only the sentinel.
- ❌ **Other tenants** on the same T3 hardware — TDs are hardware-isolated.
- ❌ **Blindfold maintainers with your plaintext** — they never have it post-register.

### Chatbot-specific trust notes

The chatbot adds one more node to the trust graph:

| Node | What it sees | What it never sees |
|---|---|---|
| `@blindfold/chatbot` engine | User questions, KB entries (paraphrased from docs), audience tags, request metadata (length, latency). | Plaintext API keys (unless explicitly opted into the fallback without the proxy). |
| LLM fallback (when triggered) | The user's question + the top-3 KB entries (scrubbed for `sk-…` / `AKIA…` / `ghp_…`). | The same — the LLM never sees the request in plaintext that contains a key. |

The chatbot dogfoods Blindfold: route the fallback LLM call through the Blindfold proxy with the sentinel, and the chatbot's process only ever sees `__BLINDFOLD__`.

---

## 3. Repository layout

```
terminal3/                       (Blindfold)
├── README.md                    — hero, TL;DR, plain-English explainer
├── CHATBOT.md                   — chatbot docs
├── ARCHITECTURE.md              — this file
├── KNOWLEDGE.md                 — KB schema + contributor workflow
├── SECURITY.md                  — threat model + audit checklist
├── ROADMAP.md                   — what's next
├── CHANGELOG.md                 — what shipped
├── CONTRIBUTING.md              — how to contribute
├── LICENSE                      — MIT
├── explain.md                   — long-form explainer
├── current_status.md            — living status file
├── usage.md                     — scenario-by-scenario usage guide
├── EXAMPLES.md                  — provider-by-provider examples
├── integration-stack.md         — full provider / industry matrix
├── FAQ.md                       — common questions
├── TEAMS.md                     — contributor guide for the team
├── integration-stack.md         — provider matrix
├── docs/                        — long-form design docs
│   ├── 01-problem-analysis.md
│   ├── 02-terminal3-analysis.md
│   ├── 03-architecture.md
│   ├── 04-usage.md
│   ├── 05-compatibility.md
│   ├── AGENTS.md
│   └── index.html               — graph viewer
│
├── packages/
│   ├── blindfold/               — the TS SDK + CLI + proxy + dashboard
│   │   ├── src/
│   │   │   ├── register.ts      ⚠️  the only plaintext path
│   │   │   ├── proxy.ts        — OpenAI-shaped loopback server
│   │   │   ├── wrap.ts         — in-process SDK re-pointer
│   │   │   ├── release.ts      — broker-style release for one call
│   │   │   ├── providers.ts    — first-class provider registry
│   │   │   ├── t3-client.ts    — typed T3 SDK wrapper
│   │   │   ├── constants.ts    — SENTINEL, ports, contract version
│   │   │   ├── env.ts          — .env loader (no value logging)
│   │   │   ├── log.ts          — safeLog (redacts header values)
│   │   │   ├── init.ts         — first-time setup
│   │   │   ├── migrate.ts      — bulk .env → enclave
│   │   │   ├── sealed-ledger.ts — metadata-only ledger
│   │   │   ├── versions.ts     — rotate / rollback versions
│   │   │   ├── usage-log.ts    — non-sensitive telemetry
│   │   │   ├── compat.ts       — detect agent CLIs on this machine
│   │   │   ├── dashboard.ts    — local dashboard server
│   │   │   ├── prompt.ts       — terminal-secret reader
│   │   │   └── index.ts        — public exports
│   │   └── bin/blindfold.ts    — CLI entry
│   │
│   └── chatbot/                 — the rule-based chatbot
│       ├── README.md
│       ├── src/
│       │   ├── engine.ts       — orchestrator
│       │   ├── classifier.ts   — regex/phrase/keyword/exact
│       │   ├── audiences.ts    — user/dev/founder/enterprise/researcher
│       │   ├── entities.ts     — provider/file/cmd extraction
│       │   ├── intents.ts      — intent pattern table
│       │   ├── knowledge.ts    — KB loader + lookup
│       │   ├── responder.ts    — audience-aware markdown
│       │   ├── llm-fallback.ts — optional LLM call (scrubbed)
│       │   ├── server.ts       — web server (http, no framework)
│       │   ├── types.ts
│       │   ├── index.ts        — public exports
│       │   └── public/         — hand-crafted UI
│       │       ├── index.html
│       │       └── assets/
│       │           ├── styles.css
│       │           └── app.js
│       ├── bin/
│       │   ├── chatbot.ts      — CLI (repl/ask/serve/audit/extract)
│       │   └── extract-knowledge.ts — KB extraction pipeline
│       └── data/
│           ├── knowledge.json   — curated + extracted KB
│           └── .extract-cache.json — extraction cache (idempotency)
│
├── contract/                    — Rust → WASM T3 contract
│   ├── Cargo.toml
│   ├── wit/
│   │   └── world.wit           — kv-store + http + logging + tenant-context
│   └── src/
│       ├── lib.rs              — entrypoint, exports Component
│       ├── forward.rs          — forward() in-enclave substitution
│       ├── auth.rs             — sigv4 / basic auth helpers
│       └── auth-tests/
│
├── scripts/                     — live T3 utilities
│   ├── test-enclave-egress.ts  — proves in-enclave substitution
│   ├── smtp-with-blindfold.ts  — SMTP with sealed password
│   ├── grant-and-call.ts       — one-shot: grant + call
│   ├── real-e2e-test.ts        — full chain test
│   └── …
│
├── demo/                        — side-by-side attack demo
│   ├── agent-a-leaks/          — leaks the key
│   ├── agent-b-blindfolded/    — leaks only the sentinel
│   ├── shared/                 — shared fixtures
│   └── run-demo.ts
│
├── examples/                    — runnable per-stack
│   ├── openai-node-quickstart/
│   ├── openai-python-quickstart/
│   ├── anthropic-quickstart/
│   ├── langchain-summarizer/
│   ├── cli-tools/              — no-code `blindfold use` recipes
│   ├── api-providers/          — Deepgram / Blogger / Hostinger
│   ├── digital-ocean/          — doctl + curl + enclave, verified
│   ├── gemini/                 — Google Gemini, non-Bearer auth
│   ├── stripe/                 — real Stripe test-mode
│   ├── aws/                    — AWS SES + S3, SigV4
│   ├── twilio/                 — Twilio, HTTP Basic
│   └── prompt-injection/       — live attack, defeated
│
└── tests/                       — test:report matrix (9/9)
```

---

## 4. The request lifecycle (four steps, one diagram)

```
   ┌──────────┐ one-time seal   ┌─────────────────────────────────────┐
   │  dev box │ ────────────────▶│ Terminal 3 — Intel TDX trust domain │
   │  .env    │ value read once,│                                     │
   │          │ local binding   │  ┌───────────────────────────────┐  │
   │          │ out of scope    │  │ KV: z:<tenant>:secrets         │  │
   └──────────┘                  │  │   openai_api_key ─── (sealed)  │  │
                                 │  └───────────────────────────────┘  │
                                 └────────────────┬────────────────────┘
                                                  │
   ┌──────────┐ every request   ┌──────────────────▼─────────────────┐
   │ AI agent │ ────────────────▶│ Blindfold proxy (loopback)         │
   │ (no keys)│ Authorization:  │  - resolveProvider(path)            │
   │          │ Bearer _______  │  - plant sentinel in headers        │
   │          │                 │  - t3.invokeForward(req)            │
   │          │ ◀────────────── │  - writeHead + body pipe            │
   │          │ HTTP response   │  - logUsage(provider, latency, …)   │
   └──────────┘                 └─────────────────────────────────────┘

   Inside the enclave (forward.rs):

     let secret = kv::get(req.secret_key)?;
     let headers = req.headers.iter()
       .map(|(k, v)| (k, v.replace(SENTINEL, &secret)))   // bearer scheme
       // or: build Basic header from SID + secret          // basic scheme
       // or: sigv4_authorization(...)                     // sigv4 scheme
       .collect();
     let resp = http::call(method, url, headers, body)?;
     return resp;  // plaintext secret never crosses the boundary
```

---

## 5. The audit invariant

> Read **one file** to verify the security property: `packages/blindfold/src/register.ts`.

That file:

- reads the value from `process.env` (or stdin / explicit arg)
- passes it as the `value` field of a single `seedSecret` call
- returns — the local binding `value` goes out of scope

That is the **only** function in the entire codebase that holds a plaintext secret. Everywhere else deals in *names*, *sentinels*, or *request shapes*. The local binding is never assigned to module state, never logged, never written to disk.

For the chatbot:

- The rule-based path never sees an API key. Period.
- The LLM fallback holds the key in one local binding for the duration of one `fetch()` call, exactly like `registerSecret`. Or — better — routes through the Blindfold proxy with the sentinel, so the chatbot's process only ever sees `__BLINDFOLD__`.

This is what the `ZERO ADDED RISK` invariant in `CONTRIBUTING.md` means in practice. A security auditor can read the codebase end to end and answer "where could the key leak in this wrapper?" with **"nowhere it wasn't already."**

---

## 6. Where plaintext exists, with timestamps

| Phase | Where | How long |
|---|---|---|
| `blindfold register` | `registerSecret` local binding → `seedSecret` wire | <50 ms |
| Every proxy request | TD RAM inside the enclave | per-request |
| `blindfold use -- <cmd>` | child process env | lifetime of the child |
| Chatbot fallback (no proxy) | one local binding in `llm-fallback.ts` | per-fetch (~1–3 s) |
| Chatbot fallback (via proxy) | never in the chatbot's process | — |
| Disk / `.env` / git history / paste buffer | **never again** after deletion | — |

---

## 7. Provider matrix

See `EXAMPLES.md` for the canonical, runnable list. As of the current build:

| Provider | Path | Auth | Sealed name | Provider-specific headers |
|---|---|---|---|---|
| OpenAI | `/v1/`, `/openai/` | Bearer | `openai_api_key` | — |
| Anthropic | `/anthropic/` | Bearer | `anthropic_api_key` | `anthropic-version: 2023-06-01` |
| xAI / Grok | `/x/` | Bearer | `xai_api_key` | — |
| Groq | `/groq/` | Bearer | `groq_api_key` | — |
| Google Gemini | `/gemini/` | `x-goog-api-key` | `gemini_api_key` | — |
| Stripe | `/stripe/` | Bearer | `stripe_secret_key` | `stripe-version`, `content-type` |
| GitHub | `/github/` | Bearer | `github_token` | `x-github-api-version`, `User-Agent` |
| SendGrid | `/sendgrid/` | Bearer | `sendgrid_api_key` | — |
| Slack | `/slack/` | Bearer | `slack_bot_token` | — |
| Twilio | `/twilio/` | HTTP Basic | `twilio_auth_token` | `content-type` |
| AWS SES | `/aws/ses/` | SigV4 | `aws_secret_access_key` | — |
| AWS S3 | `/aws/s3/` | SigV4 | `aws_secret_access_key` | — |

Adding a provider is one entry in `packages/blindfold/src/providers.ts`. The full contributor flow is in `CONTRIBUTING.md`.

---

## 8. The chatbot's role in the architecture

The chatbot is a **regular Blindfold client**. It runs in the same untrusted zone as your agent, holds the same sentinel pattern, and can use the same proxy + wrap pattern. Its uniqueness is that:

1. It has a **deterministic, source-cited** answer path (rule-based) so it can talk about Blindfold without needing to make API calls for common questions.
2. It has an **optional LLM fallback** for long-tail questions — opt-in via env, scrubbed of any key-shaped tokens before sending.
3. It **dogfoods** the Blindfold proxy: you can configure it so the LLM fallback API key is sealed into the enclave, and the chatbot's process never holds the plaintext.

This is a clean loop:

- The chatbot **teaches** the user about Blindfold.
- The chatbot **uses** Blindfold to protect its own LLM key (when configured).
- The chatbot **extends** Blindfold — adding intents and KB entries is one PR.

---

## 9. Operational model

### Local dev (mock mode)

```bash
BLINDFOLD_MOCK=1 npm run demo            # side-by-side leak demo
BLINDFOLD_MOCK=1 npm run test:report     # 9-check battery
BLINDFOLD_MOCK=1 npx tsx packages/chatbot/bin/extract-knowledge.ts
```

Mock mode simulates the enclave in-process with the same interface. No T3 credentials required.

### Testnet (real TDX)

```bash
# 1. Get creds
#    https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens
# 2. Put them in .env
T3N_API_KEY=0x...
DID=did:t3n:...

# 3. Verify
npm run blindfold -- doctor
npm run blindfold -- verify

# 4. Run
npm run demo
npm run blindfold -- proxy
```

### Production

Same as testnet, but with `BLINDFOLD_T3_ENV=production`. Expect a per-tenant fuel quota. See `usage.md` §8 for the deployment checklist.

### CI

```bash
# .github/workflows/ci.yml
- run: BLINDFOLD_MOCK=1 npm run test:report
- run: BLINDFOLD_MOCK=1 npm run demo
- run: npx tsx packages/chatbot/test-quick.mts
```

---

## 10. Failure modes — what to do when

| Symptom | First check | Fix |
|---|---|---|
| `t3n api: NO ✖` from `doctor` | T3N_API_KEY in `.env` | Re-fetch from T3 docs |
| `did: NO ✖` | DID in `.env` | Must match the key |
| `tenant: suspended` | T3 console | Contact T3 |
| `contract: not published` | — | `npm run blindfold -- init` |
| `secrets ACL: NO ✖` | — | `npm run blindfold -- init` (re-grants) |
| `egress_denied` in proxy response | Host not allowlisted | `blindfold grant --host <host>` |
| `fuel_per_minute` | Testnet rate-limit | Wait ~60 s, space calls |
| `parse_payload` (form-encoded body) | T3 parses bodies as JSON | Proxy auto-converts form → query string |
| `secret <name> not found` | Not sealed yet | `blindfold register --name <name> --from-env <var>` |
| Chatbot says "I don't have a confident answer" | KB gap | `blindfold-chatbot extract` to refresh from latest docs; add an intent + KB entry if needed |

---

## 11. See also

- [`README.md`](README.md) — entry point
- [`docs/03-architecture.md`](docs/03-architecture.md) — the original architecture doc
- [`CHATBOT.md`](CHATBOT.md) — chatbot-specific
- [`SECURITY.md`](SECURITY.md) — threat model + audit checklist
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to add intents / KB entries / providers
- [`ROADMAP.md`](ROADMAP.md) — what's next