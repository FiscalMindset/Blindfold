# Real API providers — Deepgram, Blogger, Hostinger

Three real services, **three different auth styles**, one pattern. This is the example that shows `blindfold use` isn't just for `Bearer` tokens — it releases the sealed secret as an env var and **you put it wherever the API wants it** (a header, a different header, or a query param). The plaintext never enters your shell.

> Every output below is **real** — captured live from this repo's sealed secrets. The token never appears in any of it.

## Seal them (or use `blindfold migrate` for all at once)

```bash
blindfold register --name deepgram_api_key  --from-env deepgram_api_key
blindfold register --name blogger_api_key   --from-env blogger_api_key
blindfold register --name hostinger_api_key --from-env hostinger_api_key
```

---

## 1. Deepgram — `Authorization: Token <key>` (NOT Bearer)

```bash
blindfold use --name deepgram_api_key --as DG -- \
  bash -c 'curl -s -H "Authorization: Token $DG" https://api.deepgram.com/v1/projects'
```

Real output:

```json
{"projects":[{"project_id":"266e816e-8b0a-4758-bff4-4b50b54f4990",
  "name":"npdimagine@gmail.com's Project","mip_opt_out":false,"allowed_providers":[]}]}
```
`HTTP 200` ✅

---

## 2. Blogger (Google) — `?key=<API_KEY>` query param

Google API keys go in the URL, not a header:

```bash
blindfold use --name blogger_api_key --as K -- \
  bash -c 'curl -s "https://www.googleapis.com/blogger/v3/blogs/2399953?key=$K"'
```

Real output (the official Blogger blog):

```
Official Blogger Blog · 540 posts · http://blogger.googleblog.com/
```
`HTTP 200` ✅

---

## 3. Hostinger — `Authorization: Bearer <key>`

```bash
blindfold use --name hostinger_api_key --as TOK -- \
  bash -c 'curl -s -H "Authorization: Bearer $TOK" https://developers.hostinger.com/api/vps/v1/virtual-machines'
```

Real output (account has no VPS yet):

```json
[]
```
`HTTP 200` ✅

---

## Run all three

```bash
chmod +x examples/api-providers/demo.sh
./examples/api-providers/demo.sh
```

## The takeaway

| Provider | Where the secret goes |
|---|---|
| Deepgram | `Authorization: Token <key>` |
| Blogger / Google | `?key=<key>` query param |
| Hostinger / DigitalOcean / GitHub | `Authorization: Bearer <key>` |

`blindfold use --name X --as VAR -- <cmd>` releases the secret into `$VAR` for that one command — you decide where it goes. The token is never printed, never in your shell history, never back in `.env`.
