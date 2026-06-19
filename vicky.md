# Vicky's Questions — plain-English answers

> A running Q&A as Vicky learns how Blindfold actually works. New questions go at the top. If you're a new user, reading this top-to-bottom is the fastest path to the "aha moment."

---

## Q9 (2026-06-20) — "When I run a command, what does each output line actually mean? And what's a real error vs an OK error?"

### `npm run blindfold -- doctor`

What you'll see:

```
Blindfold doctor:
  mode:               REAL (T3)
  T3N_API_KEY set:    yes
  DID set:            yes
  T3 environment:     testnet
  default proxy port: 8787
```

| If you see | What it means | What to do |
|---|---|---|
| `mode: REAL` | T3 credentials found in `.env` | ✅ continue |
| `mode: MOCK (BLINDFOLD_MOCK=1)` | You explicitly set `BLINDFOLD_MOCK=1` | OK if you wanted mock; unset for REAL |
| `T3N_API_KEY set: NO ✖` | Missing in `.env` | Run `npm run setup` — wizard will prompt |
| `DID set: NO ✖` | Missing in `.env` | Same — wizard will prompt |
| exit code 1 + a `⚠` block | REAL selected but creds missing | The doc tells you the claim URL; fix `.env`, re-run |

### `npm run blindfold -- verify`

```
🛡️  Blindfold — verify
  · mode: REAL  ·  T3 env: testnet
  · attempting handshake + authenticate against T3 …
  ✓ REAL T3 round-trip succeeded.
```

| Last line | Meaning |
|---|---|
| `✓ REAL T3 round-trip succeeded.` | Your creds work; T3 is reachable. |
| `✖ REAL T3 connection failed. Error: HTTP 4xx Unauthorized …` | `T3N_API_KEY` doesn't match a real T3 account. Re-claim. |
| `✖ ... HTTP 500: Internal error` | T3-side issue. Save the `request_id` and email devrel@terminal3.io. |

### `npm run blindfold -- register --name foo`

```
  Value for "foo" (input is hidden): ●●●●●●●● ↵
{"t":"...","level":"info","msg":"seeded","name":"foo"}
{"t":"...","level":"info","msg":"registered","name":"foo","source":"stdin","length":16,"mode":"real"}
✓ Registered "foo" — value lives only in the enclave.
```

| Line | Meaning |
|---|---|
| `Value for "foo" (input is hidden):` | TTY prompt — paste your secret, press Enter. Nothing echoes. |
| `seeded ... name="foo"` | T3 accepted the `executeControl("map-entry-set", …)` call. Secret is now in the enclave. |
| `source: stdin` (or `env:VAR`) | Where the value came from; the *value* itself never appears. |
| `length: 16` | Sanity check the byte-count matches what you pasted. |
| ✖ `map not found` | First-time tenant — run `npm run blindfold -- init` once to scaffold. |
| ✖ `Missing required env: T3N_API_KEY, DID` | Same fix — run `init` or fill `.env`. |

### `npm run blindfold -- init`

```
[1/5] Preflight
  ✓ T3 testnet · tenant did:t3n:...
  ✓ @terminal3/t3n-sdk present
  ✓ Rust toolchain + wasm32-wasip2 target ready
[2/5] Build contract  (Rust → WASM)
  ✓ Built /.../blindfold_proxy.wasm (157989 bytes)
[3/5] Authenticate to T3
  ✓ Handshake + authenticate succeeded ✨
[4/5] Publish the wrapper contract + grant ACLs
  ✓ Published "blindfold-proxy"  ·  contract_id=251
  ✓ Granted read access on z:tid:secrets to contract 251
[5/5] Seal a secret into the enclave
  · No --seed flag given.
✓ All done.
```

