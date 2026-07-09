<div align="center">

# 📘 Blindfold — Usage Guide

**Seal a key once. Then use it from anywhere — your agent, your CLI, your app — without the plaintext ever touching your code again.**

### 📖 &nbsp; [Home](README.md) &nbsp;·&nbsp; **[Usage Guide](usage.md)** &nbsp;·&nbsp; [Examples](EXAMPLES.md) &nbsp;·&nbsp; [Teams](TEAMS.md) &nbsp;·&nbsp; [FAQ](FAQ.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

</div>

---

> **How to read this:** find the one scenario that matches you in the tree below, copy the commands, done. Each scenario is self-contained. If anything errors, jump to [§10 Troubleshooting](#10-troubleshooting-errors-youll-actually-hit).

> 🧠 **The whole idea in one breath:** `register` puts a secret into the enclave under a *name*. Everything after that just refers to the *name* — you never paste, store, or script-per-secret the real value again.

---

## 0. First — check everything is working (60 seconds)

Run these four. All four green = you can use any scenario in this doc.

```bash
npm run blindfold -- doctor              # → mode: REAL (T3)
npm run blindfold -- verify              # → ✓ REAL T3 round-trip succeeded.
npm run blindfold -- compat              # → lists agent CLIs on your machine
npm run demo                             # → ✅ Demonstration successful: Blindfold neutralised the same attack.
```

If `doctor` says `mode: MOCK` or any creds are `NO ✖`, fix that first by running `npm run setup` (interactive wizard that walks you through claiming T3 creds and putting them in `.env`).

---

## Command reference (all of them)

> Run any command with `blindfold <cmd>` (global install) or
> `npm run blindfold -- <cmd>` (in the repo). No secret value is ever printed.

**Setup**
| Command | What it does |
|---|---|
| `login` | Store tenant creds in `~/.blindfold`; tenant key → OS keychain. Works from any directory afterward. |
| `logout` | Remove stored creds (keychain + `~/.blindfold/config.json`). |
| `whoami` | Show config path, tenant, env, and where the key is stored (never the value). |
| `doctor` | Config sanity + a live T3 handshake/auth check. |
| `verify` | Quick T3 round-trip smoke test. |
| `init` | One-shot setup (publish + seed + grant). |

**Seal & inspect**
| Command | What it does |
|---|---|
| `register --name <name> [--from-env <VAR>]` | Seal a secret. Without `--from-env` it prompts (hidden). |
| `sealed` | Local ledger of sealed keys (metadata only). |
| `status` | Mode, tenant health, and the sealed-secrets list. |
| `audit` | Reconcile the ledger against the enclave — what's actually usable now. |
| `versions [--name <name>]` | List rollback snapshots (from `rotate`). |

**Use**
| Command | What it does |
|---|---|
| `use --name <name> -- <cmd>` | Release + inject the key into one child command only. |
| `use --name <name> --url <https>` | Quick "does it auth?" check. |
| `proxy [--port 8787]` | Run the local proxy; agents use `__BLINDFOLD__`. |
| `export --name <name> [--as <VAR>]` | CI-only: release into `$GITHUB_ENV`, masked in logs. |

**Lifecycle**
| Command | What it does |
|---|---|
| `rotate --name <name> [--from-env <VAR>]` | Replace a secret's value; snapshots the old one. |
| `rollback --name <name> [--to <fp\|ts>]` | Restore a snapshot (verifies fingerprint first). |
| `migrate [--dry-run] [--keep]` | Seal every `.env` secret at once; `--dry-run` previews. |
| `grant --host <h>[,<h2>…]` | Authorize egress to hosts (needed for proxy/in-enclave calls). |
| `share --to <did> --host <h>` | Give a teammate forward-only (use, not extract) access. |
| `revoke --to <did>` | Remove a teammate's access. |
| `publish [--wasm <path>]` | Publish the enclave contract (one-time / on contract change). |

**Extras**
| Command | What it does |
|---|---|
| `compat` | Scan this machine for agent tools + print the exact env-var swap. |
| `dashboard` | Live HTML dashboard of usage/sealed keys. |
| `skill install [--global\|--opencode\|--cursor\|--cline\|--all]` / `skill uninstall` | Install/remove the agent skill. |

### Install (any OS)

```bash
npm install -g blindfold        # or: npm i -g ./packages/blindfold from a clone
blindfold login                 # tenant DID + key → OS credential store
blindfold doctor                # confirm; then use `blindfold` from any directory
```

Credentials are stored in the OS credential store — macOS **Keychain**, Linux
**libsecret** (`secret-tool`), Windows **Credential Manager**. If none is
available (or a non-interactive session), `login` falls back to a `0600` file
and says so. `~/.blindfold/config.json` holds only the non-secret DID + settings.

### Windows notes

- The global install **auto-adds** `%APPDATA%\npm` to your user PATH. **Open a
  new terminal** afterward so `blindfold` is recognized. (If it still isn't, add
  that folder to PATH manually, or run via the shim `%APPDATA%\npm\blindfold.cmd`.)
- `git` isn't required to *use* Blindfold; a normal `npm i -g blindfold` works.
- To store the key in the **Credential Manager**, run `blindfold login` in an
  **interactive desktop terminal** — over SSH/non-interactive sessions Windows
  returns `1312` (no logon session) and Blindfold falls back to the `0600` file.
  Verify with `blindfold whoami` (want: `key: set (Windows Credential Manager)`)
  and `cmdkey /list | findstr blindfold`.

---

## ⚡ Fastest path — seal your whole `.env` in one command

Already have a `.env` full of keys? Move them all into the enclave at once:

```bash
blindfold migrate --dry-run     # preview: what gets sealed vs. skipped (no changes)
blindfold migrate               # seal every secret, strip the plaintext lines (backup kept)
```

It seals every secret-looking var, **removes the plaintext from `.env`** (keeping a backup), and **skips** your T3 creds (`T3N_API_KEY`, `DID`), team keys (`t1_*`/`t2_*`), and config (`*_HOST`, `*_EMAIL`, …). After this, your `.env` holds no API keys — use any of them with `blindfold use --name <x> -- <cmd>` (§3c). Use `--keep` to comment the lines out instead of deleting them.

---

## 1. Scenario tree — pick yours

| You want to … | Jump to |
|---|---|
| Try Blindfold without doing any T3 setup | §2 |
| **Use a sealed secret with ANY command-line tool (no code)** | **§3c** |
| Protect the key your own agent uses (Node/Python/whatever) | §3 |
| Protect the key Claude Code / OpenCode / Aider / Codex CLI uses | §4 |
| **Load Blindfold as an agent skill** (auto-safe key handling in Claude Code / OpenCode) | **§4a** |
| Protect the key your custom chatbot / FastAPI / Next.js app uses | §5 |
| Protect an SMTP password / IMAP password / non-HTTP credential | §6 |
| Integrate into an existing app that already has a Fernet/local vault (Aurora-style) | §7 |
| Run Blindfold in CI / production | §8 |
| Just check on what's happening (dashboard / stats / history) | §9 |

---

## 2. Try it in 30 seconds, no T3 required

```bash
git clone https://github.com/FiscalMindset/Blindfold.git && cd Blindfold
npm install
npm run demo
```

You'll see Agent A leak a fake API key under a prompt injection, then Agent B (one-line diff) take the same injection and leak only the sentinel. No T3 creds, no real API keys, no setup. Use this to show colleagues / judges / yourself what Blindfold does.

---

## 3. Your own agent (Node, Python, anything)

There are two patterns. **Use the one that fits your protocol.**

### 3a. Pattern A — base-URL swap (HTTP/HTTPS APIs only; gated today)

Works for OpenAI / Anthropic / Grok / Groq / any OpenAI-compatible API once `forward()` is wired to call `http::call`. As of 2026-06-25 the canonical `host:interfaces/http@2.1.0` WIT has landed and imports cleanly, so the WIT-level blocker is gone; what remains is the contract-code wiring plus a live execute. Code change in your app today is already correct. See §11 for the honest status.

```bash
# 1. Seal your key (interactive prompt — no echo, no .env edit needed)
npm run blindfold -- register --name openai_api_key
#   Value for "openai_api_key" (input is hidden): ●●●●●●●● ↵

# 2. Start the proxy (terminal 1, leave running)
npm run blindfold -- proxy

# 3. Point your agent at it (terminal 2)
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=__BLINDFOLD__ node my-agent.js
```

Provider routes the proxy understands today:

| Provider | env vars |
|---|---|
| OpenAI | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` · `OPENAI_API_KEY=__BLINDFOLD__` |
| Anthropic | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic` · `ANTHROPIC_API_KEY=__BLINDFOLD__` |
| xAI / Grok | `XAI_BASE_URL=http://127.0.0.1:8787/x/v1` · `XAI_API_KEY=__BLINDFOLD__` |
| Groq | `GROQ_BASE_URL=http://127.0.0.1:8787/groq/v1` · `GROQ_API_KEY=__BLINDFOLD__` |

### 3b. Pattern B — release-broker (works today, any protocol)

This is the **production-viable path right now**. Your code calls the T3 contract to fetch the sealed secret just-in-time, uses it for one call, drops it. Works for SMTP / IMAP / gRPC / anything.

Minimal Node example:

```ts
import { loadBlindfoldEnv } from "blindfold";

async function callSomethingThatNeedsApiKey() {
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

  // Pull the sealed value just-in-time:
  const { value: apiKey } = await tenant.contracts.execute("blindfold-proxy", {
    version: "0.5.1",
    functionName: "release-to-tenant",
    input: { secret_key: "openai_api_key" },
  }) as { value: string };

  try {
    // Use it for ONE call:
    return await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ /* ... */ }),
    });
  } finally {
    // Plaintext is now out of scope; nothing persisted.
  }
}
```

Full working example: [`scripts/smtp-with-blindfold.ts`](scripts/smtp-with-blindfold.ts) (real SMTP send via T3-released password).

---

## 3c. ⭐ Pattern C — `blindfold use` (no code, any tool)

The easiest way to *use* a sealed secret. Blindfold releases it from the enclave and injects it as an environment variable into **one** subprocess — it never goes back into your shell, and it's never printed. Works with `gh`, `git`, `curl`, `psql`, `docker`, `aws`, anything that reads an env var.

```bash
# Seal once:
blindfold register --name github_token --from-env GITHUB_TOKEN

# Then use it with any tool. --as sets the env-var name (default: NAME upper-cased).
blindfold use --name github_token --as GH_TOKEN -- gh api user --jq .login
# ✓ released "github_token" (93 B) → injecting $GH_TOKEN into: gh api user --jq .login
# FiscalMindset
```

More recipes:

```bash
# git push with a sealed token — nothing in your environment
blindfold use --name github_token --as GH_TOKEN -- git push origin main

# psql with a sealed DB password
blindfold use --name db_password --as PGPASSWORD -- psql -h db.internal -U app

# quick "does this key still work?" check (no command)
blindfold use --name github_token --url https://api.github.com/user
#   HTTP 200 OK  ✅ accepted
```

**Why this is safe:** the plaintext lives only inside the child process's environment for the lifetime of that single command, then it's gone. Your shell history, your `.env`, and your scripts never see it. See [EXAMPLES.md §1](EXAMPLES.md#1-no-code--blindfold-use) for more.

---

## 4. Coding-agent CLIs (Claude Code / OpenCode / Aider / Codex / Cursor / Continue / Cline)

Run `npm run blindfold -- compat` — it scans your machine and prints the exact env-var swap for every tool it finds. Sample output on a fresh Mac:

```
✓ OpenCode (sst.dev/opencode) · Blindfold protects this
    OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=__BLINDFOLD__
✓ Cline (VS Code extension)  · Blindfold protects this
✓ OpenAI Codex CLI (codex) · Blindfold protects this
? Claude Code (claude) · Depends on how you authenticate
    Only applies if you authenticate Claude Code with an Anthropic API key.
    Default Claude Code uses claude.ai OAuth — there is no exposed key to protect.
✖ Ollama · Doesn't apply (no user-supplied key)
```

**Honest verdict by tool:**

| Tool | Blindfold protects it? |
|---|---|
| OpenAI SDK / Anthropic SDK / LangChain / LlamaIndex / AutoGen | ✅ yes, base-URL swap (§3a) |
| OpenCode / Aider / Codex CLI / Continue.dev / Cline | ✅ yes, base-URL swap or config file |
| **Claude Code in OAuth mode** (the default subscription flow) | ❌ doesn't apply — no API key on your disk to protect |
| **Claude Code in `ANTHROPIC_API_KEY` mode** (enterprise / proxy) | ✅ yes, set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic` |
| Cursor desktop (default mode) | ❌ no base-URL hook in current builds |
| ChatGPT.com / web UIs | ❌ doesn't apply — no key on your disk |
| Ollama (local models) | ❌ doesn't apply — no remote key to protect |

Long-form writeup: [`docs/05-compatibility.md`](docs/05-compatibility.md).

### 4a. Load Blindfold as an agent skill (Claude Code / OpenCode / any skill-aware agent)

Blindfold ships a **built-in skill** that teaches your coding agent to handle secrets safely — automatically. When loaded, the agent proposes safe terminal commands instead of asking for keys, writes release-broker code instead of `process.env`, and verifies by fingerprint instead of reading `.env`.

#### Install the skill

**One command** (from inside the Blindfold repo):

```bash
blindfold skill install              # this project (Claude Code auto-discovers it)
blindfold skill install --global     # every Claude Code session on your machine
blindfold skill install --cursor     # Cursor (.cursor/rules/)
blindfold skill install --opencode   # OpenCode (.opencode/skills/)
blindfold skill install --cline      # Cline / Continue.dev (.cline/rules/)
blindfold skill install --all        # all of the above at once
```

**npx** (from any directory, no clone needed):

```bash
npx blindfold skill install           # current project
npx blindfold skill install --global  # global
```

**Already cloned this repo?** It already works — Claude Code auto-discovers `.claude/skills/blindfold/SKILL.md`. Nothing to install.

**Without cloning** (curl one-liner for any project):

```bash
mkdir -p .claude/skills/blindfold
curl -sL https://raw.githubusercontent.com/FiscalMindset/Blindfold/main/.claude/skills/blindfold/SKILL.md \
  -o .claude/skills/blindfold/SKILL.md
```

**Uninstall:** `blindfold skill uninstall` removes all installed skill files.

#### Verify it's loaded

In Claude Code, type any of these — if the skill is active, the agent will respond with Blindfold-specific commands (not generic advice):

```
> "seal my Stripe key"                → proposes: blindfold register --name stripe_api_key
> "how do I protect my API key"       → walks you through the register + sealed workflow
> "write code that calls OpenAI"      → generates release-broker pattern, not process.env
> "what's in my .env?"                → runs env:fingerprint, never cat .env
```

If the agent gives generic "put it in .env" advice instead, the skill isn't loaded — re-check the path.

#### What the skill enforces (the four rules)

| Rule | What it means |
|---|---|
| R1 — no paste into chat | Agent never asks for the secret value; proposes terminal commands instead |
| R2 — verify by fingerprint | `blindfold sealed` and `env:fingerprint` only — never reads raw `.env` |
| R3 — release-broker in code | All generated code fetches secrets from T3 just-in-time via `release()` |
| R4 — cleanup after seal | Agent proposes deleting the `.env` copy once the enclave copy is confirmed |

---

## 5. Your custom app (FastAPI / Next.js / Flask / Rails / anything)

Same two patterns as §3. Two more concrete recipes:

### FastAPI (Python) — wrap an OpenAI tool route

```python
import os, httpx
from fastapi import FastAPI

# The "wrapper" — in Pattern A you'd just set OPENAI_BASE_URL globally; this
# explicit version makes the substitution obvious in code review.
PROXY = os.environ.get("BLINDFOLD_PROXY_URL", "http://127.0.0.1:8787")

app = FastAPI()

@app.post("/chat")
async def chat(prompt: str):
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{PROXY}/v1/chat/completions",
            headers={"Authorization": "Bearer __BLINDFOLD__"},
            json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": prompt}]},
        )
        return r.json()
```

`OPENAI_API_KEY` is nowhere on the FastAPI server. The key lives in T3.

### Next.js Route Handler (App Router)

```ts
// app/api/chat/route.ts
import OpenAI from "openai";
const openai = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey:  "__BLINDFOLD__",
});

