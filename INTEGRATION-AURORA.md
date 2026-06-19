# Integrating Blindfold into Aurora — coding-agent prompt

> **Paste this whole file into Claude Code / Cursor / Aider** working in `/Volumes/algsoch/research`. It tells the agent exactly what Aurora already has, what Blindfold can do, and what to change to make the WITH-Blindfold path *actually send the email* (not just refuse).

---

## TL;DR for the coding agent

Aurora has a working `EnclaveBroker` (`backend/app/blindfold_agent.py`) that holds an SMTP password in Python memory and uses it on behalf of an agent that only ever sees the sentinel. **Your job: replace the in-memory secret with a just-in-time fetch from the Blindfold project's T3-backed enclave.** Aurora's agent code does not change. Only `EnclaveBroker.__init__` + `read_inbox` + `send` change shape.

---

## What already exists (don't re-do)

### Aurora side (`/Volumes/algsoch/research`)
- `backend/app/blindfold_agent.py`
  - `EnclaveBroker(real_password)` — the *target* of this integration. Currently takes plaintext.
  - `EmailAgentRuntime(blindfolded=True)` — agent that *never* has the password when blindfolded; passes `SENTINEL` to the broker.
  - `_record(...)` — emits structured exposure events. Keep emitting these.
- `backend/app/api/blindfold.py` — WITHOUT/WITH side-by-side endpoint. Already calls our proxy at `settings.blindfold_proxy_url`.
- `backend/app/security/vault.py` — local Fernet vault. Keep as fallback when Blindfold REAL mode isn't configured; mark it Phase-1.
- `backend/app/security/exposure.py` — scanner that detects secret bytes crossing boundaries. Don't touch — its job is to find ZERO matches in the blindfolded path.

### Blindfold side (`/Volumes/algsoch/terminal 3`)
- `npm run blindfold -- register --name <K>` — seal a secret into T3's TDX-enclave KV map. Working live.
- `npm run blindfold -- proxy` — OpenAI/Anthropic/xAI-shaped HTTP proxy. Routes `/v1/*`, `/anthropic/*`, `/x/*`, `/groq/*`. **Today's gap:** the contract's in-enclave `http::call` returns an opaque T3 500 (canonical host WITs not yet shipped). For HTTPS LLM traffic, this means the proxy can route to T3 + auth + read the secret in-enclave, but the actual outbound HTTPS call from inside the enclave fails.
- `docs/02-terminal3-analysis.md` — every T3 surface we use, verbatim.
- `docs/03-architecture.md` — the full Blindfold architecture.
- `tests/smtp-demo.md` — proof that sealing + deleting the .env line removes the leak surface. Demonstrates the "without" path (real email sent) but the "with" path currently refuses to send. **Closing that is what this integration is for.**

---

## Architecture after this integration

```
Aurora agent (blindfolded=True)
   │ uses SMTP/IMAP tool
   ▼
EmailAgentRuntime  ──► passes SENTINEL to broker
   │
   ▼
EnclaveBroker (NEW: thin shim, no plaintext in __init__)
   │ calls Blindfold via local HTTP
   ▼
Blindfold release-broker (NEW endpoint on the proxy)
   │ authenticates as the T3 tenant (T3N_API_KEY)
   ▼
T3 contract: release_to_tenant(secret_key)         ◄── runs inside TDX
   │ kv_store::get("z:<tid>:secrets", secret_key)
   ▼
returns plaintext over T3's encrypted session
   │
Blindfold release-broker hands it back to EnclaveBroker
   │
EnclaveBroker uses it for SMTP login, drops it after the call
```

**Threat-model improvement vs. today:**
- Aurora's Fernet vault: secret on disk encrypted with a local key, decrypted into Python for the call.
- After this integration: secret at rest only in T3's TDX-encrypted KV; decrypted only when the broker asks; broker process holds it for *one call*; gone after.
- After T3 ships canonical http::call WITs: secret never enters the broker at all — T3 makes the SMTP call directly (use the existing `tenant.contracts.execute` path; the broker becomes a no-op forwarder).

---

## Two things to add on the Blindfold side

