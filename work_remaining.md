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

## npm publish prerequisites

- [x] **`packages/blindfold/README.md`** — focused install + `signup` + quickstart.
- [x] **MIT LICENSE + `license` field** (+ repository/homepage/bugs/keywords).
- [x] **Library `exports` fixed** — `.`, `./proxy`, `./register`, `./wrap` build to
  `dist/lib/*.mjs` (plain-Node runnable); types resolve from shipped `src/*.ts`.
- [x] **Version cut to 0.4.0** (CHANGELOG dated).
- [ ] **`npm publish`** — actually publish `@fiscalmindset/blindfold@0.4.0` once
  you're ready (needs an npm login with publish rights to the `@fiscalmindset`
  scope). `npm pack --dry-run` is clean: 41 files, README + LICENSE + dist ship,
  no secrets.

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
