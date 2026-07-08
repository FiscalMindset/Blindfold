# Discord webhook via Blindfold

Post to a Discord channel without the **webhook URL** ever living in your
process, shell, or `.env`. The URL is sealed in a Terminal 3 TDX enclave and
released just-in-time for a single POST.

## Why a webhook is a special case

A Discord webhook is `https://discord.com/api/webhooks/<id>/<token>` — **the
secret is the whole URL**, and you POST JSON to it with **no Authorization
header**. Blindfold's proxy path substitutes a *header* (bearer/basic/sigv4), so
it doesn't fit a URL-secret. The **release broker** is the right pattern here:
fetch the sealed URL from the enclave, use it for one POST, drop it.

(A proxy provider that substitutes the sentinel *in the URL* — so webhooks are
un-leakable via the proxy too — is tracked as the next step; see the repo's
version notes.)

## Prereq (one time)

```bash
# webhook_discord_url in .env, plus real T3 creds (T3N_API_KEY, DID)
npm run blindfold -- register --name webhook_discord_url --from-env webhook_discord_url
```

## Run

```bash
npx tsx examples/discord-webhook/agent.ts
npx tsx examples/discord-webhook/agent.ts "your custom message"
```

Real output of a live run (Discord returns `204 No Content` on success):

```text
✓ released webhook_discord_url from the enclave (121 bytes, value never shown)
✓ Discord responded: HTTP 204 ✅ message delivered
🧪 What could a hijacked agent leak here? Nothing — the URL is out of scope now.
```

## No-code version (CLI)

```bash
blindfold use --name webhook_discord_url --as HOOK -- \
  sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -H "Content-Type: application/json" \
         -d "{\"content\":\"posted via Blindfold\"}" "$HOOK"'
# → 204
```

The webhook URL is injected into that one child process only — never back into
your shell.

## Why it's safe (and the honest limit)

- The URL is read once at `register` time and dropped; the canonical copy lives
  only in the enclave.
- On the release path the URL is in the process **for the duration of one POST**,
  then out of scope — the same residual as any release-path secret.
- A Discord webhook is a "bearer-in-the-URL" secret: anyone with the URL can
  post. Sealing it means it's not sitting in `.env` or your shell history, and
  an agent using this pattern never has to see it beyond that one call.
