# Anthropic SDK quickstart (Node)

A real Claude call where **this process never holds the API key** — only the `__BLINDFOLD__` sentinel.

> Note: Anthropic authenticates with the `x-api-key` header (not `Bearer`). The SDK sends `x-api-key: __BLINDFOLD__`, and the contract substitutes the sentinel in **every** header — so this works the same way as the Bearer providers.

## Prerequisites

- A real Anthropic API key (the proxy makes a genuine call to `api.anthropic.com`).
- A healthy T3 tenant — check with `npm run blindfold -- doctor`.

## Setup (one-time, from the repo root)

```bash
npm run blindfold -- init                                       # build + publish the contract + grant the secrets ACL
blindfold register --name anthropic_api_key --from-env ANTHROPIC_API_KEY   # seal your key, then delete it from .env
blindfold grant --host api.anthropic.com                        # authorize the contract to call Anthropic  ← required
```

## Run it

```bash
blindfold proxy --port 8788 --secret anthropic_api_key   # terminal 1 — leave running

cd examples/anthropic-quickstart                          # terminal 2
npm install
node index.js
```

## Expected output

```
🔒 This process's apiKey = "__BLINDFOLD__"  (the real key is in the enclave)
🤖 Blindfold works.
✅ Real Claude response using a key this process never held.
```

## What this proves

The Blindfold integration is the `baseURL` + `apiKey` options in the `Anthropic({…})` constructor — everything else is stock SDK. The key this process carries is a sentinel, so a prompt-injection or leaked `.env` gets nothing, yet the Claude response is real because the request flows proxy → contract → **in-enclave `http::call` to api.anthropic.com**, where the sealed key replaces the sentinel.

> No proxy/egress setup? `blindfold use --name anthropic_api_key -- <command>` releases the key for one command with no publish/grant needed. See [../../EXAMPLES.md](../../EXAMPLES.md).
