# Blindfold — full command tour (real run, GitHub token)

This is a **real, unedited (only token-redacted) transcript** of every Blindfold
command run against the live Terminal 3 testnet tenant
`did:t3n:58f5f5f9c81e55f31ef5be09de009db7a6f80b49`, using a real GitHub
fine-grained PAT sealed as `github_token`.

- Token values are **never** printed by Blindfold, and are redacted here anyway.
- The account shown (`FiscalMindset`, id `254638087`) is a real, public GitHub
  profile — safe to show, not a secret.
- Nothing here is faked. Where a command failed, the real failure is shown.

Runnable version of the highlights: [`../examples/github/`](../examples/github/).

---

## Setup / health

### `doctor` — verify creds + a live T3 round-trip
```text
Blindfold doctor:
  mode:               REAL (T3)
  T3N_API_KEY set:    yes
  DID set:            yes
  T3 environment:     testnet
  Live check (handshake + authenticate + me) …
  auth:               ✅ handshake + authenticate OK
  tenant:             ✅ did:t3n:58f5f5f9…  (status=active)
  ✅ Ready to seal & use secrets on this tenant.
```

### `verify` — handshake + auth smoke test
```text
🛡️  Blindfold — verify
  ✓ REAL T3 round-trip succeeded.
```

### `compat` — scan this machine for agent tools to protect
```text
Detected (6):
  ✓ OpenCode           OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=__BLINDFOLD__
  ✓ OpenAI Codex CLI   OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=__BLINDFOLD__
  ✓ openai (Node SDK)  OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=__BLINDFOLD__
  ✖ ollama             Doesn't apply (no user-supplied key)
```

---

## Seal + inspect

### `register` — seal GITHUB_TOKEN into the enclave
```text
{"level":"info","msg":"seeded","name":"github_token"}
{"level":"info","msg":"registered","name":"github_token","source":"env:GITHUB_TOKEN","length":93,"mode":"real"}
✓ Registered "github_token" (value read from GITHUB_TOKEN once, then dropped).
```

### `status` — mode, tenant health, sealed list (metadata only)
```text
🛡️  Blindfold status
  mode:    REAL   ·   T3 env: testnet
  tenant:  ✅ did:t3n:58f5f5f9…  (status=active)
  Sealed secrets (12):
    • github_token             93 B   real
    • stripe_secret_key       107 B   real
    • gemini_api_key           53 B   real
    …
```

### `sealed` — the local append-only ledger (never values)
```text
  WHEN                  NAME            BYTES  MODE   WHERE
  2026-07-06 13:24:49   github_token       93  real   z:58f5f5f9…:secrets/github_token
  (values are NOT stored in this ledger — only metadata. The canonical copy lives in the enclave.)
```

### `audit` — tamper-evident chain + reconcile against the enclave
```text
🔍 Blindfold audit
  1. Ledger integrity (tamper-evidence)
     ✅ hash-chain intact — 1 chained entry, 18 legacy (pre-chain, unverifiable)
  2. Enclave reconciliation — the enclave is the source of truth (12 secrets)
     ✅ github_token           present (93 B, fp=5238a611)
  Summary: 9 verified · 0 drift · 3 missing · ledger intact
```
> The 18 "legacy" entries predate the keyed hash-chain and are treated as
> unverifiable (never falsely "TAMPERED"); new entries use an HMAC chain.

### `stats` — proxy usage telemetry (metadata only)
```text
Blindfold usage stats
  Total requests:     113
  2xx / 4xx+:         84 / 28
  By provider:        openai×29  stripe×51  github×7  gemini×12  (enclave)×12
```

---

## Use the sealed token (three ways)

### `use --check` / `use --url` — release for one call
```text
$ use --name github_token --check
✓ "github_token" is sealed and usable — 93 bytes (value never shown)

$ use --name github_token --url https://api.github.com/user
✓ released "github_token" (93 B, value not shown) → https://api.github.com/user
  HTTP 200 OK  ✅ accepted

$ use --name github_token --url http://api.github.com/user
✖ refusing to send the released key to a non-https URL (http://api.github.com).
```

