# 02 — Terminal 3 Analysis: What We're Building On

> Everything below is taken from the live T3 docs (fetched 2026-06-19). Anything I'm not certain about is flagged **NEEDS VERIFICATION** rather than guessed.

---

## 1. The shape of Terminal 3 in one paragraph

Terminal 3 (T3N) is a decentralized confidential-compute network. Each node is an Intel TDX-protected VM running a **Wasmtime** runtime. Developers write **Rust contracts** that compile to **WASM (wasi-p2)**; the contract is sealed against a per-tenant content-addressed registry. Inside the enclave, the contract can only touch the outside world through a strongly-typed, capability-gated **Host API** (HTTP, KV store, logging, signing, etc.) — declared explicitly in the contract's `world.wit`. Secrets, user PII, and tenant state live in encrypted KV maps that are only decryptable from within an attested TEE. The client SDK is **`@terminal3/t3n-sdk`** (TypeScript only at the moment); clients authenticate via an **Ethereum/secp256k1 keypair** whose tenant identity is a **`did:t3n:<id>`** DID.

This is exactly the shape Blindfold needs: a place to put a developer's API key where it is *structurally* unreachable from the calling AI agent.

---

## 2. The two T3 features Blindfold actually needs

The T3 docs document several mechanisms for keeping secrets away from the caller. Blindfold cares about two of them:

### 2.1 The **secrets map** + `kv-store` capability (the primary mechanism)

This is the path for **a developer's own API key** (the OpenAI key, the Stripe key, etc.).

- The key is sealed into a per-tenant KV map named `z:<tid>:secrets` via a control-plane call.
- A contract that imports `host:interfaces/kv-store@2.1.0` can read the value back **only from inside the TDX enclave** at execution time.
- The value never appears outside the enclave. The docs are explicit: *"The only path to the key is through your contract code — no external observer, not the agent, not the calling developer, can read it back out."*

**Seeding the secret** — exact verbatim TypeScript from `tips/seed-api-key.md`:

```ts
await tenant.executeControl("map-entry-set", {
  map_name: tenant.canonicalName("secrets"),
  key:      "duffel_api_key",
  value:    process.env.DUFFEL_API_KEY!,
});
```

**Reading the secret from inside the contract** — exact verbatim Rust:

```rust
use crate::host::{interfaces::kv_store, tenant::tenant_context};

fn get_api_key() -> Result<String, String> {
    let tid = tenant_context::tenant_did();
    let map_name = format!("z:{}:secrets", hex::encode(&tid));
    let bytes = kv_store::get(&map_name, b"duffel_api_key")
        .map_err(|e| format!("kv read: {e}"))?
        .ok_or("duffel_api_key not found in z:<tid>:secrets")?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
```

That's the whole secret-handling pattern. Once the key is in the secrets map, the contract uses it like any string — but the string is only materialised inside the enclave.

### 2.2 `http-with-placeholders` (a secondary mechanism, useful but not core)

This is the path for **user-side PII** (first name, DOB, payment info) that a *different* user has delegated to an agent. It lets the contract embed markers like `{{profile.first_name}}` in the request body or headers, and the host substitutes the calling user's profile values *inside the enclave just before the request leaves*. Verbatim Rust:

```rust
use crate::host::interfaces::http_with_placeholders as hwp;
use serde_json::json;

let body = json!({
    "passenger": {
        "given_name":  "{{profile.first_name}}",
        "family_name": "{{profile.last_name}}",
        "born_on":     "{{profile.date_of_birth}}",
    }
});
let resp = hwp::call(&hwp::Request {
    method:  hwp::Verb::Post,
    url:     format!("{DUFFEL_BASE}/air/orders"),
    headers: Some(duffel_headers(&api_key)),
    payload: Some(serde_json::to_vec(&body).map_err(|e| e.to_string())?),
})?;
```

