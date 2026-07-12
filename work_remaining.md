# Work remaining

Living list of what's left, newest concerns first. Update as items land.

## Onboarding / signup

- [x] **Re-verify the save-key-before-admit hardening live.** Done 2026-07-12:
  0.4.0 (with `onKeyReady`) redeployed to `ssh win`; signup succeeded end-to-end
  → `did:t3n:21e3d7e82ae0aa837d47f6795a34e0b161086eba`, doctor active, credit
  ~19,990 tokens. Success path unchanged; credentials persisted via the callback.
  (Post-verify-failure branch is code-reviewed but hard to trigger on demand.)
- [ ] **Burned test aliases (informational).** `algsoch+blindfold1@gmail.com` and
  `+blindfold2` are bound to discarded keys on testnet (harmless dev tenants).
  `+blindfold3` → `did:t3n:36506da58d1de0d977b193f0ad73a076c832030a` is the live one
  stored on the Windows box.

## npm publish prerequisites

- [x] **`packages/blindfold/README.md`** — focused install + `signup` + quickstart.
- [x] **MIT LICENSE + `license` field** (+ repository/homepage/bugs/keywords).
- [x] **Library `exports` fixed** — `.`, `./proxy`, `./register`, `./wrap` build to
  `dist/lib/*.mjs` (plain-Node runnable); types resolve from shipped `src/*.ts`.
- [x] **Version cut to 0.4.0** (CHANGELOG dated).
- [x] **`npm publish`** — DONE 2026-07-12. `@fiscalmindset/blindfold@0.4.0` is
  live on npm (MIT, `latest` tag, public). Created the free `@fiscalmindset` npm
  org (owner `algsoch`) first. Verified: clean `npm i -g @fiscalmindset/blindfold`
  installs + `blindfold help/doctor` run. Page:
  https://www.npmjs.com/package/@fiscalmindset/blindfold
- [ ] **Regenerate npm 2FA recovery codes** — five were pasted in chat (one
  consumed by the publish); regenerate at npmjs.com so the rest are void. Prefer a
  granular access token (bypass-2FA) for future publishes.

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
