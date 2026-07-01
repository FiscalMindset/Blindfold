# Gemini through Blindfold — real, key-free agent

Google Gemini is the interesting case: it does **not** use `Authorization: Bearer`.
Its native API expects the key in a provider-specific header, **`x-goog-api-key`**.
Blindfold handles that real convention — the agent sends the sentinel in
`x-goog-api-key`, and the sealed `gemini_api_key` is substituted for it **inside
the TDX enclave**, on the outbound call to `generativelanguage.googleapis.com`.

This is a **real** demo. It calls the live enclave and the live Gemini API. No
mock, no stub.

## What it proves

1. This Node process holds **no** Gemini key — the demo scans the *entire*
   `process.env` for a real key (legacy `AIza…` or newer `AQ.…`) and finds none,
   because you removed it from `.env` once sealed. If a key were left in `.env`,
   the demo reports it as a real leak instead of hiding it.
2. The agent makes a real `generateContent` call and gets a real answer.
3. A prompt-injection that tricked the agent into dumping its own credentials
   would get only `x-goog-api-key: __BLINDFOLD__` — nothing usable.

## Setup (one time)

```bash
# Seal the key into the enclave (reads it from .env once, then it's gone from your side)
npm run blindfold -- register --name gemini_api_key --from-env gemini_api_key

# Authorize the enclave to call Google's endpoint
npm run blindfold -- grant --host generativelanguage.googleapis.com

# Now delete the gemini_api_key line from .env — it lives only in the enclave.
```

## Run

```bash
npx tsx examples/gemini/agent.ts
npx tsx examples/gemini/agent.ts "write a haiku about sealed enclaves"

# pick a model (defaults to gemini-2.5-flash; falls back on transient 503/429)
GEMINI_MODEL=gemini-flash-latest npx tsx examples/gemini/agent.ts
```

## Example output

```
🔒 Blindfold proxy: http://127.0.0.1:8787   (this process has NO Gemini key)
🤖 model: gemini-2.5-flash

✅ Real Gemini answer (key never left the enclave):

   An Intel TDX enclave is a hardware-isolated execution environment that
   protects the confidentiality and integrity of code and data, even from
   the hypervisor.

🕵️  If a prompt-injection dumped this agent's credentials, it would get:
   • env vars containing a real Gemini key: (none)
   • auth header the agent sends:           x-goog-api-key: __BLINDFOLD__
🛡️  Nothing usable. The real key exists only inside the TDX enclave.
```

## The one line that matters

The agent points at the local proxy and attaches **no key**:

```
POST http://127.0.0.1:8787/gemini/v1beta/models/gemini-2.5-flash:generateContent
```

Compare to the direct call you'd otherwise make:

```
POST https://generativelanguage.googleapis.com/v1beta/models/...:generateContent
x-goog-api-key: <your real AIza… key sitting in the agent's memory>
```

Same request. The difference is *where the key lives* — in the enclave, not in
your agent.

See [`../../integration-stack.md`](../../integration-stack.md) for how the
provider registry and in-enclave auth schemes work.
