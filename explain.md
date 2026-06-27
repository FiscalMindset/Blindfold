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
3. ✅ **`T3N_API_KEY` role + DID derivation** — RESOLVED 2026-06-28, and it overturned a wrong assumption. (a) An API key only works if T3 has an **active tenant provisioned** for it; an un-provisioned key 500s on *everything*, including a read-only `me()`. (b) **The tenant DID is NOT `did:t3n:<key eth address>`** — it is server-assigned and unrelated (t1 key `06165c…` → tenant `58f5f5f9…`). `.env` must carry the key **and** its real tenant DID (from `me().tenant`). This was the actual cause of all the seal 500s — see the 2026-06-28 log entry.
4. ✅ **Egress allowlist setup** — RESOLVED 2026-06-28. Egress is granted via `t3n.execute({ script_name:"tee:user/contracts", function_name:"agent-auth-update", input:{ agents:[{ agentDid, scripts:[{ scriptName, versionReq, functions, allowedHosts }] }] } })`. Verified live: with `allowedHosts:["api.github.com"]` the contract's in-enclave `http::call` reached GitHub and got `200`. See the 2026-06-28 log entry.
5. ✅ **`loadWasmComponent()` source** — RESOLVED. Default load (no args) works against testnet; verified by the live `verify` round-trip.
6. ⏳ **ACL setup before `map-entry-set`** — still untested at HEAD; will surface as `access denied` if needed.
7. ✅ **Host WIT package canonical source** — RESOLVED 2026-06-25. The T3 dev team delivered the canonical host WITs. Vendored at `contract/wit/deps/host-tenant-1.0.0/package.wit` and `host-interfaces-2.1.0/package.wit` (stubs deleted). `world.wit` now imports all four capabilities including `http`; `cargo build --target wasm32-wasip2 --release` is clean. Root cause of the old instantiation 500 confirmed: the stub's `http.response` carried a `headers` field that T3's canonical `response` (`{ code, payload }`) does not. Full text + diff in repo-root `response.md`. (Publish + live execute at HEAD still pending a testnet recovery — see the running log.)

---

## Running log

### 2026-06-28 (pm) — seal↔use symmetry, live `doctor`, and the pure enclave-egress path

- **`blindfold use` added** — the missing half. `blindfold use --name <secret> -- <command>` releases the secret and runs the command with it injected as an env var for that subprocess only (no code, works with any tool); `--url <https>` is a quick auth check. `register` now prints the matching "how to use it" recipe. Verified live: `use --as GH_TOKEN -- gh api user` → authenticated as the token owner; `use --url …` → GitHub 200. **There is no per-secret `.ts` to write** — the CLI is generic over any secret.
- **`release()` made robust** — falls back to a direct tenant read of the secrets map when the contract isn't published, so the use path works without publishing first.
- **`doctor` now does a LIVE check** (handshake + authenticate + `me()`) and explains failures in plain English: unprovisioned key (500), out-of-credit tenant (403 InsufficientCredit), or DID mismatch (server-assigned tenant ≠ key address). This is exactly the diagnosis that took days by hand.
- **#3 — in-enclave `http::call` turned ON.** `forward()` now substitutes the sealed secret and makes the outbound HTTPS call *inside the TDX enclave*. Rebuilt (`http` import now retained, not tree-shaken). Published v0.5.3 (contract_id 458), granted secrets read-ACL + egress to `api.github.com`, then: dry-run proved in-enclave substitution (`length=100 = "Bearer "+93`), and the **real** call returned `code=200` — GitHub authenticated as the token owner with the plaintext **never leaving the enclave**. Repro: `scripts/test-enclave-egress.ts`.

### 2026-06-28 — RESOLVED: github_token sealed for real; root cause was an unprovisioned API key (not the network)

The recurring `HTTP 500`s on every seal were **not** a testnet outage and **not**
a credential *mismatch*. The real cause: **the `T3N_API_KEY` in `.env`
(`df48744c…`) has no provisioned tenant on T3**, so every call with it fails.

**Why your key didn't work vs. why the team keys do** (per-key probe,
`me()` = read, `map-entry-set` = write):

