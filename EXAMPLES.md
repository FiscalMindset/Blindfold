<div align="center">

# 🧪 Blindfold Examples

**Seal a secret once. Use it from anywhere — without the plaintext ever touching your code, your env, or (optionally) your machine.**

### 📖 &nbsp; [Home](README.md) &nbsp;·&nbsp; [Usage Guide](usage.md) &nbsp;·&nbsp; **[Examples](EXAMPLES.md)** &nbsp;·&nbsp; [Teams](TEAMS.md) &nbsp;·&nbsp; [FAQ](FAQ.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

</div>

---

Every example below is **real and runnable**. They are grouped by the *three ways* to use a sealed secret — pick the row that matches how much code you want to write.

| If you are… | Use surface | Code? | Jump to |
|---|---|---|---|
| Anyone with a terminal | `blindfold use -- <cmd>` | **none** | [§1 No-code](#1-no-code--blindfold-use) |
| Calling an HTTP API | `proxy` + `__BLINDFOLD__` | one line | [§2 One-line swap](#2-one-line-swap--the-proxy) |
| Writing an app | `release()` / `wrap()` | one line | [§3 In code](#3-in-code--release--wrap) |
| Security-maximalist | in-enclave `http::call` | n/a | [§4 Secret never leaves the enclave](#4-secret-never-leaves-the-enclave) |

> **One mental model:** `register` seals a secret into the T3 enclave under a name. Everything else is just *using* that name. **You never write a script per secret — the tooling is generic over any name.**

---

## 0. Seal something first (10 seconds)

```bash
# Seal ANY secret — an API key, a DB password, an SSH token, anything.
blindfold register --name github_token --from-env GITHUB_TOKEN
# ✓ Registered "github_token" (value read from GITHUB_TOKEN once, then dropped).
#   You can now DELETE GITHUB_TOKEN from your .env.

# …or seal your ENTIRE .env in one shot (skips T3 creds + config, keeps a backup):
blindfold migrate --dry-run    # preview
blindfold migrate              # seal all + strip plaintext
```

Confirm it's live and your tenant is healthy:

```bash
blindfold doctor
#   auth:    ✅ handshake + authenticate OK
#   tenant:  ✅ did:t3n:58f…  (status=active)
#   ✅ Ready to seal & use secrets on this tenant.
```

---

## 1. No-code — `blindfold use`

The fastest way to *use* a sealed secret with **any** command-line tool. Blindfold releases the secret and injects it as an environment variable into **one** subprocess — it never goes back into your shell.

### Run the GitHub CLI with a sealed token

```bash
blindfold use --name github_token --as GH_TOKEN -- gh api user --jq .login
# ✓ released "github_token" (93 B) → injecting $GH_TOKEN into: gh api user --jq .login
# FiscalMindset
```

### `git push` with a sealed token — nothing in your environment

```bash
blindfold use --name github_token --as GH_TOKEN -- git push origin main
```

### Connect to Postgres with a sealed password

```bash
blindfold use --name db_password --as PGPASSWORD -- psql -h db.internal -U app -c '\dt'
```

### Quick "does this key still work?" check (no command needed)

```bash
blindfold use --name github_token --url https://api.github.com/user
# ✓ released "github_token" (93 B, value not shown) → https://api.github.com/user
#   HTTP 200 OK  ✅ accepted
```

> 💡 `--as` defaults to the secret name upper-cased (`github_token` → `GITHUB_TOKEN`). The plaintext is **never printed** and exists only in the child process's env for the lifetime of that one command.

---

## 2. One-line swap — the proxy

For anything that speaks the OpenAI/Anthropic HTTP wire format. Start the proxy once, then point your SDK at it with the `__BLINDFOLD__` sentinel as the "key". The proxy forwards to the enclave, which substitutes the real value.

```bash
# Terminal 1 — one-time setup, then run the proxy
blindfold register --name openai_api_key --from-env OPENAI_API_KEY
npm run blindfold -- init                 # publish contract + grant secrets ACL (one-time)
blindfold grant --host api.openai.com     # authorize the contract to call OpenAI (required for the proxy)
blindfold proxy                           # → http://127.0.0.1:8787
```

```js
// Terminal 2 — your agent. The ONLY changed lines are baseURL + apiKey.
import OpenAI from "openai";
const openai = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey:  "__BLINDFOLD__",          // ← the real key is in the enclave, not here
});
```

Runnable versions of this for several stacks live in [`examples/`](examples/):

| Example | Stack |
|---|---|
| [`examples/openai-node-quickstart/`](examples/openai-node-quickstart/) | OpenAI SDK · Node |
| [`examples/openai-python-quickstart/`](examples/openai-python-quickstart/) | OpenAI SDK · Python |
| [`examples/langchain-summarizer/`](examples/langchain-summarizer/) | LangChain · Node (with a live injection attack) |
| [`examples/anthropic-quickstart/`](examples/anthropic-quickstart/) | Anthropic SDK · Node |
| [`examples/cli-tools/`](examples/cli-tools/) | **No-code `blindfold use` recipes** |
| [`examples/digital-ocean/`](examples/digital-ocean/) | **DigitalOcean infra — `doctl`/`curl`/enclave (verified)** |
| [`examples/api-providers/`](examples/api-providers/) | **Deepgram / Blogger / Hostinger — 3 auth styles, real output** |

---

## 3. In code — `release()` / `wrap()`

When you're writing the app and want the secret programmatically for a short-lived call (the "release-broker" pattern): get it, use it, drop it.

```ts
import { release } from "@blindfold";

// Release for ONE outbound call, then let it fall out of scope.
const token = await release("github_token");
const res = await fetch("https://api.github.com/user", {
  headers: { Authorization: `Bearer ${token}`, "User-Agent": "my-app" },
});
console.log((await res.json()).login);   // → FiscalMindset
// `token` is gone after this function returns. Never log it, never store it.
```

A full SMTP example (releasing a sealed mail password to send one email) lives in
[`scripts/smtp-with-blindfold.ts`](scripts/smtp-with-blindfold.ts), and a Grok/xAI
example in [`examples/grok-via-blindfold.ts`](examples/grok-via-blindfold.ts).

---

## 4. Secret never leaves the enclave

The strongest mode: the **contract itself** makes the outbound HTTPS call from inside the Intel TDX enclave. The plaintext is substituted in enclave memory and the real key **never reaches your machine at all** — not even briefly.

```bash
# Publishes the contract, grants the secrets read-ACL + egress to api.github.com,
# then runs a dry-run (proves in-enclave substitution) and the real call.
npx tsx scripts/test-enclave-egress.ts <contract_id>
```

```
→ forward dry-run (in-enclave substitution proof)
  ✓ {"ok":true,"code":0,"length":100,"dry_run":true}   (100 = "Bearer " + 93-byte token)

→ forward REAL → https://api.github.com/user (enclave makes the call)
  code=200 length=1346
  🎉 ENCLAVE-EGRESS WORKS — GitHub authenticated as: FiscalMindset
     The sealed token NEVER left the enclave.
```

| Mode | Where plaintext briefly exists | Best for |
|---|---|---|
| `blindfold use` / `release()` | local broker process, one call | scripts, CLIs, quick adoption |
| proxy + sentinel | local broker process, one call | drop-in HTTP SDK use |
| in-enclave `http::call` | **never leaves the enclave** | auditor-grade / zero-trust hosts |

---

## See also

- **[Usage Guide](usage.md)** — scenario-by-scenario walkthrough for every situation.
- **[Home](README.md)** — what Blindfold is and why it's prompt-injection-proof.
- **[Contributing](CONTRIBUTING.md)** — add a provider, run the tests, the security rules.
