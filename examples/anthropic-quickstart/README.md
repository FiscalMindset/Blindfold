# Anthropic SDK quickstart (Node)

A real Claude call where **this process never holds the API key** — only the `__BLINDFOLD__` sentinel.

## Run it

```bash
# In the repo root (one-time): seal your Anthropic key, then delete it from .env
blindfold register --name anthropic_api_key --from-env ANTHROPIC_API_KEY
blindfold proxy --port 8788 --secret anthropic_api_key   # leave running

# In this folder:
cd examples/anthropic-quickstart
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

The Blindfold integration is the `baseURL` + `apiKey` options in the `Anthropic({…})` constructor — everything else is stock SDK. The key this process carries is a sentinel, so a prompt-injection or leaked `.env` gets nothing, yet the Claude response is real because the proxy substitutes the sealed key inside the enclave.
