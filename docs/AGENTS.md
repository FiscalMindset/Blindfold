# AGENTS.md — For Future Coding Agents Working On This Repo

> If you are an AI coding assistant (Claude Code, Cursor, Codex, Aider, …) about to make changes here, read this in full first. It is short on purpose.

---

## What this project is

**Blindfold** is a thin wrapper around Terminal 3 (T3, a confidential-compute network on Intel TDX) that protects an AI agent's API keys from prompt-injection exfiltration. The full design is in `docs/01-problem-analysis.md` (the problem), `docs/02-terminal3-analysis.md` (the T3 surface we use), `docs/03-architecture.md` (how the wrapper is built), `docs/04-usage.md` (adoption recipes per stack), and `docs/05-compatibility.md` (which agent CLIs Blindfold works with).

Before doing anything, read `explain.md` — it is the single source of truth for project status, open questions, and the running log. Update it at the end of every change you make.

---

## The two non-negotiable invariants

If you violate either of these, you have broken Blindfold. Test for them before merging.

1. **EASY.** A developer adopts Blindfold by changing **at most one line** (env var or `wrap()` call). Any new feature that requires more is not in scope; rework it.
2. **ZERO ADDED RISK in the agent.** The plaintext API key never enters the agent's process or context. The only processes that may briefly touch the plaintext are:
   - **Registration** — `packages/blindfold/src/register.ts` (one `executeControl("map-entry-set", …)` call; value dropped immediately).
   - **Release broker** (today, until T3 ships canonical `http::call` WITs) — `scripts/smtp-with-blindfold.ts` and Aurora's `EnclaveBroker`: receive the plaintext from the T3 contract over the tenant-authenticated session, use it for one outbound call, drop it. Audit table in `docs/03-architecture.md` §6 lists every such path.

Practical rules:
- Never `console.log` a value whose origin is `process.env.*_API_KEY`, an `authorization` header, or the return of `contracts.execute("release_to_tenant", …)`.
- Never persist plaintext to disk. Logs use `packages/blindfold/src/log.ts::safeLog` which scrubs sensitive header names.
- The proxy (`proxy.ts`) ALWAYS replaces any `Authorization` header the agent sent with `Bearer __BLINDFOLD__` before calling T3. Don't introduce any path that bypasses this.
- Any new code path that *could* see plaintext must be added to the audit table in `docs/03-architecture.md` §6 with a one-line justification.

---

## Folder map (skim, then go read the files)

```
contract/                                Rust crate — the T3 WASM contract.
  Cargo.toml
  wit/
    world.wit                            forward + release-to-tenant exports; kv-store + tenant-context imports.
    deps/host-{tenant,interfaces}/       Best-effort host WIT stubs (replace if T3 ships canonical).
  src/{lib.rs, forward.rs}               forward() returns substitution-proof; release_to_tenant() returns plaintext.

packages/blindfold/                      TS package — dev-facing SDK + CLI + proxy + dashboard.
  src/
    register.ts                          ⚠️ ONE of two plaintext-touching paths (audit-critical). Three input modes: stdin prompt / pipe / --from-env.
    prompt.ts                            stdlib-only hidden-input reader for `register` without --from-env.
    proxy.ts                             OpenAI/Anthropic/xAI/Groq-shaped HTTP proxy. Never sees plaintext.
    wrap.ts                              In-process fetch wrap.
    t3-client.ts                         @terminal3/t3n-sdk wrapper. REAL only (mock is opt-in via BLINDFOLD_MOCK=1).
    init.ts                              `blindfold init` wizard logic (.env walkthrough, build, auth, scaffold, publish, ACL, seed).
    compat.ts                            `blindfold compat` scans local box for agent CLIs.
    dashboard.ts                         Live HTML dashboard server (default port 8799).
    usage-log.ts                         Append-only JSONL telemetry; metadata only.
    env.ts                               Loads .env; assertRealReady() throws if creds missing.
    log.ts, types.ts, constants.ts, index.ts
  bin/blindfold.ts                       CLI entrypoint. Commands listed below.

demo/                                    Two agents (A leaks, B doesn't) + a runner. Mock-LLM driven so it runs anywhere.

examples/                                Runnable per-stack quickstarts (openai-node, openai-python, langchain, anthropic).

scripts/
  build-contract.sh, one-time-setup.sh   Shell helpers.
  run-tests.ts                           `npm run test:report` — full 9-check battery; appends to output_analysis.md.
  real-e2e-test.ts                       `npm run test:real` — live REAL T3 pipeline.
  smtp-with-blindfold.ts                 The end-to-end "sealed AND used" demo. Real email sent via T3-released password.
  demo-smtp.ts                           SMTP send from env (the "without Blindfold" baseline).
  init-tenant.ts                         One-time per-tenant scaffolding (now baked into the wizard).
  diagnose-execute.ts                    Pulls contract logs + raw error after execute calls.
  probe-*.ts, grant-*.ts                 Diagnostic helpers — kept in-tree as the journal of what we tried.

docs/                                    01..05 = design docs. AGENTS.md = this file.
INTEGRATION-AURORA.md                    Coding-agent prompt for integrating Blindfold into the Aurora research engine.
vicky.md                                 Plain-English Q&A for new users. Newest at top.
explain.md                               Living status file. Update at the end of every change.
output_analysis.md                       Auto-appended test history.
tests/smtp-demo.md                       Permanent record of the without/with SMTP test runs.
```

