# OpenAI SDK — Node.js quickstart

A real OpenAI call where **this process never holds the API key** — it lives in the T3 enclave, and the code only ever sees the `__BLINDFOLD__` sentinel.

## Run it

```bash
# In the repo root (one-time): seal your key, then delete it from .env
blindfold register --name openai_api_key --from-env OPENAI_API_KEY
blindfold proxy                      # leave running → http://127.0.0.1:8787

# In this folder:
cd examples/openai-node-quickstart
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
- Yet the completion is **real** — the proxy substitutes the sealed key inside the enclave, after the request leaves this process.
