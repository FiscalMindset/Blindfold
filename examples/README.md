# Examples

Runnable, copy-paste-friendly examples of using Blindfold with the AI stacks people actually ship.

| Example | Stack | What it shows |
|---|---|---|
| [`openai-node-quickstart/`](openai-node-quickstart/) | OpenAI SDK · Node | Smallest possible OpenAI call routed through Blindfold |
| [`openai-python-quickstart/`](openai-python-quickstart/) | OpenAI SDK · Python | Same, but Python |
| [`langchain-summarizer/`](langchain-summarizer/) | LangChain · Node | A summarizer agent — the prompt-injection attack lives in the page it fetches |
| [`anthropic-quickstart/`](anthropic-quickstart/) | Anthropic SDK · Node | Claude through Blindfold's `/anthropic/*` path |

## Common prerequisites (do once)

```bash
# In the repo root:
./scripts/one-time-setup.sh

# Provide your real key, register it with T3, then delete it from .env:
echo "OPENAI_API_KEY=sk-real-..." >> .env
npm run blindfold -- register --name openai_api_key --from-env OPENAI_API_KEY
# (Now delete that line from .env — the value lives only in the enclave.)

# Run the proxy in one terminal and leave it running:
npm run blindfold -- proxy --port 8787
```

> All examples assume the proxy is running at `http://127.0.0.1:8787`. Pass `--port` to change it.

## The pattern is always the same

1. Set the SDK's base URL to `http://127.0.0.1:8787/v1` (or `/anthropic`, etc.).
2. Set the SDK's API key to `__BLINDFOLD__` (a sentinel — the real value is in T3).
3. Run your code unchanged.

That's it. Each example below is ~20 lines.
