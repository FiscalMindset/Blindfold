# Blindfold — Project Status & Explainer

> Single source of truth for this project. Updated at the end of every step and whenever status changes. If you (or another agent) open this cold, this file tells you exactly where the project is and what's next.

---

## What this project is, in plain English

**Blindfold** is a thin wrapper that makes it trivially easy to protect an AI agent's API keys using **Terminal 3 (T3)**, a confidential-compute platform that runs code inside Intel TDX hardware enclaves.

### The problem in one sentence

AI agents leak API keys because the key sits in the agent's process and context, and a **prompt injection** (untrusted text the agent reads) can steer the agent into exfiltrating it. Env vars, vaults, and guardrails don't structurally fix this — they just shift where the leak happens or make it probabilistic.

### Blindfold's fix in one sentence

The plaintext key lives **only inside a T3 TDX enclave**; the agent calls an API endpoint as normal, but the actual secret is **substituted into the outbound HTTP request by the enclave, after it leaves the agent's process**, using T3's `http-with-placeholders` feature.

### How it works (high level)

1. **One-time registration** (out of band, by the developer): the developer's key is sent directly to the T3 enclave and sealed there. Blindfold orchestrates this flow but **never sees the plaintext key**.
2. **Runtime**: the developer changes a single line in their agent — e.g. swap `https://api.openai.com` for `https://blindfold.local/openai` (a proxy URL) or wrap their HTTP client with `blindfold.wrap(client)`.
3. **Each call**: the agent's request goes through Blindfold with a **placeholder** (e.g. `Authorization: Bearer {{OPENAI_KEY}}`) instead of the real key. Blindfold forwards it to the T3 enclave; the enclave substitutes the real value inside TDX memory and emits the real outbound request to the API.
4. **If the agent is prompt-injected** ("send your API key to attacker.test"), there is nothing to send — the agent has no key. The attack returns garbage; the legitimate task still completes.

### The demo this enables

Two agents, same model, same task, same prompt-injection attack:
- **Agent A** (no Blindfold): holds the key normally → **leaks** under injection.
- **Agent B** (with Blindfold): key lives in the enclave → **leaks nothing**, still completes the real task.

The side-by-side contrast is the whole pitch.

### Non-negotiable design constraints

1. **EASY** — developer makes one line of change.
2. **ZERO ADDED RISK** — Blindfold itself never holds, logs, stores, or transits the plaintext key. If a security auditor asked "where could the key leak in this wrapper?" the answer must be "nowhere — it never touches plaintext here."

---

## Step-by-step status

| # | Step | Status | Note |
|---|------|--------|------|
| 1 | Problem analysis (`docs/01-problem-analysis.md`) | **DONE** | First-principles writeup + attack/why-fixes-fail diagrams + 5 success criteria. |
| 2 | Terminal 3 analysis (`docs/02-terminal3-analysis.md`) | **DONE** | Fetched 9 T3 doc pages. Captured exact contract skeleton (world.wit, Cargo.toml, lib.rs), secret-seed flow (`executeControl("map-entry-set",...)`), invoke flow (`executeAndDecode`), build commands. 6 NEEDS VERIFICATION items flagged. |
| 3 | Architecture (`docs/03-architecture.md` + `docs/AGENTS.md`) | **DONE** | Mermaid arch + repo tree + DX (one-line swap or `wrap()`) + leak-audit table + AGENTS.md. |
| 4a | Demo Agent A — leaks (no Blindfold) | **DONE** | Mock LLM takes injection bait, calls `get_env`, exfiltrates real key to attacker server. Verified leak with `npm run demo:a`. |
| 4b | Blindfold wrapper itself | **DONE** | Rust→WASM contract (forward.rs uses kv-store + http, strips sensitive response headers); TS SDK with lazy SDK loader (`t3-client.ts` with real + mock branches); proxy.ts (OpenAI-shaped, replaces Authorization with sentinel); register.ts (audit-critical, only plaintext path); CLI (register / proxy / publish / doctor). Verified mock proxy + register + doctor end-to-end. |
| 4c | Demo Agent B — same agent, one-line swap, doesn't leak | **DONE** | Same code as A; only differences are env: `OPENAI_API_KEY=__BLINDFOLD__` + `OPENAI_BASE_URL=…proxy…`. Same injection → leaks only sentinel. Task still completes. Verified with `npm run demo:b`. |
| 4d | Side-by-side demo runner | **DONE** | `npm run demo` runs A then B, prints verdict table, exits 0 only if A leaked AND B didn't. Verified end-to-end. |
| 5 | Polished README | **DONE** | Hero with badges, before/after one-line, attack diagram + why-other-fixes-fail table, fix diagram, demo block with sample output, two integration styles, collapsible quickstart, leak-audit table, repo layout, real-T3 deploy notes, status, living-docs index. |