export async function POST(req: Request) {
  const { message } = await req.json();
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: message }],
  });
  return Response.json(r.choices[0]?.message);
}
```

More worked examples in [`examples/`](examples/) — OpenAI Node, OpenAI Python, LangChain, Anthropic.

---

## 6. SMTP / IMAP / non-HTTP credentials

This is the proven-today path. Mirrors what works in [`scripts/smtp-with-blindfold.ts`](scripts/smtp-with-blindfold.ts) (already used to send real emails to `algsoch@gmail.com`).

```bash
# 1. Seal the SMTP password into the enclave (interactive — no .env edit)
npm run blindfold -- register --name smtp_password

# 2. In your script, fetch it from T3 right before the SMTP login:
```

```ts
import nodemailer from "nodemailer";
// ... same SDK setup as §3b ...
const { value: pass } = await tenant.contracts.execute("blindfold-proxy", {
  version: "0.5.1",
  functionName: "release-to-tenant",
  input: { secret_key: "smtp_password" },
}) as { value: string };

await nodemailer.createTransport({
  host: "smtp.gmail.com", port: 465, secure: true,
  auth: { user: "you@gmail.com", pass },
}).sendMail({ to: "...", subject: "...", text: "..." });
// `pass` goes out of scope here; nothing persisted.
```

The `smtp_password` is never in `process.env`. It lives in TDX. It's in the broker process for one SMTP login. Then gone.

---

## 7. Existing app with a local/Fernet vault (Aurora-style)

If your app already has a `Vault` abstraction that holds secrets in Python/Node memory (encrypted on disk, decrypted in-process), **don't rip it out**. Add Blindfold as a *backend* and switch which one your vault uses at runtime.

Architecture:

```
your app's Vault interface
   ├─ FernetBackend  (today, fallback)
   └─ BlindfoldBackend ← thin shim, calls release-to-tenant just-in-time
