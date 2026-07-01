# Stripe payments agent through Blindfold — real, test mode

The concrete **payments** version of Blindfold's thesis. An AI billing agent has
genuine read + write access to a real Stripe account, yet the secret key is never
in the agent. A prompt-injection that tries to steal the key — to run fraudulent
charges from anywhere — gets only the sentinel.

**Real, not staged:**
- `GET /v1/balance` → live **200** (the sealed key authenticates to a real account)
- `POST /v1/customers` → live **200**, real `cus_…` id (the agent genuinely has
  write power — the thing an attacker would want)
- the key `stripe_secret_key` lives only in the TDX enclave
- the exfil check scans the **entire** `process.env` (any var name) for a real
  `sk_…` key — a leftover in `.env` is reported as a leak, never hidden

The only safety rail is that it's a Stripe **test** key (`sk_test_…`); the demo
asserts `livemode === false` and refuses to run otherwise, so it can never touch
real money.

## Setup (one time)

```bash
npm run blindfold -- register --name stripe_secret_key --from-env strip_secret_key
npm run blindfold -- grant --host api.stripe.com
# then remove strip_secret_key from .env — it lives only in the enclave now
```

## Run

```bash
npx tsx examples/stripe/agent.ts
```

## Output

```
✅ Authenticated to a REAL Stripe account (test mode, livemode=false).
✅ Real WRITE succeeded — created customer cus_UnzQbHl4Iv4zUN (livemode=false).
   The agent can move money on this account. That's exactly what makes the key valuable.
...
📤 If a prompt-injection dumped this agent's credentials, it would get:
   • env vars containing a real Stripe key: (none)
   • Authorization header the agent sends:  Bearer __BLINDFOLD__
🛡️  Attacker receives only the sentinel. The sk_test_ key never left the enclave.
```

## Two real, honest caveats

1. **Stripe wants form encoding; the T3 host egress parses request bodies as
   JSON.** So params go in the **query string** with an empty body and a
   `content-type: application/x-www-form-urlencoded` header. Stripe accepts that.

2. **On T3 testnet, form-encoded WRITES are flaky** — the testnet host egress
   doesn't always forward the `content-type` header, so Stripe intermittently
   rejects the POST. Reads (`GET /v1/balance`) are 100% reliable. The demo
   retries writes a few times and, if the egress is dropping headers right now,
   says so rather than pretend. This is a **testnet host** limitation, not a
   Blindfold design issue — auth and key protection work regardless.

See [`../../integration-stack.md`](../../integration-stack.md) for the full
integration architecture and the in-enclave auth schemes.
