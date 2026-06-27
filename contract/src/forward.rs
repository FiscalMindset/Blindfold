// Blindfold contract — kv only (no http). See contract/wit/world.wit
// for the why. Outbound HTTPS happens in the local broker process
// after `release-to-tenant` returns the plaintext.

use serde::{Deserialize, Serialize};

use crate::host::interfaces::http;
use crate::host::interfaces::kv_store;
use crate::host::tenant::tenant_context;

pub const SENTINEL: &str = "__BLINDFOLD__";

/* ---------------- forward: in-enclave outbound call --------------------- */

#[derive(Deserialize)]
struct ForwardInput {
    /// HTTP method (GET/POST/PUT/PATCH/DELETE). Defaults to GET.
    #[serde(default = "default_method")]
    method: String,
    /// Absolute URL to call.
    url: String,
    /// Headers; any occurrence of the SENTINEL in a value is replaced with the
    /// real secret inside the enclave, on the stack, just before the call.
    #[serde(default)]
    headers: Vec<(String, String)>,
    /// Optional UTF-8 request body.
    #[serde(default)]
    body: Option<String>,
    /// Name of the sealed secret to substitute for the SENTINEL.
    secret_key: String,
    /// If true, do not make the outbound call — just prove the substitution.
    #[serde(default)]
    dry_run: bool,
}

fn default_method() -> String { "GET".to_string() }

#[derive(Serialize)]
struct ForwardOutput {
    ok: bool,
    /// HTTP status code from the upstream (0 when dry_run).
    code: u16,
    /// Upstream response body as UTF-8 (lossy). Empty when dry_run.
    body: String,
    /// Byte length of the upstream response payload.
    length: usize,
    /// True when no outbound call was made.
    dry_run: bool,
}

pub fn forward(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input: ForwardInput = serde_json::from_slice(input_bytes)
        .map_err(|e| format!("bad input json: {e}"))?;

    // Read the sealed secret from enclave KV and substitute the sentinel into
    // every header value. `secret` is dropped at the end of this function.
    let secret = read_secret(&input.secret_key)?;
    let substituted: Vec<(String, String)> = input.headers.iter()
        .map(|(k, v)| (k.clone(), v.replace(SENTINEL, &secret)))
        .collect();

    if input.dry_run {
        let auth_len = substituted.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
            .map(|(_, v)| v.len()).unwrap_or(0);
        return serde_json::to_vec(&ForwardOutput {
            ok: true, code: 0, body: String::new(), length: auth_len, dry_run: true,
        }).map_err(|e| format!("encode: {e}"));
    }

    let method = parse_verb(&input.method)?;
    let req = http::Request {
        method,
        url: input.url,
        headers: Some(substituted),
        payload: input.body.map(|b| b.into_bytes()),
    };

    // The real outbound call — happens entirely inside the TDX enclave. The
    // plaintext secret never leaves this process except inside this request.
    let resp = http::call(&req).map_err(|e| format!("http::call: {e}"))?;

    serde_json::to_vec(&ForwardOutput {
        ok: resp.code >= 200 && resp.code < 400,
        code: resp.code,
        length: resp.payload.len(),
        body: String::from_utf8_lossy(&resp.payload).into_owned(),
        dry_run: false,
    }).map_err(|e| format!("encode: {e}"))
}

fn parse_verb(m: &str) -> Result<http::Verb, String> {
    match m.to_ascii_uppercase().as_str() {
        "GET" => Ok(http::Verb::Get),
        "POST" => Ok(http::Verb::Post),
        "PUT" => Ok(http::Verb::Put),
        "PATCH" => Ok(http::Verb::Patch),
        "DELETE" => Ok(http::Verb::Delete),
        other => Err(format!("unsupported method: {other}")),
    }
}

/* --------------- release-to-tenant: plaintext to authenticated tenant --- */

#[derive(Deserialize)] struct ReleaseInput { secret_key: String }
#[derive(Serialize)] struct ReleaseOutput { ok: bool, value: String, length: usize }

pub fn release_to_tenant(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let req: ReleaseInput = serde_json::from_slice(input_bytes)
        .map_err(|e| format!("input: {e}"))?;
    let value = read_secret(&req.secret_key)?;
    let length = value.len();
    serde_json::to_vec(&ReleaseOutput { ok: true, value, length })
        .map_err(|e| format!("encode: {e}"))
}

/* --------------- helpers ----------------------------------------------- */

fn read_secret(name: &str) -> Result<String, String> {
    let tid = tenant_context::tenant_did();
    let map_name = format!("z:{}:secrets", hex::encode(&tid));
    let bytes = kv_store::get(&map_name, name.as_bytes())
        .map_err(|e| format!("kv read: {e}"))?
        .ok_or_else(|| format!("secret {name} not found"))?;
    String::from_utf8(bytes).map_err(|e| format!("non-utf8: {e}"))
}
