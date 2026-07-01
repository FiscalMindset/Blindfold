# HTTP Basic auth in the enclave (the Twilio scheme) — proven live

Twilio authenticates with HTTP Basic: `base64(AccountSID:AuthToken)`. That base64
can only be computed **after** the secret is joined — so a generic "swap the
sentinel" proxy cannot do it. Blindfold computes it **inside the TDX enclave**.

This demo proves that end-to-end **without a Twilio account**: it seals a known
password, the agent sends **no** credential, and the enclave calls
`httpbin.org/basic-auth/<user>/<pass>` — which returns **200 only if** the
enclave's base64 is exactly right. Twilio uses the identical mechanism.

## Setup (one time)

```bash
httpbin_basic_pass='s3cr3t-basic-test' \
  npm run blindfold -- register --name httpbin_basic_pass --from-env httpbin_basic_pass
npm run blindfold -- grant --host httpbin.org,<keep your other granted hosts>
```
(`grant` **replaces** the allowlist — list every host you still need in one call.)

## Run

```bash
npx tsx examples/twilio/agent.ts
```

## Output

```
✅ httpbin validated the credential: HTTP 200
   { "authenticated": true, "user": "blindfold" }
   The enclave built Basic base64(user:secret) correctly — the agent never
   had the password.
```

## Real Twilio mode

Seal your Auth Token and set your Account SID, then use the `/twilio/` route
through the proxy:

```bash
npm run blindfold -- register --name twilio_auth_token --from-env twilio_auth_token
npm run blindfold -- grant --host api.twilio.com,<others>
# TWILIO_ACCOUNT_SID=ACxxxx in env (the Basic-auth username; not secret)
# POST http://127.0.0.1:8787/twilio/2010-04-01/Accounts/ACxxxx/Messages.json
```

Same enclave computation — the only difference is who validates the base64.
See [`../../integration-stack.md`](../../integration-stack.md).
