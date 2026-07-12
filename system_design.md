<div align="center">

# 🏗️ Blindfold — System Design

**How an API key gets used without ever being held.**

[Home](README.md) · [Architecture](ARCHITECTURE.md) · [Usage](usage.md) · [FAQ](FAQ.md) · [Security](SECURITY.md)

</div>

> **The whole system in one sentence:** the developer seals a secret into a
> Terminal 3 **TDX enclave** once; from then on the agent sends a placeholder
> (`__BLINDFOLD__`), and the real key is substituted **inside the enclave**, at
> the last moment — so it is never present in the agent's process, memory, logs,
> or shell history.

<details open>
<summary><b>📑 Contents</b></summary>
<br/>

<table>
<tr>
<td valign="top" width="33%">

**Big picture**
- [1 · System context](#1--system-context)
- [2 · Component architecture](#2--component-architecture)
- [3 · The core trick](#3--the-core-trick-sentinel-substitution)

</td>
<td valign="top" width="33%">

**The flows**
- [4 · Three secret paths](#4--the-three-secret-paths)
- [5 · Self-serve signup](#5--self-serve-signup)
- [6 · Attestation](#6--remote-attestation)

</td>
<td valign="top" width="33%">

**Guarantees & internals**
- [7 · Trust boundaries](#7--trust-boundaries--threat-model)
- [8 · Tamper-evident ledger](#8--tamper-evident-ledger)
- [9 · Secret lifecycle](#9--secret-lifecycle)
- [10 · Deployment & files](#10--deployment--file-map)

</td>
</tr>
</table>

</details>

---

## 1 · System context

Who talks to whom. The **agent never touches the real key** — it only ever holds
the sentinel. The one component that briefly handles plaintext (registration) is
isolated, and the enclave is the only place the canonical secret lives.

```mermaid
flowchart LR
    classDef ok fill:#e8fff0,stroke:#3fb950,color:#04260f
    classDef danger fill:#fff0f0,stroke:#f85149,color:#3d0a0a
    classDef enc fill:#eef0ff,stroke:#6e44ff,color:#160a3d
    classDef ext fill:#f3f4f6,stroke:#8b949e,color:#1c2128

    dev["🧑‍💻 Developer<br/>seals a key once"]:::ok
    agent["🤖 AI Agent<br/>holds only __BLINDFOLD__"]:::ok
    inj["💀 Prompt injection<br/>tries to exfiltrate keys"]:::danger

    subgraph local["🖥️ Your machine — untrusted for secrets"]
        cli["blindfold CLI"]:::ok
        proxy["Local proxy<br/>127.0.0.1:8787"]:::ok
    end

    subgraph t3["☁️ Terminal 3 · Intel TDX"]
        enc[("🔒 Enclave contract<br/>blindfold-proxy<br/>+ secrets map")]:::enc
    end

    api["✅ Upstream API<br/>OpenAI · Stripe · GitHub · …"]:::ext

    dev -->|"register: plaintext once, dropped"| enc
    agent -->|"Bearer __BLINDFOLD__"| proxy
    proxy -->|"ForwardRequest, sentinel only"| enc
    enc -->|"swap sentinel to real key, in-enclave"| api
    api -->|"response only"| enc
    enc --> proxy --> agent
    inj -.->|"reads env and context"| agent
    agent -.->|"leaks only __BLINDFOLD__"| inj
```

**Key idea:** everything on *your machine* is treated as untrusted for secrets.
The real key crosses one boundary — into the enclave at registration — and is
substituted back in only *inside* the enclave, never on the way out.

---

## 2 · Component architecture

```mermaid
flowchart TB
    classDef client fill:#eef0ff,stroke:#58a6ff,color:#0a1a3d
    classDef t3 fill:#eef0ff,stroke:#6e44ff,color:#160a3d
    classDef store fill:#fff8e6,stroke:#d29922,color:#3d2c04
    classDef ext fill:#f3f4f6,stroke:#8b949e,color:#1c2128

    subgraph CLIENT["🖥️ Client side — packages/blindfold"]
        direction TB
        cli["bin/blindfold.ts<br/>CLI dispatcher"]:::client
        reg["register.ts<br/>⚠ only plaintext-touching path"]:::client
        prox["proxy.ts<br/>sentinel HTTP proxy"]:::client
        wrap["wrap.ts / release.ts<br/>in-process helpers"]:::client
        t3c["t3-client.ts<br/>terminal3 SDK wrapper"]:::client
        prov["providers.ts<br/>URL prefix to host + secret + auth"]:::client
        led[("sealed-ledger.ts<br/>sealed.jsonl<br/>HMAC hash-chain")]:::store
        cfg[("env.ts / keychain.ts<br/>DID + tenant key in OS keychain")]:::store
    end

    subgraph T3["☁️ Terminal 3 · Intel TDX"]
        direction TB
        contract["contract Rust to WASM<br/>forward · release-to-tenant"]:::t3
        secrets[("secrets map<br/>the canonical copy")]:::t3
        acl[("agent-auth-update<br/>egress allowlist, deny by default")]:::t3
    end

    api["Upstream API"]:::ext

    cli --> reg & prox & wrap & t3c
    prox --> prov --> t3c
    reg --> t3c
    prox --> led
    t3c --> cfg
    t3c -->|"handshake + authenticate"| contract
    contract --> secrets
    contract --> acl
    contract -->|"in-enclave HTTPS"| api
```

<details>
<summary><b>Component responsibilities (table)</b></summary>

| Component | File | Responsibility | Sees plaintext? |
|---|---|---|---|
| CLI dispatcher | `bin/blindfold.ts` | route commands to `cmd-*.ts` handlers | no |
| Register | `src/register.ts` | seal a secret with one `map-entry-set` | **once**, dropped immediately |
| Proxy | `src/proxy.ts` | swap any `Authorization` for `Bearer __BLINDFOLD__`, route by URL, forward to enclave | **no** |
| Providers | `src/providers.ts` | prefix → upstream host + secret name + auth scheme | no |
| T3 client | `src/t3-client.ts` | SDK wrapper: auth, `seedSecret`, `invokeForward`, `releaseSecret`, `deleteSecret`, `getBalance` | release path returns it locally |
| Release / wrap | `src/release.ts`, `src/wrap.ts` | broker plaintext to *your* process for one call | **yes**, by design (local) |
| Ledger | `src/sealed-ledger.ts` | metadata-only, HMAC-chained record of what's sealed | never (metadata only) |
| Contract | `contract/src/forward.rs` | `forward` substitutes in-enclave; `release-to-tenant` returns plaintext | inside the enclave only |

</details>

---

## 3 · The core trick: sentinel substitution

The agent sends `Authorization: Bearer __BLINDFOLD__`. The proxy figures out
*which* API and *which* sealed secret from the **URL path**, and the enclave
swaps the sentinel for the real key at the very last moment.

```mermaid
flowchart LR
    classDef ok fill:#e8fff0,stroke:#3fb950,color:#04260f
    classDef enc fill:#eef0ff,stroke:#6e44ff,color:#160a3d

    a["Agent request<br/>POST /v1/chat/completions<br/>Authorization: Bearer __BLINDFOLD__"]:::ok
    p["Proxy matches prefix<br/>provider = openai<br/>host = api.openai.com<br/>secret = openai_api_key"]:::ok
    e["Enclave forward:<br/>read secret from map,<br/>replace __BLINDFOLD__ with sk-…,<br/>call upstream"]:::enc
    r["API response<br/>no key inside"]:::ok
    a --> p --> e --> r
```

> **Deny-by-default, twice:** a URL prefix not in `providers.ts` returns `404 no
> upstream mapping`; and the enclave refuses any host not on the tenant's egress
> allowlist (`grant --host …`). Two independent gates.

---

## 4 · The three secret paths

Blindfold has **three** ways a sealed secret gets used, with different security
postures. Pick per workload — see [Cost](README.md#cost).

| Path | Where the plaintext appears | Guarantee | Use for |
|---|---|---|---|
| **Proxy / forward** | *only inside the enclave* | strongest — agent never holds it | agent HTTP calls, autonomous agents |
| **Release broker** | *your local process*, briefly | protects the agent's *context*, not your process | CLI `use`, non-HTTP, batch (release-once-reuse) |
| **Seed / register** | *your process once*, at seal time | unavoidable — the value must enter the enclave once | one-time setup |

<details open>
<summary><b>4a · Proxy / forward — the un-leakable path</b></summary>

```mermaid
sequenceDiagram
    autonumber
    participant A as 🤖 Agent
    participant P as Proxy
    participant T as t3-client
    participant E as 🔒 Enclave
    participant U as Upstream API

    A->>P: POST with Authorization Bearer __BLINDFOLD__
    Note over P: overwrite Authorization with the sentinel,<br/>ignore whatever the agent sent
    P->>P: match URL prefix to provider host secret auth-scheme
    P->>T: ForwardRequest url method body secret_key auth
    T->>E: execute forward, tenant-authenticated
    Note over E: read secret from the secrets map,<br/>replace __BLINDFOLD__ with the real key,<br/>apply auth scheme bearer basic sigv4 webhook
    E->>U: real HTTPS request from inside TDX
    U-->>E: response
    E-->>T: code and body, sealed secret redacted from body
    T-->>P: ForwardResponse
    P-->>A: response — the key never crossed back out
```

The plaintext key exists **only** inside the enclave, for one outbound call. The
agent, proxy, and `t3-client` only ever handle the sentinel.

</details>

<details>
<summary><b>4b · Release broker — plaintext to your process</b></summary>

```mermaid
sequenceDiagram
    autonumber
    participant C as CLI or your code
    participant T as t3-client
    participant E as 🔒 Enclave
    participant X as Child process, one call

    C->>T: release openai_api_key
    T->>E: execute release-to-tenant, secret_key
    Note over E: ACL check, then return plaintext<br/>to the authenticated tenant
    E-->>T: plaintext over the authenticated session
    T-->>C: value kept local, never logged
    C->>X: inject as ENV for one command, then drop
    Note over C,X: blindfold use --name X -- cmd<br/>protection rests on the tenant key<br/>being out of the agent's reach
```

Used by `use`, `export`, `rotate`, `rollback`, and `wrap`/`release`. Cheaper for
bursts — **release once, reuse for N calls** — at the cost of the value living in
your process for that window.

</details>

<details>
<summary><b>4c · Seal / register — one-time</b></summary>

```mermaid
sequenceDiagram
    autonumber
    participant D as 🧑‍💻 Developer
    participant R as register.ts
    participant T as t3-client
    participant E as 🔒 Enclave
    participant L as Ledger, local

    D->>R: blindfold register --name openai_api_key
    Note over R: hidden prompt, no echo, no shell history
    R->>T: seedSecret name value  — the one plaintext line
    T->>E: map-entry-set into the secrets map
    E-->>T: ok
    T-->>R: value dropped from scope
    R->>L: record metadata only, name length when, HMAC-chained
    R-->>D: sealed — value lives only in the enclave
```

</details>

---

## 5 · Self-serve signup

`blindfold signup` provisions a funded Terminal 3 testnet tenant with no manual
step — the tenant key is generated **locally** and never leaves the machine
except to authenticate.

```mermaid
sequenceDiagram
    autonumber
    participant U as 🧑‍💻 User
    participant B as blindfold signup
    participant K as OS keychain
    participant T3 as Terminal 3

    U->>B: blindfold signup --email you@x.com
    B->>B: generate secp256k1 key, 32 random bytes
    B->>K: store key, never printed
    B->>T3: handshake + authenticate, eth-derived DID
    B->>T3: otpRequest email
    T3-->>U: 📧 verification code
    U->>B: enter code
    B->>T3: otpVerify code
    B->>T3: submitUserInput becomeDevTenant true
    Note over T3: self-admit and mint welcome credits, about 20k tokens
    T3-->>B: tenant admitted and DID
    B-->>U: funded tenant ready — doctor, credit, register
```

---

## 6 · Remote attestation

`blindfold attest` proves the enclave runs the **expected code** before you trust
it with secrets. Quotes chain to Intel's SGX root CA; the code measurement
`RTMR3` can be pinned so `seal`/`proxy` verify it first.

```mermaid
flowchart TB
    classDef ok fill:#e8fff0,stroke:#3fb950,color:#04260f
    classDef enc fill:#eef0ff,stroke:#6e44ff,color:#160a3d

    q["Fetch TDX quote + attestation_msg<br/>from the T3 node status endpoint"]:::enc
    r["report_data equals keccak512 of attestation_msg?"]:::ok
    c["Quote chains to the Intel SGX root CA?"]:::ok
    m["RTMR3 equals the pinned code measurement?"]:::ok
    k["attestation_msg starts with the ML-KEM<br/>encaps key the session encrypts to"]:::enc
    ok(["✅ enclave verified<br/>seal and proxy allowed"]):::ok
    q --> r --> c --> m --> k --> ok
```

> **Why it binds:** seals encrypt through the authenticated session derived from
> the same status ML-KEM key that attestation binds to — so the attested key *is*
> the seal-recipient key. Pinning `RTMR3` closes the residual "is it my code?"
> question.

---

## 7 · Trust boundaries & threat model

```mermaid
flowchart LR
    classDef danger fill:#fff0f0,stroke:#f85149,color:#3d0a0a
    classDef enc fill:#e8fff0,stroke:#3fb950,color:#04260f

    subgraph UNTRUSTED["🚨 Untrusted for secrets — assume compromised"]
        agent["Agent process and context"]:::danger
        webpage["Web pages, PDFs, tools<br/>prompt-injection sources"]:::danger
        proxyz["Local proxy — sees only the sentinel"]:::danger
    end

    subgraph TRUSTED["🔒 Trusted — hardware-isolated"]
        enclave["TDX enclave + secrets map"]:::enc
    end

    webpage -.->|"inject"| agent
    agent -->|"only __BLINDFOLD__"| proxyz
    proxyz -->|"sentinel"| enclave
    enclave -->|"real key, never returned"| enclave
```

| Threat | Mitigation | Residual |
|---|---|---|
| Prompt injection exfiltrates a key | agent only ever holds `__BLINDFOLD__` | none for the proxy path |
| Proxy misused by a co-resident process | `proxy --auth` session token · `--socket` 0600 | agent as same OS user |
| Reflection-exfil — key echoed in a response | contract redacts the sealed secret from the returned body | — |
| Malicious or honest-but-curious T3 node | remote attestation + **mandatory RTMR3 pin** to seal | trust in Intel TDX + T3 |
| Tenant key stolen from disk | key in the **OS keychain**, not a plaintext file | agent as same user with unlocked keychain |
| Ledger edited to hide a secret | HMAC hash-chain, `audit` flags TAMPERED; enclave is source of truth | — |

---

## 8 · Tamper-evident ledger

`~/.blindfold/sealed.jsonl` is a metadata-only, append-only, HMAC hash-chained
record of what's sealed. It never holds values — `audit` reconciles it against
the enclave, the source of truth.

```mermaid
flowchart LR
    classDef store fill:#fff8e6,stroke:#d29922,color:#3d2c04
    e0["entry 0<br/>hash = HMAC of empty + core0"]:::store
    e1["entry 1<br/>prev = hash0<br/>hash = HMAC of prev + core1"]:::store
    e2["entry 2<br/>prev = hash1<br/>hash = HMAC of prev + core2"]:::store
    e0 --> e1 --> e2
```

- **Keyed** — `ledger.key`, 0600 — an attacker who edits a line can't forge a
  valid chain (unlike a plain sha256 chain anyone could recompute).
- **`blindfold delete`** removes an entry and **re-chains** the survivors (backup
  kept) so the chain stays valid — a legitimate owner action, not a stealth edit.
- **`blindfold audit`** verifies the chain *and* reconciles each name against the
  enclave: present / drift / missing.

---

## 9 · Secret lifecycle

```mermaid
stateDiagram-v2
    [*] --> Sealed: register
    Sealed --> Used: use / proxy / release
    Used --> Sealed: value dropped after each use
    Sealed --> Rotated: rotate, snapshots the old value
    Rotated --> Sealed: rollback restores a snapshot
    Sealed --> Shared: share to a teammate DID, forward-only
    Shared --> Sealed: revoke
    Sealed --> Deleted: delete, empties enclave and re-chains ledger
    Deleted --> [*]
```

---

## 10 · Deployment & file map

| Concern | Where it lives |
|---|---|
| Canonical secret value | **only** the TDX enclave secrets map |
| Tenant key (`T3N_API_KEY`) | OS keychain — macOS `security` / Linux `secret-tool` / Windows Cred Mgr; 0600 file fallback |
| DID + settings | `~/.blindfold/config.json` — 0600, non-secret |
| Sealed-keys ledger + HMAC key | `~/.blindfold/sealed.jsonl` + `ledger.key`, 0600 |
| Egress allowlist | server-side on T3 (`agent-auth-update`) — **not** client-bypassable |
| The contract | `contract/` → Rust → `wasm32-wasip2` WASM, published as `blindfold-proxy` v0.5.6 |
| The CLI | published npm `@fiscalmindset/blindfold` → `dist/cli.mjs` |

```
packages/blindfold/
  bin/     blindfold.ts (dispatch) + cmd-*.ts (command groups)
  src/     proxy.ts · t3-client.ts · register.ts · release.ts · wrap.ts
           providers.ts · sealed-ledger.ts · attest.ts · env.ts · keychain.ts
           help.ts · tui.ts (responsive terminal UI)
contract/
  src/     lib.rs · forward.rs  (forward + release-to-tenant)
  wit/     world.wit            (exports + host imports)
```

---

<div align="center">

**Read next:** [Architecture writeup](ARCHITECTURE.md) · [Security model](SECURITY.md) · [Cost model](README.md#cost) · [Usage](usage.md)

<sub>Diagrams render natively on GitHub (Mermaid). Collapsible sections keep it scannable.</sub>

</div>
