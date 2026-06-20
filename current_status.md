# Blindfold — Current Status (as of 2026-06-20, after T3 team feedback)

> Snapshot. Read top to bottom. §2 is the headline.

---

## 1. What the T3 team told us

The T3 dev team responded to our `http::call` gap and answered all three open items:

1. **Naming convention** — kebab-case on the wire (`"release-to-tenant"`, not `"release_to_tenant"`). We had already discovered this.
2. **Egress authorization** — pointed at `docs/.../invoke-contract`. Confirmed: the missing step was `t3n.execute({ script_name: "tee:user/contracts", script_version: "2.10.2", function_name: "agent-auth-update", input: { agents: [{ agentDid, scripts: [{ scriptName, versionReq, functions, allowedHosts }] }] } })`. We had been calling `tenant.executeControl` against control-plane action names — wrong API. The correct one is a SYSTEM script (`tee:user/contracts`), accessed via `t3n.execute` (not `tenant.executeControl`), looked up via `getScriptVersion(rpcUrl, "tee:user/contracts")`.
3. **`http` capability should not be gated** — confirmed by docs, but importing it on this tenant still breaks the contract at instantiation. Likely cause: our best-effort WIT stub for `host:interfaces/http@2.1.0` has signatures that don't match T3's runtime expectation. The team explicitly said: *"if you still find any barriers, please try a workaround or hardcode certain parts with assumptions so the demo can work — also please note where in the project you did that and reflect the difficulty. We'd totally understand and will reflect this to the core eng team."*

§3 records the workaround per their request.

---

## 2. Headline (after applying everything T3 said)

| Capability | Status | How |
|---|---|---|
| **Egress authorization** (the previously-mysterious 500 vector) | ✅ **NOW VERIFIED** | `scripts/grant-and-call.ts`: granted `agentDid=<tenant>`, `scripts=[{scriptName, versionReq:">=0.5.0", functions:["forward","release-to-tenant"], allowedHosts:["api.x.ai"]}]`. Accepted: `tx_hash: tx:302:53785`. |
| **Contract-internal `http::call` from inside TDX** (the dream path) | 🚧 **blocked by WIT stub mismatch** | Importing `host:interfaces/http@2.1.0` causes the contract to 500 *at instantiation*, even on functions that never call `http::call`. The egress grant is no longer the blocker. The blocker is our `wit/deps/host-interfaces/world.wit` stub for the http interface — signatures don't match T3's runtime. Per T3 team: workaround now, replace stub with canonical when shipped. |
| **Sealed AND used end-to-end via release-broker** | ✅ **verified live (again, just now)** | `scripts/smtp-with-blindfold.ts` sent a real email to `algsoch@gmail.com`. Contract v0.5.1, `messageId=da6e234c-c955-3712-8394-73cbf6fd7402@gmail.com`, Gmail `250 2.0.0 OK`. `process.env.smtp_password` absent throughout. |

The blunt translation: the **only** thing standing between us and the philosophically-pure "secret never leaves the enclave even briefly" mode is T3 publishing the canonical `host:interfaces/http@2.1.0` WIT file. Everything else — including the egress authorization that we and the T3 team thought was the blocker — is now wired and working.

---

## 3. Workaround in use (per T3 team's go-ahead)

| Where | What | Why |
|---|---|---|
| `contract/wit/world.wit` | `host:interfaces/http@2.1.0` is **NOT** imported. Comment at the top of the file explains why and how to migrate when the canonical WIT lands. | Importing our best-effort stub for http causes the contract to fail at instantiation, even when the function never calls `http::call`. T3 team said it shouldn't be gated, so this is a stub-signature mismatch. |
| `contract/src/forward.rs` | `forward()` no longer makes an outbound call. It reads the secret, performs the sentinel substitution, returns `secret_len` + `authorization_header_len_after_substitution` (lengths only, never the value) — proof that the in-enclave substitution works. `release_to_tenant()` returns the plaintext to the authenticated tenant over T3's encrypted session. | The in-enclave call requires the http import we can't safely include yet. |
| `scripts/smtp-with-blindfold.ts` + `INTEGRATION-AURORA.md`'s `EnclaveBroker` | Calls `release-to-tenant`, holds the plaintext in the local broker process for **one** outbound call (Gmail SMTP), drops it. | This is the production-viable pattern today. Agent's process — the prompt-injection target — never sees the value. |
| `scripts/grant-and-call.ts` | Implements the full egress-grant + http-call flow exactly as the T3 docs describe. Currently hits the WIT-stub mismatch on execute. **Keep this file** — it's the migration test once T3 ships the canonical WIT. | So we have a one-command verification when the upstream fix lands. |

**Difficulty surfaced for the T3 core eng team** (per their request):

