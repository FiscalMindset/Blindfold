# Blindfold — Output & Test Analysis

> A living analysis of what Blindfold does, run-by-run. Every `npm run test:report` appends a new run block at the **top** of the "Test runs" section below — nothing here gets overwritten.

## How this file is updated

```bash
npm run test:report      # runs the full battery, appends a timestamped block
```

The script lives at `scripts/run-tests.ts` and exits non-zero if any check fails.

## What each test analyses

### T1 — Side-by-side demo (the headline claim)

- **Without Blindfold (Agent A):** `OPENAI_API_KEY=sk-live-…` is in the agent's env. The agent fetches an injected page, the model takes the bait, calls `get_env("OPENAI_API_KEY")`, exfiltrates the value to the attacker URL.
- **With Blindfold (Agent B):** `OPENAI_API_KEY=__BLINDFOLD__`; the real key lives only in T3. The same code, same model, same injection — but `get_env` returns the sentinel, so the only thing that reaches the attacker is the sentinel.
- **What happens:** A leaks the real key; B leaks only the sentinel; both complete the legitimate summarisation task. Exit code asserted = 0.

### T2 — CLI doctor

- **Without it:** there's no way to confirm whether the wrapper actually has T3 credentials before you try to use it.
- **With it:** `blindfold doctor` reports REAL vs MOCK mode + which env keys are set. Catches misconfiguration at the cheapest possible point.
- **What happens:** asserts `T3N_API_KEY set: yes` and `DID set: yes` from your real `.env`.

### T3 — register never logs the secret

- **Without it:** every line in the wrapper is a potential leak surface for the developer's plaintext key.
- **With it:** the value enters one function (`registerSecret`), is passed straight to T3's `executeControl("map-entry-set", …)`, and goes out of scope. Audit-critical.
- **What happens:** runs register with a fake secret `sk-test-DO-NOT-LEAK-<ts>` and greps every byte of stdout + stderr. If the secret appears anywhere, the test fails loudly.

### T4 — proxy /health

- **Without it:** can't tell from inside an agent whether the proxy is up before sending real traffic.
- **With it:** `GET /health` → `{ok:true, mock:…}` is the trivial readiness probe.

### T5 — proxy forward

- **Without it:** the wrapper isn't useful — there's no plumbing.
- **With it:** the proxy accepts an OpenAI-shaped request (with a fake bearer the agent sent), routes it to `invokeForward`, returns a response.
- **What happens:** in MOCK mode this returns the local stub; in REAL mode it would route through T3 → OpenAI.

### T6 — proxy log scrubbing (auditor-critical)

- **Without it:** even if the proxy *substitutes* the sentinel, accidental log lines could still echo the agent-supplied header value.
- **With it:** `safeLog` scrubs known sensitive headers; the test sends a unique bearer like `sk-FAKE-AGENT-BEARER-<ts>` and `grep`s the full stderr log for that exact string.
- **What happens:** the bearer must not appear anywhere. If it does, the test fails.

### T7 — wrap() removes the real key

- **Without it:** developers using `wrap(new OpenAI())` might wrongly assume the SDK still holds their real key.
- **With it:** `wrap()` overwrites both `baseURL` (→ proxy) and `apiKey` (→ sentinel) on the SDK object. The original key field is gone.
- **What happens:** asserts `apiKey === "__BLINDFOLD__"` and `baseURL === "http://127.0.0.1:8787/v1"` after wrapping.

### T8 — log helper scrubs sensitive headers

- **Without it:** any future logging change could accidentally include header values.
- **With it:** `redact()` handles both object and tuple-array header shapes, plus top-level fields named `cookie`/`set-cookie`/etc.
- **What happens:** runs four planted secrets through `redact()` and asserts none survive in the JSON output.

### T9 — usage log smoke test

- **Without it:** we'd have no visibility into how the proxy is being used.
- **With it:** every forwarded request appends a JSON line to `.blindfold/usage.jsonl` — metadata only (provider, path, status, latency, sentinel_in_outbound). The dashboard and `blindfold stats` read from this file.
- **What happens:** spawns a proxy with `BLINDFOLD_USAGE_LOG` pointed at a temp file, fires one request, reads the file, asserts the event has the right shape and `sentinel_in_outbound === true`.

## Test runs

