# 04 — Usage Recipes

> One-line-adoption snippets for the AI frameworks people actually ship. Pick yours; the rest of the file is reference.

The rule, again: **set the base URL to Blindfold's local proxy and put the sentinel in the API key field.** Your code doesn't otherwise change.

> **Prerequisite for every recipe:** Blindfold proxy is running and your real API key is registered with T3.
>
> ```bash
> npm run blindfold -- register --name openai_api_key --from-env OPENAI_API_KEY
> npm run blindfold -- proxy   # leave this running
> ```

---

## OpenAI SDK — Node.js (the official `openai` package)

The SDK reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from env. **Zero code changes.**

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 \
OPENAI_API_KEY=__BLINDFOLD__ \
node my-agent.js
```

Or in code:

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey:  "__BLINDFOLD__",           // sentinel; the real key never enters this process
});

const r = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
});
```

Runnable copy: [`examples/openai-node-quickstart/`](../examples/openai-node-quickstart/)

---

## OpenAI SDK — Python (the official `openai` package, v1+)

Same idea — env vars or constructor args.

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=__BLINDFOLD__
python my_agent.py
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="__BLINDFOLD__",
)

r = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hi"}],
)
```

Runnable copy: [`examples/openai-python-quickstart/`](../examples/openai-python-quickstart/)

---

## LangChain (Node or Python)

`ChatOpenAI` accepts `baseURL` / `base_url`. **One option change.**

```ts
// Node — @langchain/openai
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  model: "gpt-4o-mini",
  apiKey: "__BLINDFOLD__",
  configuration: { baseURL: "http://127.0.0.1:8787/v1" },
});
```

```python
# Python — langchain-openai
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4o-mini",
    api_key="__BLINDFOLD__",
    base_url="http://127.0.0.1:8787/v1",
)
```

Runnable copy: [`examples/langchain-summarizer/`](../examples/langchain-summarizer/)

---

## AutoGen (Microsoft)

`config_list` entries take `base_url`. Set it on every OpenAI-flavoured entry.

```python
from autogen import AssistantAgent

config_list = [{
    "model":    "gpt-4o-mini",
    "api_key":  "__BLINDFOLD__",
    "base_url": "http://127.0.0.1:8787/v1",
}]

assistant = AssistantAgent("assistant", llm_config={"config_list": config_list})
```

---

## Anthropic SDK

Blindfold's proxy understands `/anthropic/*` as well. The proxy substitutes the secret named `anthropic_api_key` (register it the same way as the OpenAI one).

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  baseURL: "http://127.0.0.1:8787/anthropic",
  apiKey:  "__BLINDFOLD__",
});
```

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8787/anthropic",
    api_key="__BLINDFOLD__",
)
```

Register once:

```bash
npm run blindfold -- register --name anthropic_api_key --from-env ANTHROPIC_API_KEY
```

Then tell the proxy to use that secret for /anthropic routes:

```bash
npm run blindfold -- proxy --secret anthropic_api_key
```

(Or run two proxies on different ports — one per provider — if you mix.)

---

## LlamaIndex (Node or Python)

Wraps the OpenAI client, so the recipe is the OpenAI one. In Python:

```python
from llama_index.llms.openai import OpenAI

llm = OpenAI(
    model="gpt-4o-mini",
    api_key="__BLINDFOLD__",
    api_base="http://127.0.0.1:8787/v1",
)
```

---

## The "my framework hides the HTTP client" escape hatch

If your library doesn't let you override the base URL, use Blindfold's in-process `wrap()`:

```ts
import OpenAI from "openai";
import { wrap } from "blindfold";

const openai = wrap(new OpenAI());          // mutates baseURL + apiKey for you
```

`wrap()` is a one-line monkey-patch on the client's `baseURL` and `apiKey` fields. It doesn't shim `fetch`, so it works with any client that uses Node's global `fetch` under the hood (which is most of them in 2026).

If even that doesn't work — the library bundles its own `fetch` shim and ignores `baseURL` — file an issue with the framework. Every modern AI SDK honours `*_BASE_URL`.

---

## Verifying you're actually using Blindfold

Hit the proxy's `/health` endpoint and check the logs:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"mock":false}     <-- mock=false means REAL T3 mode

# Then make one call from your agent and watch the proxy stderr:
# {"t":"...","level":"info","msg":"proxy_forward","method":"POST","upstream":"https://api.openai.com/v1/chat/completions"}
```

If your agent prints something resembling the real key, **you skipped the env swap**. Set `OPENAI_API_KEY=__BLINDFOLD__` and verify with `echo $OPENAI_API_KEY` before re-running.

---

## Rotating a key

```bash
# Update the .env temporarily, re-run register, delete from .env.
npm run blindfold -- register --name openai_api_key --from-env OPENAI_API_KEY
```

The new value overwrites the old one in `z:<tid>:secrets`. All in-flight proxy calls after the next request pick up the new value automatically — no proxy restart required.

---

## A note on what Blindfold does *not* protect

- **Outbound content** (the prompt body). If your prompt contains a user's private data, that data still leaves your process. Blindfold protects the API key, not the payload. (T3's `http-with-placeholders` is the right primitive for per-user PII in payloads — that's a separate Blindfold feature on the roadmap.)
- **Model responses**. If the upstream API returns sensitive data, your agent will see it. Blindfold is in the request path, not a response sanitiser.
- **Tool outputs**. If a tool the agent calls returns secrets (e.g. reading a config file), those land in the agent's context. Blindfold can only address the credential it manages.

The thing Blindfold makes structurally impossible is one specific thing — the developer's API key being exfiltrated through the agent. It's good at that one thing.