```

For the full Aurora-specific recipe — including the exact `EnclaveBroker` refactor — see [`INTEGRATION-AURORA.md`](INTEGRATION-AURORA.md). It's a paste-and-go prompt for Claude Code / Cursor working in the Aurora repo.

---

## 8. CI / production

| Concern | What to do |
|---|---|
| `BLINDFOLD_T3_ENV` | Set to `production` when you have a production tenant; default is `testnet`. |
| Secret rotation | Re-run `npm run blindfold -- register --name <K>` — overwrites the value in `z:<tid>:secrets`. Running clients pick up the new value on their next release call. |
| CI tests | Use `BLINDFOLD_MOCK=1` so tests don't hit T3 or burn quota. The 9-check `npm run test:report` is mock-mode by design. |
| Where logs go | `.blindfold/usage.jsonl` (gitignored). Metadata only by construction. Override path via `BLINDFOLD_USAGE_LOG=<path>`. |
| Dashboard in prod | Bind it to localhost; never expose it. Disabling the dashboard process is enough — Blindfold itself doesn't depend on it. |
| Re-deployment | The contract lives on T3. You don't redeploy it per release of your app. Bump `CONTRACT_VERSION` only when contract logic changes. |
| Multi-tenant production | Each end-user customer should have their own T3 DID; the proxy and contract are per-tenant. (Out of scope for the hackathon MVP.) |

---

## 9. Watch what's happening

```bash
npm run blindfold -- proxy           # terminal 1
npm run dashboard                    # terminal 2 → open http://127.0.0.1:8799
npm run blindfold -- stats           # one-shot terminal summary
npm run blindfold -- stats:clear     # wipe the log
```

The dashboard shows total requests, by provider, success rate, average latency, and "sentinel substituted" rate (should always equal the total request count). **No bodies, no header values, no request content — by construction.**

---

## 10. Troubleshooting (errors you'll actually hit)

Indexed by keyword in the error message.

| Keyword | Plain English | Fix |
|---|---|---|
| `mode: MOCK (BLINDFOLD_MOCK=1)` when you didn't want it | You set `BLINDFOLD_MOCK=1` somewhere | `unset BLINDFOLD_MOCK` or fix your shell config |
| `T3N_API_KEY set: NO ✖` | Missing in `.env` | Run `npm run setup` — wizard prompts you |
| `map not found` | First time on this tenant — `secrets` map doesn't exist | `npm run setup` (idempotent — creates the map) |
| `access denied: TenantContract(.../<id>) cannot read map` | The contract isn't authorised | Wizard does this on publish; for old contracts: `npx tsx scripts/grant-secrets-read.ts <contract_id>` |
| `version not higher` | Same `CONTRACT_VERSION` as last publish | Bump it in both `packages/blindfold/src/constants.ts` AND `contract/Cargo.toml` |
| `InsufficientCredit (account=..., available=0)` | Testnet quota exhausted | Re-claim at the T3 claim page |
| `HTTP 500: Internal error` on *all* seals/executes while `verify` is green | **#1 cause: your key has no provisioned tenant.** A working key authenticates AND passes a read. Run `blindfold doctor` — it now does a live `me()` and tells you if the key is unprovisioned (500), out of credit (403), or has a server-assigned DID different from your `.env` DID. | Switch `.env` to a key that passes `blindfold doctor`, or ask T3 to provision a tenant for the key. |
| Everything 500s but a **healthy key on another machine works** — the node itself is unhealthy (e.g. a Raft follower that can't commit) | The SDK targets one hardcoded node. If that node is down/behind, all writes fail with no recourse. | Set `T3_BASE_URL=<healthy-or-leader-node-url>` in `.env` to point Blindfold at a different node. `blindfold doctor` shows which node URL is active. |
| `HTTP 400: Invalid semver format: latest` | A SYSTEM script needs a numeric semver, not "latest" | Use `getScriptVersion(rpcUrl, scriptName)` — handled in `scripts/grant-and-call.ts` |
| `aborted by user` during `register` | You hit Ctrl+C at the prompt | Re-run |
| `@terminal3/t3n-sdk not installed` | npm dep missing | `npm install @terminal3/t3n-sdk` |
| `T3N_API_KEY must be a 0x-prefixed 32-byte hex` | Typo in `.env` | Re-claim from T3 |

---

## 11. Honest status of the patterns

All three use-patterns are verified live (2026-06-28). The differences are about *where the plaintext briefly exists*, not whether they work.

| Pattern | Status | Where plaintext briefly exists |
|---|---|---|
| **C. `blindfold use`** (no code, any tool) | ✅ verified live | the child process's env, for one command |
| **A. Proxy / base-URL swap** (HTTP SDKs) | ✅ verified live | the local broker process, for one call |
| **B. Release-broker** (`release()` in code, any protocol) | ✅ verified live (real Gmail SMTP send; real GitHub API) | the local broker process, for one call |
| **D. In-enclave `http::call`** (maximalist) | ✅ verified live (contract → GitHub `200`, see `scripts/test-enclave-egress.ts`) | **never leaves the enclave** |

For the threat Blindfold exists to fix — **prompt injection of your agent** — all four are equally strong, because the agent process never holds the key in any of them. Pattern D additionally protects against a compromised *local* machine. Pick C for the fastest adoption, D for zero-trust.

---

## 12. If you get stuck

1. Re-run §0's four health checks. Each one tells you where it broke.
2. Check `vicky.md` — newer-user Q&A that grows over time.
3. Save the request_id from any `HTTP 500: Internal error` and check `current_status.md` §3 (workarounds in use + difficulties surfaced for the T3 core eng team).
4. For Aurora integration specifically, `INTEGRATION-AURORA.md` is the paste-and-go prompt.

---

## 13. Source-of-truth index

| Question | File |
|---|---|
| What's working / blocked right now | `current_status.md` |
| Per-stack adoption recipes | `docs/04-usage.md` |
| Which agent CLIs are compatible | `docs/05-compatibility.md` |
| Why Blindfold exists | `docs/01-problem-analysis.md` |
| Aurora integration | `INTEGRATION-AURORA.md` |
| Plain-English Q&A (newest at top) | `vicky.md` |
| **You are here** | `usage.md` |