| key | eth addr | `me()` | tenant DID | write |
|-----|----------|--------|------------|-------|
| **current** (`.env`) | `df48744c…` | ❌ HTTP 500 | — (none) | ❌ 500 |
| **t1** (team) | `06165c…` | ✅ OK | `did:t3n:58f5f5f9…` (active) | ✅ |
| **t2** (team) | `94ae6a…` | ✅ OK | `did:t3n:3abddb60…` (active) | ✅ |

- `me()` needs no consensus/credits/write — it just reads the tenant behind the
  key. The `df48744c…` key 500s even there ⇒ **no tenant is bound to it**. That
  is why *everything* failed and why it masqueraded as an "outage."
- The team keys return **active** tenants with quotas ⇒ reads succeed, writes
  commit. The cluster was healthy the whole time (commit index advancing).
- **Second finding (corrects a long-standing assumption):** tenant DID ≠
  `did:t3n:<key address>`. It is server-assigned. The seal must target
  `me().tenant` → map `z:<tenant-hex>:secrets`.

**Fix applied:** pointed `.env` at the provisioned **t1** key + its real tenant
DID (`did:t3n:58f5f5f9…`); old `.env` backed up to `.env.bak.*` (gitignored).
Then the standard no-paste seal succeeded:

```
✓ Registered "github_token"  (mode=real, length=93, value read from env once then dropped)
sealed ledger:  93  real  z:58f5f5f9…:secrets/github_token
verify: map-entry-get OK (stored length=93)
```

`GITHUB_TOKEN` line then removed from `.env` (value now lives only in the
enclave). If the `df48744c…` key must be used specifically, the only ask to T3
is: *"provision/claim a tenant for key `df48744c…` — it has none."* Diagnostic:
`scripts/seal-via-working-key.ts`. Full detail in repo-root `response.md`.

### 2026-06-25 — canonical host WITs implemented; GitHub-token seal attempted (testnet down)

- **Canonical host WITs vendored.** Replaced the best-effort stubs with T3's canonical packages (delivered verbatim by the dev team; archived in repo-root `response.md`): `contract/wit/deps/host-tenant-1.0.0/package.wit` + `host-interfaces-2.1.0/package.wit`. Deleted the old `host-tenant/` + `host-interfaces/` stub dirs. Updated `contract/wit/deps/README.md` from "stubs" → "canonical".
- **`world.wit` now imports all four capabilities including `http`** (previously omitted because the stub broke instantiation). Confirmed root cause: stub `http.response` had a `headers` field; canonical `response` is `{ code: u16, payload: list<u8> }` only. `lib.rs`/`forward.rs` unchanged.
- **Build verified.** `cargo build --target wasm32-wasip2 --release` clean (~152 KB). `wasm-tools component wit` shows the unused `http`/`logging` imports are tree-shaken out — so importing them is harmless until `forward()` calls them.
- **GitHub-token seal attempted via the no-paste path** (`blindfold register --name github_token --from-env GITHUB_TOKEN`) — fails `HTTP 500`. Initially read as a testnet outage; deeper probing found the real headline cause: a **`.env` credential mismatch**. The `T3N_API_KEY` resolves to address `2f548795…`, but `DID` is `256ddb4f…` (a stale mock-session tenant), while the provisioned tenant with the contract + the 2026-06-20 deepgram seal is a third identity `d20089c4…`. Single-key-as-tenant requires `DID` hex == key address; it doesn't. `handshake`/`authenticate` pass (key-only), but every write/execute (`map-entry-set`, `map-entry-delete`, `contracts.execute`, even `maps.create` on the key's own tenant) 500s; re-sealing known-good 40 B/39 B secrets 500s too — so it's not github-specific or value-specific. Fix: restore the matching key+DID for `d20089c4…` (has the contract + seals) or claim/`init` a fresh tenant for the current key. Full diagnosis + request_ids in repo-root `response.md`. (A genuine testnet outage can't be ruled out as a *secondary* factor, since `maps.create` on the key's own tenant could 500 from either an unclaimed key or a server outage — see the 2026-06-22 outage below for the same surface symptom.)

### 2026-06-22 — demo real HTTP, release() helper, CI, sentinel guard, dead code removed