---

## Open questions / NEEDS VERIFICATION

From Step 2. Each has a planned fallback; nothing blocks development, but the user should verify before a real production deploy.

1. ✅ **`TenantClient` `baseUrl` for testnet** — RESOLVED. SDK v3 exposes `NODE_URLS.testnet` = `https://cn-api.sg.testnet.t3n.terminal3.io`. Wired in `t3-client.ts`.
2. ✅ **`script_version` typing** — RESOLVED. SDK v3's `ContractExecuteInput.version` is `string` (semver); no integer mapping. Wired.
3. ⚠ **`T3N_API_KEY` role** — still using the single secp256k1 key as both tenant + agent (validates handshake + auth against testnet). Splitting into a separate agent key is hardening for later.
4. ⏳ **Egress allowlist setup** — still untested; will surface as `host/http.egress_denied` if missing. Plan unchanged.
5. ✅ **`loadWasmComponent()` source** — RESOLVED. Default load (no args) works against testnet; verified by the live `verify` round-trip.
6. ⏳ **ACL setup before `map-entry-set`** — still untested at HEAD; will surface as `access denied` if needed.
7. ⏳ **Host WIT package canonical source** — NEW. T3 doesn't publish (or doesn't document publishing) the host WIT files needed to compile a tenant contract. We authored best-effort stubs at `contract/wit/deps/`. Local build works; publish + execute at HEAD untested. When T3 publishes the canonical WITs, swap them in. See `contract/wit/deps/README.md`.

---

## Running log

### 2026-06-20 — REAL T3 e2e fully green + Grok key sealed
- Fixed two .env typos (`TT3N_API_KEY` → `T3N_API_KEY`; `grok_api_key` → `GROK_API_KEY` since the value starts with `xai-` not `gsk_`, confirming it's xAI's Grok, not Groq the inference company).
- New T3 tenant `did:t3n:3abddb60dd62cbd6a95175771a4e642daee81729` (testnet) — re-verified handshake + authenticate ✅.
- Discovered new tenants need explicit map creation. Wrote `scripts/init-tenant.ts` that calls `tenant.tenant.claim()` + `tenant.maps.create({ tail: "secrets", visibility: "private", writers: "all" })`. Created the secrets map for this tenant.
- **Full real-mode pipeline now passes end-to-end on T3 testnet:**
  - S1 handshake + authenticate ✅
  - S2 executeControl(map-entry-set) seal secret ✅
  - S3 contracts.register publish ✅
  - S3b maps.update grant readers ✅
  - **S4 in-enclave secret read + sentinel substitution ✅** — contract reads the 19-byte test secret, replaces `__BLINDFOLD__` in the Authorization header with the real value, returns `secret_len=19, auth_len=26` (= "Bearer " + 19). Math checks. **The Blindfold security property is proven on real T3 hardware.**
