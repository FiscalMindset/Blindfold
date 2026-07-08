# Usage by Claude — dogfooding status & protocol

> **What's new (v0.2 / v0.3 + webhook):** installable global CLI (`npm i -g`, runs from any directory, state in `~/.blindfold`); `blindfold login` stores the tenant key in the **OS keychain** (not a plaintext file); Discord webhook support (release path + `/discord` proxy provider, contract v0.5.5). See `CHANGELOG.md`.


> Can a coding agent (me, Claude Code) actually use Blindfold for the keys it sees while chatting with you? Yes, with two unavoidable limits and one protocol that closes the gap around them. This file is the agent-side rulebook, updated whenever the situation changes.

---

## 1. The honest answer in one sentence

I can use Blindfold for any key you'd otherwise paste into chat — **as long as you run the seal command in your terminal instead of asking me to do it from here.** Once a value enters our conversation, no amount of subsequent sealing can un-expose it for the duration of this transcript.

---

## 2. Two unavoidable limits (the doubt)

| Limit | Why it can't be avoided from within chat |
|---|---|
| Once you paste a value into chat, it's in my context for this conversation. | I can't un-see it. Anthropic's transcript-retention policy applies. |
| When I `Read` your `.env`, the values enter my context. | `Read` returns the whole file. I have no "read only the first 3 + last 2 chars" mode. |

Neither limit is a Blindfold bug; they're properties of an LLM conversational agent reading text.

---

## 3. The solution (the "no-paste" protocol)

A four-rule protocol that closes the practical gap:

| Rule | Concrete shape |
|---|---|
| **R1. I don't ask you to paste new secrets into chat.** | When a new secret is needed (e.g. you say "I want to seal my Stripe key"), I respond with: *"In your own terminal, run `npm run blindfold -- register --name stripe_api_key` — it prompts with no echo. Paste your key there, not here. Tell me when done; I'll verify the fingerprint."* You run it locally. Value never reaches my context. |
| **R2. To verify the seal, you run the fingerprint helper; you paste *that* output to me (it's safe).** | `npm run env:fingerprint` lists every `.env` line as `KEY = first3…last2 (N bytes)`. `npm run blindfold -- sealed` does the same for sealed keys. Both outputs are safe to share with me. They prove "the right key is in the right place" without revealing it. |
| **R3. Any code I write for you uses the release-broker pattern, never `process.env.X` for provider keys.** | Reference templates: `examples/grok-via-blindfold.ts` (HTTPS), `scripts/smtp-with-blindfold.ts` (non-HTTP). Pattern: fetch from T3 inside a `try { … } finally { /* dropped */ }`. |
| **R4. After every successful seal, I propose `.env` cleanup.** | The sealed copy is canonical; the `.env` copy is now pure leak surface. (`T3N_API_KEY` itself stays — chicken-and-egg; see Q-table.) |

When you ask me to do something that *requires* the value (e.g. "make a real API call"), I can either (a) write code following R3 that pulls from T3 at runtime, or (b) decline and ask you to run a command locally yourself. (b) is always safer; pick (a) only when you've explicitly accepted the chat-context exposure.

---

## 4. Self-audit — what I did right and wrong in this conversation

### Right
- ✅ Sealed `cognee_api_key` via stdin pipe (no echo, no shell history beyond the literal `printf` line you ran)
- ✅ Verified by fingerprint (`efa…bc, 64 bytes`) — never printed the full value
- ✅ Wrote `examples/grok-via-blindfold.ts` in the release-broker pattern (rule R3)
- ✅ Proactively recommended deleting `GROK_API_KEY` from `.env` and did the edit
- ✅ Stored the agent-side rulebook in memory (`feedback_blindfold_keys.md`)

### Wrong (and corrected here)
- ❌ When you pasted the cognee value into chat, I should have *first* offered: *"want to seal from here, or paste in your terminal (better)?"* I picked the easier-for-me path. Going forward → R1.
- ❌ When you added new secrets to `.env` and I needed to confirm format, I `Read` the whole file. I should have used a fingerprint-only inspection. The new `scripts/env-fingerprint.sh` exists for exactly this. Going forward → R2.
- ❌ `deepgram_api_key` is still in your `.env` even though it's sealed. I'll propose deletion below.

---

## 5. Status: what's currently in your `.env` vs sealed

(Refreshed by running `npm run env:fingerprint` and `npm run blindfold -- sealed`. Update whenever either changes.)

**In `.env` right now** (fingerprints only — safe to share):

```
T3N_API_KEY          = 0x1…56  (66 bytes)     ← root credential, can't be sealed
DID                  = did…9f  (48 bytes)     ← identity, not a secret
smtp_email           = npd…om  (20 bytes)     ← not a secret
smtp_host            = smt…om  (14 bytes)     ← not a secret
deepgram_api_key     = fcb…76  (40 bytes)     ← ⚠ sealed already; this .env copy is redundant
```

**Sealed in TDX right now**:

```
deepgram_api_key       40 bytes  z:d20…071a9f:secrets/deepgram_api_key
cognee_api_key         64 bytes  z:d20…071a9f:secrets/cognee_api_key
```

**Recommendation (R4):** delete the `deepgram_api_key=…` line from `.env`. The canonical copy is in TDX; the `.env` copy is pure leak surface.

---

## 6. Helper commands (the kit that makes the protocol practical)

| Command | What it gives back (safe to share) |
|---|---|
| `npm run env:fingerprint` | Every `.env` line as `KEY = first3…last2 (N bytes)` |
| `npm run blindfold -- sealed` | Every sealed key as `WHEN  NAME  BYTES  MODE  WHERE` — metadata only |
| `npx tsx scripts/test-v5-release.ts <name>` | Fingerprint of the released plaintext — proves the right value is sealed without revealing it |
| `npm run blindfold -- doctor` | Mode + cred presence (yes/no only — no values) |
| `npm run blindfold -- verify` | T3 round-trip status |

All five are designed to produce **safe output** — you can paste any of their stdout to me without leaking a secret byte.

---

## 7. The seal flows I should propose to you (in order of preference)

1. **(best) You run interactive prompt in your own terminal:**
   ```
   npm run blindfold -- register --name <KV_KEY>
   #  Value for "<KV_KEY>" (input is hidden): ●●●●●● ↵
   ```
   Value never touches chat. Tell me when done; I verify by fingerprint.

2. **(also good) Pipe from a place you already have it (e.g. `pbpaste` on Mac):**
   ```
   pbpaste | npm run blindfold -- register --name <KV_KEY>
   ```
   Value goes clipboard → process → enclave; not in chat, not in shell history.

3. **(ok with caveat) Paste into chat AND let me seal it:**
   I'll use `printf 'VALUE' | ...`. Value lives in this chat's transcript. Only do this if you've already accepted that.

4. **(weakest) Add to `.env` then `register --from-env`:**
   Value lives briefly on disk. Acceptable for scripted automation; not great for ad-hoc sealing.

---

## 8. How this file stays updated

This is a *living* status file. Update it when:
- A new key is sealed → refresh the §5 status table
- A new helper or protocol is added → §6 / §7
- I (Claude in a future session) miss a rule → add it to §4 "wrong" and refine §3
- The unavoidable limits change (e.g. Anthropic ships ephemeral-context mode) → §2

The agent-side mirror lives in `~/.claude/projects/.../memory/feedback_blindfold_keys.md` — future sessions in this repo read that on startup and follow the same protocol without re-deriving it. If you want me to re-read it explicitly, just say *"reload the Blindfold key-handling rules"*.

---

## 9. One-sentence summary

I can dogfood Blindfold cleanly for you **if every new secret is born in your terminal and not in this chat** — the env-fingerprint + sealed-ledger commands let us prove things together using only metadata, so the conversation never needs a real key in it to know everything's working.
