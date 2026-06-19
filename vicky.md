# Vicky's Questions — plain-English answers

> A running Q&A as Vicky learns how Blindfold actually works. New questions go at the top. If you're a new user, reading this top-to-bottom is the fastest path to the "aha moment."

---

## Q3 (2026-06-20) — "What does 'canonical copy lives inside the enclave' mean?"

Two phrases, separately.

**"Canonical copy"** = the *one authoritative* version. Like the original of your passport vs photocopies — if there are six photocopies floating around, only the original counts when you go through immigration. The photocopies are just extra surfaces where it could leak.

**"Inside the enclave"** = stored in T3's TDX hardware-encrypted RAM at the address `z:<tenant_id>:secrets`. That memory is sealed by the Intel CPU itself. Even the cloud provider hosting T3 can't read it. Think bank vault — bills go in, the bank's own staff can't see them; the vault only opens for the authenticated client (your contract).

**Concretely for your Grok API key right now:**

```
  BEFORE sealing                          AFTER sealing
  ──────────────────                      ─────────────────────
  📄 .env on your laptop                  🔒 TDX enclave at T3
     GROK_API_KEY=xai-…                      z:tid:secrets
                                              grok_api_key = …
  ⚠ leaks if:                             ✅ unreadable by:
   • laptop stolen                          • the cloud provider
   • git accidentally                       • the host OS
   • backup synced wrong                    • anyone with disk access
   • a tool runs `cat .env`                 • you, until your contract asks for it
```

Right now your key has **two** copies — the one in `.env` (a liability) and the one in the enclave (the canonical one used for actual API calls). Deleting `GROK_API_KEY` from `.env` collapses that to **one** copy: the canonical one, in TDX. After that, the only place that key exists on Earth is inside hardware-protected RAM on a T3 node — and your laptop can be lost, stolen, or `cat .env`'d safely.

That's the whole point of Blindfold: get the canonical copy out of every place it doesn't need to be, and put it in the one place it does.

---

## Q2 (template — placeholder for the next question)

When you ask the next question, the answer goes here.

---

## Q1 (template — placeholder for the next question)

Same — pushed down as new ones arrive.

---

## How to add a new question

Just say "add a question to vicky.md: <your question>". The newest answer goes at the top so you can read top-down chronologically.
