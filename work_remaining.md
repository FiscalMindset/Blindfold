# Work remaining

Living list of what's left, newest concerns first. Update as items land.

## Onboarding / signup

- [ ] **Re-verify the save-key-before-admit hardening live.** The `onKeyReady`
  callback (persist key the instant the email verifies, before self-admit) is
  built + typechecked but only the pre-hardening happy path was verified live on
  Windows. Redeploy to `ssh win` and run one signup to confirm the success path
  is unchanged and the post-verify-failure path reports "key saved, not lost".
- [ ] **Burned test aliases (informational).** `algsoch+blindfold1@gmail.com` and
  `+blindfold2` are bound to discarded keys on testnet (harmless dev tenants).
  `+blindfold3` → `did:t3n:36506da58d1de0d977b193f0ad73a076c832030a` is the live one
  stored on the Windows box.

## npm publish prerequisites (blockers for `npm publish`)

- [ ] **`packages/blindfold/README.md`** — currently absent, so the npm package
  page would be blank. Write a focused install + `signup` + quickstart README.
- [ ] **LICENSE + `license` field** in `packages/blindfold/package.json`.
- [ ] **Fix the library `exports`** — `./`, `./proxy`, `./register`, `./wrap` point
  at `.ts` sources. Either build them to `.js`/`.d.ts` or document that consumers
  need a TS/tsx loader. (The `bin` already ships the bundled `dist/cli.mjs`.)
- [ ] Decide version bump: `[Unreleased]` in CHANGELOG is substantial (signup,
  attest, credit, update, socket, audit remediation) — cut a real version.

## Nice-to-have hardening

- [ ] Consider funding-independent onboarding messaging: if the testnet welcome
  dial ever drops to 0, `signup` already warns and points at `blindfold credit`.
- [ ] `runOtpThenUserInput` is no longer used (we call the 3 steps explicitly);
  the interface member can be removed if we want to trim the SDK surface.

## Done (for reference)

- [x] `blindfold signup` self-serve onboarding — built + verified live on Windows.
- [x] Distinct error surfacing: wrong code / expired / email-already-owned.
- [x] Level-1 profile fields (first/last name) + `--first`/`--last`.
- [x] Save-key-before-admit hardening (code; live re-verify pending above).
- [x] Docs: README onramp, AGENTS.md, CHANGELOG.
- [x] Local test log: `window.md` (gitignored).
