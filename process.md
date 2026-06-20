# The Process — first time using Blindfold, end to end

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
echo "deepgram_api_key=REDACTED-DEEPGRAM-KEY-REVOKED" >> .env
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
