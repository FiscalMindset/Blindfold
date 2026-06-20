// Blindfold contract — kv only (no http). See contract/wit/world.wit
// for the why. Outbound HTTPS happens in the local broker process
// after `release-to-tenant` returns the plaintext.

use serde::{Deserialize, Serialize};

use crate::host::interfaces::kv_store;
use crate::host::tenant::tenant_context;

pub const SENTINEL: &str = "__BLINDFOLD__";

/* ---------------- forward: in-enclave substitution proof --------------- */

#[derive(Deserialize)]
struct ForwardInput {
    #[serde(default)]
    headers: Vec<(String, String)>,
    secret_key: String,
}

#[derive(Serialize)]
struct ForwardOutput {
    ok: bool,
    secret_len: usize,
    authorization_header_len_after_substitution: usize,
    dry_run: bool,
}

pub fn forward(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input: ForwardInput = serde_json::from_slice(input_bytes)
        .map_err(|e| format!("bad input json: {e}"))?;
    let secret = read_secret(&input.secret_key)?;
    let substituted: Vec<(String, String)> = input.headers.into_iter()
        .map(|(k, v)| (k, v.replace(SENTINEL, &secret))).collect();
    let auth_len = substituted.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.len()).unwrap_or(0);
    serde_json::to_vec(&ForwardOutput {
        ok: true, secret_len: secret.len(),
        authorization_header_len_after_substitution: auth_len, dry_run: true,
    }).map_err(|e| format!("encode: {e}"))
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