- Importing `host:interfaces/http@2.1.0` in `contract/wit/world.wit` with our best-effort signatures causes T3's runtime to reject the contract — every `tenant.contracts.execute` returns `HTTP 500 internal_error` with no typed body, even for functions that don't use http. `tenant.contracts.logs(...)` returns empty for these failures. We genuinely cannot guess the canonical signature without T3 publishing the host WIT files.
- We tried two signature variants for the http record fields (`option<list<tuple<string,string>>>` vs `list<tuple<string,list<u8>>>` for headers; `option<list<u8>>` vs `list<u8>` for payload/body). Both produce the same opaque 500 at contract execute time.
- The egress-grant docs at `invoke-contract.md` are clear; what's missing is a published canonical `host:interfaces/http@2.1.0` WIT file (and ideally `host:tenant/tenant-context@1.0.0`, `host:interfaces/kv-store@2.1.0`, `host:interfaces/logging@2.1.0`).

---

## 4. Verified-live matrix

| Layer | Status | Evidence |
|---|---|---|
| `blindfold doctor` / `verify` / `init` / `register` / `compat` / `proxy` / `dashboard` / `stats` | ✅ | All exercised against the new tenant; `npm run test:report` 9/9 ✅ |
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
| Contract-internal `http::call` (dream path) | 🚧 | Blocked on canonical T3 host WIT — workaround in place |

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

- **`.env`:** `T3N_API_KEY`, `DID`, `GROK_API_KEY`, `smtp_email`, `smtp_host`, `SMTP_PASSWORD`.
  - 🚧 *Action:* delete `GROK_API_KEY` and `SMTP_PASSWORD` lines — both are sealed in the enclave; the `.env` copy is leak surface.
- **Tenant `did:t3n:3abddb60dd62cbd6a95175771a4e642daee81729`** (testnet):
  - `secrets` map: ✅ holds `grok_api_key`, `smtp_password`, plus historical `blindfold_test_<ts>` entries.
  - `authorised-hosts` map: ✅ exists (T3 may or may not consult it; the real egress mechanism is `agent-auth-update`, not this map).
  - `blindfold-proxy` contract: ✅ v0.5.1 (contract_id 285). ACLs granted. **Egress grant for `api.x.ai` accepted** (tx `tx:302:53785`).
  - Contract slot usage: well within quota (we've been republishing the same tail).
- **`@terminal3/t3n-sdk`** v3.9 installed. REAL mode is the default.

---

## 7. Punch list (updated)

| # | Action | Status | Why |
|---|---|---|---|
| 1 | Delete `GROK_API_KEY` + `SMTP_PASSWORD` from `.env` | ❗ pending user | 5 sec; both are sealed |
| 2 | Egress-grant API discovered + working | ✅ done this session | `agent-auth-update`, `tee:user/contracts` v2.10.2, `getScriptVersion(baseUrl, "tee:user/contracts")` |
| 3 | `http::call` from inside the enclave | 🚧 blocked on canonical T3 host WIT | T3 team aware; workaround in production use |
| 4 | Replace `contract/wit/deps/host-interfaces/world.wit` with T3 canonical | ❗ waiting on T3 to publish | Single file swap; `scripts/grant-and-call.ts` is the verifier |
| 5 | Aurora integration (`INTEGRATION-AURORA.md`) | ⏳ ready for the user's coding agent | `release-to-tenant` is the API |
| 6 | (Optional) `/internal/release/:name` HTTP route on the proxy | ⏳ designed in `INTEGRATION-AURORA.md` | Convenience for Aurora-style clients |

---

## 8. What changed since the last `current_status.md`

- Found and verified the egress-grant API (`agent-auth-update` on `tee:user/contracts`). The 500s we saw earlier were because we called `tenant.executeControl(...)` instead of `t3n.execute(...)` against a SYSTEM script.
- Confirmed via bisection that just *importing* our best-effort `host:interfaces/http@2.1.0` WIT stub causes T3 to reject the contract at instantiation. Reverted contract to no-http per T3 team's explicit "use a workaround" guidance.
- Re-verified release-broker SMTP path end-to-end on the post-T3-team-feedback build — sent another real email to `algsoch@gmail.com` (`messageId=da6e234c-c955-3712-8394-73cbf6fd7402@gmail.com`, Gmail `250 2.0.0 OK`).
- Kept `scripts/grant-and-call.ts` in tree as the one-command verifier for when T3 ships the canonical WIT.

---

## 9. One-sentence summary

After T3 team feedback we resolved the egress-authorization gap (it's `agent-auth-update`, not `executeControl`) and isolated the remaining blocker to one specific file (`contract/wit/deps/host-interfaces/world.wit`'s stub signatures for `host:interfaces/http@2.1.0`) — the release-broker workaround is in production today and verified by another real email send.