---

## The CLI commands

```
blindfold init     [--seed KV:ENV]... [--start]   Zero-knowledge bootstrap. The preferred onramp.
blindfold verify                                   Handshake + auth round-trip against T3 testnet.
blindfold compat   [--json]                        Scan local box for agent CLIs.
blindfold register --name <K> [--from-env <ENV>]  Seal a secret. Prompts (no echo) if --from-env omitted; piped stdin also works.
blindfold proxy    [--port 8787] [--auth] [--socket [path]]  Local OpenAI-shaped proxy. --auth = per-session token; --socket = 0600 unix socket.
blindfold attest   [--expect-rtmr3 <b64>] [--pin] [--json]   Verify the enclave's TDX attestation (Intel root CA); --pin gates seal/proxy on the code measurement.
blindfold credit   [--json]                       Show the tenant's Terminal 3 token/credit balance (no credit cost).
blindfold publish  [--wasm <path>]                Manually publish the WASM (init does this automatically).
blindfold dashboard [--port 8799]                  Live HTML usage dashboard.
blindfold stats    | stats:clear                  CLI usage summary / wipe.
blindfold doctor                                   Show mode + config. Exit 1 if REAL is missing creds.
blindfold update   [--from <path>]                Update the global install (repo source, else @fiscalmindset/blindfold@latest).
```

Mocked behaviour is opt-in only: `BLINDFOLD_MOCK=1`. Otherwise, REAL mode is the only mode.

---

## How to extend Blindfold

### Adding a new provider (e.g. Anthropic, Stripe)

The contract is generic. Only:
1. Add a route in `packages/blindfold/src/proxy.ts::upstreamForPath` for the new provider's URL shape.
2. Add a provider tag in `packages/blindfold/src/usage-log.ts::providerForUpstream` for dashboard recognition.
3. Document the env-var swap in `docs/04-usage.md`.

### Adding a new T3 capability the contract needs

Only add the import to `contract/wit/world.wit` if the contract code actually uses it. Each import widens the contract's blast radius. Justify in a comment. **Known footgun (2026-06):** the `host:interfaces/http@2.1.0` import alone (without calling it) causes T3 to reject the contract at instantiation on some tenants. Until that's resolved, the working contract shape is kv-store + tenant-context only.

### Adding logging / metrics

- Never log header *values* — pass through `safeLog`.
- Log shape, not content (`POST /v1/chat/completions 1421b` not the body).
- `usage-log.ts` is the canonical telemetry path — metadata only by construction.

### Adding tests

- `npm run test:report` runs the 9-check battery (T1–T9 in `output_analysis.md`'s explainer). Uses `BLINDFOLD_MOCK=1` for proxy tests.
- `npm run test:real` runs a full live REAL-mode round-trip against T3 testnet. Costs one contract slot per publish.
- Never embed a real `T3N_API_KEY` in test fixtures.

---

## Quick "where do I edit" map

| If you want to … | Edit … |
|---|---|
| Change what the contract does when called | `contract/src/forward.rs` |
| Change which T3 capabilities the contract has | `contract/wit/world.wit` |
| Change the developer-facing CLI | `packages/blindfold/bin/blindfold.ts` + the `src/<command>.ts` it dispatches to |
| Change how the proxy parses incoming requests | `packages/blindfold/src/proxy.ts` |
| Change how secrets are sealed | `packages/blindfold/src/register.ts` (and *only* this file) |
| Change how secrets are released to a local broker | `contract/src/forward.rs::release_to_tenant` |
| Change the wizard flow | `packages/blindfold/src/init.ts` |
| Change the dashboard UI | the inline HTML in `packages/blindfold/src/dashboard.ts` |
| Change the demo prompts / attack payload | `demo/shared/injection-page.ts` |
| Add a new demo scenario | `demo/<scenario-name>/` |

---

## The single rule for updating `explain.md`

After every commit or material change: update the status table row + append a dated log entry. If you discover something uncertain about T3's behaviour, add it under "Open questions / NEEDS VERIFICATION" — do not guess in code.

---

## Style + conventions

- **TypeScript:** strict mode on. Avoid `any` (some SDK-shape escapes are tagged with `// eslint-disable-next-line` — keep them narrow).
- **Rust contract:** match the T3 walkthrough exactly. `wit_bindgen` macros, `serde` derive, `cargo build --target wasm32-wasip2 --release`. Bump `CONTRACT_VERSION` in `packages/blindfold/src/constants.ts` AND `contract/Cargo.toml` on every contract change.
- **No new top-level files** without updating the folder map above + `docs/03-architecture.md`.
- **Comments:** explain *why*, not *what*. Naming should make *what* self-evident.
- **Commit messages:** semantic prefix (`feat:`, `fix:`, `docs:`); body explains the *why* and lists *what* in bullets.

---

## When in doubt

Re-read invariant #2. If your change makes someone re-read it nervously, redesign.
