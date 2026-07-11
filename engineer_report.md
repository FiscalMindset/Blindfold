# Blindfold — Engineering Review

**Date:** 2026-07-11
**Reviewer scope:** architecture, code quality, testing/CI, build & dependency hygiene, developer experience, and tech debt. Security and scalability were covered in depth separately (`SECURITY_AUDIT.md`); this report references them and does not repeat the full findings.
**Repo:** `FiscalMindset/Blindfold` — CLI + local proxy (`packages/blindfold`), companion Q&A service (`packages/chatbot`), Rust→WASM enclave contract (`contract/`).

---

## Verdict

Solid, coherent, and unusually disciplined for a project this young. The core idea is cleanly expressed in the code: the agent only ever holds the `__BLINDFOLD__` sentinel; substitution happens inside the enclave. Zero runtime dependencies, strict TypeScript, and test-pinned cryptographic vectors are real signs of engineering maturity. It ships as an installable, cross-platform CLI with layered access control (per-session token, unix socket, TDX attestation).

The main gaps are **process, not design**: CI does not type-check or secret-scan, the new security features have no automated tests (they were verified manually), and the CLI entry point has grown into a 969-line god-file. None of these threaten correctness today; all are cheap to fix and worth fixing before wider adoption.

**Rating: strong. Ready for demo and early users; close the CI + test-coverage gaps before promoting it as production-grade.**

---

## 1. Architecture

