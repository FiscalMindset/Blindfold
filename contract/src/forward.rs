// The forward operation:
//   1. parse input JSON: { method, url, headers, body?, secret_key }
//   2. read the named secret from z:<tid>:secrets (KV — enclave-only)
//   3. substitute the sentinel "__BLINDFOLD__" in every header value
//   4. make the HTTP call via host:interfaces/http
//   5. return the response (status, headers, body) as JSON bytes
//
// The plaintext secret exists only as a local String here; it is dropped
// at function return. The contract never echoes it into logs or the body.

use serde::{Deserialize, Serialize};

use crate::host::interfaces::{http, logging};
use crate::host::tenant::tenant_context;
use crate::host::interfaces::kv_store;

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
}

#[derive(Serialize)]
struct ForwardOutput {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

pub fn forward(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input: ForwardInput =
        serde_json::from_slice(input_bytes).map_err(|e| format!("bad input json: {e}"))?;

    let _ = logging::info(&format!(
        "blindfold.forward: method={} url={} headers={} secret_key={}",
        input.method,
        scheme_and_host(&input.url),
        input.headers.len(),
        input.secret_key
    ));

    // Read the secret. The plaintext lives only on this stack frame.
    let api_key = read_secret(&input.secret_key)?;

    // Rewrite headers with the secret substituted in. We allocate a new
    // Vec rather than mutating in place to make the lifetimes obvious.
    let substituted: Vec<(String, String)> = input
        .headers
        .into_iter()
        .map(|(k, v)| (k, v.replace(SENTINEL, &api_key)))
        .collect();

    let resp = http::call(&http::Request {
        method: parse_verb(&input.method)?,
        url: input.url,
        headers: Some(substituted),
        payload: input.body.map(|b| b.into_bytes()),
    })
    .map_err(|e| format!("upstream http error: {e:?}"))?;

    // Belt-and-braces: never echo Authorization back to the caller, even
    // though we already substituted it in the outbound direction. Some
    // upstreams reflect headers; strip anything that looks like a secret.
    let sanitized_headers: Vec<(String, String)> = resp
        .headers
        .into_iter()
        .filter(|(k, _)| !is_sensitive_header(k))
        .collect();

    let out = ForwardOutput {
        status: resp.code,
        headers: sanitized_headers,
        body: resp.payload,
    };
    serde_json::to_vec(&out).map_err(|e| format!("output encode: {e}"))
}

fn read_secret(name: &str) -> Result<String, String> {
    let tid = tenant_context::tenant_did();
    let map_name = format!("z:{}:secrets", hex::encode(&tid));
    let bytes = kv_store::get(&map_name, name.as_bytes())
        .map_err(|e| format!("kv read: {e:?}"))?
        .ok_or_else(|| format!("secret {name} not found in {map_name}"))?;
    String::from_utf8(bytes).map_err(|e| format!("secret is not utf-8: {e}"))
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

fn scheme_and_host(url: &str) -> String {
    // For logging only — never log paths or queries (could include PII / IDs).
    if let Some(rest) = url.strip_prefix("https://") {
        let end = rest.find('/').unwrap_or(rest.len());
        return format!("https://{}", &rest[..end]);
    }
    if let Some(rest) = url.strip_prefix("http://") {
        let end = rest.find('/').unwrap_or(rest.len());
        return format!("http://{}", &rest[..end]);
    }
    "<unknown-scheme>".to_string()
}

fn is_sensitive_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "authorization" | "proxy-authorization" | "set-cookie" | "cookie" | "x-api-key"
    )
}
