# Blindfold Integration Stack

*How Blindfold went from a 4-endpoint LLM-key proxy to a real, multi-industry
secret proxy with in-enclave provider auth — what changed, why, and the impact.*

---

## Why this work exists

Product feedback (Terminal 3 PM, competitive review): Blindfold ranked just
outside the top 10. The two named gaps:

1. **Integration coverage / stack score is lower than the rest.**
2. **The problem being solved isn't as concrete or distinct as other projects.**

Both traced to the same root cause in the code.

### The root cause

The enclave's substitution was a blind string replace (`contract/src/forward.rs`):

```rust
.map(|(k, v)| (k.clone(), v.replace(SENTINEL, &secret)))
```

That only works for **one** auth scheme — `Authorization: Bearer <token>`. So the
proxy could only ever route providers that share it. Unsurprisingly, all four
supported upstreams were LLM APIs (OpenAI, Anthropic, xAI, Groq). Meanwhile the
pitch claimed *"your agent holds its OpenAI / **Stripe** / Anthropic key"* —
Stripe and every non-LLM provider were unbacked. A judge scoring "integration
stack" saw four near-identical LLM endpoints, not a moat.

The instruction that shaped the fix: **"I do not want generic — I want proper
industry-based, not faking generic."** A generic host-allowlist passthrough that
keeps doing the dumb replace against more hostnames would *look* like breadth
while adding none. Real breadth means teaching the enclave each provider's actual
auth computation.

---

## What changed

### 1. In-enclave provider auth schemes (`contract/src/auth.rs`, `forward.rs`)

The enclave now applies the **real** auth computation for a provider, selected by
a typed, tagged `AuthSpec`:

| Scheme | Providers | What the enclave computes (inside TDX) |
|---|---|---|
| `bearer` | OpenAI, Anthropic, xAI, Groq, Stripe, GitHub, SendGrid, Slack, **Gemini** | sentinel → secret swap (Gemini swaps in `x-goog-api-key`, not `Authorization`) |
| `basic` | **Twilio** | `base64(username : secret)` — the secret is joined then base64-encoded *in the enclave* |
| `sigv4` | **AWS S3, AWS SES** | full AWS Signature V4 — the secret **signs** a canonical request via an HMAC chain and is **never transmitted** |

The `basic` and `sigv4` schemes are the proof that this is *proper*, not generic:
their secret is **consumed by a computation**, not pasted into a header. A generic
"swap the sentinel" proxy structurally cannot reach Twilio or AWS, because:

- Twilio's `base64(SID:token)` must be computed **after** the secret is joined —
  you can't pre-place a sentinel inside a base64 blob.
- AWS SigV4's signature is an HMAC over the request keyed by the secret; the
  secret appears **nowhere** in the outbound bytes.

So for a whole class of major APIs, the raw secret now never exists as a header
value anywhere — it's only ever an input to a computation that runs in sealed
TDX memory.

The auth logic lives in a dependency-isolated module (no wit/host imports) so it
is unit-testable natively.

### 2. Concrete provider registry (`packages/blindfold/src/providers.ts`)

Not a generic router — a list of **named, first-class integrations**, each with
its exact upstream host, its own sealed-secret name, and its auth scheme:

| Provider | Industry | Host | Sealed secret | Auth |
|---|---|---|---|---|
| OpenAI / Anthropic / xAI / Groq | LLM | api.openai.com, … | (default) | bearer |
| **Gemini** | LLM | generativelanguage.googleapis.com | `gemini_api_key` | bearer via `x-goog-api-key` |
| **Stripe** | Payments | api.stripe.com | `stripe_secret_key` | bearer |
| **GitHub** | Dev infra | api.github.com | `github_token` | bearer |
| **SendGrid** | Email | api.sendgrid.com | `sendgrid_api_key` | bearer |
| **Slack** | Comms | slack.com/api | `slack_bot_token` | bearer |
| **Twilio** | Telephony | api.twilio.com | `twilio_auth_token` | **basic** |
| **AWS SES** | Cloud | email.\<region\>.amazonaws.com | `aws_secret_access_key` | **sigv4** |
| **AWS S3** | Cloud | s3.\<region\>.amazonaws.com | `aws_secret_access_key` | **sigv4** |

