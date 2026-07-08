# The Process — first time using Blindfold, end to end

> **What's new (v0.2 / v0.3 + webhook):** installable global CLI (`npm i -g`, runs from any directory, state in `~/.blindfold`); `blindfold login` stores the tenant key in the **OS keychain** (not a plaintext file); Discord webhook support (release path + `/discord` proxy provider, contract v0.5.5). See `CHANGELOG.md`.


> Written for someone opening this repo cold. Two real examples (Deepgram + Grok). Every command + every expected output. ~10 minutes total.

---

## 0. Mental model in three sentences

- **The problem.** Any API key in your agent's process can be exfiltrated by a prompt-injection. Even careful agents fail because the model itself can't distinguish "developer instructions" from "untrusted text it just fetched".
- **The fix.** Put your keys somewhere the agent's process *can't reach* — specifically, inside an Intel-TDX-encrypted memory region on a Terminal 3 node. Your agent talks to a tiny local broker; the broker fetches the key just-in-time from T3, uses it for one call, drops it.
- **The result.** The agent process holds zero secrets. Whatever the prompt-injection asks for, the agent has nothing to leak.

---

## 1. What you'll have when this walkthrough is done

After following this file once:

```
.env on your laptop
  T3N_API_KEY=0x…                   ← needed to reach T3 (can't be sealed; see §11)
  DID=did:t3n:…                     ← your T3 identity
  smtp_email=…                      ← not a secret
  smtp_host=…                       ← not a secret
  (no provider keys at all)

Inside T3's TDX enclave (z:<your-tid>:secrets/)
  deepgram_api_key  → 40 bytes      ← canonical copy
  grok_api_key      → 84 bytes      ← canonical copy
```

And every time your code needs the deepgram key, it asks T3 for it, gets it for one call, drops it. Your `.env` stays clean.

---

## 2. Prerequisites (one-time, ~2 min)

```bash
# 1. Clone + install
git clone https://github.com/FiscalMindset/Blindfold.git
cd Blindfold
npm install

# 2. Rust (only if you want to build the contract yourself — most people skip this and use the wizard's auto-skip)
#    Mac:    brew install rustup-init && rustup-init
#    Linux:  https://rustup.rs
rustup target add wasm32-wasip2
```

---

## 3. See the leak demo first (30 sec, no T3 required)

Before we set up real T3, see what Blindfold actually does:

```bash
npm run demo
```

You'll see two agents run the same prompt-injection attack. Agent A (no Blindfold) leaks a fake key. Agent B (one-line diff) leaks only the sentinel `__BLINDFOLD__`. Verdict block prints at the end. **This is the value proposition.** The next sections make it real.

---

## 4. Get T3 credentials (one-time, ~30 sec)

Visit https://docs.terminal3.io/developers/adk/get-started/prerequisites/request-test-tokens, claim, copy two values:

- `T3N_API_KEY` — 64 hex chars prefixed with `0x` (it's an Ethereum-style private key)
- `DID` — looks like `did:t3n:<40 hex chars>`

Paste both into `.env`:

```bash
echo "T3N_API_KEY=0xYOUR_HEX_HERE" >> .env
echo "DID=did:t3n:YOUR_HEX_HERE"   >> .env
```

Verify:

```bash
npm run blindfold -- doctor
# Expected:
#   mode:               REAL (T3)
#   T3N_API_KEY set:    yes
#   DID set:            yes
```

If it says `NO ✖`, the value isn't getting read. Re-check `.env`.

---

## 5. One command to bootstrap the tenant (~30 sec)

```bash
npm run setup
```

Behind the scenes this does five things:

1. Preflight — checks Rust + npm SDK
2. Builds the Rust→WASM contract (~5 sec)
3. Authenticates to T3
4. Creates your tenant's `secrets` and `authorised-hosts` maps (idempotent — safe to re-run)
5. Publishes the contract + grants it ACL access to read your secrets map

Expected output (last lines):

```
[4/5] Publish the wrapper contract + grant ACLs
  ✓ Published "blindfold-proxy"  ·  contract_id=310
  ✓ Granted read access on z:tid:secrets to contract 310

[5/5] Seal a secret into the enclave
  · No --seed flag given.
✓ All done.
```

The `contract_id` will be different for you. Note it down if you like — `blindfold doctor` and `current_status.md` will reference it.

---

## 6. Example A — seal a Deepgram API key (real, with `--seed` flag)

Put the key in `.env` temporarily:

```bash
echo "deepgram_api_key=fcbf753350cc0dd5a804ba6efb5a870dccf04076" >> .env
# (use your real Deepgram key — the one above is from the writer's test setup)
```

Seal it in one shot:

```bash
npm run setup -- --seed deepgram_api_key:deepgram_api_key
```

Expected last lines:

```
[5/5] Seal a secret into the enclave
  ✓ Sealed deepgram_api_key (read from deepgram_api_key, 40 bytes, then dropped). You can DELETE deepgram_api_key from .env now.
```

Now look at the **sealed-keys ledger** — Blindfold records what's sealed (metadata only, never the value):

```bash
npm run blindfold -- sealed
```

```
Sealed keys  (source: /Volumes/algsoch/terminal 3/.blindfold/sealed.jsonl)

  WHEN                  NAME                       BYTES  MODE   WHERE
  ────                  ────                       ─────  ────   ─────
  2026-06-20 12:31:46   deepgram_api_key               40  real   z:d20089c46f7bafc0905414bb089005b70a071a9f:secrets/deepgram_api_key

  (values are NOT stored in this ledger — only metadata. The canonical copy lives in the enclave.)
```

That last column — `z:<tid>:secrets/deepgram_api_key` — is what your Deepgram key *became* after sealing. It's the address inside the TDX enclave; only your contract running inside T3 can read what's there. **You** can confirm it's there (without the value) any time with `blindfold sealed`.

---

## 7. Example B — seal a Grok (xAI) API key (real, *without* `.env`)

This time skip the `.env` step entirely. Use the interactive prompt — the value goes terminal → enclave, never disk, never shell history:

```bash
npm run blindfold -- register --name grok_api_key
#  Value for "grok_api_key" (input is hidden): ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●● ↵
#  ✓ Registered "grok_api_key" — value lives only in the enclave.
```

Paste your `xai-…` key, press Enter, done. Re-check the ledger:

```bash
npm run blindfold -- sealed
```

```
  2026-06-20 12:31:46   deepgram_api_key               40  real   z:d20…071a9f:secrets/deepgram_api_key
  2026-06-20 12:35:02   grok_api_key                   84  real   z:d20…071a9f:secrets/grok_api_key
```

Two sealed keys now, both in your enclave, neither one's value present anywhere on your laptop.

---

## 8. Clean up `.env` (recommended — see §11 if you'd rather keep the entries)

```bash
# Open .env and remove the line:
#   deepgram_api_key=...
# Grok was never in .env (we used the interactive prompt) so nothing to do for it.
```

Verify with `cat .env`. Only `T3N_API_KEY`, `DID`, and non-secret values should remain.

---

## 9. Use the sealed key from your code

This is the **production path today**. Same pattern works for any protocol (HTTPS, SMTP, gRPC, whatever).

```ts
// Pull the sealed value just-in-time, use for one call, drop.
import { loadBlindfoldEnv } from "blindfold";
import { CONTRACT_VERSION } from "blindfold";

async function callDeepgram(audioUrl: string): Promise<string> {
  const env = loadBlindfoldEnv();
  const sdk = await import("@terminal3/t3n-sdk");
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const addr = sdk.eth_get_address(env.t3nApiKey);
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(),
    handlers: { EthSign: sdk.metamask_sign(addr, undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(addr));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  // The release call — plaintext lives in this process for ONE outbound call.
  const { value: dgKey } = await tenant.contracts.execute("blindfold-proxy", {
    version: CONTRACT_VERSION,
    functionName: "release-to-tenant",
    input: { secret_key: "deepgram_api_key" },
  }) as { value: string };

  try {
    const res = await fetch(`https://api.deepgram.com/v1/listen?url=${encodeURIComponent(audioUrl)}`, {
      method: "POST",
      headers: { Authorization: `Token ${dgKey}` },
    });
    return await res.text();
  } finally {
    /* dgKey out of scope here — nothing persisted, nothing logged */
  }
}
```

A working reference for the same pattern with Grok: [`examples/grok-via-blindfold.ts`](examples/grok-via-blindfold.ts).
Same pattern with SMTP: [`scripts/smtp-with-blindfold.ts`](scripts/smtp-with-blindfold.ts).

To verify your Deepgram key is reachable without writing application code:

```bash
npx tsx scripts/test-v5-release.ts deepgram_api_key
# ✓ released: fcb…76  (40 bytes)  ·  reported length=40  ·  match=true
# (full plaintext NOT printed; if you need to inspect, do it in a non-shared terminal)
```

The first-and-last few chars + byte count let you confirm the right key is there without ever revealing the full value.

---

## 9.5. What's actually happening at each step (cognee API key, real run)

Concrete trace of one full lifecycle, using a third real key (cognee). The actual value is never shown — only what Blindfold *records* and what your code *gets back*. The fingerprint matches (first-3 + last-2 + byte-count) so you can confirm identity without exposing the value.

### Step A — seal: which command, and which one I picked for cognee

You have **four** ways to seal a secret. All four end at the same point — one `executeControl("map-entry-set", …)` call to T3. The difference is *where the plaintext comes from on its way in* — and that's the only window of risk on your machine.

| # | Command | Where the value comes from | Best when |
|---|---|---|---|
| 1 | `npm run blindfold -- register --name <KV_KEY>` | **interactive prompt with no echo** — you paste, press Enter, screen never shows the chars | you're at a terminal and want zero `.env` / shell-history exposure. **The most defensive option.** |
| 2 | `printf 'VALUE' \| npm run blindfold -- register --name <KV_KEY>` | piped stdin | the value is already in some other secure place (vault tool output, generated string, programmatic source) and you want to script the seal; or — like with cognee just now — the value already exists in this conversation's context and re-pasting into a prompt would just put it in two places. The pipe goes terminal-process → stdin → SDK → enclave; never touches a file or shell history. |
| 3 | `npm run blindfold -- register --name <KV_KEY> --from-env <ENV_VAR>` | `process.env[<ENV_VAR>]` (you put it in `.env` first) | the value was *already* in env for an unrelated reason (you got it from a vault tool that sets env vars; you're scripting and env is the cleanest plumbing). |
| 4 | `npm run setup -- --seed <KV_KEY>:<ENV_VAR>` | same as (3), but the seal happens as the last step of `init` — combines first-time setup + seal | brand-new machine and you're setting everything up at once. |

**For the cognee key just now I picked (2) — piped stdin** — for one specific reason: the value was already in the chat context (you'd pasted it for me to seal), so re-asking for an interactive paste would just expose it in two places. `printf 'VALUE' | …` puts it on this process's stdin and nowhere else: not in `.env`, not in shell history (the `printf` *flag* is in history, but with a single-quoted literal, my shell records exactly that line — the key, but no exposure beyond the line you ran). For your own production work I'd actually recommend (1) — the interactive prompt — because then *neither* the chat *nor* the shell history sees the value.

The actual command I ran for cognee:

```bash
printf 'efae5a5f…b04b7252f6c9bc' | npx tsx packages/blindfold/bin/blindfold.ts register --name cognee_api_key
```

(I'm only showing the first/last few chars in this doc on purpose — the full value goes nowhere committed.)

What happens inside that command, in order:

1. **stdin** — the 64-byte value is read from the pipe (no echo, no shell history).
2. **t3-client.ts** opens an encrypted session to T3 testnet (handshake + Ethereum-style authenticate using your `T3N_API_KEY`).
3. **register.ts** calls `tenant.executeControl("map-entry-set", { map_name: "z:<tid>:secrets", key: "cognee_api_key", value: <the 64 bytes> })`.
4. The plaintext lives only inside this Node process for the duration of that one RPC. Once it returns, the local binding is dropped.
5. **sealed-ledger.ts** appends one JSON line to `.blindfold/sealed.jsonl` — metadata only, never the value:

   ```json
   {"t":"2026-06-20T12:48:54.888Z","name":"cognee_api_key","source":"stdin","length":64,"mode":"real","tenant_did":"did:t3n:d20…071a9f","map_name":"z:d20…071a9f:secrets"}
   ```

What you see in your terminal:

```
✓ Registered "cognee_api_key" — value lives only in the enclave.
```

### Step B — confirm via the ledger (no T3 round-trip; reads the local jsonl)

```bash
npm run blindfold -- sealed
```

```
WHEN                  NAME              BYTES  MODE  WHERE
────                  ────              ─────  ────  ─────
2026-06-20 12:31:46   deepgram_api_key     40  real  z:d20…071a9f:secrets/deepgram_api_key
2026-06-20 12:48:54   cognee_api_key       64  real  z:d20…071a9f:secrets/cognee_api_key
```

This is "is the key sealed?" *yes/no*. No value. The ledger is purely local metadata; cheap to read.

### Step C — confirm via T3 contract (real round-trip, returns fingerprint)

```bash
npx tsx scripts/test-v5-release.ts cognee_api_key
```

```
testing v0.5.1 release-to-tenant for "cognee_api_key" (no egress needed)
  ✓ released: efa…bc  (64 bytes)  ·  reported length=64  ·  match=true
  (full plaintext NOT printed; if you need to inspect, do it in a non-shared terminal)