<!-- TEST_RUNS_BELOW -->
### Real-T3 run 2026-06-19 19:11:26 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781896283" len=19 (value never logged) |
| S3 | contracts.register | 🚨 | HTTP 403: Forbidden ({"code":"forbidden","detail":"InsufficientCredit (account=256ddb4f2fa02414f473ff75bc7572af01117654, required=10000, available=0)","request_id":"a5127f2f-2bf0-41ae-8932-f5ab617abdea"}) |
| S4 | contracts.execute | ⚠️ | contract not published — can't exercise execute path |

### Real-T3 run 2026-06-19 19:10:58 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781896256" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=245; wasm=97,588B |
| S3b | maps.update(secrets, readers: only) | ✅ | granted read for contract_id=245 |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 500: Internal error [a25783af-ff5a-4f0d-9169-caa33d678276] ({"code":"internal_error","request_id":"a25783af-ff5a-4f0d-9169-caa33d678276"}) |

### Real-T3 run 2026-06-19 19:08:15 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781896090" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=244; wasm=97,588B |
| S3b | maps.update(secrets, readers: only) | ✅ | granted read for contract_id=244 |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 500: Internal error [2b8fe83c-760f-4100-a211-7255da75a20c] ({"code":"internal_error","request_id":"2b8fe83c-760f-4100-a211-7255da75a20c"}) |

### Real-T3 run 2026-06-19 19:07:14 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781896031" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=243; wasm=90,067B |
| S3b | maps.update(secrets, readers: only) | ✅ | granted read for contract_id=243 |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 500: Internal error [809e26d7-94ac-42bd-8df8-423ffa747be6] ({"code":"internal_error","request_id":"809e26d7-94ac-42bd-8df8-423ffa747be6"}) |

### Real-T3 run 2026-06-19 19:06:07 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781895963" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=242; wasm=1,56,946B |
| S3b | maps.update(secrets, readers: only) | ✅ | granted read for contract_id=242 |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 500: Internal error [a9019131-966b-4a57-85b7-fe76e0f683a2] ({"code":"internal_error","request_id":"a9019131-966b-4a57-85b7-fe76e0f683a2"}) |

### Real-T3 run 2026-06-19 18:56:56 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781895414" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=241; wasm=88,219B |
| S3b | maps.update(secrets, readers: only) | ✅ | granted read for contract_id=241 |
| S4 | contracts.execute (httpbin echo) | 🚨 | The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined |

### Real-T3 run 2026-06-19 18:55:49 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781895340" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=240; wasm=1,55,883B |
| S3b | maps.update(secrets, readers: only) | ✅ | granted read for contract_id=240 |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 500: Internal error [1d62de72-dbb6-49a4-a92c-bd253d04b05d] ({"code":"internal_error","request_id":"1d62de72-dbb6-49a4-a92c-bd253d04b05d"}) |

