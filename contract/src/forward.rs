// Full forward — kv read + http call. Egress allowlist is now populated
// via z:<tid>:authorised-hosts.
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

    let api_key = read_secret(&input.secret_key)?;

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
        .ok_or_else(|| format!("secret {name} not found"))?;
    String::from_utf8(bytes).map_err(|e| format!("secret not utf-8: {e}"))
}

fn parse_verb(m: &str) -> Result<http::Verb, String> {
    Ok(match m.to_ascii_uppercase().as_str() {
        "GET" => http::Verb::Get, "POST" => http::Verb::Post, "PUT" => http::Verb::Put,
        "DELETE" => http::Verb::Delete, "PATCH" => http::Verb::Patch, "HEAD" => http::Verb::Head,
        other => return Err(format!("unsupported method: {other}")),
    })
}

fn is_sensitive_header(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "set-cookie" | "cookie" | "x-api-key")
}