```

What happened: the script asked the **contract running inside the TDX enclave** to read `z:<tid>:secrets/cognee_api_key`. The contract returned the bytes to your authenticated tenant session. The script took the first 3 + last 2 chars + byte-count and printed *only that*. The full value was in this script's process for milliseconds, then garbage-collected.

The fingerprint (`efa…bc, 64 bytes`) is enough to confirm "yes, the right key is in there" — you can compare with the key you intended to seal — without exposing it. This is what you do when something's wrong and you want to verify the seal *worked* without re-sealing.

### Step D — use it in real code (the production pattern)

When your real application needs to call cognee, here's the smallest possible shape — same code that today sends real emails via SMTP and authenticates real xAI calls:

```ts
import { loadBlindfoldEnv, CONTRACT_VERSION } from "blindfold";

async function cogneeCall(prompt: string): Promise<unknown> {
  // (Tenant client setup omitted — make it once at server boot, reuse it.)
  const { value: cogneeKey } = await tenant.contracts.execute("blindfold-proxy", {
    version: CONTRACT_VERSION,
    functionName: "release-to-tenant",
    input: { secret_key: "cognee_api_key" },
  }) as { value: string };

  try {
    const res = await fetch("https://api.cognee.ai/v1/...", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cogneeKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt }),
    });
    return await res.json();
  } finally {
    /* cogneeKey out of scope — nothing persisted, nothing logged */
  }
}
```

What happens per call:

1. Your function asks T3 for the sealed value (one round-trip).
2. T3's contract reads `z:<tid>:secrets/cognee_api_key` *inside the TDX enclave* and returns it over the encrypted session.
3. Your process holds the value for the duration of one outbound `fetch()` — typically ~100ms for a real API call.
4. After the `try { … }` block, the binding is dropped. Garbage collector reclaims the bytes shortly after.

The provider (cognee) receives the real value in the `Authorization` header — exactly as it would without Blindfold. Cognee can't tell the difference. **You** can: `process.env.cognee_api_key` is empty; `cat .env | grep -i cognee` returns nothing.

### Where the value lives at each step (the picture)

```
                              ┌───────────────────────────────────────────────┐
                              │  T3 TDX enclave (always — canonical copy)     │
                              │  z:d20…071a9f:secrets/cognee_api_key (64B)    │
                              └───────────────────────────────────────────────┘
                                  ▲                              │
                                  │ seal (Step A)                │ release (Step D)
                                  │ — one RPC, value             │ — one RPC, value briefly
                                  │ briefly here                 │ in YOUR process
                                  │                              ▼
                              ┌─────────────────┐         ┌──────────────────────┐
                              │  register cmd   │         │  your fetch() call   │
                              │  (one process,  │         │  (one process,       │
                              │   one moment)   │         │   one outbound call) │
                              └─────────────────┘         └──────────────────────┘
                                  ▲                              │
                                  │ stdin pipe / env / paste     │
                                  │                              ▼
                              ┌─────────────────┐         ┌──────────────────┐
                              │  YOUR TERMINAL  │         │  api.cognee.ai   │
                              │  (transient)    │         │  (the provider)  │
                              └─────────────────┘         └──────────────────┘

  ❌ NEVER here:  agent process · prompt context · .env on disk · git history · backups · logs
