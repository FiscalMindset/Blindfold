# AGENTS.md — For Future Coding Agents Working On This Repo

> If you are an AI coding assistant (Claude Code, Cursor, Codex, Aider, …) about to make changes here, read this in full first. It is short on purpose.

---

## What this project is

**Blindfold** is a thin wrapper around Terminal 3 (T3, a confidential-compute network on Intel TDX) that protects an AI agent's API keys from prompt-injection exfiltration. The full design is in `docs/01-problem-analysis.md` (the problem), `docs/02-terminal3-analysis.md` (the T3 surface we use), and `docs/03-architecture.md` (how the wrapper is built).

Before doing anything, read `explain.md` — it is the single source of truth for project status, open questions, and the running log. Update it at the end of every change you make.

---

## The two non-negotiable invariants

If you violate either of these, you have broken Blindfold. Test for them before merging.

1. **EASY.** A developer adopts Blindfold by changing **at most one line** (env var or `wrap()` call). Any new feature that requires more is not in scope; rework it.
2. **ZERO ADDED RISK.** The plaintext API key passes through *exactly one* function in this repo: `packages/blindfold/src/register.ts` → the single `executeControl("map-entry-set", …)` call. **Nowhere else.** Not in proxy logs, not in error messages, not in metrics, not in caches, not in tests' fixtures, not in CLI stdout.

Practical rules that come from invariant #2:

- Never `console.log` a value whose origin is `process.env.*_API_KEY` or any HTTP header named `authorization`.
- Never persist anything from `register.ts` to disk. The function reads → calls T3 → returns. No state.
- Never share state between `register.ts` and `proxy.ts`. They run in different processes; they share no module-level variables. (CI should grep for cross-imports.)
- Any new code path that *could* see a plaintext secret must be added to the audit table in `docs/03-architecture.md` §6 with a one-line justification.

---

## Folder map (skim, then go read the files)

```
contract/        Rust crate. The T3 WASM contract. Reads secret from KV, makes outbound call.
packages/blindfold/   TS package. The dev-facing SDK + CLI + proxy.
  src/register.ts     ⚠️ The ONLY plaintext-touching path. Audit-critical.
  src/proxy.ts        OpenAI-shaped HTTP proxy. Never touches the key.
  src/wrap.ts         In-process fetch wrap. Never touches the key.
  src/t3-client.ts    Auth + invoke helpers for @terminal3/t3n-sdk.
  bin/blindfold.ts    CLI entrypoint.
demo/            Two agents (A leaks, B doesn't) + a runner that prints the contrast.
docs/            Step-by-step design docs. 01, 02, 03 are the design; this is the agent guide.
scripts/         build-contract.sh + one-time-setup.sh.
```

---

## How to extend Blindfold

### Adding a new provider (e.g. Anthropic, Stripe)

You do **not** need to change `contract/` for a new provider. The contract is generic. You only need to:

1. Add a route in `packages/blindfold/src/proxy.ts` for the new provider's URL shape (e.g. `/v1/messages`).
2. Document the env-var swap in the README (`ANTHROPIC_BASE_URL=…`).
3. Add a demo under `demo/` if you want to show off the new provider; not required.

### Adding a new T3 capability the contract needs

Only add the capability to `contract/wit/world.wit` if the contract code actually uses it. Capabilities are not free — they widen the contract's blast radius if it's ever compromised. Justify the addition in a comment.

### Adding logging / metrics

Allowed, but:
- Never log header *values*.
- Always pass logs through `packages/blindfold/src/log.ts::safe()` if it touches any header or body.
- Log the *shape* of a request, not the contents (e.g. `POST /v1/chat/completions, 1421 bytes body` — not the body itself).

### Adding tests

Tests should never embed a real T3N_API_KEY. Use the mock T3 client at `packages/blindfold/src/t3-client.mock.ts` (added in a later iteration if needed). The full demo can run against the real testnet but is gated behind `BLINDFOLD_E2E=1`.

---

## How to find the right thing to change

| If you want to … | Edit … |
|---|---|
| Change what the contract does when called | `contract/src/forward.rs` |
| Change which T3 capabilities the contract has | `contract/wit/world.wit` |
| Change the developer-facing CLI commands | `packages/blindfold/bin/blindfold.ts` |
| Change how the proxy parses incoming requests | `packages/blindfold/src/proxy.ts` |
| Change how secrets get into T3 | `packages/blindfold/src/register.ts` (and *only* this file) |
| Change the demo prompts / attack payload | `demo/shared/injection-page.ts` |
| Add a new demo scenario | `demo/<scenario-name>/` |

---

## The single rule for updating `explain.md`

After every commit or material change: update the status table row + append a dated log entry. If you discover something uncertain about T3's behaviour, add it under "Open questions / NEEDS VERIFICATION" — do not guess in code.

---

## Style + conventions

- **TypeScript:** strict mode on. No `any` unless justified in a comment. Prefer narrow types from `src/types.ts`.
- **Rust:** match the T3 walkthrough exactly. `wit_bindgen` macros, `serde` derive, `cargo build --target wasm32-wasip2 --release`.
- **No new top-level files** without updating the folder map above + the architecture doc.
- **No comments explaining *what* code does** — explain *why*, but only when non-obvious. Naming should make `what` self-evident.

---

## When in doubt

Re-read invariant #2. If your change makes someone re-read it nervously, redesign.
