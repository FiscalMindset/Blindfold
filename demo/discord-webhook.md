# Blindfold demo — Discord webhook (real run)

A real, token-redacted run showing a sealed **Discord webhook URL** used to post
to a channel, without the URL ever entering the shell or the agent's process.

A webhook is a special secret: the secret is the **entire URL**, and you POST
JSON to it with no Authorization header. So this uses the **release-broker**
path (fetch the sealed URL just-in-time), not the header-substitution proxy.

## Seal it once

```text
$ blindfold register --name webhook_discord_url --from-env webhook_discord_url
✓ Registered "webhook_discord_url" (value read once, then dropped).  [121 B, real]
```

## Post a message (CLI, no code)

```text
$ blindfold use --name webhook_discord_url --as HOOK -- \
    sh -c 'curl -s -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
      -d "{\"content\":\"posted via Blindfold\"}" "$HOOK"'

✓ released "webhook_discord_url" (121 B, value never shown)
  Discord HTTP 204   ← message delivered
```

## Post a message (code)

```text
$ npx tsx examples/discord-webhook/agent.ts
✓ released webhook_discord_url from the enclave (121 bytes, value never shown)
✓ Discord responded: HTTP 204 ✅ message delivered
```

Real webhook, real Discord channel, real 204. The URL was released from the
enclave for one POST and dropped — the process never persisted it, and it was
never printed.

Runnable version: [`../examples/discord-webhook/`](../examples/discord-webhook/).