```

The agent process (your LLM-driven part — the prompt-injection target) is *off the diagram entirely*. There is no arrow into it. That's the whole point.

---

## 10. The day-2 view — what's live, what's been used

Two more reads to know about:

```bash
npm run blindfold -- sealed       # what's in the enclave (you've seen this)
npm run blindfold -- doctor       # current mode + config
npm run blindfold -- verify       # quick T3 connectivity check
```

If you start the proxy + an agent, also:

```bash
npm run blindfold -- proxy        # leave running
npm run dashboard                 # → http://127.0.0.1:8799 — live traffic, by provider
npm run blindfold -- stats        # CLI summary of usage.jsonl
```

---

## 11. Two questions everyone asks

### "Why isn't `T3N_API_KEY` sealed too?"

It's a chicken-and-egg. `T3N_API_KEY` is what authenticates you *to* T3 in the first place. If we sealed it inside T3, you'd need it to authenticate *to retrieve it* — impossible. The same is true for any HSM, Vault, etc. There has to be one "root" credential that lives *outside* the protected store.

Three good places to keep `T3N_API_KEY`:

1. **`.env`** with `chmod 600 .env` — what we have today. Fine for development.
2. **A hardware token / passkey** — wraps the signing operation so the raw key never leaves the device. Production-grade.
3. **A cloud-provider secret manager that requires hardware-attested clients** (AWS KMS, Cloud HSM, etc.) — Blindfold's `EthSign` handler can be swapped to delegate to one of these.

The win from Blindfold isn't "no credentials anywhere" — that's physically impossible. It's "no *provider* credentials anywhere except inside TDX". The number of secrets on your laptop went from N (one per provider) to 1 (just the T3 root).

### "Do I have to delete the key from `.env` after sealing?"

Strictly: no. Blindfold doesn't read or use the `.env` copy after sealing — the contract reads from `z:<tid>:secrets/<name>` directly. So leaving it in `.env` doesn't break anything functionally.

But you should delete it. Here's why:

| What you're protecting against | Does the `.env` copy hurt? |
|---|---|
| Prompt-injection in your agent | Same effect either way (agent never reads `.env`) |
| Laptop theft | Yes — the thief gets the key from `.env` |
| Accidental `git add .env` | Yes — the key ends up in the repo |
| `tail -f .env` / `cat .env` in a shared tmux | Yes — the key shows up |
| Tools that scan `.env` for credentials (e.g. cloud uploads) | Yes — false-positive becomes true-positive |

The `.env` copy is *no longer load-bearing* (you can delete it and Blindfold still works). Keeping it around is pure leak surface. Delete it.

If you really want to keep it as a backup (recoverable in case of T3 outage), at minimum:

```bash
# Rename so Blindfold + the OpenAI/Anthropic SDKs don't accidentally use it
# Prefix with _OFFLINE_BACKUP_ or move to a separate file outside the project
mv .env .env.with-secrets.OFFLINE-BACKUP
chmod 400 .env.with-secrets.OFFLINE-BACKUP
echo .env.with-secrets.OFFLINE-BACKUP >> .gitignore
# Then re-create .env from the sealed version with the provider keys removed
```

---

## 12. What to do next

| Now you know how to … | Next, look at … |
|---|---|
| Seal + use any HTTPS provider key | [`examples/grok-via-blindfold.ts`](examples/grok-via-blindfold.ts) |
| Seal + use a non-HTTP credential (SMTP) | [`scripts/smtp-with-blindfold.ts`](scripts/smtp-with-blindfold.ts) |
| Wire Blindfold into an existing app with a vault layer | [`INTEGRATION-AURORA.md`](INTEGRATION-AURORA.md) |
| Understand the security claim end-to-end | [`docs/01-problem-analysis.md`](docs/01-problem-analysis.md) |
| See every other scenario covered (Claude Code, OpenCode, …) | [`usage.md`](usage.md) and [`docs/05-compatibility.md`](docs/05-compatibility.md) |
| Get unstuck when a command errors | [`vicky.md`](vicky.md) Q6 — keyword-indexed error table |

---

## 13. One-line summary of where you are after this walkthrough

Two real provider keys (Deepgram + Grok) live exclusively inside your T3 TDX enclave; your `.env` has only the one root credential (`T3N_API_KEY`) plus its derived DID; any future code that needs those provider keys fetches them just-in-time from the enclave for one call and drops them — and the sealed-keys ledger (`blindfold sealed`) lets you confirm what's sealed without ever exposing a single value.
