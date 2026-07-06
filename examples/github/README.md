# GitHub via Blindfold

Use a real GitHub token (fine-grained or classic PAT) from your agent/CLI/CI
**without the plaintext ever living in your process, shell, or `.env`**. The
token is sealed inside a Terminal 3 TDX enclave; every use is a just-in-time
release or an in-enclave substitution.

GitHub uses `Authorization: Bearer <token>`. Blindfold's GitHub provider routes
`/github/*` → `https://api.github.com/*`, substituting the sealed `github_token`
for the sentinel **inside the enclave**, on the outbound call.

Everything below is the **actual output of a real run** against the live testnet
tenant `did:t3n:58f5f5f9…` — token values are redacted; the account shown
(`FiscalMindset`) is a real, public GitHub profile.

## Prereqs (one time)

```bash
# GITHUB_TOKEN in .env, plus real T3 creds (T3N_API_KEY, DID)
npm run blindfold -- register --name github_token --from-env GITHUB_TOKEN
npm run blindfold -- grant --host api.github.com
```

## 1. Seal it (`register`)

```text
$ npm run blindfold -- register --name github_token --from-env GITHUB_TOKEN
{"level":"info","msg":"seeded","name":"github_token"}
{"level":"info","msg":"registered","name":"github_token","source":"env:GITHUB_TOKEN","length":93,"mode":"real"}
✓ Registered "github_token" (value read from GITHUB_TOKEN once, then dropped).
  You can now DELETE GITHUB_TOKEN from your .env.
```

## 2. Authorize egress (`grant`)

```text
$ npm run blindfold -- grant --host api.github.com
✓ Egress granted for: api.github.com
  Contract is now authorized to call ALL of: api.github.com, api.stripe.com,
  api.twilio.com, generativelanguage.googleapis.com, httpbin.org, s3.us-east-1.amazonaws.com
```

## 3. Quick auth check (`use --url`)

The token is released, used for one call, then dropped. A non-`https` URL is
refused so the key can't be exfiltrated to an attacker-controlled host.

```text
$ npm run blindfold -- use --name github_token --url https://api.github.com/user
✓ released "github_token" (93 B, value not shown) → https://api.github.com/user
  HTTP 200 OK  ✅ accepted

$ npm run blindfold -- use --name github_token --url http://api.github.com/user
✖ refusing to send the released key to a non-https URL (http://api.github.com).
  Use https, target localhost, or pass --allow-insecure to override.
```

## 4. Inject into one command only (`use -- <cmd>`)

The token is set as `$GITHUB_TOKEN` for the child process only — never back in
your shell.

```text
$ npm run blindfold -- use --name github_token --as GITHUB_TOKEN -- \
    sh -c 'curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | grep -o "\"login\":[^,]*"'
✓ released "github_token" (93 B) → injecting $GITHUB_TOKEN into: sh -c …
  "login": "FiscalMindset"
```

## 5. The proxy path (`agent.ts`)

The agent points at the local proxy and sends **only the sentinel** — no token.
The enclave swaps in the real key on the outbound call.

```bash
npx tsx examples/github/agent.ts
npx tsx examples/github/agent.ts /repos/anthropics/anthropic-sdk-typescript
```

```text
🔒 Blindfold proxy: http://127.0.0.1:8787   (this process has NO GitHub token)
🐙 GET api.github.com/user

✓ GitHub responded: HTTP 200 OK
   login: "FiscalMindset"
   id: 254638087
   type: "User"
   html_url: "https://github.com/FiscalMindset"
   public_repos: 29

🧪 Prompt-injection check — what could a hijacked agent leak?
   Authorization it holds: "Bearer __BLINDFOLD__"  → nothing to steal.
```

## Everything at once

```bash
bash examples/github/demo.sh
```

## Why it's safe

- The plaintext token is read **once** at `register` time and dropped; the
  canonical copy lives only in the enclave.
- On the **proxy path** the token is never in this process — the agent holds the
  sentinel `__BLINDFOLD__`; substitution happens inside the TDX enclave.
- On the **release path** (`use` / `export`) the token is in memory only for the
  duration of one call. Protection rests on `T3N_API_KEY` staying out of an
  agent-reachable environment — see [`SECURITY.md`](../../SECURITY.md).
- `blindfold audit` verifies the sealed-secrets ledger against the enclave and
  checks the tamper-evident hash-chain:

```text
$ npm run blindfold -- audit
  1. Ledger integrity (tamper-evidence)
     ✅ hash-chain intact — 1 chained entry, 18 legacy (pre-chain, unverifiable)
  2. Enclave reconciliation — the enclave is the source of truth
     ✅ github_token           present (93 B, fp=5238a611)
```

> Note: `blindfold share --to <did>` / `revoke --to <did>` currently replace the
> tenant's full agent-authorization set, which drops the owner's own egress
> grant. If you share/revoke, re-run `blindfold grant --host api.github.com`
> afterward to restore the proxy path.