### `use -- <cmd>` — inject into one child process only
```text
✓ released "github_token" (93 B) → injecting $GITHUB_TOKEN into: sh -c …
  github user login: "login": "FiscalMindset"
  env var visible to child only: GITHUB_TOKEN is SET (value hidden)
# parent shell afterward: GITHUB_TOKEN not in this shell env (good)
```

### `proxy` — the un-leakable path (agent sends only the sentinel)
```text
$ proxy --port 8791 --secret github_token
✓ Blindfold proxy listening at http://127.0.0.1:8791

# agent → curl -H "Authorization: Bearer __BLINDFOLD__" .../github/user
"login": "FiscalMindset"
"id": 254638087
"type": "User"

# proxy log: {"msg":"proxy_forward","method":"GET","upstream":"https://api.github.com/user"}
```

### `export` — CI path: release into $GITHUB_ENV (masked in logs)
```text
::add-mask::github_pat_…REDACTED
✓ exported $GH_TOKEN from sealed "github_token" (93 B, masked in logs)
# $GITHUB_ENV file now contains:  GH_TOKEN=github_pat_…REDACTED
```

---

## Lifecycle

### `grant` — authorize egress (union, doesn't clobber prior hosts)
```text
✓ Egress granted for: api.github.com
  Contract is now authorized to call ALL of: api.github.com, api.stripe.com,
  api.twilio.com, generativelanguage.googleapis.com, httpbin.org, s3.us-east-1.amazonaws.com
```

### `rotate` → `versions` → `rollback`
```text
$ rotate --name github_token --from-env GITHUB_TOKEN
  before:  "github_token"  93 B  fp=5238a611  (snapshot saved — rollback available)
✓ Rotated "github_token"  →  93 B  fp=5238a611  (mode=real)

$ versions --name github_token
  WHEN                  NAME           BYTES  FINGERPRINT
  2026-07-06 13:28:47   github_token      93  5238a611

$ rollback --name github_token
✓ Rolled back "github_token"
  fp 5238a611 (93 B)  →  fp 5238a611 (93 B)     # fingerprint verified before re-seal
```

### `share` → `revoke` — least-privilege teammate access
```text
$ share --to did:t3n:…TEAMMATE --host api.github.com
✓ Shared access with did:t3n:…TEAMMATE
  authorized: forward → api.github.com  (they can USE the key via the enclave; never the plaintext)

$ revoke --to did:t3n:…TEAMMATE
✓ Revoked all contract access for did:t3n:…TEAMMATE
```
> ⚠️ Real finding from this run: `share`/`revoke` replace the tenant's full
> agent-authorization set, which **drops the owner's own egress grant**. After
> a share/revoke, re-run `grant --host …` to restore the proxy path.

### `migrate --dry-run` — preview sealing every .env secret (no changes)
```text
🔍 blindfold migrate --dry-run (no changes will be made)
    skip  T3N_API_KEY   — root cred / config — must stay in .env
    SEAL  GITHUB_TOKEN  → github_token  (93 B)
  Would seal 3 secret(s), then remove their .env lines (a .env backup is kept either way).
```

### `publish` — one-time contract publish (already published here)
```text
✖ HTTP 400: contract version invalid: version 0.5.4 is not higher than current version 0.5.4
```
> This is the expected idempotency guard — the contract was already published at
> v0.5.4 (which is why the proxy path works).

### `skill install` / `uninstall` — teach your coding agent to use Blindfold
```text
$ skill install
  ✓ this project (Claude Code) → .claude/skills/blindfold/SKILL.md
```

---

## Command coverage

Executed against real T3 in this run (21/22):
`doctor` · `verify` · `compat` · `register` · `use` (check/url/cmd) · `export` ·
`rotate` · `versions` · `rollback` · `status` · `sealed` · `audit` · `stats` ·
`proxy` · `grant` · `share` · `revoke` · `migrate --dry-run` · `publish` ·
`skill install/uninstall`.

Not run: `init` (the one-shot composite of `publish` + `register` + `grant`,
each shown individually above) and a non-dry-run `migrate` (it rewrites `.env`).
