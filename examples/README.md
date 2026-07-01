# Examples

Runnable, copy-paste examples of using a **sealed** secret — across the three ways Blindfold lets you use one. For the full annotated showcase, see **[../EXAMPLES.md](../EXAMPLES.md)**.

> You seal a secret **once** (`blindfold register --name X --from-env X`) and then refer to it by name forever. **You never write a script per secret** — the examples below are generic templates, not one-offs.

## Pick by how much code you want

| Example | Stack | Use surface | Code? |
|---|---|---|---|
| [`cli-tools/`](cli-tools/) | `gh` · `git` · `curl` · `psql` · `docker` | `blindfold use` | **none** |
| [`digital-ocean/`](digital-ocean/) | DigitalOcean API · `doctl` · `curl` | `blindfold use` + enclave-egress | **none** |
| [`api-providers/`](api-providers/) | Deepgram · Blogger · Hostinger (3 auth styles, real output) | `blindfold use` | **none** |
| [`openai-node-quickstart/`](openai-node-quickstart/) | OpenAI SDK · Node | proxy + sentinel | one line |
| [`openai-python-quickstart/`](openai-python-quickstart/) | OpenAI SDK · Python | proxy + sentinel | one line |
| [`langchain-summarizer/`](langchain-summarizer/) | LangChain · Node | proxy + sentinel | one line · **includes a live prompt-injection attack** |
| [`anthropic-quickstart/`](anthropic-quickstart/) | Anthropic SDK · Node | proxy + sentinel | one line |
| [`grok-via-blindfold.ts`](grok-via-blindfold.ts) | xAI/Grok · Node | `release()` in code | one line |
| [`gemini/`](gemini/) | Google Gemini · Node | proxy + sentinel (`x-goog-api-key`) | one line · **real live call, non-Bearer auth** |
| [`stripe/`](stripe/) | Stripe · Node | proxy + sentinel | **real test-mode read+write, injection can't steal the key** |
| [`prompt-injection/`](prompt-injection/) | GitHub · Node | proxy + sentinel | **real live credential-theft attack, defeated structurally** |
| [`twilio/`](twilio/) | HTTP Basic · Node | in-enclave `base64(user:secret)` | **proven live via httpbin (200) — the Twilio scheme** |
| [`aws/`](aws/) | AWS SigV4 · Node | in-enclave request signing | **proven live vs real S3 + byte-exact AWS vectors** |

> **Integration depth:** Blindfold ships first-class support for 12 providers across 6 industries and 3 in-enclave auth schemes (bearer, HTTP Basic, AWS SigV4). See **[../integration-stack.md](../integration-stack.md)**.

## Prerequisites (do once)

```bash
# From the repo root — confirm your tenant is healthy first:
npm run blindfold -- doctor
#   ✅ Ready to seal & use secrets on this tenant.

# Seal the key this example needs, then delete it from .env:
blindfold register --name openai_api_key --from-env OPENAI_API_KEY
```

## The two patterns these examples use

**Proxy + sentinel (HTTP SDKs)** — one-time setup, then point the SDK at the proxy:

```bash
npm run blindfold -- init                 # publish contract + grant secrets ACL (one-time)
blindfold grant --host api.openai.com     # authorize the contract to call the provider (required)
blindfold proxy                           # → http://127.0.0.1:8787, leave running
```
```js
new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "__BLINDFOLD__" });
```

**`blindfold use` (no code, any CLI)** — see [`cli-tools/`](cli-tools/):

```bash
blindfold use --name github_token --as GH_TOKEN -- gh api user
```

Each example folder has its own README with the exact run commands.