### Real-T3 run 2026-06-19 18:50:01 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781894999" len=19 (value never logged) |
| S3 | contracts.register | ✅ | already registered at this version (idempotent): HTTP 400: Invalid params ({"code":"bad_request","detail":"contract version invalid: version 0.1.4 is |
| S4 | contracts.execute (httpbin echo) | 🚨 | The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined |

### Real-T3 run 2026-06-19 18:47:41 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781894860" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=239; wasm=1,51,686B |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 400: Invalid params ({"code":"bad_request","detail":"kv_store.get error: \"kv_store.get on 'z:256ddb4f2fa02414f473ff75bc7572af01117654:secrets' read denied: access denied: TenantContract(did:t3n:256ddb4f2fa02414f473ff75bc7572af01117654 |

### Real-T3 run 2026-06-19 18:46:58 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781894816" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=238; wasm=93,473B |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 400: Invalid params ({"code":"bad_request","detail":"kv read failed: \"kv_store.get on 'z:256ddb4f2fa02414f473ff75bc7572af01117654:secrets' read denied: access denied: TenantContract(did:t3n:256ddb4f2fa02414f473ff75bc7572af01117654/238 |

### Real-T3 run 2026-06-19 18:45:11 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781894709" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=237; wasm=88,211B |
| S4 | contracts.execute (httpbin echo) | 🚨 | The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined |

### Real-T3 run 2026-06-19 18:44:32 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781894670" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=236; wasm=1,56,028B |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 500: Internal error [e8590d63-9d60-4c26-8498-2f639de18a19] ({"code":"internal_error","request_id":"e8590d63-9d60-4c26-8498-2f639de18a19"}) |

### Real-T3 run 2026-06-19 18:34:12 UTC

| # | Step | Status | Detail |
|---|------|--------|--------|
| S1 | handshake + authenticate | ✅ | round-trip succeeded |
| S2 | executeControl(map-entry-set) | ✅ | wrote key="blindfold_test_1781894051" len=19 (value never logged) |
| S3 | contracts.register | ✅ | contract_id=234; wasm=1,57,989B |
| S4 | contracts.execute (httpbin echo) | 🚨 | HTTP 500: Internal error [280a8685-a21b-494b-ae8b-b8e64a3ce382] ({"code":"internal_error","request_id":"280a8685-a21b-494b-ae8b-b8e64a3ce382"}) |

### Run 2026-06-19 18:18:14 UTC

**✅ ALL PASS** — 9/9 tests passed.

| # | Test | Status | Detail |
|---|------|--------|--------|
| T1 | Side-by-side demo (A leaks real key, B leaks only sentinel) | ✅ | exit=0; A_leaked_real=true; B_sentinel_only=true |
| T2 | CLI doctor detects T3N_API_KEY + DID | ✅ | Blindfold doctor: \|   mode:               REAL (T3 testnet/prod) |
| T3 | register never logs the plaintext secret | ✅ | value never appeared in stdout/stderr |
| T4 | proxy /health responds | ✅ | status=200 body={"ok":true,"mock":true} |
| T5 | proxy forwards and returns a response | ✅ | status=200 body~={"mock":true,"note":"Blindfold mock mode — no real call made.","echo":{"url":"ht |
| T6 | proxy logs do NOT contain agent-supplied Authorization | ✅ | no bearer in 402 log bytes |
| T7 | wrap() mutates client: real key → sentinel | ✅ | output={"ok":true,"baseURL":"http://127.0.0.1:8787/v1","apiKey":"__BLINDFOLD__"} |
| T8 | redact() strips authorization / x-api-key / cookie | ✅ | output={"ok":true,"sample":"{\"a\":{\"headers\":{\"authorization\":\"[redacted]\"}},\"b\":{\"headers\":[[\"Authorization\",\"[redacted]\"],[\"X-API-Key\",\"[red |
| T9 | usage log records the request (metadata only) | ✅ | event={"t":"2026-06-19T18:18:14.225Z","mode":"mock","provider":"openai","method":"POST","path":"/v1/chat/completions","upstream":"https://api.openai.com/v1/chat |

### Run 2026-06-19 18:02:17 UTC

**✅ ALL PASS** — 9/9 tests passed.

| # | Test | Status | Detail |
|---|------|--------|--------|
| T1 | Side-by-side demo (A leaks real key, B leaks only sentinel) | ✅ | exit=0; A_leaked_real=true; B_sentinel_only=true |
| T2 | CLI doctor detects T3N_API_KEY + DID | ✅ | Blindfold doctor: \|   mode:               REAL (T3 testnet/prod) |
| T3 | register never logs the plaintext secret | ✅ | value never appeared in stdout/stderr |
| T4 | proxy /health responds | ✅ | status=200 body={"ok":true,"mock":true} |
| T5 | proxy forwards and returns a response | ✅ | status=200 body~={"mock":true,"note":"Blindfold mock mode — no real call made.","echo":{"url":"ht |
| T6 | proxy logs do NOT contain agent-supplied Authorization | ✅ | no bearer in 402 log bytes |
| T7 | wrap() mutates client: real key → sentinel | ✅ | output={"ok":true,"baseURL":"http://127.0.0.1:8787/v1","apiKey":"__BLINDFOLD__"} |
| T8 | redact() strips authorization / x-api-key / cookie | ✅ | output={"ok":true,"sample":"{\"a\":{\"headers\":{\"authorization\":\"[redacted]\"}},\"b\":{\"headers\":[[\"Authorization\",\"[redacted]\"],[\"X-API-Key\",\"[red |
| T9 | usage log records the request (metadata only) | ✅ | event={"t":"2026-06-19T18:02:17.148Z","mode":"mock","provider":"openai","method":"POST","path":"/v1/chat/completions","upstream":"https://api.openai.com/v1/chat |

### Run 2026-06-19 17:43:06 UTC

**✅ ALL PASS** — 9/9 tests passed.

| # | Test | Status | Detail |
|---|------|--------|--------|
| T1 | Side-by-side demo (A leaks real key, B leaks only sentinel) | ✅ | exit=0; A_leaked_real=true; B_sentinel_only=true |
| T2 | CLI doctor detects T3N_API_KEY + DID | ✅ | Blindfold doctor: \|   mode:               REAL (T3 testnet/prod) |
| T3 | register never logs the plaintext secret | ✅ | value never appeared in stdout/stderr |
| T4 | proxy /health responds | ✅ | status=200 body={"ok":true,"mock":true} |
| T5 | proxy forwards and returns a response | ✅ | status=200 body~={"mock":true,"note":"Blindfold mock mode — no real call made.","echo":{"url":"ht |
| T6 | proxy logs do NOT contain agent-supplied Authorization | ✅ | no bearer in 402 log bytes |
| T7 | wrap() mutates client: real key → sentinel | ✅ | output={"ok":true,"baseURL":"http://127.0.0.1:8787/v1","apiKey":"__BLINDFOLD__"} |
| T8 | redact() strips authorization / x-api-key / cookie | ✅ | output={"ok":true,"sample":"{\"a\":{\"headers\":{\"authorization\":\"[redacted]\"}},\"b\":{\"headers\":[[\"Authorization\",\"[redacted]\"],[\"X-API-Key\",\"[red |
| T9 | usage log records the request (metadata only) | ✅ | event={"t":"2026-06-19T17:43:06.058Z","mode":"mock","provider":"openai","method":"POST","path":"/v1/chat/completions","upstream":"https://api.openai.com/v1/chat |

### Run 2026-06-19 17:17:03 UTC

**✅ ALL PASS** — 9/9 tests passed.

| # | Test | Status | Detail |
|---|------|--------|--------|
| T1 | Side-by-side demo (A leaks real key, B leaks only sentinel) | ✅ | exit=0; A_leaked_real=true; B_sentinel_only=true |
| T2 | CLI doctor detects T3N_API_KEY + DID | ✅ | Blindfold doctor: \|   mode:               REAL (T3 testnet/prod) |
| T3 | register never logs the plaintext secret | ✅ | value never appeared in stdout/stderr |
| T4 | proxy /health responds | ✅ | status=200 body={"ok":true,"mock":true} |
| T5 | proxy forwards and returns a response | ✅ | status=200 body~={"mock":true,"note":"Blindfold mock mode — no real call made.","echo":{"url":"ht |
| T6 | proxy logs do NOT contain agent-supplied Authorization | ✅ | no bearer in 402 log bytes |
| T7 | wrap() mutates client: real key → sentinel | ✅ | output={"ok":true,"baseURL":"http://127.0.0.1:8787/v1","apiKey":"__BLINDFOLD__"} |
| T8 | redact() strips authorization / x-api-key / cookie | ✅ | output={"ok":true,"sample":"{\"a\":{\"headers\":{\"authorization\":\"[redacted]\"}},\"b\":{\"headers\":[[\"Authorization\",\"[redacted]\"],[\"X-API-Key\",\"[red |
| T9 | usage log records the request (metadata only) | ✅ | event={"t":"2026-06-19T17:17:02.929Z","mode":"mock","provider":"openai","method":"POST","path":"/v1/chat/completions","upstream":"https://api.openai.com/v1/chat |

### Run 2026-06-19 17:12:43 UTC

**✅ ALL PASS** — 9/9 tests passed.

| # | Test | Status | Detail |
|---|------|--------|--------|
| T1 | Side-by-side demo (A leaks real key, B leaks only sentinel) | ✅ | exit=0; A_leaked_real=true; B_sentinel_only=true |
| T2 | CLI doctor detects T3N_API_KEY + DID | ✅ | Blindfold doctor: \|   mode:               REAL (T3 testnet/prod) |
| T3 | register never logs the plaintext secret | ✅ | value never appeared in stdout/stderr |
| T4 | proxy /health responds | ✅ | status=200 body={"ok":true,"mock":true} |
| T5 | proxy forwards and returns a response | ✅ | status=200 body~={"mock":true,"note":"Blindfold mock mode — no real call made.","echo":{"url":"ht |
| T6 | proxy logs do NOT contain agent-supplied Authorization | ✅ | no bearer in 402 log bytes |
| T7 | wrap() mutates client: real key → sentinel | ✅ | output={"ok":true,"baseURL":"http://127.0.0.1:8787/v1","apiKey":"__BLINDFOLD__"} |
| T8 | redact() strips authorization / x-api-key / cookie | ✅ | output={"ok":true,"sample":"{\"a\":{\"headers\":{\"authorization\":\"[redacted]\"}},\"b\":{\"headers\":[[\"Authorization\",\"[redacted]\"],[\"X-API-Key\",\"[red |
| T9 | usage log records the request (metadata only) | ✅ | event={"t":"2026-06-19T17:12:43.080Z","mode":"mock","provider":"openai","method":"POST","path":"/v1/chat/completions","upstream":"https://api.openai.com/v1/chat |

