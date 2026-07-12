# Blindfold — Current Status (as of 2026-06-28, real seal working)

> **2026-07 update:** shipped **v0.4 — published on npm** as
> [`@fiscalmindset/blindfold`](https://www.npmjs.com/package/@fiscalmindset/blindfold)
> with **self-serve onboarding** (`blindfold signup` mints a funded testnet tenant,
> no manual token claim; verified live on a second machine). Earlier: v0.2
> (installable, SSD-independent CLI — `npm i -g`, state in `~/.blindfold`), v0.3
> (tenant key in the OS keychain via `blindfold login`), a full security/scale
> hardening pass, and Discord webhook support (contract v0.5.5). CI is green. See
> `CHANGELOG.md` for the full list.

> Snapshot. Read top to bottom. §2 is the headline.
>
> **2026-06-28 update — RESOLVED:** the live-seal failures were **not** a
> testnet outage. The root cause was the **API key in `.env` (`df48744c…`) had
> no provisioned tenant** on T3, so *every* call with it — even a read-only
> `me()` — returned `HTTP 500 internal_error`. Switching `.env` to a
> **provisioned team key (t1 → tenant `58f5f5f9…`, status `active`)** made the
> real seal succeed immediately: `github_token` (93 B) is sealed and verified
> by read-back. See §0 for the full why. The earlier "outage" language below is
> kept for history but is superseded.
>
> **2026-06-25 update:** the T3 dev team delivered the canonical host WIT
> files (the thing every prior status called "the only remaining blocker").
> They are now vendored and the contract builds with `http` imported. See §1
> and §8.

---

## 0. Root cause of the seal failures (2026-06-28) — it was the API key, not the network

**Short answer: your `T3N_API_KEY` was the problem — specifically the
`df48744c…` key that used to be in `.env`. It is not provisioned on T3 (it has
no tenant bound to it), so nothing it does can succeed.**

### Why your key (`df48744c…`) did NOT work

On T3, an API key only does anything if the server has an **active tenant**
bound to it. The `df48744c…` key has none. Proof — a plain read with it fails:

```
[current df48744c…]  me():  ❌ HTTP 500 internal_error
                     claim(): ❌ 500
                     map-entry-set: ❌ 500
```

`me()` needs no consensus, no credits, no write — it just reads the tenant
behind the key. It still 500s, which means **there is no tenant behind the
key.** That is why *everything* failed, and why it looked like an "outage": the
key is dead server-side, so it 500s on every endpoint.

### Why your team keys (t1 / t2) DO work

The same probe with the provisioned team keys returns clean, active tenants:

```
[t1  06165c…]  me(): ✅ OK → tenant did:t3n:58f5f5f9…  status=active  (quotas present)
[t2  94ae6a…]  me(): ✅ OK → tenant did:t3n:3abddb60…  status=active
```

These keys have **claimed, active tenants** behind them, so reads succeed and
writes commit. The cluster itself is healthy (commit index advancing, stable
raft term) — it was never the blocker.

### The second trap: DID ≠ key address

The old `.env` assumed `DID = did:t3n:<key's eth address>`. **That is wrong on
T3.** A provisioned key's tenant DID is **server-assigned and unrelated** to the
key's address:

| key | eth address | actual tenant DID (from `me()`) |
|-----|-------------|---------------------------------|
| t1  | `06165c…`   | `did:t3n:58f5f5f9…` (active) |
| t2  | `94ae6a…`   | `did:t3n:3abddb60…` (active) |

(DIDs are public tenant identifiers, not secrets — truncated here; the full
value lives only in `.env`, which is gitignored.)

The seal must target the **real** tenant DID (`me().tenant`) → map
`z:<tenant-hex>:secrets`. `.env` now uses t1's key + its real `DID`.

### Result

```
✅ SEALED "github_token" (93 bytes) → z:58f5f5f9…:secrets   (mode=real)
verify: map-entry-get OK (stored length=93)
```

**If you specifically need the `df48744c…` key alive, that is the one thing to
ask T3:** *"please provision/claim a tenant for key `df48744c…` — it currently
has none."* Nothing on our side (code, WIT, SDK, credits) needs to change.

---

## 1. What the T3 team told us

The T3 dev team responded to our `http::call` gap and answered all three open items:

1. **Naming convention** — kebab-case on the wire (`"release-to-tenant"`, not `"release_to_tenant"`). We had already discovered this.
2. **Egress authorization** — pointed at `docs/.../invoke-contract`. Confirmed: the missing step was `t3n.execute({ script_name: "tee:user/contracts", script_version: "2.10.2", function_name: "agent-auth-update", input: { agents: [{ agentDid, scripts: [{ scriptName, versionReq, functions, allowedHosts }] }] } })`. We had been calling `tenant.executeControl` against control-plane action names — wrong API. The correct one is a SYSTEM script (`tee:user/contracts`), accessed via `t3n.execute` (not `tenant.executeControl`), looked up via `getScriptVersion(rpcUrl, "tee:user/contracts")`.
3. **`http` capability should not be gated** — confirmed by docs, but importing it on this tenant still breaks the contract at instantiation. Likely cause: our best-effort WIT stub for `host:interfaces/http@2.1.0` has signatures that don't match T3's runtime expectation. The team explicitly said: *"if you still find any barriers, please try a workaround or hardcode certain parts with assumptions so the demo can work — also please note where in the project you did that and reflect the difficulty. We'd totally understand and will reflect this to the core eng team."*

§3 records the workaround per their request.

### 2026-06-25 — canonical host WITs delivered (root cause confirmed)

The T3 dev team sent the canonical host WIT files (full text + diff in the
repo-root `response.md`). They **confirmed our root-cause hypothesis**: the
stub's `http.response` declared a `headers` field, but T3's live host links a
`response` of `{ code: u16, payload: list<u8> }` — **no response headers**.
That single mismatch is what made the contract 500 at instantiation whenever
`http` was imported. Other confirmed shapes:

- `http.call` takes a single `request` **record** (not positional args); error channel is a bare `string`.
- `http.verb` = `{ get, post, put, patch, delete }` (no `head`).
- Pin `@2.1.0` (live host); a `@2.2.0` label is additive — don't chase it.
- Runtime note: tenant HTTP egress is gated by the caller's `agent_auth` grant; `http.call` returns `Err` for unauthorised hosts. Build + register succeeding ≠ host reachable.

**Implemented this session** (see §8): stubs replaced with the canonical
packages, `http` (and `logging`) now imported in `world.wit`, contract
rebuilds clean. The "blocked by WIT stub mismatch" blocker below is therefore
**resolved**.

---

## 2. Headline (after applying everything T3 said)

| Capability | Status | How |
|---|---|---|
| **Egress authorization** (the previously-mysterious 500 vector) | ✅ **NOW VERIFIED** | `scripts/grant-and-call.ts`: granted `agentDid=<tenant>`, `scripts=[{scriptName, versionReq:">=0.5.0", functions:["forward","release-to-tenant"], allowedHosts:["api.x.ai"]}]`. Accepted: `tx_hash: tx:302:53785`. |
| **Canonical host WITs imported (incl. `http`)** | ✅ **DONE 2026-06-25** | Stubs replaced with T3's canonical `host:tenant@1.0.0` + `host:interfaces@2.1.0`; `world.wit` imports all four capabilities including `http`; `cargo build --target wasm32-wasip2 --release` succeeds. The stub-mismatch instantiation blocker is gone. |
| **Contract-internal `http::call` from inside TDX** (the dream path) | 🟡 **unblocked at the WIT level; `forward.rs` wiring + live test remain** | The import that used to 500 at instantiation now compiles cleanly. Remaining: rewrite `forward()` to build a `request` and call `http::call` (returning `response.code`/`response.payload`), then verify live with the `api.x.ai` egress grant. (Live verification currently waiting on the testnet outage in §4.) |
| **Sealed AND used end-to-end via release-broker** | ✅ **verified live (2026-06-22 send)** | `scripts/smtp-with-blindfold.ts` sent a real email to `algsoch@gmail.com`. Contract v0.5.1, `messageId=da6e234c-c955-3712-8394-73cbf6fd7402@gmail.com`, Gmail `250 2.0.0 OK`. `process.env.smtp_password` absent throughout. |

The blunt translation: the canonical-WIT blocker that every prior status
called "the only remaining thing" is **resolved**. What's left for the
philosophically-pure "secret never leaves the enclave even briefly" mode is
now just application code — wiring `forward()` to call `http::call` — plus a
live execute, which is gated only by the current testnet outage (§4), not by
anything missing in the design.

---

## 3. Workaround in use (per T3 team's go-ahead)

| Where | What | Why |
|---|---|---|
| `contract/wit/world.wit` | ✅ **RESOLVED 2026-06-25.** Now imports all four canonical interfaces including `host:interfaces/http@2.1.0`. The stale "do NOT import http" comment is replaced with the new state + egress-grant runtime note. | Canonical signatures landed; the `response`-had-`headers` mismatch that caused the instantiation 500 is fixed. |
| `contract/src/forward.rs` | **Unchanged** (intentionally — the WIT swap needed no code change). `forward()` still reads the secret, performs the sentinel substitution, and returns lengths only (`secret_len` + `authorization_header_len_after_substitution`) as a dry-run proof; `release_to_tenant()` returns the plaintext to the authenticated tenant. | Wiring `forward()` to actually call `http::call` is now a separate, unblocked functional change (build no longer fails on the import). |
| `scripts/smtp-with-blindfold.ts` + `INTEGRATION-AURORA.md`'s `EnclaveBroker` | Calls `release-to-tenant`, holds the plaintext in the local broker process for **one** outbound call (Gmail SMTP), drops it. | This is the production-viable pattern today. Agent's process — the prompt-injection target — never sees the value. |
| `scripts/grant-and-call.ts` | Implements the full egress-grant + http-call flow exactly as the T3 docs describe. **Keep this file** — it's the verifier for the `forward()` → `http::call` migration. | So we have a one-command verification once `forward()` is wired and the testnet is back. |

**Difficulty surfaced for the T3 core eng team — now RESOLVED by their canonical WITs (2026-06-25):**

- The root cause is confirmed: importing `host:interfaces/http@2.1.0` with our best-effort signatures made `tenant.contracts.execute` return `HTTP 500 internal_error` (no typed body) even for functions that never call http, **because our stub's `response` record carried a `headers` field that T3's live host does not have**. The canonical `response` is `{ code: u16, payload: list<u8> }`.
- Both signature variants we had tried earlier shared that wrong `response` shape, which is why both produced the same opaque 500. With the canonical packages vendored, the import compiles and (by design) is tree-shaken out until `forward()` calls it.
- The ask that closed this out — "publish the canonical `host:interfaces/http@2.1.0` (and `host:tenant/tenant-context@1.0.0`, `host:interfaces/kv-store@2.1.0`, `host:interfaces/logging@2.1.0`)" — has been delivered. Full text + diff archived in repo-root `response.md`.

---

## 4. Verified-live matrix

> ✅ **RESOLVED 2026-06-28 — see §0.** The `HTTP 500`s were **not** an outage
> and **not** a credential *mismatch* — they were an **unprovisioned API key**.
> The `df48744c…` key in `.env` has no tenant bound to it, so even a read-only
> `me()` 500s. Switching `.env` to a provisioned team key (**t1 → tenant
> `58f5f5f9…`, active**) made the real seal succeed and verify. The cluster is
> healthy; team keys read/write fine. The history below (and earlier "testnet
> outage" notes) is kept for the record but is superseded by §0.

| Layer | Status | Evidence |
|---|---|---|
| **Contract builds with canonical WITs (`http` imported)** | ✅ **2026-06-25** | `cargo build --target wasm32-wasip2 --release` clean; `wasm-tools component wit` shows imports tree-shaken to `tenant-context.tenant-did` + `kv-store.get` |
| `blindfold verify` (handshake + authenticate) | ✅ **2026-06-25** | REAL T3 round-trip succeeded today |
| `blindfold doctor` / `init` / `register` / `compat` / `proxy` / `dashboard` / `stats` | ✅ | All exercised against the new tenant; `npm run test:report` 9/9 ✅ |
| `npm run demo` (Agent A leaks, Agent B doesn't) | ✅ | Mock-LLM driven, runs anywhere |
| T3 auth (handshake + authenticate) | ✅ | `npm run blindfold -- verify` |
| Seal a secret (`executeControl("map-entry-set", …)`) | ✅ | `grok_api_key` (84B), `smtp_password` (16B) live in the user's tenant |
| `tenant.maps.create("secrets")` + `("authorised-hosts")` | ✅ | Wizard auto-scaffolds; idempotent |
| `tenant.maps.update("secrets", { readers: { only: [<id>] } })` ACL grant | ✅ | Wizard auto-applies after publish |
| Contract publish (`tenant.contracts.register`) | ✅ | Currently at v0.5.1, contract_id 285 |
| In-enclave secret read via `kv_store::get` | ✅ | Verified via `forward()` returning `secret_len` |
| In-enclave sentinel substitution | ✅ | `authorization_header_len_after_substitution = "Bearer " (7) + secret_len` |
| **Egress authorization grant (`agent-auth-update`)** | ✅ **NEW** | tx_hash `tx:302:53785` accepted on the live tenant |
| `release-to-tenant` returns plaintext to authenticated tenant | ✅ | Used live in SMTP send |
| **Release-broker outbound (SMTP send via released secret)** | ✅ **just re-verified** | `messageId=da6e234c-c955-3712-8394-73cbf6fd7402@gmail.com`, Gmail accepted |
| Contract-internal `http::call` (dream path) | 🟡 | WIT-level unblocked (canonical `http` imports + builds); needs `forward()` wiring + a live execute (latter gated on the §4 outage) |
| Seal `github_token` (`map-entry-set`) | ✅ **DONE 2026-06-28** | Sealed real (93 B) → `z:58f5f5f9…:secrets` via `register --from-env GITHUB_TOKEN` on the t1 tenant; verified by read-back (length 93). Failed earlier only because `.env` held the unprovisioned `df48744c…` key (§0) |

---

## 5. Today's threat model (unchanged in shape; tightened in practice)

| Place the plaintext API key might live | Without Blindfold | With Blindfold (today) | With Blindfold (after canonical http WIT) |
|---|---|---|---|
| Agent's `process.env` | ✅ yes (prompt-injection target) | **❌ no** | **❌ no** |
| Agent's process memory / tools | ✅ yes | **❌ no** | **❌ no** |
| `.env` on disk | ✅ yes | ❌ no (delete after seal) | ❌ no |
| Local broker process | ✅ yes, full lifetime | ⚠ briefly, one call | **❌ no** (T3 makes the call) |
| T3 TDX enclave | n/a | ✅ canonical | ✅ canonical |

The agent — the only attack surface that matters for prompt injection — is structurally clean today.

---

## 6. User's current setup state

- **`.env` (by `npm run env:fingerprint`, 2026-06-28):** `T3N_API_KEY` (now the **t1** team key `0x7…db`), `DID=did:t3n:58f5f5f9…` (t1's real tenant), plus `t1_*`/`t2_*` keys, `smtp_*`, `deepgram_api_key`, `blogger_api_key`. `GITHUB_TOKEN` line **removed** after a successful real seal (value lives only in the enclave now). Prior `.env` backed up to `.env.bak.*` (gitignored).
  - ✅ *Done:* `github_token` sealed real on the t1 tenant; `.env` plaintext deleted.
  - 🚧 *Optional:* also seal `blogger_api_key`; delete the `.env` copies of any other already-sealed key (e.g. `deepgram_api_key`). `T3N_API_KEY` + `DID` stay (root creds).
- **Active tenant (t1) tail `58f5f5f9…`** (testnet) — `status=active`, holds the new `github_token` (93 B) seal. The older real seals (deepgram/cognee/paypal) live on tenant `d20089c4…` from 2026-06-20.
- **Old tenant tail `d20089c4…`** (testnet), per the sealed ledger:
  - `secrets` map: holds `deepgram_api_key` (40 B), `cognee_api_key` (64 B), `paypal` (80 B) from earlier sessions. `github_token` **not yet sealed** (blocked by the §4 outage).
  - `authorised-hosts` map: exists (the real egress mechanism is `agent-auth-update`, not this map).
  - `blindfold-proxy` contract: v0.5.1. **Egress grant for `api.x.ai` accepted** (tx `tx:302:53785`).
- **`@terminal3/t3n-sdk`** installed. REAL mode is the default.
- ⓘ The local sealed ledger (`.blindfold/sealed.jsonl`) is per-machine metadata and may not list seals done elsewhere; treat the enclave (verified by fingerprint) as canonical.

---

## 7. Punch list (updated)

| # | Action | Status | Why |
|---|---|---|---|
| 1 | Seal `GITHUB_TOKEN` (done) + `blogger_api_key`, then delete sealed keys' `.env` lines | ✅ github_token sealed real + `.env` line removed (2026-06-28); blogger optional | Root cause was the unprovisioned `df48744c…` key (§0); fixed by using the t1 team key |
| 2 | Egress-grant API discovered + working | ✅ done | `agent-auth-update`, `tee:user/contracts` v2.10.2, `getScriptVersion(baseUrl, "tee:user/contracts")` |
| 3 | Replace stubs with T3 canonical host WITs | ✅ **done 2026-06-25** | `host-tenant-1.0.0/` + `host-interfaces-2.1.0/`; old stubs deleted; build clean (see `response.md`) |
| 4 | Wire `forward()` to call `http::call` from inside the enclave | 🟡 unblocked, not yet written | Build no longer fails on the import; `scripts/grant-and-call.ts` is the verifier; live test gated on §4 outage |
| 5 | Aurora integration (`INTEGRATION-AURORA.md`) | ⏳ ready for the user's coding agent | `release-to-tenant` is the API |
| 6 | (Optional) `/internal/release/:name` HTTP route on the proxy | ⏳ designed in `INTEGRATION-AURORA.md` | Convenience for Aurora-style clients |

---

## 8. What changed since the last `current_status.md`

### 2026-06-25 — canonical host WITs implemented + tested

- **Swapped stubs for T3's canonical host WITs.** Added `contract/wit/deps/host-tenant-1.0.0/package.wit` and `host-interfaces-2.1.0/package.wit` (verbatim from the dev team; archived in repo-root `response.md`); deleted the old `host-tenant/` + `host-interfaces/` stub dirs.
- **`world.wit` now imports all four capabilities including `http`** — the import that previously 500'd at instantiation. Stale "do NOT import http" comment replaced.
- **Root cause confirmed:** the stub's `http.response` had a `headers` field; T3's canonical `response` is `{ code, payload }` only. `lib.rs`/`forward.rs` unchanged (the swap needed no code change, as the deps README predicted).
- **Build verified:** `cargo build --target wasm32-wasip2 --release` clean; `wasm-tools` confirms unused imports (`http`, `logging`) are tree-shaken out of the component.
- **Live seal/execute attempted, blocked by testnet outage** (§4): `register --from-env GITHUB_TOKEN`, a known-good re-seal, and a `release-to-tenant` all return `HTTP 500`. `verify` (handshake+auth) still green. request_ids captured for devrel.

### Earlier (2026-06-20)

- Found and verified the egress-grant API (`agent-auth-update` on `tee:user/contracts`). The 500s seen earlier were because we called `tenant.executeControl(...)` instead of `t3n.execute(...)` against a SYSTEM script.
- Re-verified release-broker SMTP path end-to-end — real email to `algsoch@gmail.com` (`messageId=da6e234c-c955-3712-8394-73cbf6fd7402@gmail.com`, Gmail `250 2.0.0 OK`).

---

## 9. One-sentence summary

The canonical host WITs landed and build cleanly, AND the live seal now works:
the `HTTP 500`s were never an outage — the `df48744c…` API key in `.env` simply
had no provisioned tenant (so even `me()` 500s), while the provisioned team key
t1 (tenant `58f5f5f9…`) seals `github_token` for real on the first try; what
remains is the optional `forward()`→`http::call` wiring for the pure
enclave-egress path.
