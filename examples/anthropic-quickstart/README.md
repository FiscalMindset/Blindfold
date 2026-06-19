# Anthropic SDK quickstart (Node)

```bash
# In the repo root, register your Anthropic key with T3 (one-time):
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
npm run blindfold -- register --name anthropic_api_key --from-env ANTHROPIC_API_KEY
# (Then delete that line from .env.)

# Run the proxy in Anthropic mode (or run two proxies on different ports):
npm run blindfold -- proxy --port 8788 --secret anthropic_api_key

# Then in this folder:
cd examples/anthropic-quickstart
npm install
node index.js
```

The Blindfold integration is the `baseURL` + `apiKey` options in the `Anthropic({...})` constructor. Everything else is stock SDK.