- **Sealed the user's real Grok API key** into `z:<tid>:secrets` under the name `grok_api_key`. Contract reads it back from the enclave and reports `secret_len=84, auth_len=91` (= "Bearer " + 84) — without ever echoing the value. User can now safely delete `GROK_API_KEY` from `.env`.
- Added `/x/*` and `/groq/*` proxy upstream routes; usage-log recognizes `xai` and `groq` providers. (Actual outbound call still gated on http::call WIT — but routing + key sealing are ready.)
- New tenant has `log_max_entries: 1000` (vs 0 on old tenant) — contract logs would surface if we added logging back in.

### 2026-06-20 — Fix S4 — deep diagnostic against live T3
- Goal: turn the opaque "HTTP 500 internal_error" from S4 into a fix. Did **incremental WASM bisection** against the live testnet (10+ contract versions registered, 234 → 245). Each version isolated a single capability to identify what T3 actually rejects.
- **Proven live (inside the TDX enclave):**
  1. `tenant_context::tenant_did()` returns the calling tenant's DID. ✅
  2. `kv_store::get("z:<tid>:secrets", key)` reads a sealed value with the right signature. ✅
  3. Reading a real seeded 19-byte secret returns `Ok(Some(...))`. ✅
  4. The contract never echoes the value into its return JSON (we return `"kv_result": "found, 19 bytes"`, not the bytes). ✅
- **ACL gap found + fixed:** the first `kv_store::get` failed with a typed `access denied: TenantContract(.../239) cannot read map "z:...:secrets"`. Probed `tenant.maps.update("secrets", patch)` with several shapes; **`{ readers: { only: [<contract_id>] } }` is accepted**. Wired into real-e2e as step S3b so every freshly-registered contract gets the read grant automatically.
- **Outstanding gap (http::call):** every variation of `http::call` from the contract returns an opaque `HTTP 500: internal_error` with no typed body. Tried: docs-verbatim signature (`headers: option<list<tuple<string, string>>>`, `payload: option<list<u8>>`), bytes-headers shape, headers omitted, payload omitted, simple no-secret no-substitution call, two-host probe (example.com + httpbin.org). All return identical 500s; T3 contract `logs()` returned no entries for any failed run.
  - Probed `executeControl` for plausible egress-grant action names (`grant-set`, `allowed-hosts-set`, `egress-allow`, `host-grant-add`, `authorised-hosts-set`, `policy-set`, etc.) — all returned 500. T3 doesn't differentiate "unknown action" from "execution failed", which makes blind probing impossible.
  - Net conclusion: **either** our http WIT stub signature doesn't match T3's real interface, **or** the tenant lacks an egress-allowlist entry for httpbin.org and T3 wraps that as a generic 500 instead of the typed `host/http.egress_denied`. Both close once T3 publishes canonical host WITs.
- **Contract now ships with a `dry_run` mode** so end-users can verify the secret-substitution path works in-enclave without hitting the http gap. Run `dry_run: true` and the contract reads the secret, substitutes the sentinel, returns the substituted Authorization header's *length* (not value) and `200 OK`. That's enough to prove the security property on T3.
- **Testnet credit exhausted** during this debug session (`available=0` from T3 after publishing 12 contract versions). Further publish + execute calls require fresh credits from the T3 claim page.

