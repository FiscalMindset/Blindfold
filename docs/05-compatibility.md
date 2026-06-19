# 05 — Compatibility: Where Blindfold Works (and Where It Doesn't)

> The short version: Blindfold protects **any tool that lets you set a base URL and uses a user-supplied API key**. The interesting cases are the tools that don't.

Run `npm run blindfold -- compat` to scan your local machine; this doc gives the longer story.

---

## The two-property test

For Blindfold to be able to protect a tool, the tool must satisfy **both**:

1. **It uses an API key you control.** If the tool authenticates via an OAuth session / SSO / proprietary token tied to your account on a vendor portal (Claude Code's default flow, Cursor's bundled mode, ChatGPT's web UI), there is no user-supplied secret on disk — there's nothing for Blindfold to protect.
2. **It accepts a base-URL override.** The tool's HTTP client must honour an env var (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, etc.) or a config-file setting (`baseURL`, `apiBase`, `endpoint`). If the URL is hard-coded in the binary, Blindfold can't intercept without DNS-level tricks.

The matrix below maps the tools you'll actually encounter against those two properties.

---

## Compatibility matrix

| Tool | User-supplied key? | Base-URL override? | Verdict | One-line wire-up |
|---|---|---|---|---|
| **OpenAI SDK** (Node + Python) | ✅ | ✅ `OPENAI_BASE_URL` | ✅ Just works | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=__BLINDFOLD__` |
| **Anthropic SDK** (Node + Python) | ✅ | ✅ `ANTHROPIC_BASE_URL` | ✅ Just works | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic ANTHROPIC_API_KEY=__BLINDFOLD__` |
| **LangChain** (`ChatOpenAI`, `ChatAnthropic`) | ✅ | ✅ `configuration.baseURL` / `base_url` | ✅ Just works | `new ChatOpenAI({ apiKey: "__BLINDFOLD__", configuration: { baseURL: "http://127.0.0.1:8787/v1" } })` |
| **LlamaIndex** | ✅ | ✅ `api_base` | ✅ Just works | `OpenAI(api_key="__BLINDFOLD__", api_base="http://127.0.0.1:8787/v1")` |
| **AutoGen** | ✅ | ✅ per-config `base_url` | ✅ Just works | `config_list = [{"base_url": "http://127.0.0.1:8787/v1", "api_key": "__BLINDFOLD__"}]` |
| **OpenCode** (sst.dev/opencode) | ✅ | ✅ `~/.config/opencode/config.json` | ✅ Just works | Set the provider's `baseURL` to `http://127.0.0.1:8787/v1` |
| **Aider** | ✅ | ✅ `OPENAI_API_BASE` (older spelling) | ✅ Just works | `OPENAI_API_BASE=http://127.0.0.1:8787/v1 OPENAI_API_KEY=__BLINDFOLD__ aider` |
| **OpenAI Codex CLI** (`codex`) | ✅ | ✅ `OPENAI_BASE_URL` | ✅ Just works | Same env-var swap as the OpenAI SDK |
| **Continue.dev** (VS Code / JetBrains) | ✅ | ✅ `~/.continue/config.json` `apiBase` | ✅ Edit one field | Set `apiBase: "http://127.0.0.1:8787/v1"`, `apiKey: "__BLINDFOLD__"` |
| **Cline** (VS Code extension) | ✅ | ✅ extension settings | ✅ Two settings | API Provider → set Base URL + API Key |
| **Claude Code** | ⚠ depends | ✅ if you use a key | ⚠ See note below | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic ANTHROPIC_API_KEY=__BLINDFOLD__` *only if you're on the key-based auth path* |
| **Cursor** (desktop) | ❌ default / ✅ "Use your own key" | ❌ no base-URL in current builds | ⚠ Limited | Default mode uses Cursor's bundled service — no key on disk. "Use your own key" mode lacks a base-URL hook. |
| **ChatGPT.com / claude.ai / web UIs** | ❌ | ❌ | ❌ Doesn't apply | These are SaaS apps — no key on your disk, no proxy point. |
| **Ollama** (local models) | ❌ no remote key | n/a | ❌ Doesn't apply | Models run locally; no external API key to protect. |

---

## The Claude Code note in detail

Claude Code (this CLI) has two auth modes:

1. **Subscription / OAuth (default).** You log in once with your claude.ai account; Claude Code holds an OAuth session token. There is no `ANTHROPIC_API_KEY` on disk. Blindfold cannot protect what isn't there — and you don't need it to, because the OAuth flow doesn't expose a long-lived API credential to your agent code.
2. **API-key auth (`ANTHROPIC_API_KEY`, used by some enterprise / proxy / CI setups).** Here you put a real Anthropic key in your environment and Claude Code uses it directly. **This is the case where Blindfold helps.** Set:

   ```bash
   ANTHROPIC_API_KEY=__BLINDFOLD__
   ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
   ```

   Then register your real Anthropic key with T3 once:

   ```bash
   echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
   npm run blindfold -- register --name anthropic_api_key --from-env ANTHROPIC_API_KEY
   # delete from .env now
   npm run blindfold -- proxy --secret anthropic_api_key --port 8787
   ```

If you're not sure which mode you're in: open Claude Code and check whether `ANTHROPIC_API_KEY` is set in the environment it launched from. If yes → use Blindfold. If no → you're on OAuth and it doesn't apply (and that's fine).

---

## What about tools that don't honour a base URL?

You have three escape hatches, in order of preference:

1. **Open a feature request with the tool.** Every modern HTTP client supports a base URL; tools that hard-code one usually accept a PR to add it.
2. **Run an upstream gateway** (LiteLLM, OpenRouter, an Envoy with rewrites) that the tool *can* point at; have *that* gateway point at Blindfold. One extra hop, fully transparent to the tool.
3. **System-level interception** (etc-hosts override + a local TLS cert installed in the system trust store). Possible but invasive — only worth it for stubborn closed-source binaries.

If your tool falls into this bucket, file an issue against Blindfold with the tool's name and we'll keep the matrix updated.

---

## Running the scan

```bash
npm run blindfold -- compat
```

Sample output (your machine may show different rows):

```
🛡️  Blindfold — compatibility scan

Detected (3):
  ✓ openai (Node SDK) · Blindfold protects this
    OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=__BLINDFOLD__
  ✓ @anthropic-ai/sdk (Node SDK) · Blindfold protects this
    ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic  ANTHROPIC_API_KEY=__BLINDFOLD__
  ? Claude Code (claude) · Depends on how you authenticate
    ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic  ANTHROPIC_API_KEY=__BLINDFOLD__

Not found on this machine (8):
  · Aider · (not installed)
  · Continue.dev (continue) · (not installed)
  …
```

`npm run blindfold -- compat --json` gives the same data as machine-readable JSON.
