# AWS SigV4 in the enclave — proven live

SigV4 is the strongest proof that Blindfold is provider-aware: the secret access
key **never travels in the request** — it *signs* a canonical request via an HMAC
chain, **inside TDX**. A generic proxy structurally cannot do this.

Correctness is proven two ways:

1. **Byte-exact unit vectors** (`contract/auth-tests`) against AWS's published
   "get-vanilla" signature + signing-key derivation.
2. **Live**, here: with AWS's example access key, real S3 returns
   **403 `InvalidAccessKeyId`** — meaning AWS *parsed* our SigV4 header and
   reached credential lookup, rather than `AuthorizationHeaderMalformed` /
   `IncompleteSignature` (what a malformed signature yields). A real IAM key → 200.

## Setup (one time)

```bash
aws_secret_access_key='wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' \
  npm run blindfold -- register --name aws_secret_access_key --from-env aws_secret_access_key
npm run blindfold -- grant --host s3.us-east-1.amazonaws.com,<keep your other hosts>
```

## Run

```bash
npx tsx examples/aws/agent.ts
```

## Output

```
🔒 AWS SigV4 — signature computed inside the TDX enclave (secret never sent).
   access key: AKIDEXAMPLE  (AWS example key ⇒ expect InvalidAccessKeyId)

✅ AWS parsed our SigV4 header: HTTP 403 InvalidAccessKeyId
   AWS reached credential/time evaluation — the signature is well-formed.
```

## Real AWS mode

Seal a real (throwaway/limited) IAM secret and set the key id + region:

```bash
aws_secret_access_key=<real> npm run blindfold -- register --name aws_secret_access_key --from-env aws_secret_access_key
# AWS_ACCESS_KEY_ID=AKIA…  AWS_REGION=us-east-1  in env
npx tsx examples/aws/agent.ts   # → HTTP 200
```

The demo classifies AWS's response: signature-**structure** errors fail the run
(a real bug); credential/time errors pass (the signature was well-formed). See
[`../../integration-stack.md`](../../integration-stack.md).
