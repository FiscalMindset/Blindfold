# OpenAI SDK — Node.js quickstart

A real OpenAI call where **this process never holds the API key** — it lives in the T3 enclave, and the code only ever sees the `__BLINDFOLD__` sentinel.

## Prerequisites

- A real OpenAI API key (the proxy makes a genuine call to `api.openai.com`).
- A healthy T3 tenant — check with `npm run blindfold -- doctor` (must say `Ready to seal & use`).

## Setup (one-time, from the repo root)

```bash
npm run blindfold -- init                                   # build + publish the contract + grant the secrets ACL
blindfold register --name openai_api_key --from-env OPENAI_API_KEY   # seal your key, then delete it from .env
blindfold grant --host api.openai.com                       # authorize the contract to call OpenAI  ← easy to forget
```

> The `grant` step is what makes the in-enclave call to OpenAI allowed. Without it the proxy returns an egress error — it is **not** optional.

## Run it

```bash
npm run blindfold -- proxy            # terminal 1 — leave running → http://127.0.0.1:8787

cd examples/openai-node-quickstart    # terminal 2
npm install
node index.js
```

## Expected output

```
🔒 This process's apiKey = "__BLINDFOLD__"  (the real key is in the enclave)
🤖 Blindfold works.
🕵️  If this agent were tricked into leaking its key, it would send: "__BLINDFOLD__"
✅ Real completion succeeded with a key this process never held.
```

## What this proves

- The only Blindfold-specific lines are `baseURL` + `apiKey` in the `OpenAI({…})` constructor — adoption is **one line**.
- The "key" in this process is a **sentinel**, not a secret. A prompt-injection that exfiltrates `OPENAI_API_KEY` leaks the worthless string `__BLINDFOLD__`.
- Yet the completion is **real** — the request flows proxy → contract → **in-enclave `http::call` to api.openai.com**, where the sealed key is substituted. Verified end-to-end: with a throwaway key, OpenAI returns `401 invalid_api_key` — proof the chain reaches OpenAI; with a real key it returns a completion.

## Don't want to set up egress? (simpler, no proxy)

For non-HTTP tools or quick use, `blindfold use` releases the key for one command with **no publish/grant needed**:

```bash
blindfold use --name openai_api_key --url https://api.openai.com/v1/models   # quick auth check
```
See [../../EXAMPLES.md](../../EXAMPLES.md) for the three use surfaces.
