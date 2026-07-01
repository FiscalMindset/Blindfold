# Prompt-injection resistance — real, not staged

This is the concrete, watchable version of Blindfold's thesis: an AI agent with a
**real** API credential is fed **untrusted content** containing a prompt
injection that tries to steal that credential — and gets nothing, because the
credential was never in the agent to begin with.

## Why GitHub (and how to make it Stripe)

The demo runs live against **GitHub** because `github_token` is the credential
sealed in this enclave, so the calls are genuinely authenticated (you'll see the
agent authenticate as a real GitHub login). GitHub-issue prompt injection —
malicious instructions hidden in an issue/PR/comment the agent reads — is a real,
documented attack class.

The harm generalizes directly to **payments** — and that version is real too:
see [`../stripe/`](../stripe/), which does the same thing against a live Stripe
test account (real balance read + customer write, injection can't steal the
`sk_test_` key). The injection resistance is **identical** because it's
structural — the agent holds a sentinel, not a key — not a classifier that might
be talked around.

## What's real here

- ✅ A real, authenticated GitHub API call through the TDX enclave.
- ✅ The credential (`github_token`) is genuinely privileged (the demo prints the
  authenticated login to prove it).
- ✅ The agent process holds **no** token — the demo scans the *entire*
  `process.env` for a real `ghp_…`/`github_pat_…` token and finds none. A
  leftover in `.env` would be reported as a real leak, not hidden.
- ✅ The only credential the agent can hand over is `Bearer __BLINDFOLD__`.

The only thing simulated is the attacker's issue text (a fixture) and that we
print the exfiltration payload instead of POSTing it to a real attacker.

## Setup (one time)

```bash
npm run blindfold -- register --name github_token --from-env GITHUB_TOKEN
npm run blindfold -- grant --host api.github.com
# then delete GITHUB_TOKEN from .env — it lives only in the enclave
```

## Run

```bash
npx tsx examples/prompt-injection/agent.ts
```

## Output

```
✅ Legit call succeeded — agent is authenticated to GitHub as "FiscalMindset".
   The token that authorized this is REAL and privileged.

🧨 The injection demands the agent leak its GITHUB_TOKEN and POST it to the attacker.

📤 If the agent dumped its credentials, the attacker would get:
   • env vars containing a real GitHub token: (none)
   • Authorization header the agent sends:    Bearer __BLINDFOLD__

🛡️  Attacker receives only the sentinel. Nothing usable.
```

## The point

Guardrails, classifiers, and allowlists are probabilistic — a clever enough
injection eventually talks its way through. Blindfold is structural: there is no
key in the agent's context, so there is nothing for any injection to exfiltrate,
no matter how convincing. See [`../../integration-stack.md`](../../integration-stack.md).