> **Important subtlety I almost got wrong.** The placeholder syntax (`{{profile.<field>}}`) resolves from the **calling user's profile**, not from the developer's secrets map. It's gated by **per-user delegation grants**, and the host returns `placeholder not permitted: <marker>` if the calling user hasn't authorised that field. So `http-with-placeholders` is for *PII delegated by a separate end-user* — not for a developer's own API key.
>
> For our case (the agent's API key), the right primitive is **the secrets map + plain `http` capability**. The contract reads the key from the map and includes it as a normal header; the key never leaves the enclave because the contract itself runs in the enclave.

`http-with-placeholders` will be relevant later if Blindfold also needs to protect end-user data flowing through the agent. For the MVP, we don't need it.

---

## 3. Anatomy of a T3 contract (the bits Blindfold has to produce)

A contract is a Rust crate with three pieces.

### 3.1 `world.wit` — declared capabilities

Verbatim, from the walkthrough:

```wit
package z:tenant-flight@0.4.0;

world tenant-flight {
  import host:tenant/tenant-context@1.0.0;
  import host:interfaces/logging@2.1.0;
  import host:interfaces/kv-store@2.1.0;
  import host:interfaces/http@2.1.0;
  import host:interfaces/http-with-placeholders@2.1.0;

  export contracts;
}

interface contracts {
  record generic-input {
    input:        option<list<u8>>,
    user-profile: option<list<u8>>,
    context:      option<list<u8>>,
  }

  search-offers: func(req: generic-input) -> result<list<u8>, string>;
  book-offer:    func(req: generic-input) -> result<list<u8>, string>;
}
```

For Blindfold's wrapper contract we will only need `kv-store`, `http`, `logging`, and `tenant-context` (no `http-with-placeholders` for MVP).

### 3.2 `Cargo.toml` — build target

Verbatim:

```toml
[package]
name = "z-tenant-flight"
version = "0.4.1"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
wit-bindgen = { version = "0.49", default-features = false, features = ["macros", "realloc"] }
serde = { version = "1.0", default-features = false, features = ["derive", "alloc"] }
serde_json = { version = "1.0", default-features = false, features = ["alloc"] }
hex = { version = "0.4", default-features = false, features = ["alloc"] }
```

### 3.3 `lib.rs` — entrypoint shape

```rust
wit_bindgen::generate!({
    world: "tenant-flight",
    path: "wit",
    additional_derives: [serde::Deserialize, serde::Serialize],
    generate_all,
});

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::tenant_flight::contracts::Guest for Component {
    fn search_offers(req: exports::z::tenant_flight::contracts::GenericInput)
        -> Result<Vec<u8>, String> { /* ... */ }
}

#[cfg(target_arch = "wasm32")]
export!(Component);
```

Each exported function follows the same signature shape:

```text
fn <op>(req: GenericInput) -> Result<Vec<u8>, String>
```

Where `GenericInput` is `{ input?, user_profile?, context? }` — all `Option<Vec<u8>>` (JSON bytes).

### 3.4 Build

```bash
rustup target add wasm32-wasip2          # once
cargo build --target wasm32-wasip2 --release
# Artifact: target/wasm32-wasip2/release/<name>.wasm   (hyphens become underscores)
```

---

## 4. The TypeScript client surface Blindfold will use

All from `@terminal3/t3n-sdk` (Node ≥18). Verbatim where shown in docs.

### 4.1 Imports + setup

```ts
import {
  T3nClient,
  TenantClient,                 // implied — used in the setup snippet
  loadWasmComponent,
  createEthAuthInput,
  eth_get_address,
  metamask_sign,
  getScriptVersion,
  getNodeUrl,
  setEnvironment,
} from "@terminal3/t3n-sdk";
```

### 4.2 Authenticate

```ts
setEnvironment("testnet");                                    // or "production"

const wasmComponent = await loadWasmComponent();              // SDK-internal blob
const agentKey      = process.env.AGENT_KEY!;                 // hex secp256k1 priv key
const agentAddress  = eth_get_address(agentKey);

const t3n = new T3nClient({
  wasmComponent,
  handlers: { EthSign: metamask_sign(agentAddress, undefined, agentKey) },
});

await t3n.handshake();
await t3n.authenticate(createEthAuthInput(agentAddress));
```

> **Mapping to our `.env`:** the user's `.env` has `T3N_API_KEY=0x...` (32 bytes hex) and `DID=did:t3n:...`. The `0x...` API key is structurally an Ethereum private key; it plays the role of `AGENT_KEY` / `TENANT_KEY` in the SDK. The DID is the on-network identity derived from that key. The wrapper will pull both from env and not log either.

### 4.3 Tenant operations (one-time, by the developer)

```ts
const tenant = new TenantClient({ t3n, baseUrl, tenantDid }); // NEEDS VERIFICATION on baseUrl

// Seed the API key — the only line in Blindfold that touches the plaintext,
// and only for the duration of this call. We do not log, store, or persist it.
await tenant.executeControl("map-entry-set", {
  map_name: tenant.canonicalName("secrets"),
  key:      "openai_api_key",
  value:    process.env.OPENAI_API_KEY!,
});

// Register the wrapper contract (once, after `cargo build`)
const { contract_id } = await tenant.contracts.register({
  tail:    "blindfold-proxy",
  version: "0.1.0",
  wasm:    fs.readFileSync(".../blindfold_proxy.wasm"),
});
```

### 4.4 Agent operations (every call, from inside Blindfold's runtime path)

```ts
const result = await agentClient.executeAndDecode({
  script_name:    `z:${tenantDid.slice("did:t3n:".length)}:blindfold-proxy`,
  script_version: 1,                                  // numeric — NEEDS VERIFICATION how this maps from "0.1.0"
  function_name:  "forward",
  input: {                                            // ↓ JSON our contract knows how to parse
    method:  "POST",
    url:     "https://api.openai.com/v1/chat/completions",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer __BLINDFOLD_SECRET__" },
    body:    "<the agent's literal request body>",
  },
});
```

The contract reads `__BLINDFOLD_SECRET__` (or any other agreed sentinel) and substitutes the real value from `kv-store::get("z:<tid>:secrets", "openai_api_key")` before calling `http::call`. The sentinel is a *signal* to the contract, not a secret; replacing it inside the enclave is the whole point.

---

## 5. How Blindfold sits in the picture

```mermaid
flowchart LR
    classDef dev   fill:#eef,stroke:#33c,color:#003
    classDef agent fill:#ffe,stroke:#990,color:#660
    classDef bf    fill:#efe,stroke:#3a3,color:#060
    classDef tee   fill:#fef,stroke:#a3a,color:#606
    classDef ext   fill:#eee,stroke:#666,color:#333

    Dev["👩‍💻 Developer<br/>(.env has key)"]:::dev
    Reg["Blindfold CLI<br/><i>blindfold register</i>"]:::bf
    Agent["🤖 AI Agent<br/>(holds NO key)"]:::agent
    Proxy["Blindfold Proxy<br/>(OpenAI-shaped URL)"]:::bf
    Node["T3 Node (TDX enclave)"]:::tee
    Contract["blindfold-proxy contract<br/>(WASM, in enclave)"]:::tee
    Secrets[("KV: z:tid:secrets<br/>🔑 openai_api_key")]:::tee
    API["api.openai.com"]:::ext

    Dev -- "key, ONCE (out of band)" --> Reg
    Reg -- "map-entry-set" --> Node
    Node --> Secrets

    Agent -- "request w/ sentinel<br/>Bearer __BLINDFOLD_SECRET__" --> Proxy
    Proxy -- "executeAndDecode<br/>(no key ever)" --> Node
    Node --> Contract
    Contract -- "kv::get" --> Secrets
    Contract -- "http::call w/ real key<br/>(substituted IN enclave)" --> API
    API -- "response" --> Contract --> Node --> Proxy --> Agent
```

Notice where the 🔑 lives, where it is read, and — crucially — that the Blindfold Proxy on the left-hand side **never** touches it. Its only inputs are (a) a sentinel string and (b) the agent's normal request. It can't leak what it doesn't have.

---

## 6. The exact T3 API surface Blindfold will use

| Use | API call | Notes |
|---|---|---|
| Auth | `t3n.handshake()` + `t3n.authenticate(createEthAuthInput(addr))` | Ethereum-style challenge/response, signed by `T3N_API_KEY`. |
| One-time secret seed | `tenant.executeControl("map-entry-set", { map_name, key, value })` | This is the **only** line in Blindfold that ever sees the plaintext, and only because the developer hands it to us literally during registration. We do not persist or log it. |
| Map naming | `tenant.canonicalName("secrets")` | Returns `z:<tid>:secrets`. |
| One-time contract publish | `tenant.contracts.register({ tail, version, wasm })` | Returns `contract_id`. |
| Per-call invocation | `agent.executeAndDecode({ script_name, script_version, function_name, input })` | `script_name` = `z:<tid_hex>:<tail>`. |
| In-enclave secret read | `kv_store::get(map_name, key)` (Rust, in contract) | Inside TDX only. |
| In-enclave outbound HTTP | `http::call(&http::Request{...})` (Rust, in contract) | Egress is gated by per-user allowed-hosts list — see `outbound-http-auth-by-user`. |

---

## 7. NEEDS VERIFICATION (open questions for the user)

These are items I refuse to guess in code. Each has a planned fallback so Step 4 can still make progress.

1. **The exact `baseUrl` for `TenantClient` on testnet** — the SDK exposes `getNodeUrl()`; the docs hint that the right value comes from `setEnvironment("testnet")` plus a tenant-specific endpoint. Plan: try `getNodeUrl()` first, fall back to a config flag.
2. **`script_version` typing** — `executeAndDecode` takes a numeric `script_version`, but `contracts.register` takes a semver `version: "0.1.0"`. The mapping (does T3 hand back an integer? do we call `getScriptVersion()`?) isn't fully documented in the pages I fetched. Plan: call `getScriptVersion()` if the SDK provides a resolver; otherwise call `contracts.list` (if it exists) and pick the latest.
3. **Whether `T3N_API_KEY` in our `.env` is the tenant key or the agent key** — both roles use a secp256k1 hex private key. The user's `.env` has only one. For an MVP we will use it as **both** the tenant (one-time registration) and the agent (per-call invocation), which is valid because the tenant owns its own contracts. The "separate agent DID" pattern is a hardening step for later.
4. **Egress allowlist setup** — `outbound-http-auth-by-user.md` says outbound hosts must be on an allowed-hosts list per-user-grant; `common-errors.md` confirms `host/http.egress_denied` if not. We need to figure out how the *tenant's own* grants are configured (probably a separate `executeControl` action) so that `api.openai.com` is allowed for the contract. Plan: try a `grant-set` / `policy-set` control action; mark as NEEDS VERIFICATION until confirmed.
5. **`loadWasmComponent()` source** — the SDK ships an internal WASM blob it loads at startup. Plan: trust the SDK's default path; if it requires a URL, use `getNodeUrl()`.
6. **Whether `contracts.register` requires explicit ACL setup** for the `secrets` map before `map-entry-set` works, or whether the tenant's own write to a control map bypasses ACLs (the docs say "the `map-entry-set` control write bypasses the map's `writers` ACL"). Plan: assume bypass for the tenant; if we hit an `access denied` error, add an ACL-grant call before seeding.

For each of these, Blindfold's TS layer will surface a clean error message rather than silently retry, so the developer (and the auditor) can see exactly which T3 call failed and why.

---

## 8. The single most important invariant for Step 3 onwards

> **The plaintext API key enters one — and only one — line of Blindfold's TypeScript: the `executeControl("map-entry-set", { ... value: process.env.X! })` call during one-time registration.** That call hands the value directly to the T3 SDK, which sends it (over the SDK's established encrypted channel) to the TDX enclave. After the call returns, the value is out of scope. We do not log it, persist it, or pass it anywhere else. Every other Blindfold code path operates on **placeholders and request shapes**, never on the secret itself.

Step 3 (architecture) will be organized to make this invariant impossible to violate by accident — including by separating the registration code path from the runtime proxy path so they cannot share variables or state.
