# DigitalOcean — manage real infra with a sealed token

A concrete, **verified** example: seal a DigitalOcean API token once, then use it to hit the real DigitalOcean API — from the `doctl` CLI, from `curl`, or straight from the enclave — with the token never sitting in your environment.

> Verified live on this repo's tenant: `use --url` → `HTTP 200`; `doctl`/`curl` returned the real account; the in-enclave call returned `code=200` with the token never leaving the enclave.

## Seal it once

```bash
blindfold register --name digital_ocean_api_key --from-env digital_ocean_api_key
# then delete the digital_ocean_api_key line from .env — it lives only in the enclave now
```

## Use it — three ways

**1. No code, with `doctl`** (Blindfold auto-maps `doctl` → `DIGITALOCEAN_ACCESS_TOKEN`):

```bash
blindfold use --name digital_ocean_api_key -- doctl account get
blindfold use --name digital_ocean_api_key -- doctl compute droplet list
```

**2. No code, with `curl`:**

```bash
blindfold use --name digital_ocean_api_key --as TOK -- \
  bash -c 'curl -s -H "Authorization: Bearer $TOK" https://api.digitalocean.com/v2/account'
# → {"account":{"email":"…","status":"active",…}}
```

**3. Quick health check (no command):**

```bash
blindfold use --name digital_ocean_api_key --url https://api.digitalocean.com/v2/account
#   HTTP 200 OK  ✅ accepted
```

## Maximalist mode — the token never leaves the enclave

The contract itself makes the DigitalOcean call from inside the TDX enclave:

```bash
npx tsx scripts/test-enclave-egress.ts <contract_id> digital_ocean_api_key api.digitalocean.com /v2/account
# → forward REAL → https://api.digitalocean.com/v2/account
#   code=200  🎉 ENCLAVE-EGRESS WORKS — api.digitalocean.com authenticated.
#   The sealed secret NEVER left the enclave.
```

## Why this matters

A DigitalOcean token can spin up servers and run up your bill. With Blindfold it lives in the enclave — a prompt-injected agent, a leaked `.env`, or a compromised CI log has **nothing to steal**, yet your deploy scripts keep working unchanged.
