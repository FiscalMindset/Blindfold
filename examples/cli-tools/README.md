# Use sealed secrets with any CLI tool — no code

This is the most "anyone can use it" example: you seal a secret once, then run **any command-line tool** with it, and the plaintext never goes back into your shell, your `.env`, or your history.

`blindfold use --name <secret> --as <ENV_VAR> -- <command>` releases the secret from the enclave, sets `$ENV_VAR` for that **one** subprocess, runs the command, and drops the value.

## Try it (uses the sealed `github_token`)

```bash
# from the repo root
chmod +x examples/cli-tools/demo.sh
./examples/cli-tools/demo.sh
```

## Real recipes — copy the one you need

| Tool | Env var it reads | Command |
|---|---|---|
| **GitHub CLI** | `GH_TOKEN` | `blindfold use --name github_token --as GH_TOKEN -- gh api user` |
| **git push** | `GH_TOKEN` | `blindfold use --name github_token --as GH_TOKEN -- git push origin main` |
| **curl** (any Bearer API) | — | `blindfold use --name github_token --url https://api.github.com/user` |
| **Postgres** | `PGPASSWORD` | `blindfold use --name db_password --as PGPASSWORD -- psql -h db -U app` |
| **AWS CLI** | `AWS_SECRET_ACCESS_KEY` | `blindfold use --name aws_secret --as AWS_SECRET_ACCESS_KEY -- aws s3 ls` |
| **Docker login** | `--password-stdin` | `blindfold use --name registry_token --url …` then pipe — or use `--as` with a wrapper |
| **Stripe CLI** | `STRIPE_API_KEY` | `blindfold use --name stripe_key --as STRIPE_API_KEY -- stripe balance retrieve` |

## Why this is safe

- The plaintext lives **only** inside the child process's environment, for the lifetime of that single command.
- It is **never printed** (Blindfold prints only the byte-length), never written to disk, never in your shell history.
- `--as` defaults to the secret name upper-cased, so `--name github_token` → `$GITHUB_TOKEN` if you omit `--as`.

## Seal something first

```bash
blindfold register --name github_token --from-env GITHUB_TOKEN
# then delete GITHUB_TOKEN from your .env — it lives only in the enclave now
```