The coding agent should add these in `/Volumes/algsoch/terminal 3` (Blindfold project) and commit/push there.

### B1. New contract function `release_to_tenant`

In `contract/src/forward.rs`, add a second exported function:

```rust
pub fn release_to_tenant(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let req: Release = serde_json::from_slice(input_bytes)?;
    let secret = read_secret(&req.secret_key)?; // same KV read we already use
    Ok(serde_json::to_vec(&serde_json::json!({
        "ok": true,
        "value": secret,   // plaintext — only returned over the T3-encrypted session to the authenticated tenant
    }))?)
}

#[derive(Deserialize)] struct Release { secret_key: String }
```

Wire it into `contract/wit/world.wit`:

```wit
interface contracts {
  // …existing…
  release-to-tenant: func(req: generic-input) -> result<list<u8>, string>;
}
```

Bump `CONTRACT_VERSION` in `packages/blindfold/src/constants.ts`. Rebuild + republish via `npm run blindfold -- init --skip-build false`.

### B2. New proxy endpoint `/internal/release/:name`

In `packages/blindfold/src/proxy.ts`, add a route the local broker can hit:

```ts
if (req.method === "POST" && req.url?.startsWith("/internal/release/")) {
  // Bound to 127.0.0.1 only (already true) — never expose this on a public port.
  const name = req.url.slice("/internal/release/".length);
  const r = await t3.invokeRelease(name);   // calls release-to-tenant; returns { ok, value }
  res.writeHead(200, {"content-type": "application/json"});
  res.end(JSON.stringify({ ok: true, value: r.value }));
  return;
}
```

Add `invokeRelease(name)` to `T3ClientHandle` (`packages/blindfold/src/t3-client.ts`) — same shape as `invokeForward` but calls `release_to_tenant`.

**Audit note:** `/internal/release/*` is the only Blindfold endpoint that ever returns plaintext over the wire. Keep it bound to `127.0.0.1`. Add a `BLINDFOLD_RELEASE_DISABLE=1` env flag that 403s the route, so production deployments that don't need release can lock it off.

---

## Three things to change on the Aurora side

The coding agent should make these in `/Volumes/algsoch/research` (Aurora project) and commit there.

### A1. `EnclaveBroker` becomes a thin HTTP client

`backend/app/blindfold_agent.py`:

```python
class EnclaveBroker:
    """Fetches the real secret just-in-time from Blindfold's local release broker.
    The broker process holds the plaintext for the duration of one call, never longer.
    """
    def __init__(self, secret_name: str = "smtp_password", blindfold_url: str | None = None):
        self.secret_name = secret_name
        self.url = blindfold_url or settings.blindfold_proxy_url

    async def _fetch(self) -> str:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(f"{self.url}/internal/release/{self.secret_name}")
            r.raise_for_status()
            return r.json()["value"]

    async def read_inbox(self, address, supplied, n, with_body=False):
        if supplied != SENTINEL: return {"ok": False, "error": "broker expected the sentinel"}
        pw = await self._fetch()
        try:
            return await fetch_latest_emails(address, pw, n, with_body)
        finally:
            del pw  # not a real wipe; signals intent + drops the strong ref

    async def send(self, address, supplied, to, subject, body, in_reply_to=None):
        if supplied != SENTINEL: return {"ok": False, "error": "broker expected the sentinel"}
        pw = await self._fetch()
        try:
            return await send_email(address, pw, to, subject, body, in_reply_to)
        finally:
            del pw
```

Constructor no longer needs the plaintext password. `EmailAgentRuntime.__init__` should drop its `real_pw` parameter when `blindfolded=True`.

### A2. Add a Blindfold-backed vault adapter alongside the Fernet one

`backend/app/security/blindfold_vault.py` (new):

```python
"""T3-backed vault. Same interface as Vault but values live in the T3 enclave."""
class BlindfoldVault:
    def __init__(self, proxy_url: str): ...
    async def add(self, name: str, secret: str) -> dict:
        # POST plaintext ONCE to a hypothetical /internal/seal endpoint that shells out to
        # `blindfold register --name <name>` via stdin. (Or in-process via the SDK.)
        # NOTE: this is the only path where Aurora touches plaintext.
        ...
    async def fingerprint_of(self, name: str) -> str:
        # The scanner still needs a fingerprint to detect leaks. Compute SHA256 of the
        # value once at seal time and cache; do NOT keep the value.
        ...
```

