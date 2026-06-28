# OpenAI SDK — Python quickstart

A real OpenAI call from Python where **this process never holds the API key** — only the `__BLINDFOLD__` sentinel.

## Prerequisites

- A real OpenAI API key (the proxy makes a genuine call to `api.openai.com`).
- A healthy T3 tenant — check with `npm run blindfold -- doctor`.

## Setup (one-time, from the repo root)

```bash
npm run blindfold -- init                                   # build + publish the contract + grant the secrets ACL
blindfold register --name openai_api_key --from-env OPENAI_API_KEY   # seal your key, then delete it from .env
blindfold grant --host api.openai.com                       # authorize the contract to call OpenAI  ← required
```

## Run it

```bash
npm run blindfold -- proxy            # terminal 1 — leave running → http://127.0.0.1:8787

cd examples/openai-python-quickstart  # terminal 2
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

## Expected output

```
🔒 This process's api_key = "__BLINDFOLD__"  (the real key is in the enclave)
🤖 Blindfold works.
✅ Real completion succeeded with a key this process never held.
```

## What this proves

The two Blindfold-specific lines are `base_url` + `api_key` in the `OpenAI(...)` constructor. Strip them and you're back to a stock OpenAI call. The "key" this process carries is a sentinel — a leaked `.env` or prompt injection gets nothing — yet the completion is real because the request flows proxy → contract → **in-enclave `http::call`**, where the sealed key is substituted (verified: a throwaway key yields a real `401` from OpenAI). Tested against `openai >= 1.50`.

> No proxy/egress setup? `blindfold use --name openai_api_key --url https://api.openai.com/v1/models` works immediately. See [../../EXAMPLES.md](../../EXAMPLES.md).
