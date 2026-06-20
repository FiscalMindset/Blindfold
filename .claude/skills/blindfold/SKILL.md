---
name: blindfold
description: Use Blindfold (Terminal 3 TDX enclave wrapper) to seal and use API keys safely. Invoke when the user mentions sealing/sealing a key, asks "how do I protect my API key", pastes a credential into chat, or asks for help with secrets in this project. Always prefer the no-paste workflow — propose commands the user runs in their own terminal, verify by fingerprint, never write keys to files.
---

# Blindfold skill — the rulebook

You're working in (or with) Blindfold — a Terminal 3 TDX-enclave wrapper that keeps AI-agent API keys un-leakable. Read `current_status.md`, `process.md`, `usage_by_claude.md`, and `vicky.md` for context; this file is the agent-side rulebook that decides how *you* behave.

## When to invoke this skill

- User pastes (or is about to paste) any API key, password, token, or credential.
- User asks "how do I use [provider]" in a way that implies handling a key.
- User asks about `.env`, sealing, vaulting, or "where do I put my key".
- You're about to write code that would read `process.env.SOME_PROVIDER_KEY` for an outbound call.
- User says "use Blindfold" or "seal it" or "make this safe".

## The four rules (mirror of `usage_by_claude.md` §3)

1. **R1 — no-paste-into-chat.** If a new secret needs sealing, *propose* the command (`npm run blindfold -- register --name <KV_KEY>`) for the user to run in their own terminal. Do NOT ask them to paste the value into chat. Only use `printf 'VALUE' | ...` from chat as a fallback, and only after the user explicitly says "go ahead from here".
2. **R2 — verify by fingerprint, never by value.** To check what's sealed: `npm run blindfold -- sealed`. To check what's in `.env`: `npm run env:fingerprint`. To check a specific sealed key matches an expected value: `npx tsx scripts/test-v5-release.ts <secret_name>` (prints `first3…last2 (N bytes)`, never plaintext). Ask the user to paste the *output* of those commands — that's safe.
3. **R3 — code uses release-broker pattern.** Any code you write that needs a provider key must fetch it from T3 just-in-time via `tenant.contracts.execute("blindfold-proxy", { version: CONTRACT_VERSION, functionName: "release-to-tenant", input: { secret_key: "<name>" } })`, use it inside a `try { … } finally { /* dropped */ }`, and never reference `process.env.<provider>_API_KEY`. Reference templates: `examples/grok-via-blindfold.ts` (HTTPS) and `scripts/smtp-with-blindfold.ts` (non-HTTP).
4. **R4 — propose `.env` cleanup after every successful seal.** The sealed copy is canonical; the `.env` copy is leak surface. *Exception:* `T3N_API_KEY` itself stays in `.env` — it's the root credential, can't be sealed (chicken-and-egg).

## Command kit (every output is safe to share)

| Command | Purpose | Safe to paste output? |
|---|---|---|
| `npm run blindfold -- doctor` | mode + cred presence (yes/no) | ✅ |
| `npm run blindfold -- verify` | T3 round-trip status | ✅ |
| `npm run blindfold -- sealed` | sealed-keys ledger (metadata only) | ✅ |
| `npm run env:fingerprint` | `.env` lines as `KEY = first3…last2 (N bytes)` | ✅ |
| `npx tsx scripts/test-v5-release.ts <name>` | fingerprint of the released value | ✅ |
| `npm run dashboard` | live HTML dashboard at `http://127.0.0.1:8799` | n/a (UI) |
| `npm run blindfold -- register --name <K>` | interactive seal (no echo) | ⚠ tell user to run in their terminal |
| `printf 'V' \| npm run blindfold -- register --name <K>` | piped seal (value briefly in this process) | ⚠ only if user already pasted value |

## What to do, by scenario

### "I want to seal my Stripe key" (or any new credential)

**Don't ask for the value.** Respond with:

> In your own terminal, run:
>
> ```bash
> npm run blindfold -- register --name stripe_api_key
> ```
>
> It'll prompt for the value with input hidden (no echo, no shell history). Paste your `sk_live_…` there, press Enter. Once done, paste me the output of `npm run blindfold -- sealed` so I can verify it landed in the right place.

### "I already pasted my OpenAI key in chat — seal it"

It's in our chat context now (can't undo). Reduce future surface:

```bash
printf 'sk-...' | npx tsx packages/blindfold/bin/blindfold.ts register --name openai_api_key
```

Then propose deleting any `.env` copy. Note in your response that the chat-context exposure already happened and you can't retroactively fix it — only forward-protect.

### "Write me code that calls OpenAI"

Write the release-broker pattern (see `examples/grok-via-blindfold.ts`). Never `import OpenAI from "openai"` + `apiKey: process.env.OPENAI_API_KEY`. Always:

```ts
const { value: apiKey } = await tenant.contracts.execute("blindfold-proxy", {
  version: CONTRACT_VERSION,
  functionName: "release-to-tenant",
  input: { secret_key: "openai_api_key" },
}) as { value: string };
try {
  // use apiKey for ONE call
} finally { /* dropped */ }
```

### "Read my .env to check what's there"

**Don't `Read .env`.** Run:

```bash
npm run env:fingerprint
```

Ask the user to paste that output. You get key *names* + lengths + first/last few chars — enough to identify, never enough to use.

### "It's broken — what's wrong?"

Run these in order, asking the user to paste each output:

```bash
npm run blindfold -- doctor      # config sanity
npm run blindfold -- verify      # T3 reachability
npm run blindfold -- sealed      # is the key there?
```

Cross-reference any errors with `vicky.md` Q6 (keyword-indexed error table).

## What this skill must NEVER do

- Write a real plaintext key value to any file, doc, or commit message.
- `console.log` / `safeLog` a value whose origin is `process.env.*_API_KEY` or an `Authorization` header.
- Use `Read` on `.env` when `npm run env:fingerprint` would do.
- Suggest the user paste a key into chat as a default — always default to "run the command in your terminal".
- Generate code that references `process.env.<provider>_API_KEY` for outbound provider calls.

## When the user objects to a recommendation

If the user explicitly chooses a less-defensive path ("I know, just seal it from here"), honor it but say so once: *"Going to use the piped-stdin path — value will be in this chat's transcript; if you want zero chat exposure, prefer running `register` in your own terminal."* Then proceed with their choice.

## Reference files (when in doubt)

| File | What's in it |
|---|---|
| `usage_by_claude.md` | The user-facing twin of this rulebook; refresh §5 status table when sealing |
| `process.md` | First-time-user walkthrough — copy command shapes from here |
| `vicky.md` | Plain-English Q&A — copy explanations from here when answering questions |
| `current_status.md` | What's working vs blocked right now — quote from here when status is asked |
| `examples/grok-via-blindfold.ts` | The canonical release-broker template for HTTPS APIs |
| `scripts/smtp-with-blindfold.ts` | The canonical release-broker template for non-HTTP protocols |
