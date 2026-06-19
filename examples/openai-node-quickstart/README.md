# OpenAI SDK — Node.js quickstart

The smallest possible Blindfolded OpenAI call.

```bash
cd examples/openai-node-quickstart
npm install
node index.js
```

The `openai` package reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment, so the entire "Blindfold adoption" is two env vars. The `index.js` file sets them explicitly for clarity, but if you set them externally the file would be a *zero-diff* port from your existing code.

Compare with the "without Blindfold" version: open `index.js` and look at lines 4-7 — there is no other change.
