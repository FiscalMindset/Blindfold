// Blindfold-proxy contract.
//
// SECURITY INVARIANT: the plaintext secret is read from KV inside this
// process (TDX enclave memory), substituted into headers on the stack,
// passed to host::interfaces::http::call, and then dropped. It is never
// returned to the caller, logged, or stored outside the outbound HTTPS
// request payload.
//
// VERIFIED LIVE (T3 testnet, 2026-06-19):
//   - tenant_context::tenant_did() works ✅
//   - kv_store::get(z:<tid>:secrets, key) reads the sealed value ✅
//   - The substitution runs entirely inside the TDX enclave ✅
//
// GATED on canonical T3 host WITs:
//   - http::call returns an opaque HTTP 500 from the host runtime when
//     called. Most likely: our wit/deps/host-interfaces stub for the
//     http interface has a signature T3 rejects at runtime, OR the
//     tenant's egress allowlist is empty. Both can be resolved by
//     swapping in T3's canonical host WIT files. When that's done,
//     this file does not need to change.

use serde::{Deserialize, Serialize};

use crate::host::interfaces::{http, kv_store};
use crate::host::tenant::tenant_context;

pub const SENTINEL: &str = "__BLINDFOLD__";

#[derive(Deserialize)]
struct ForwardInput {
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: Option<String>,
    secret_key: String,
    /// When true, skips http::call and returns the in-enclave proof of
    /// secret substitution only (status=200, body=size-of-substituted-value).
    /// Useful for diagnostics when egress is unconfigured.
    #[serde(default)]
    dry_run: bool,
}

#[derive(Serialize)]
struct ForwardOutput {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

pub fn forward(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input: ForwardInput = serde_json::from_slice(input_bytes)
        .map_err(|e| format!("bad input json: {e}"))?;

    // Plaintext exists only on this stack frame; dropped at fn return.
    let api_key = read_secret(&input.secret_key)?;

    let substituted: Vec<(String, String)> = input
        .headers
        .into_iter()
        .map(|(k, v)| (k, v.replace(SENTINEL, &api_key)))
        .collect();

    if input.dry_run {
        // Prove the substitution happened without making an outbound call.
        // The response intentionally does NOT echo the secret — only its
        // post-substitution length, so the caller can confirm the contract
        // wrote it into the Authorization header.
        let auth_len = substituted
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.len())
            .unwrap_or(0);
        let out = ForwardOutput {
            status: 200,
            headers: vec![("x-blindfold-mode".into(), "dry-run".into())],
            body: format!(
                r#"{{"ok":true,"dry_run":true,"authorization_header_len_after_substitution":{}}}"#,
                auth_len
            ),
        };
        return serde_json::to_vec(&out).map_err(|e| format!("output encode: {e}"))
    }

    let resp = http::call(&http::Request {
        method: parse_verb(&input.method)?,
        url: input.url,
        headers: Some(substituted),
        payload: input.body.map(|b| b.into_bytes()),
    })
    .map_err(|e| format!("http::call: {e}"))?;

    let sanitized_headers: Vec<(String, String)> = resp
        .headers
        .into_iter()
        .filter(|(k, _)| !is_sensitive_header(k))
        .collect();

    let body_str = String::from_utf8(resp.payload).unwrap_or_else(|e| {
        format!("<{} non-utf8 bytes>", e.into_bytes().len())
    });

    let out = ForwardOutput {
        status: resp.code,
        headers: sanitized_headers,
        body: body_str,
    };
    serde_json::to_vec(&out).map_err(|e| format!("output encode: {e}"))
}

fn read_secret(name: &str) -> Result<String, String> {
    let tid = tenant_context::tenant_did();
    let map_name = format!("z:{}:secrets", hex::encode(&tid));
    let bytes = kv_store::get(&map_name, name.as_bytes())
        .map_err(|e| format!("kv read: {e}"))?
        .ok_or_else(|| format!("secret {name} not found in {map_name}"))?;
    String::from_utf8(bytes).map_err(|e| format!("secret not utf-8: {e}"))
}

fn parse_verb(m: &str) -> Result<http::Verb, String> {
    Ok(match m.to_ascii_uppercase().as_str() {
        "GET" => http::Verb::Get,
        "POST" => http::Verb::Post,
        "PUT" => http::Verb::Put,
        "DELETE" => http::Verb::Delete,
        "PATCH" => http::Verb::Patch,
        "HEAD" => http::Verb::Head,
        other => return Err(format!("unsupported method: {other}")),
    })
}

fn is_sensitive_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(n.as_str(), "authorization" | "proxy-authorization" | "set-cookie" | "cookie" | "x-api-key")
}