Aurora's existing exposure scanner should keep watching for any of the fingerprints. With Blindfold, those fingerprints should *never* appear in any boundary text — that's what the harness proves.

### A3. Side-by-side endpoint already exists — wire the new broker through it

`backend/app/api/blindfold.py` calls `EnclaveBroker(...)`. Change:
- `WITHOUT`: pass `real_password=...` (current path).
- `WITH`: construct `EnclaveBroker(secret_name="smtp_password")` (no plaintext arg).

The endpoint then runs both. Aurora's exposure detector should see secret bytes in WITHOUT, none in WITH. **This is the test rig's pass/fail criterion.**

---

## Success criteria (what done looks like)

1. `npm run demo:smtp` in the Blindfold project, after removing `smtp_password` from `.env`, still refuses to send — that's a true negative.
2. Aurora's WITH-Blindfold email send works end-to-end (real email arrives at the destination) **without** `smtp_password` ever appearing in `aurora` process memory's `id()` for that string.
3. Aurora's exposure scanner reports `findings: []` for every boundary in the WITH path; `severity: CRITICAL` for the WITHOUT path on the same content.
4. Killing the Blindfold proxy mid-call returns a typed error to Aurora (broker fetch fails) — not silent fallback. Aurora's harness logs the failure as an exposure event with reason "broker unreachable".
5. `BLINDFOLD_RELEASE_DISABLE=1` makes the `/internal/release/*` route 403; Aurora correctly surfaces "release path disabled" without crashing.

---

## What is *not* in scope (do not attempt)

- Don't try to fix the in-enclave `http::call` 500. That gap is gated on T3 shipping canonical host WITs — confirmed by 12+ probe attempts. See `explain.md` "NEEDS VERIFICATION" item #7.
- Don't replace Aurora's Fernet vault outright. Keep it as a fallback for when `BLINDFOLD_T3_ENV` is unset or `REAL` mode can't reach T3 — Aurora's dashboard should show clearly which backend each secret lives in.
- Don't add new ML/agent capabilities. This integration is purely about *where the secret lives* and *how it's released*.

---

## Threat-model honest statement (for Aurora's README + dashboard)

After this integration:

| Where the SMTP password exists | Today (Fernet) | After Blindfold integration |
|---|---|---|
| In `.env` on disk | only briefly before seal | no |
| Encrypted on Aurora's disk | yes (Fernet) | no |
| In Aurora process memory | for the lifetime of the broker | only during one IMAP/SMTP call |
| In Blindfold broker process | n/a | only during one release call |
| In T3 TDX enclave | n/a | always (canonical copy) |
| In the agent runtime (the prompt-injection target) | **no, both today and after** | **no, both today and after** |

The integration *narrows* the leak window from "agent process lifetime" to "one call". The agent process — the actual injection surface — never has the value in either model. The fully-zero-leak-window version (secret never leaves the enclave even for the broker) is the post-T3-WITs state.

---

## How to run the integration end-to-end (acceptance test)

```bash
# Blindfold side (terminal 1)
cd /Volumes/algsoch/terminal\ 3
npm run blindfold -- register --name smtp_password   # interactive prompt
npm run blindfold -- proxy                            # leave running

# Aurora side (terminal 2)
cd /Volumes/algsoch/research
uv run uvicorn app.main:app                          # backend
# In yet another terminal:
cd /Volumes/algsoch/research/frontend && npm run dev # UI

# Hit the side-by-side endpoint:
curl -X POST localhost:8000/blindfold/email-send-test \
  -d '{"to":"algsoch@gmail.com","subject":"WITH Blindfold","body":"sent via T3-backed enclave broker"}'
# Both WITHOUT and WITH paths should succeed in sending; exposure detector should
# log CRITICAL for WITHOUT, clean for WITH.
```

When this works, write the result up in Aurora's `STATUS.md` and Blindfold's `explain.md`.
