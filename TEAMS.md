<div align="center">

# 👥 Blindfold for Teams

**Run Blindfold across a team: shared secrets, rotation, per-agent access, and an audit trail.**

### 📖 &nbsp; [Home](README.md) &nbsp;·&nbsp; [Usage Guide](usage.md) &nbsp;·&nbsp; [Examples](EXAMPLES.md) &nbsp;·&nbsp; **[Teams](TEAMS.md)** &nbsp;·&nbsp; [Contributing](CONTRIBUTING.md)

</div>

---

A solo developer seals a key and uses it. A **team** needs four more things: shared access, rotation, scoped permissions, and an audit trail. Here's how each works on Blindfold + Terminal 3.

## The model in one picture

```
            ┌────────────────────── T3 tenant (one per team/project) ──────────────────────┐
            │  z:<tenant>:secrets   →  { openai_api_key, github_token, db_password, … }       │
            │                          (plaintext lives only in the TDX enclave)             │
            └───────────────▲───────────────────────────▲───────────────────────▲───────────┘
                            │ read-ACL                   │ agent-auth grant       │
                  blindfold-proxy contract        Alice's agent (DID)      Bob's agent (DID)
                  (release-to-tenant / forward)   scoped: which funcs,     scoped: which funcs,
                                                  which hosts              which hosts
```

One tenant owns the secrets and the contract. **People/agents are granted scoped access** — they never hold the keys or the tenant's root key.

---

## 1. Rotation — built in

When a key leaks or expires, rotate it in one command. Everything that uses the *name* picks up the new value automatically — no code or config change anywhere.

```bash
blindfold rotate --name openai_api_key --from-env OPENAI_API_KEY
#   before:  "openai_api_key"  51 B  fp=a1b2c3d4
# ✓ Rotated "openai_api_key"  →  51 B  fp=9f8e7d6c  (mode=real)
#   Every place that uses "openai_api_key" now gets the new value — no code/config change.
```

The `fp=` is a non-reversible SHA-256 fingerprint — it lets you **confirm the value changed without ever seeing it.** Make rotation a routine: rotate on a schedule, and immediately after anyone leaves the team.

---

## 2. Scoped access — grant agents, not keys

A teammate's agent gets access by **DID grant**, never by receiving the key. The grant is per-(agent, contract, function, host) — least privilege by construction.

```ts
// Authorize Alice's agent to call ONLY release-to-tenant, ONLY for api.openai.com:
await t3n.execute({
  script_name: "tee:user/contracts",
  function_name: "agent-auth-update",
  input: { agents: [{
    agentDid: "did:t3n:<alice-agent>",
    scripts: [{
      scriptName: "z:<tenant>:blindfold-proxy",
      versionReq: ">=0.5.0",
      functions: ["release-to-tenant"],   // not "forward" — least privilege
      allowedHosts: ["api.openai.com"],   // can't exfiltrate elsewhere
    }],
  }] },
});
```

The contract's own read access to the secrets map is a separate ACL grant (auto-wired by `blindfold init` / publish):

```ts
await tenant.maps.update("secrets", { readers: { only: [<contract_id>] } });
```

Reference implementation: [`scripts/grant-and-call.ts`](scripts/grant-and-call.ts) (self-grant + call) and [`scripts/test-enclave-egress.ts`](scripts/test-enclave-egress.ts) (publish + ACL + egress + call).

> **Revoking access** = re-run `agent-auth-update` without that agent (or with an empty `scripts` list). Because nobody holds the raw key, revocation is immediate and complete — there's no leaked copy to chase.

---

## 3. Multiple keys / environments

Keep separate tenants for separate blast radii (e.g. `dev`, `staging`, `prod`, or per-team). The CLI selects via `.env`:

```bash
T3N_API_KEY=<key>           # the key whose tenant you're operating
DID=did:t3n:<that-key's-tenant>   # the SERVER-ASSIGNED tenant DID (from `blindfold doctor`)
BLINDFOLD_T3_ENV=testnet    # or production
```

Before trusting any key, run `blindfold doctor` — it tells you in plain English whether the key has an active, provisioned tenant (the #1 cause of mysterious failures). Use `blindfold status` for a one-glance roster of what's sealed.

> ⚠️ The tenant DID is **server-assigned**, not derived from the key address. Always read it from `blindfold doctor` / `me()` — don't assume `did:t3n:<key-address>`.

---

## 4. Audit trail

| Question | Where to look |
|---|---|
| What's sealed, when, how big, real vs mock? | `blindfold sealed` / `blindfold status` (metadata only — never values) |
| Who's calling the proxy, how often, success rate? | `blindfold dashboard` (live HTML) / `blindfold stats` |
| Did a contract execution happen / fail? | `tenant.contracts.logs("blindfold-proxy", …)` |
| Did a value actually change after rotation? | the `fp=` fingerprint from `blindfold rotate` |

None of these ever record a plaintext secret — by construction.

---

## 5. Recommended team workflow

1. **One tenant per project**, owned by a service key (not a person's personal key). Verify with `blindfold doctor`.
2. `blindfold init` → publish the contract + auto-grant the secrets read-ACL.
3. Seal each secret: `blindfold register --name <X> --from-env <X>`, then delete the `.env` line.
4. Grant each teammate's agent **least-privilege** access via `agent-auth-update` (specific functions + hosts).
5. **Rotate on a schedule** and on every offboarding: `blindfold rotate --name <X> --from-env <X>`.
6. Watch `blindfold dashboard` / `stats`; export `blindfold sealed` for compliance.

---

## See also

- **[Usage Guide](usage.md)** — every single-user scenario.
- **[Examples](EXAMPLES.md)** — the three ways to use a sealed secret.
- **[Contributing](CONTRIBUTING.md)** — the security rules and how to extend Blindfold.