12 named integrations across 6 industries (LLM, payments, dev, email, comms,
cloud) and all three auth schemes. Longest-prefix routing; non-secret config
(Twilio Account SID, AWS access-key-id / region) comes from env, never sealed.

### 3. Proxy + type wiring

- `ForwardRequest` gained an optional `auth` field that serialises 1:1 into the
  contract's `AuthSpec` (`types.ts`).
- `proxy.ts` resolves the provider, sets the per-provider `secret_key`, and
  plants the sentinel in the right header (or omits it entirely for basic/sigv4,
  where the enclave builds the whole `Authorization`).
- The old `upstreamForPath` switch was deleted; routing lives in `providers.ts`.
- Backward compatible: `auth` defaults to `bearer`, and an older published
  contract simply ignores the field — existing LLM flows are unchanged.

---

## Why it's correct (not hand-waving)

- **Native crypto vectors** — `contract/auth-tests` runs `auth.rs` natively and
  passes **4/4**, including:
  - AWS SigV4 **"get-vanilla"** full-signature vector (byte-exact
    `Signature=5fa00fa3…fbf31`).
  - AWS **signing-key derivation** vector (`f4780e2d…db404d`).
  - base64 RFC-4648 vectors and the Twilio Basic-auth shape.
- **Enclave rebuilds clean** — `blindfold_proxy.wasm`, 227,364 bytes, with
  sha2 + hmac compiled in.
- **Provider resolution + full mock proxy run** — all paths route to the right
  upstream with the right sealed secret and the right `auth` descriptor.

---

## Live, real end-to-end runs

Both examples run against the **live enclave** (tenant
`did:t3n:58f5f5f9…`, testnet) — no mock, no stub.

### Gemini (`examples/gemini/`)

Sealed `gemini_api_key`, granted egress to `generativelanguage.googleapis.com`,
and made a **real** `generateContent` call with the agent holding **no key**:

```
✅ Real Gemini answer (key never left the enclave):
   An Intel TDX enclave is a hardware-isolated execution environment that
   protects the confidentiality and integrity of code and data, even from
   the hypervisor.
🕵️  If a prompt-injection dumped this agent's credentials, it would get:
   • env vars containing a real Gemini key: (none)   ← scans ALL of process.env
   • auth header the agent sends:           x-goog-api-key: __BLINDFOLD__
```

Notable: Gemini validated that the auth model is genuinely provider-aware — its
key rides in `x-goog-api-key`, not `Authorization`, and Blindfold handles that.

### Prompt injection (`examples/prompt-injection/`)

Real, authenticated GitHub call through the enclave (agent authenticates as a
real login), then an injected "issue" tries to exfiltrate the token:

```
✅ Legit call succeeded — agent is authenticated to GitHub as "FiscalMindset".
📤 If the agent dumped its credentials, the attacker would get:
   • env vars containing a real GitHub token: (none)   ← scans ALL of process.env
   • Authorization header the agent sends:    Bearer __BLINDFOLD__
🛡️  Attacker receives only the sentinel. Nothing usable.
```

Retargets to a Stripe-refund injection by sealing `stripe_secret_key` and
changing one path — the resistance is structural, so it's identical.

### Stripe — payments, read + write (`examples/stripe/`)

Sealed a real Stripe **test** key (`sk_test_…`) as `stripe_secret_key`, granted
egress to `api.stripe.com`, and ran live through the enclave:

```
✅ Authenticated to a REAL Stripe account (test mode, livemode=false).   # GET /v1/balance → 200
✅ Real WRITE succeeded — created customer cus_UnzQbHl4Iv4zUN (livemode=false).  # POST /v1/customers → 200
📤 Exfil check (scans ALL of process.env): env vars with a real Stripe key: (none); auth header: Bearer __BLINDFOLD__
🛡️  Attacker receives only the sentinel.
```

