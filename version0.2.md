# Blindfold v0.2 — Installable, SSD-independent CLI

v0.1 ran as a dev script (`npm run blindfold …`) with all config and state living
**inside the repo**. That tied the whole tool to one checkout — on an external
SSD, unplugging the drive killed it (`EPERM: uv_cwd`), and there was no way to
"install once, run anywhere."

**v0.2 makes Blindfold a real, installable product.** State, config, and code
all move off the repo, so it runs from any directory — even with the source
drive unplugged.

---

## What changed

### 1. State moved to `~/.blindfold/` (was `<repo>/.blindfold/`)

The ledger, usage log, egress-host cache, and ledger HMAC key now live in the
user's home directory, not the repo. On first run, an existing in-repo
`.blindfold/` is **migrated automatically** (copied once), so grants and history
carry over — the proxy keeps working without re-granting.

- Default: `~/.blindfold/`
- Override: `BLINDFOLD_STATE_DIR=/custom/path`
- Implementation: `stateDir()` in `packages/blindfold/src/env.ts`

### 2. Credentials via `blindfold login` → `~/.blindfold/config.json`

Tenant credentials (`T3N_API_KEY`, `DID`, environment) no longer have to live in
a repo `.env`. A new `login` command stores them in `~/.blindfold/config.json`
with `0600` permissions, so the CLI authenticates from any directory.

```bash
blindfold login                       # prompts for DID + key (key hidden)
blindfold login --did did:t3n:… --env testnet   # non-interactive (key still prompted unless --key)
blindfold whoami                      # show config path, tenant, env, key status (never the value)
blindfold logout                      # remove stored credentials
```

**Credential precedence** (first found wins): `process.env` → repo `.env` (dev
convenience, when present) → `~/.blindfold/config.json` (installed product).
So existing repo-based workflows are unchanged; a fresh install with no repo
`.env` uses the login config.

### 3. Installable binary (compiled, no `tsx` needed)

`packages/blindfold` now builds a single bundled CLI so it can be installed
globally and run with plain `node` — off the SSD, no repo, no `tsx`.

- Build: `npm run build` (esbuild → `dist/cli.mjs`, `@terminal3/t3n-sdk` external)
- `package.json`: `bin.blindfold → dist/cli.mjs`, `files` includes `dist`,
  `prepare` runs the build on install
- Verified: the bundle, copied to `~` and run from `/tmp` with the repo
  unreachable, executes correctly (creds resolved from `~/.blindfold/config.json`).

---

## Install & use (the new flow)

```bash
# From the repo (or once published to npm):
npm install -g ./packages/blindfold      # or: npm i -g blindfold

# One-time setup on any machine:
blindfold login                          # store tenant creds in ~/.blindfold
blindfold doctor                         # confirm T3 reachability

# Use it from anywhere — the source drive can be unplugged:
blindfold use --name github_token -- gh api user
blindfold proxy                          # localhost:8787, __BLINDFOLD__ sentinel
```

### Where everything lives now

| Item | v0.1 (repo / SSD) | v0.2 |
|------|-------------------|------|
| Ledger, usage, egress cache, HMAC key | `<repo>/.blindfold/` | `~/.blindfold/` |
| Tenant DID + settings | repo `.env` | `~/.blindfold/config.json` |
| Tenant key (`T3N_API_KEY`) | plaintext repo `.env` | `~/.blindfold/config.json` (`0600`) |
| CLI code | `tsx` over repo source | bundled `dist/cli.mjs`, installable |

---

## Known limitations / next steps

These commands still resolve assets relative to the repo, so they need the repo
present (or asset bundling) when running from a global install:

- `blindfold skill …` — reads `.claude/skills/blindfold/SKILL.md` from the repo
- `blindfold dashboard` — logo/static asset paths are repo-relative
- `blindfold publish` — needs the built `contract/*.wasm`

Core commands (`login`, `whoami`, `register`, `use`, `export`, `proxy`, `grant`,
`rotate`, `rollback`, `status`, `audit`, `doctor`, `verify`) are fully
self-contained and work from a global install off the SSD.

### Roadmap beyond v0.2

- ✅ **Keychain storage** — done in v0.3, see below.
- **Managed service** — `blindfold service install` to run the proxy as a
  launchd/systemd daemon (auto-start, auto-restart, logs) instead of a terminal
  you keep open.
- **Asset bundling** — ship SKILL.md, the dashboard UI, and the contract WASM
  inside the package so `skill`/`dashboard`/`publish` work from a global install.
- **One-line SDK** — `wrap(client)` that ensures the proxy is running, so code
  integrates without manually starting it.

---

# v0.3 — Tenant key in the OS keychain

v0.2 stored the tenant key (`T3N_API_KEY`) in `~/.blindfold/config.json` at
`0600`. That's still a plaintext file a prompt-injected agent with filesystem
read could grab — the core residual risk. v0.3 moves the key **out of any file**
and into the OS keychain.

## How it works

- **`blindfold login`** now writes the tenant key to the OS keychain, keyed by
  tenant DID. `config.json` keeps only the **non-secret** DID + settings plus a
  `"T3N_API_KEY_STORE": "keychain"` marker — no plaintext key on disk.
- Backends (dependency-free, shells out to the platform tool):
  - macOS → `security` (Keychain)
  - Linux → `secret-tool` (libsecret / GNOME Keyring)
  - no keychain → falls back to the v0.2 `0600` file (`login --file` forces this)
- **Credential load** (`env.ts`): after reading DID from config, if the key
  isn't already in the environment it's fetched from the keychain by DID.
- **`blindfold logout`** removes the key from the keychain *and* deletes the
  config file.
- **`blindfold whoami`** reports the key source: `macOS Keychain`,
  `config file, 0600`, or `env / repo .env`.

## Why it matters

This closes the residual risk for the release/broker path on a properly set-up
machine: with the tenant key in the keychain, there is no readable credential
file for an agent to exfiltrate. (An agent could still prompt the OS keychain if
it runs as the same user with an unlocked keychain — so the proxy-under-a-
separate-user hardening remains on the roadmap — but the trivial "read the file"
path is gone.)

Verified on macOS: `login` stores the key in Keychain with zero plaintext in
`config.json`; `logout` clears both; the existing repo-`.env` workflow is
unchanged (keychain is consulted only when the key isn't already present).
