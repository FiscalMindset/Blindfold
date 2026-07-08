# Discord webhook via Blindfold

Post to a Discord channel without the **webhook URL** ever living in your
process, shell, or `.env`. The URL is sealed in a Terminal 3 TDX enclave and
released just-in-time for a single POST.

## Why a webhook is a special case

A Discord webhook is `https://discord.com/api/webhooks/<id>/<token>` — **the
secret is the whole URL**, and you POST JSON to it with **no Authorization
header**. Blindfold supports it two ways:

- **Proxy path (un-leakable):** the `webhook` auth scheme (contract v0.5.5+)
  substitutes the sealed URL *in the URL itself* inside the enclave. The agent
  POSTs a JSON body to `http://127.0.0.1:8787/discord` and **never holds the
  webhook URL at all** — the strongest guarantee.
- **Release path:** fetch the sealed URL with `use`/`release()` and POST to it.
  The URL is briefly in the process (same residual as any release-path secret).

### Proxy path (agent never sees the URL)

```bash
blindfold grant --host discord.com     # one time
blindfold proxy                        # localhost:8787
# then, from your agent/tool — only a JSON body, no URL:
curl -X POST -H "Content-Type: application/json" \
  -d '{"content":"posted via Blindfold"}' http://127.0.0.1:8787/discord
```

Real live output: `Discord HTTP 204` — message delivered, and the agent held no
URL (the enclave substituted the sealed webhook URL on the outbound call).

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