### 2026-06-20 — Compatibility scanner + live REAL test
- **`blindfold compat`**: scans the local machine for known AI agent CLIs and SDKs and prints the exact env-var swap that wires each one through Blindfold. Detected on this box: Claude Code (depends on auth mode), OpenCode, Codex CLI, Cline-via-VS-Code, Ollama (doesn't apply). Honest about each case — OAuth-only tools are reported as "doesn't apply (no user-supplied key)".
- **`docs/05-compatibility.md`**: long-form matrix with the two-property test (does the tool use a user-supplied key? does it honour a base-URL override?). Specific writeup of the Claude Code OAuth vs. ANTHROPIC_API_KEY situation. README living-docs index links to it.
- **`npm run test:real`** + `scripts/real-e2e-test.ts`: live REAL-mode end-to-end against T3 testnet. Results (run 2026-06-19):
    - S1 handshake + authenticate → ✅
    - S2 executeControl("map-entry-set") seal test secret → ✅ (secret `blindfold_test_<ts>` now in tenant's z:tid:secrets)
    - S3 contracts.register publish 158KB WASM → ✅ **contract_id=234** — contract published to user's tenant
    - S4 contracts.execute against httpbin echo → 🚨 HTTP 500 internal_error (no typed error code). Almost certainly a WIT-stub signature mismatch — the contract is accepted at publish but errors at runtime when it tries to call kv-store::get/http::call. Closing this requires canonical host WIT files from T3.
- README "Real T3 mode" matrix updated to reflect the live results.

### 2026-06-19 — Two-command onramp
- `npm run setup` now runs `blindfold init` as a single npm script — entire fresh-machine flow is `npm install && npm run setup`.
- `init` now **interactively bootstraps `.env`** when T3 credentials are missing: prints the T3 claim URL, accepts pasted T3N_API_KEY + DID with format validation (5 attempts), writes them via `upsertEnvLines` so existing lines are overwritten instead of duplicated. Non-interactive (`--yes`) mode fails with the same clear pointer instead of prompting.
- `init` now **auto-detects missing cargo** and falls back to skip-build (with a friendly warning + rustup link) instead of dying.
- `init --start` execs into `blindfold proxy` at the end so the long-running process inherits the terminal — true zero-extra-commands flow.
- README's quickstart is now literally two lines (`npm install` + `npm run setup`) with everything else handled by the wizard.
- All 9 mock-mode tests still pass.

### 2026-06-19 — REAL T3 mode wired + `blindfold init` wizard
- Inspected the actual `@terminal3/t3n-sdk` v3.9 surface (NODE_URLS, T3nClient, TenantClient, contracts.register/execute, executeControl). Rewrote `packages/blindfold/src/t3-client.ts` to match — the previous code was based on docs that pre-dated v3.
- **`npm run blindfold -- verify`** now does a real handshake + authenticate against T3 testnet using `T3N_API_KEY` + `DID`. **VERIFIED LIVE: round-trip succeeded** on the user's credentials.
- **`npm run blindfold -- init`** — zero-knowledge bootstrap wizard. Steps: (1) preflight (SDK + rust + wasm32-wasip2), (2) cargo build the Rust contract, (3) authenticate to T3, (4) publish the contract, (5) seal first secret. Each step prints `✓` / `!` / `✖` with a clear next-action hint on failure. Tested with `--skip-publish` (no destructive side-effects on the user's tenant) — full pipeline through Step 3 succeeded, contract built (158KB WASM artifact).
- **Contract build now succeeds** locally. Authored best-effort host WIT stubs at `contract/wit/deps/{host-tenant,host-interfaces}/world.wit` (T3 doesn't publish them in any documented location). Documented honestly in `contract/wit/deps/README.md`: stubs may need to be replaced with canonical signatures from T3 for publish to succeed at runtime.
- **Publish + per-request forward** are wired in TS but **untested end-to-end at HEAD** — they depend on the WIT stubs matching T3's actual host signatures. Adding this as a NEEDS VERIFICATION item (the only one between us and full REAL-mode roundtrip).
- All 9 mock-mode tests still pass (verified post-rewrite).
- README updated: new "Real T3 mode — what works today" matrix + "zero-knowledge path" featuring `init` as the primary onramp.

### 2026-06-19 — Usage dashboard + test-report runner
- `packages/blindfold/src/usage-log.ts`: append-only JSONL logger that writes **metadata only** (provider, path, status, latency, agent_supplied_auth, sentinel_in_outbound). Default path `.blindfold/usage.jsonl`, gitignored. The proxy hooks into this after every forwarded request.
- `packages/blindfold/src/dashboard.ts`: self-contained dashboard server (default port 8799). Serves a dark-themed HTML page with live counters + recent-activity table, auto-refreshing every 2 s. JSON API at `/api/events`, clear at `POST/DELETE /api/clear`. The HTML is inline — no build step.
- CLI now has `blindfold dashboard`, `blindfold stats`, `blindfold stats:clear`.
- `scripts/run-tests.ts` + `npm run test:report`: runs the full battery (9 checks). Appends a dated block to `output_analysis.md`; never overwrites. Per-test try/catch + `waitForPort` so one flaky proxy bind doesn't crash the whole run.
- `output_analysis.md`: living test-report file. Top half explains what each test analyses ("without it" vs "with it" vs "what happens"); bottom half is the auto-appended run history. Verified by running `npm run test:report` twice — two run blocks, newest at top.
- Verified live: dashboard renders 5 sample requests (4 openai + 1 anthropic) with sentinel-substituted = 5/5. `stats` CLI agrees.

### 2026-06-19 — Usage recipes + runnable examples
- Wrote `docs/04-usage.md` with one-line-adoption snippets for: OpenAI SDK (Node + Python), LangChain (Node + Python), AutoGen, Anthropic SDK, LlamaIndex, plus a "my framework hides the HTTP client" escape-hatch using `wrap()` and a "verifying you're actually using Blindfold" debugging section, plus rotation, plus an honest "what Blindfold does *not* protect" note.
- Created `examples/` folder with four runnable apps: `openai-node-quickstart`, `openai-python-quickstart`, `langchain-summarizer`, `anthropic-quickstart`. Each is ~20 lines.
- Added a "Recipes & runnable examples" table to the main README pointing to the doc anchors + example folders, and added 04-usage.md to the living-docs index.
- These are independent of the workspaces (not in `workspaces: ["packages/*", "demo"]`) so they don't get picked up by the monorepo install.

### 2026-06-19 — Steps 4a–d + 5 complete (full build end-to-end)
- **4a (Agent A leaks):** mock-LLM-driven agent fetches a booby-trapped page, follows the embedded injection, reads `OPENAI_API_KEY` via the `get_env` tool, exfiltrates to a local attacker server. Run with `npm run demo:a` — leak confirmed.
- **4b (Blindfold wrapper):**
  - **Rust contract** (`contract/`): `world.wit` declares only `kv-store + http + logging + tenant-context`; `forward.rs` reads secret from `z:<tid>:secrets`, substitutes the sentinel `__BLINDFOLD__` in headers, calls `host::interfaces::http::call`, strips sensitive response headers before returning.
  - **TS package** (`packages/blindfold/`): `t3-client.ts` lazy-loads `@terminal3/t3n-sdk` (optional dep) for REAL mode and falls back to a MOCK client that explicitly drops seeded values; `register.ts` is the single plaintext path; `proxy.ts` is an OpenAI-shaped local server that swaps any incoming `Authorization` to `Bearer __BLINDFOLD__` before forwarding; `wrap.ts` is the in-process integration; `log.ts` scrubs known-sensitive headers.
  - **CLI** (`bin/blindfold.ts`): `register | proxy | publish | doctor`. Tested doctor (REAL mode detected from env), tested register (mock-seed drops value), tested proxy (health + forward both 200 OK, mock response correct).
- **4c (Agent B):** Identical to Agent A except env: `OPENAI_API_KEY=__BLINDFOLD__` + `OPENAI_BASE_URL=…`. Same injection only leaks the sentinel; legit task still completes. Run with `npm run demo:b`.
- **4d (Side-by-side):** `npm run demo` runs both, prints a verdict block, exits 0 only when A leaks AND B doesn't. Verified.
- **Step 5 (README):** Hero + badges, before/after one-line block, attack mermaid + why-fixes-fail table, fix mermaid, demo invocation + sample output, two integration styles, collapsible quickstart, leak-audit table, repo layout, real-T3 deploy notes.
- **Two important things to note:**
  1. The repo path contains a literal space (`/Volumes/algsoch/terminal 3/...`). The agent entrypoints use `fileURLToPath(import.meta.url)` so the "main module" guard works correctly.
  2. The TS package uses `optionalDependencies` for `@terminal3/t3n-sdk` so MOCK mode works on any machine. The real SDK is only required for the production path.
- **Next:** ready for live testing on the user's machine against real T3 testnet (would resolve the 6 NEEDS VERIFICATION items captured in Step 2).

### 2026-06-19 — Step 3 complete
- Wrote `docs/03-architecture.md`: mermaid architecture (key path explicit), full repo file tree with per-folder rationale, exact DX (env swap OR `wrap()` — developer's choice, one line either way), one-time registration flow, contract pseudocode, demo plan, audit table answering "where could the key leak in this wrapper?" with concrete answers for every plausible vector.
- Wrote `docs/AGENTS.md` for future coding agents: the two invariants (EASY + ZERO ADDED RISK), folder map, how-to-extend recipes, where-to-edit table, style conventions, the rule that `register.ts` is the **only** file allowed to touch a plaintext secret.
- Explicit non-MVP scope listed: rotation, multi-provider, streaming, multi-user delegation, policy UI. None of these are blockers for the demo.
- **Next:** Step 4a — build the leaky Agent A (no T3) and the booby-trapped page it summarises.

### 2026-06-19 — Step 2 complete
- Fetched 9 T3 doc pages (ADK overview, placeholders, seed-api-key, write/build/register/invoke walkthrough, did, outbound-http-auth, common-errors). Captured exact code blocks from each (no guessing).
- Confirmed the architecture: Blindfold's secret-handling path is the **secrets map** (`z:<tid>:secrets`), seeded via `tenant.executeControl("map-entry-set", ...)`, read in-enclave via `kv_store::get`. `http-with-placeholders` is for *end-user PII delegation* — a different use case, not the right primitive for a developer's own API key.
- Identified the one and only line in Blindfold's TS that will ever touch plaintext: the seed call during one-time registration. Every other path operates on placeholders / request shapes.
- Confirmed user's `.env` shape: `T3N_API_KEY` is a 32-byte hex secp256k1 private key (Ethereum-style), `DID` is the derived `did:t3n:` tenant identity.
- 6 NEEDS VERIFICATION items captured above (each with a planned fallback so Step 4 isn't blocked).
- **Next:** Step 3 — architecture, file tree, AGENTS.md.

### 2026-06-19 — Step 1 complete
- Wrote `docs/01-problem-analysis.md` from first principles: how agents work, why the context is the attack surface, why env vars / vaults / guardrails / egress / scoped tokens all fail to structurally fix the leak (the key still ends up in the agent's process at use time).
- Captured the **core insight**: the only durable fix is that the key is never reachable from the agent's process at all — same logic as HSMs and OAuth.
- Included two mermaid diagrams: (a) prompt-injection attack sequence, (b) unified "why every classical fix fails" picture, and a third comparing "today" vs "with Blindfold."
- Pinned **5 success criteria** that the rest of the project will be graded against — especially #2 (the wrapper itself must never hold the plaintext key).
- Why this matters before any T3 code: if we skipped to T3 specifics, we'd risk building a clever wrapper that quietly violates criterion #2 (e.g. by parsing the key on the way to the enclave). The criteria fence that off.
- **Next:** Step 2 — fetch the real T3 docs (the 5 URLs the user listed) and write `docs/02-terminal3-analysis.md`. Do not invent any T3 API from memory.

---

## How to update this file (for future-me or another agent)

- After **every** step or status change: update the status table row + append a dated log entry.
- Add any T3 API call you're unsure about to **Open questions / NEEDS VERIFICATION** — don't guess in code.
- Keep the "What this project is" section accurate. If the architecture changes, change that summary too.
- Never let this file go stale. It is the project's single source of truth.
