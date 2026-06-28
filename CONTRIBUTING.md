<div align="center">

# 🤝 Contributing to Blindfold

**Thanks for helping make API keys un-leakable.** This guide gets you from clone to merged PR.

### 📖 &nbsp; [Home](README.md) &nbsp;·&nbsp; [Usage Guide](usage.md) &nbsp;·&nbsp; [Examples](EXAMPLES.md) &nbsp;·&nbsp; [Teams](TEAMS.md) &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

</div>

---

## The two invariants (read this first)

Every change must preserve both. If a PR weakens either, it won't be merged.

1. **EASY** — adopting Blindfold is *one line* of change for the user. New features should keep that promise (a flag, a sentinel, a one-liner — never a multi-step ritual).
2. **ZERO ADDED RISK** — Blindfold itself must never hold, log, store, or transit a plaintext secret outside the one sanctioned path. If a security auditor asks *"where could the key leak in this wrapper?"*, the honest answer must stay **"nowhere it wasn't already."**

> **The golden rule:** `packages/blindfold/src/register.ts` is the **only** file allowed to touch a plaintext secret value, and only to pass it as the `value` field of a single `executeControl("map-entry-set", …)` call. Everywhere else operates on *names*, *sentinels*, or *request shapes* — never the value.

---

## Quick start

```bash
git clone https://github.com/FiscalMindset/Blindfold.git
cd Blindfold
npm install

# Works with no T3 credentials — mock mode:
BLINDFOLD_MOCK=1 npm run demo          # side-by-side leak demo
BLINDFOLD_MOCK=1 npm run test:report   # the 9-check battery
```

For REAL-mode work against T3 testnet you need `T3N_API_KEY` + `DID` in `.env` (run `npm run setup`, or see the [Usage Guide](usage.md#0-first--check-everything-is-working-60-seconds)). Confirm your tenant is healthy with `blindfold doctor` before reporting a "seal fails" bug — an unprovisioned key or wrong DID is the #1 cause.

---

## Project layout

| Path | What lives here |
|---|---|
| `packages/blindfold/src/` | The TS SDK + CLI. `register.ts` (the only plaintext path), `proxy.ts`, `release.ts`, `wrap.ts`, `t3-client.ts`, `use`/`doctor` in `bin/blindfold.ts`. |
| `contract/` | The Rust → WASM contract. `src/forward.rs` (in-enclave substitution + `http::call`), `wit/` (world + canonical host WITs). |
| `examples/` | Runnable, copy-paste examples per stack. |
| `scripts/` | Live T3 utilities & proofs (`test-enclave-egress.ts`, `smtp-with-blindfold.ts`, …). |
| `docs/` | Long-form design docs. `explain.md` / `current_status.md` are the living status. |

---

## Common contributions

### Add a new provider to the proxy
1. Add the upstream base URL + path prefix in `packages/blindfold/src/proxy.ts`.
2. Make sure the provider name is recognized by the usage logger.
3. Add a runnable example under `examples/<provider>-quickstart/`.
4. Add a row to the [Examples](EXAMPLES.md) table.

### Change the contract
1. Edit `contract/src/forward.rs` (and `contract/wit/world.wit` if the interface changes).
2. `cd contract && cargo build --target wasm32-wasip2 --release`.
3. **Bump `CONTRACT_VERSION`** in `packages/blindfold/src/constants.ts` (T3 rejects re-publishing the same or a lower version).
4. Verify the component still imports only what it should: `wasm-tools component wit contract/target/wasm32-wasip2/release/blindfold_proxy.wasm`.

### Add a CLI command
Add a `case` in `packages/blindfold/bin/blindfold.ts`, update `printHelp()`, and never print a secret value (print *lengths*, *names*, or *fingerprints* instead).

---

## Before you open a PR

- [ ] `BLINDFOLD_MOCK=1 npm run test:report` → **9/9 ✅**
- [ ] `BLINDFOLD_MOCK=1 npm run demo` → "Blindfold neutralised the same attack."
- [ ] No secret value is ever `console.log`'d, written to a file, or committed. Grep your diff for key-shaped strings.
- [ ] `.env`, `.env.bak.*`, and any real secret stay **out** of git (they're gitignored — keep it that way).
- [ ] If you touched the contract, you bumped `CONTRACT_VERSION` and rebuilt.
- [ ] Docs updated if behavior changed (`README.md` "Real T3 mode" table, `usage.md`, `EXAMPLES.md`).

---

## Security policy

If you find a way to leak a sealed secret, **please do not open a public issue.** Email the maintainer (see the team section of the [README](README.md)) with the details so it can be fixed before disclosure. Security fixes jump the queue.

---

## Style

- Match the surrounding code — naming, comment density, and idiom. Comments explain *why*, not *what*.
- Keep examples ~20 lines and copy-pasteable.
- Prefer the no-paste secret workflow everywhere: read from `process.env`/`--from-env`, verify by fingerprint, never echo a value.

Happy hacking 🛡️
