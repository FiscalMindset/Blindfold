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

