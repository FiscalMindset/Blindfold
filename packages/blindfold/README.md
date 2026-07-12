# @fiscalmindset/blindfold

> Your AI agent can't leak the API key it never had.

Blindfold seals your API keys inside a **Terminal 3 TDX enclave**. Your agent
only ever sees a placeholder — `__BLINDFOLD__` — while the real credential is
substituted *inside* the enclave, right before the outbound call. A prompt
injection can't exfiltrate a secret that was never in the agent's process.

- **The key never enters your agent's memory or context.** It lives in the
  enclave; the agent talks to a local proxy that forwards through it.
- **One-line adoption.** Point your tool at the proxy (an env-var swap) or wrap
  your client in-process with `wrap()`.
- **Self-serve.** `npm i -g @fiscalmindset/blindfold && blindfold signup` mints a
  funded Terminal 3 testnet tenant — no manual provisioning.

## Install

```bash
npm i -g @fiscalmindset/blindfold
```

## Get a tenant (self-serve, ~30s)

```bash
blindfold signup --email you@example.com
# → generates your tenant key locally (stored in the OS keychain, never printed),
#   emails you a verification code, and self-admits a funded testnet tenant.
blindfold doctor      # ✅ handshake + authenticate OK · Ready to seal & use
blindfold credit      # see your token balance
```

One email binds to one tenant. Already have Terminal 3 credentials? Use
`blindfold login --did did:t3n:… ` instead.

## Seal a secret, then use it

```bash
# Seal (one-time). Prompts with no echo; the plaintext never touches disk.
blindfold register --name openai_api_key

# Run any tool with the sealed key injected for that command only:
blindfold use --name openai_api_key --as OPENAI_API_KEY -- your-cli …
```

### Or run the local proxy

```bash
blindfold proxy                 # http://127.0.0.1:8787, __BLINDFOLD__ sentinel
blindfold proxy --auth          # per-session token (only the wrapped agent can use it)
blindfold proxy --socket        # 0600 unix socket (only your OS user can connect)
```

Point your agent's base URL at the proxy and send `Authorization: Bearer
__BLINDFOLD__`; the enclave swaps in the real key.

### In-process (Node)

```js
import { wrap } from "@fiscalmindset/blindfold/wrap";

const fetch = wrap();               // ensures the proxy is running
// use `fetch` for your provider calls — send the sentinel, not your key.
```

## Common commands

| Command | What it does |
|---|---|
| `blindfold signup` | Self-serve: mint a funded testnet tenant. |
| `blindfold login` / `logout` / `whoami` | Manage stored tenant credentials (key in OS keychain). |
| `blindfold register --name <k>` | Seal a secret into the enclave. |
| `blindfold use --name <k> -- <cmd>` | Run a command with the released secret injected. |
| `blindfold proxy [--auth] [--socket]` | Local sentinel proxy your agent points at. |
| `blindfold attest [--pin]` | Verify the enclave's TDX attestation; pin the code measurement. |
| `blindfold credit` | Show the tenant's Terminal 3 token balance. |
| `blindfold doctor` | Show mode + config; live reachability check. |
| `blindfold update` | Update the global install. |

Run `blindfold help` for the full list.

## Security model (the short version)

- **Proxy / forward path** — the plaintext key is substituted **inside** the
  enclave; this CLI and your agent never see it. This is the un-leakable path.
- **Release path** (`use`, `export`, `rotate`) — returns the plaintext to the
  *local* process on purpose (for tools that need the raw value). Protection
  rests on the tenant key living in the OS keychain, not a readable file.
- **Attestation** — `blindfold attest --pin` proves the enclave runs the exact
  expected code (RTMR3 measurement, chained to Intel's root CA) before sealing.

## Requirements

- Node.js ≥ 18.
- `@terminal3/t3n-sdk` (installed automatically as an optional dependency) for
  REAL mode. `BLINDFOLD_MOCK=1` runs a no-network mock for CI/onboarding.

## License

MIT © FiscalMindset
