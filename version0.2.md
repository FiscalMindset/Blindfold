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

- **Keychain storage** — put `T3N_API_KEY` in the OS keychain (macOS Keychain /
  libsecret / Windows Credential Manager) instead of a `0600` file, closing the
  residual risk that an agent which can read `~/.blindfold/config.json` can
  release every secret.
- **Managed service** — `blindfold service install` to run the proxy as a
  launchd/systemd daemon (auto-start, auto-restart, logs) instead of a terminal
  you keep open.
- **Asset bundling** — ship SKILL.md, the dashboard UI, and the contract WASM
  inside the package so `skill`/`dashboard`/`publish` work from a global install.
- **One-line SDK** — `wrap(client)` that ensures the proxy is running, so code
  integrates without manually starting it.
