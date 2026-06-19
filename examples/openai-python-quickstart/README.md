# OpenAI SDK — Python quickstart

```bash
cd examples/openai-python-quickstart
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

The two Blindfold-specific lines are in the `OpenAI(...)` constructor in `main.py`. Strip those out and you're back to a stock OpenAI call — no other change.

Tested against `openai >= 1.0`.
