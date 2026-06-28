# OpenAI SDK — Python quickstart

A real OpenAI call from Python where **this process never holds the API key** — only the `__BLINDFOLD__` sentinel.

## Run it

```bash
# In the repo root (one-time): seal your key, then delete it from .env
blindfold register --name openai_api_key --from-env OPENAI_API_KEY
blindfold proxy                      # leave running → http://127.0.0.1:8787

# In this folder:
cd examples/openai-python-quickstart
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

The two Blindfold-specific lines are `base_url` + `api_key` in the `OpenAI(...)` constructor. Strip them and you're back to a stock OpenAI call. The "key" this process carries is a sentinel — a leaked `.env` or prompt injection gets nothing — yet the completion is real because the proxy substitutes the sealed key inside the enclave. Tested against `openai >= 1.0`.