| Issue | Meaning + fix |
|---|---|
| `! cargo (Rust toolchain) not found — auto-skipping contract build.` | Yellow warning, not fatal. Install Rust from rustup.rs and re-run, OR proceed without the contract (some features won't work). |
| `✖ Publish failed. Error: InsufficientCredit ...` | Tenant out of contract slots. Re-claim credits at the T3 claim page. |
| `✖ Publish failed. Error: contract version not higher` | You haven't bumped `CONTRACT_VERSION` since last publish. Bump it in `packages/blindfold/src/constants.ts` AND `contract/Cargo.toml`. |
| Wizard hangs at `Authenticate to T3` | Network/firewall to `cn-api.sg.testnet.t3n.terminal3.io` blocked. |

---

## Q8 (2026-06-20) — "Show me a real end-to-end example with my Grok key"

Three commands. Total time ~1 minute (after you have T3 creds in `.env`).

```bash
# 1. Add your Grok key to .env temporarily, then seal it. No echo on screen.
echo "GROK_API_KEY=xai-..." >> .env
npm run blindfold -- register --name grok_api_key --from-env GROK_API_KEY

# 2. Delete the line from .env. The canonical copy now lives only in TDX.
#    (Edit .env in your editor and remove the GROK_API_KEY line.)

# 3. Confirm the contract can still read it from inside the enclave:
npx tsx scripts/diagnose-execute.ts grok_api_key
# Expected output:
#   "ok": true,
#   "secret_len": 84,                                    ← matches your key length
#   "authorization_header_len_after_substitution": 91,   ← "Bearer " (7) + 84
```

If `secret_len` matches your real key length, the seal worked. Your machine no longer has the canonical copy; T3 does.

---

## Q7 (2026-06-20) — "Show me 'sealed AND actually used' with a real outbound action"

The SMTP demo proves it. Two emails, one without and one with Blindfold, with the password in the enclave-only state for the second.

```bash
# Prep: have smtp_email, smtp_host, smtp_password in .env (one-time).
#       Then seal the password into T3:
npm run blindfold -- register --name smtp_password --from-env smtp_password

# 1. WITHOUT Blindfold (password still in env) — sends a real email:
npm run demo:smtp -- algsoch@gmail.com "Without Blindfold" "Test 1 of 2"

# 2. WITH Blindfold — delete smtp_password from .env first.
#    Then this script fetches the password from the T3 enclave just-in-time
#    and uses it for one SMTP login. The process never holds it for longer:
npx tsx scripts/smtp-with-blindfold.ts algsoch@gmail.com
```

Expected `smtp-with-blindfold.ts` output:

```
═══ SMTP send WITH Blindfold ═══
  process.env.smtp_password: absent ✓ — value lives in enclave
  ✓ authenticated to T3
  ✓ published v0.4.1 as contract_id=...   (or "already at version")
  ✓ granted contract X read access to z:tid:secrets
  ✓ released from enclave: length=16
  ✓ SENT  messageId=<...@gmail.com>
  server response: 250 2.0.0 OK
```

If you see `✓ SENT`, the email landed at `algsoch@gmail.com` **without the password being in `.env`**. That's the win in one screen.

---

## Q6 (2026-06-20) — "What are the common errors, in human?"

Pattern-match: search for the keyword in the error message.

| Keyword in error | Plain English | Fix |
|---|---|---|
| `map not found` | T3 secrets map doesn't exist on this tenant yet | `npm run blindfold -- init` (idempotent — creates the map) |
| `access denied: TenantContract(...) cannot read map` | Your contract isn't authorised to read `secrets` | `init` does this for fresh publishes; for old contracts, run `npx tsx scripts/grant-secrets-read.ts <contract_id>` |
| `Missing required env: T3N_API_KEY, DID` | `.env` doesn't have T3 creds | Run `init` or `setup` — wizard prompts you |
| `version not higher` | Same `CONTRACT_VERSION` as last publish | Bump it in both files and rebuild |
| `InsufficientCredit (account=..., available=0)` | Testnet quota exhausted (max 10 contracts) | Re-claim at the T3 claim page |
| `HTTP 500: Internal error [<uuid>]` | T3-side opaque error. Most common when contract calls `http::call` — known gap | Save the `request_id`, email devrel@terminal3.io with the diagnostic dossier (see `INTEGRATION-AURORA.md` for what to send) |
| `@terminal3/t3n-sdk not installed` | npm dep missing | `npm install @terminal3/t3n-sdk` (it's an optional dep) |
| `T3N_API_KEY must be a 0x-prefixed 32-byte hex` | Typo in `.env` (or the value is from a different system) | Re-claim from T3 |
| `aborted by user` during `register` | You hit Ctrl+C at the password prompt | Re-run the command |

---

## Q5 (2026-06-20) — "How do I check it's working end-to-end without sending anything?"

Three layers of verification, fastest first.

```bash
# Layer 1 (instant): is the wrapper configured?
npm run blindfold -- doctor
# pass = "mode: REAL" + both env vars say "yes"

# Layer 2 (1 sec): does the T3 connection work?
npm run blindfold -- verify
# pass = "✓ REAL T3 round-trip succeeded."

# Layer 3 (5 sec): is a specific sealed secret reachable from inside the enclave?
npx tsx scripts/diagnose-execute.ts <secret_name>
# pass = "ok": true, "secret_len": <expected length>

# Layer 4 (10 sec): the full pipeline — publish, ACL, in-enclave secret read + substitution.
npm run test:real
# pass = all S1..S4 ✅
```

Layer 4 also appends a permanent timestamped row to `output_analysis.md`, so you have a history.

---

## Q4 (2026-06-20) — "What's the easiest possible thing I can do to use Blindfold? Just the three commands."

For a brand-new machine:

```bash
git clone https://github.com/FiscalMindset/Blindfold.git && cd Blindfold
npm install
npm run setup
```

That's it for the wrapper itself. From here:

```bash
# To seal a secret (interactive — no .env shuffle needed):
npm run blindfold -- register --name openai_api_key
# Paste your sk-... at the prompt. Done.

# To use it via the local OpenAI-shaped proxy:
npm run blindfold -- proxy           # terminal 1, leave running

# Point your agent at it:
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 \
OPENAI_API_KEY=__BLINDFOLD__ \
  node your-agent.js
```

The agent's environment now has only a meaningless sentinel. Whatever it gets prompt-injected with, there's nothing on its side to leak.

Note (today): the *proxy → enclave → upstream API* path needs T3 to ship canonical host WITs to fully close. The `release-broker` path (used by `scripts/smtp-with-blindfold.ts` and Aurora's `EnclaveBroker`) works end-to-end today.

---

## Q3 (2026-06-20) — "What does 'canonical copy lives inside the enclave' mean?"

Two phrases, separately.

**"Canonical copy"** = the *one authoritative* version. Like the original of your passport vs photocopies — if there are six photocopies floating around, only the original counts when you go through immigration. The photocopies are just extra surfaces where it could leak.

**"Inside the enclave"** = stored in T3's TDX hardware-encrypted RAM at the address `z:<tenant_id>:secrets`. That memory is sealed by the Intel CPU itself. Even the cloud provider hosting T3 can't read it. Think bank vault — bills go in, the bank's own staff can't see them; the vault only opens for the authenticated client (your contract).

**Concretely for your Grok API key right now:**

```
  BEFORE sealing                          AFTER sealing
  ──────────────────                      ─────────────────────
  📄 .env on your laptop                  🔒 TDX enclave at T3
     GROK_API_KEY=xai-…                      z:tid:secrets
                                              grok_api_key = …
  ⚠ leaks if:                             ✅ unreadable by:
   • laptop stolen                          • the cloud provider
   • git accidentally                       • the host OS
   • backup synced wrong                    • anyone with disk access
   • a tool runs `cat .env`                 • you, until your contract asks for it
```

Right now your key has **two** copies — the one in `.env` (a liability) and the one in the enclave (the canonical one used for actual API calls). Deleting `GROK_API_KEY` from `.env` collapses that to **one** copy: the canonical one, in TDX. After that, the only place that key exists on Earth is inside hardware-protected RAM on a T3 node — and your laptop can be lost, stolen, or `cat .env`'d safely.

That's the whole point of Blindfold: get the canonical copy out of every place it doesn't need to be, and put it in the one place it does.

---

## Q2 (2026-06-20) — "What if I just want to see the leak demo without setting any of this up?"

One command:

```bash
git clone https://github.com/FiscalMindset/Blindfold.git && cd Blindfold
npm install
npm run demo
```

No T3 creds needed. Runs Agent A (key in env, leaks) and Agent B (one-line diff, doesn't leak) back-to-back. Prints a verdict block. Exits 0 only if A leaks AND B doesn't.

Use this to *explain* what Blindfold does to colleagues / judges / yourself. The REAL T3 setup is for actually protecting your own keys.

---

## Q1 (2026-06-20) — "Where do I see what's happening right now while my agent makes calls?"

Two views.

**Live web dashboard** (auto-refreshes every 2s):

```bash
npm run dashboard
# → open http://127.0.0.1:8799
```

Shows: total requests, by provider, success rate, average latency, sentinel-substitution rate, last 50 calls. Metadata only — no bodies, no header values.

**Terminal summary:**

```bash
npm run blindfold -- stats
# Total / 2xx / 4xx / avg latency / by-provider / recent 5 calls
```

Wipe the log: `npm run blindfold -- stats:clear`.

The log file is at `.blindfold/usage.jsonl` (one JSON object per request). Safe to grep, safe to mail to support — no secrets in it.

---

## How to add a new question

Just say "add a question to vicky.md: <your question>". The newest answer goes at the top so you can read top-down chronologically.
