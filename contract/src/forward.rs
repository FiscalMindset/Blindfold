// Diagnostic — no http import. Just kv read + sentinel substitution
// (the security-property essence of Blindfold).
use serde::{Deserialize, Serialize};

use crate::host::interfaces::kv_store;
use crate::host::tenant::tenant_context;

pub const SENTINEL: &str = "__BLINDFOLD__";

#[derive(Deserialize)]
struct In {
    secret_key: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
}

#[derive(Serialize)]
struct Out {
    ok: bool,
    secret_len: usize,
    authorization_header_len_after_substitution: usize,
    dry_run: bool,
}

pub fn forward(input_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let input: In = serde_json::from_slice(input_bytes).map_err(|e| format!("input parse: {e}"))?;

    let tid = tenant_context::tenant_did();
    let map_name = format!("z:{}:secrets", hex::encode(&tid));
    let secret_bytes = kv_store::get(&map_name, input.secret_key.as_bytes())
        .map_err(|e| format!("kv read: {e}"))?
        .ok_or_else(|| format!("secret {} not found in {}", input.secret_key, map_name))?;
    let secret = String::from_utf8(secret_bytes).map_err(|e| format!("non-utf8: {e}"))?;

    let substituted: Vec<(String, String)> = input.headers.into_iter().map(|(k, v)| (k, v.replace(SENTINEL, &secret))).collect();
    let auth_len = substituted.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.len()).unwrap_or(0);

    let out = Out {
        ok: true,
        secret_len: secret.len(),
        authorization_header_len_after_substitution: auth_len,
        dry_run: true,
    };
    serde_json::to_vec(&out).map_err(|e| format!("encode: {e}"))
}