- **Demo is now real HTTP** (not a deterministic script): both Agent A and Agent B use the actual OpenAI Node SDK making genuine `POST /v1/chat/completions` HTTP calls to a local mock server that speaks the real OpenAI wire format. Agent B's calls visibly flow through a running Blindfold proxy (`demo/shared/demo-proxy.ts`) — you can see the proxy intercept `Bearer __BLINDFOLD__` and substitute it on every LLM turn. Injection page now hides payload in JSON-LD structured data + hidden `<div>` (realistic attacker technique) instead of an obvious `<!-- INJECTION_TRIGGER -->` HTML comment.
- **`release()` one-liner** added (`packages/blindfold/src/release.ts`, exported from index). Replaces the ~30-line release-broker boilerplate. `examples/grok-via-blindfold.ts` and `scripts/smtp-with-blindfold.ts` both updated to use it.
- **Sentinel collision guard** in `registerSecret`: throws if the plaintext value contains `__BLINDFOLD__` — prevents infinite substitution.
- **GitHub Actions CI** at `.github/workflows/ci.yml` — runs `npm run demo` + `npm run test:report` on every push/PR with `BLINDFOLD_MOCK=1` (no T3 credentials needed).
- **Dead code removed**: `demo/shared/mock-llm.ts` and `demo/shared/agent-loop.ts` are no longer imported by anything (new agents use `openai-agent.ts` + `mock-openai-server.ts`).
- **T3 testnet status (as of 2026-06-22)**: `handshake + authenticate` ✅. All control-plane write operations (`map-entry-set`, `contracts.register`, `contracts.execute`) returning HTTP 500 — testnet outage, not a local issue. `blogger_api_key` sealing pending testnet recovery; `scripts/seal-blogger-key.ts` + `npm run seal:blogger` ready to run when it comes back.
- All 9 tests pass: `npm run test:report` → 9/9 ✅.

### 2026-06-20 — drop silent mock; make REAL the only default; wizard auto-scaffolds
- **Mock is now opt-in.** Previously `BLINDFOLD_MOCK=1 || !T3N_API_KEY || !DID` would silently fall to mock — misleading. Now only `BLINDFOLD_MOCK=1` triggers it. Missing creds in REAL mode produce a loud, actionable error pointing at the T3 claim page.
- New `assertRealReady(env)` helper. `openT3Client` calls it before any T3 round-trip.
- `doctor` exits non-zero if creds are missing.
- **`init` wizard now auto-scaffolds the tenant on every run:** calls `tenant.maps.create("secrets")` and `tenant.maps.create("authorised-hosts")` (both `visibility:"private", writers:"all"`); idempotent (silently skips if maps exist).
- **`init` wizard now auto-grants ACLs after publish:** `tenant.maps.update("secrets", { readers: { only: [<new_contract_id>] } })` plus the same for authorised-hosts. No more manual step.
- **Probed for an egress mechanism.** `tenant.maps.create({tail:"authorised-hosts"})` accepted; `map-entry-set` with `api.x.ai → 1` accepted. But contract's `http::call` still returns 500 after this — so either T3 doesn't consult this map for egress, or there's an additional step we haven't discovered. Confirmed: no `map-entry-get` exists on the control plane (secrets are strictly enclave-only by design — verified by probing 9 candidate action names).
- Verified: all 9 tests still pass after the rewrite; new `doctor` cleanly reports REAL mode with the new tenant.

### 2026-06-20 — register supports no-disk secret input (stdin prompt + pipe)
- New `packages/blindfold/src/prompt.ts`: tiny stdlib-only helper for reading a secret from stdin with echo disabled (raw-mode TTY) and non-TTY pipe support.
- `register.ts` now resolves the plaintext value from three sources, in priority: (1) explicit `value` arg (programmatic), (2) `--from-env` (scripting), (3) interactive prompt or piped stdin (preferred — never touches disk or shell history).
- `bin/blindfold.ts`: `--from-env` is now optional; if omitted, the CLI prompts. Help text updated.
- Backward-compat: `--from-env` still works identically.
- Tested both modes against mock: pipe (length 25 transferred via stdin) and env (length 16 from env). Both register and never echo the value.

### 2026-06-20 — REAL T3 e2e fully green + Grok key sealed
- Fixed two .env typos (`TT3N_API_KEY` → `T3N_API_KEY`; `grok_api_key` → `GROK_API_KEY` since the value starts with `xai-` not `gsk_`, confirming it's xAI's Grok, not Groq the inference company).
- New T3 tenant `did:t3n:3abddb60…` (testnet) — re-verified handshake + authenticate ✅.
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