**Strengths**
- **Clear trust boundaries.** Three secret-use paths (proxy/forward, release broker, seed) are explicitly separated, each with a documented security posture. The proxy path never reads a secret; it only plants the sentinel. That invariant is easy to audit and is upheld in code.
- **Provider registry as declarations, not code.** `providers.ts` maps a path prefix → upstream host + sealed-secret name + one of four auth schemes (bearer/basic/sigv4/webhook). Adding a provider is a ~5-line declaration; the secure core (the enclave contract) is untouched. This is the right seam.
- **Layered access control, added coherently.** Enclave (can't steal) → per-session token (which process) → unix socket `0600` (which OS user) → attestation (which code). Each layer answers a distinct question and is opt-in/back-compatible.
- **Dependency-free by design.** `packages/blindfold` has **0 runtime dependencies** (the T3 SDK is an optionalDependency). The CLI shells out to platform tools (`security`, `secret-tool`, PowerShell) rather than pulling native modules. This is excellent for supply-chain safety and install reliability, and it's on-brand for a security tool.

**Concerns**
- **The enclave "return the body" shape is inherently tension-prone.** An enclave that makes an authed call and returns the raw response is only as confidential as the destination. This was hardened (H1/H2/H3 in the audit: header-scoped substitution, response redaction, webhook host-safety) but the deeper fix — binding each sealed secret to an allowed destination host at seal time — is still open. Worth doing before untrusted third-party providers.
- **Attestation-to-seal-key binding (audit H4).** Unpinned attestation proves "genuine TDX," not "runs my code." Mitigated by requiring an RTMR3 pin to seal; the definitive binding needs confirmation from the Terminal 3 SDK team.

---

## 2. Code quality & maintainability

**Strengths**
- **Strict TypeScript, and it's honored.** `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride` are all on. `tsc --noEmit` is **clean (0 errors)** across the repo after this session's fixes.
- **Zero `TODO`/`FIXME`/`HACK`** markers in `packages/*/src` or `contract/src`. Comments explain *why*, not just *what* (e.g. the constant-time token compare, the umask-before-bind rationale).
- **Secrets never logged.** `safeLog`/redaction, metadata-only usage log, `::add-mask::` on CI export, fingerprint-only rotate/rollback.

**Concerns**
- **`bin/blindfold.ts` is 969 lines** — a single-file command dispatcher handling ~25 commands. It's readable but has become a god-file: hard to test in isolation, high merge-conflict surface. **Recommend** splitting into `bin/commands/<name>.ts` modules with a thin dispatcher.
- **`dashboard.ts` is 785 lines** of inline HTML/CSS/JS in a template string. Fine for a single self-contained dashboard, but it's the second-largest file and is untestable as written.
- **15 `as any` casts** (mostly at the T3 SDK boundary, where types are loose). Acceptable, but a small typed shim/interface for the SDK surface you actually use (you already have `T3Sdk`/`AttestSdk` partial interfaces) would remove most of them and catch SDK-shape drift.
- **5 `eslint-disable`** — low and localized; fine.

---

## 3. Testing & CI

**Strengths**
- **The cryptography is test-pinned, not asserted.** `contract/auth-tests` runs the AWS SigV4 published `get-vanilla` vector + signing-key derivation + Basic vectors on every CI run. This is the highest-value test in the repo and it's done right.
- **CI exists and does real work** (`.github/workflows/ci.yml`): installs, runs the demo, `test:report` + `test:providers` batteries, then builds the WASM contract and runs the Rust unit tests. `real-t3.yml` covers live paths.

**Gaps (this is the weakest area)**
- **CI does not run `tsc --noEmit`.** A type error can merge. Given how much this session relied on strict types catching bugs, this is the single highest-value CI addition. *(One line: `npx tsc --noEmit -p tsconfig.json`.)*
- **CI does not secret-scan.** The gitleaks pre-commit hook is local-only and bypassable with `--no-verify`; CI should run `gitleaks git` as a backstop. (A real Deepgram key reached `process.md` and shipped publicly — see the incident note below. A CI scan would have caught it even if the local hook was skipped.)
- **The new security features have no automated tests.** Per-session token (401/200), unix socket `0600`, `wrap()`-over-socket, attestation gate (mock-refuse / require-pin / bypass-warn) were all verified **manually** this session. They should be encoded as tests so they can't silently regress — they're security-critical and the manual proofs already exist as scripts.
- **No formal TS unit-test framework.** The `test:*` scripts are bespoke batteries. A lightweight runner (node:test is dependency-free and on-brand) would make per-module tests cheap.

---

## 4. Security posture

Covered fully in `SECURITY_AUDIT.md`. Summary for this report: a four-auditor adversarial review found HIGH-severity issues in the enclave contract (secret-flow), attestation trust assumptions, a unix-socket permission race, and a chatbot cost-exhaustion bug. **All findings (HIGH→LOW) were remediated**, and the hardened contract (**v0.5.6, id 476**) was rebuilt, republished, and verified live (a header-smuggling attempt now returns HTTP 400). One honest open item remains (H4, attestation key-binding — needs the T3 SDK team).

**Incident (handled):** a real Deepgram API key was found committed in `process.md`, public in git history. It was revoked (by the owner), redacted, and **scrubbed from all history** via `git filter-repo`; a **gitleaks pre-commit hook** was added to prevent recurrence. Good outcome; the process lesson is that the secret scan belongs in CI too, not only the local hook.

---

## 5. Performance & scalability

Covered in `SECURITY_AUDIT.md` §Scalability. High-leverage items fixed this session: bounded concurrent enclave calls (S1), chatbot inverted index (S2), attestation TTL cache (S3), non-blocking usage log (S4). Deferred with rationale: streaming ledger reads (S5), async lock (S6), multi-instance shared state (S7), and the single-process ceiling (S10). The proxy client is stateless post-handshake, so horizontal scaling is a `cluster` + shared-budget change when load demands it, not a rewrite.

---

## 6. Developer experience & docs

**Strengths**
- **Installable, SSD-independent, cross-platform** CLI verified on macOS + Windows. State in `~/.blindfold`, tenant key in the OS keychain.
- **Docs are current and layered**: `README`, `usage.md`, `SECURITY.md`, `CHANGELOG.md`, plus a `SKILL.md` that teaches coding agents to use the tool safely (the agent-facing rulebook — a genuinely nice touch).
- **Every command prints what it did** and never a secret value — good for auditability and for demos.

**Concerns**
- Onboarding is **not yet self-serve**: a new user still needs a Terminal 3 tenant provisioned. This is the main barrier to a public npm publish (correctly held back).
- `SKILL.md` is duplicated across four locations (`.claude`, `.opencode`, `assets`, global) and synced manually. A tiny sync script (or making the others symlinks) would remove a class of drift.

---

## 7. Prioritized recommendations

1. **Add `tsc --noEmit` to CI.** One line; highest value. Prevents type regressions.
2. **Add `gitleaks git` to CI** as a secret-scan backstop (the local hook is bypassable).
3. **Encode the new security features as automated tests** (token 401/200, socket `0600`, attestation gate paths). The manual proofs already exist as shell scripts from this session — promote them.
4. **Split `bin/blindfold.ts`** (969 lines) into per-command modules with a thin dispatcher. Improves testability and reduces merge conflicts.
5. **Type the T3 SDK boundary** to remove most of the 15 `as any` casts and catch SDK-shape drift.
6. **Close audit H1–H3 fully** by binding sealed secrets to allowed destination hosts at seal time (contract change + republish).
7. **Confirm attestation H4** with the Terminal 3 SDK team.
8. **Automate `SKILL.md` sync** across its four copies.

---

## 8. What's genuinely impressive

- The security *culture*: the team ran an adversarial audit of its own tool, found real issues including in just-shipped code, fixed them, and verified the fix live against real Intel TDX hardware.
- Cryptographic correctness is proven by pinned vectors, not asserted.
- Zero runtime dependencies for a tool whose entire job is trust.
- The "seal once, use by name forever" model is clean, and the provider-as-declaration seam scales without touching the secure core.

**Status: DONE_WITH_CONCERNS** — architecture and security are strong; the concerns are CI type-check + secret-scan, automated tests for the new security features, and the `bin/` god-file. All are cheap, well-scoped follow-ups.