The agent has genuine read **and** write power over a real payments account, yet
the injection gets nothing. The demo asserts `livemode === false` and refuses to
run on a live key, so it can never touch real money.

### Two real host-egress findings (documented, not hidden)

Running Stripe live surfaced real constraints in the **current T3 host** egress
(`host:interfaces/http` `call`) — worth recording so nobody re-diagnoses them:

1. **The host parses request bodies as JSON.** A non-JSON payload fails with
   `http.parse_payload: expected value at line 1 column 1`. JSON APIs (Gemini,
   OpenAI, Anthropic) and read GETs work fully; form-encoded bodies do not. The
   Stripe example works around this by putting params in the query string with an
   empty body.
2. **On testnet, request headers aren't always forwarded.** Form-encoded Stripe
   WRITES are flaky because the `content-type` header is intermittently dropped
   (reads are 100% reliable). The example retries and reports honestly if the
   egress is dropping headers on a given run. Neither is a Blindfold design
   issue — auth and key protection are unaffected; these are host-egress
   maturity gaps on testnet.

### Two operational gotchas (cost real diagnosis time — documented so they don't again)

- **`blindfold grant` REPLACES the egress allowlist, it doesn't append.**
  `agentAuthUpdate` sets `allowedHosts: <hosts>` for the contract, so each grant
  overwrites the previous one. Granting `api.github.com` then `api.stripe.com`
  separately leaves ONLY Stripe authorized; earlier hosts silently start
  returning `egress_denied`. **Fix: grant every host in one call** —
  `grant --host generativelanguage.googleapis.com,api.stripe.com,api.github.com`.
  (A good follow-up would be to make the CLI merge with the existing allowlist.)
- **Testnet tenants have a per-minute compute quota (`fuel_per_minute`).**
  Hammering the enclave (tight reliability loops, retry storms, repeated demo
  runs) trips `HTTP 500 too_many_requests: quota exceeded (fuel_per_minute)`,
  which surfaces to the agent as a generic `internal proxy error`. It looks like
  an outage but resets within a minute — space calls out, and don't let demo
  retry loops hammer a already-exhausted quota.

### Honesty hardening of the demos

The demos originally deleted a few hardcoded env-var names and then checked only
those names — which false-passed when the `.env` var was renamed (the real key
was still in `process.env` under the new name). They now **scan the entire
`process.env`** for the provider's real key pattern (`sk_…`, `AIza…`/`AQ.…`,
`ghp_…`) and report a leftover as a genuine leak rather than hiding it. A clean
pass therefore means the key truly isn't reachable, not that we looked away.

---

## Impact on the two gaps

**Integration coverage.** 4 LLM endpoints → 12 named integrations across 6
industries and 3 auth schemes, with two schemes (`basic`, `sigv4`) that a generic
proxy fundamentally cannot offer. The "integration stack" is now real depth, not
a switch statement.

**Problem concreteness.** The harm is now demonstrable and watchable: a real,
privileged credential, real untrusted content, a real exfiltration attempt that
comes back empty. The distinct, defensible claim — *the enclave performs the
provider's real auth (base64, SigV4 signing) so the secret is never in the agent
even for non-bearer APIs* — is one no generic-proxy competitor can make.

---

## Files

- `contract/src/auth.rs` — base64 / Basic / SigV4, computed in-enclave.
- `contract/src/forward.rs` — `AuthSpec` enum + per-scheme header building.
- `contract/auth-tests/` — native crypto-vector tests (4/4).
- `packages/blindfold/src/providers.ts` — the concrete provider registry.
- `packages/blindfold/src/proxy.ts`, `types.ts` — routing + auth wiring.
- `examples/gemini/`, `examples/prompt-injection/` — live end-to-end demos.
