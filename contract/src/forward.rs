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
    /// Provider auth scheme. Defaults to bearer (back-compatible sentinel swap).
    #[serde(default)]
    auth: AuthSpec,
    /// If true, do not make the outbound call — just prove the substitution.
    #[serde(default)]
    dry_run: bool,
}

/// How the sealed secret is turned into an outbound `Authorization` for a given
/// provider. `bearer` is the historical path (blind sentinel replace); `basic`
/// and `sigv4` *consume* the secret in a computation done inside the enclave —
/// the raw secret is never placed in a header value on its own.
#[derive(Deserialize)]
#[serde(tag = "scheme", rename_all = "lowercase")]
enum AuthSpec {
    /// `Authorization: Bearer __BLINDFOLD__` → sentinel replaced with secret.
    Bearer,
    /// HTTP Basic: `base64(username:secret)`. Username (e.g. Twilio SID) is not
    /// secret and arrives as a plain param.
    Basic { username: String },
    /// AWS Signature Version 4. The secret access key signs the request; it is
    /// never transmitted. `amz_date` (YYYYMMDDTHHMMSSZ) is supplied by the
    /// caller because the enclave has no wall clock — the timestamp is public.
    Sigv4 {
        access_key_id: String,
        region: String,
        service: String,
        amz_date: String,
    },
}

impl Default for AuthSpec {
    fn default() -> Self {
        AuthSpec::Bearer
    }
}

fn default_method() -> String { "GET".to_string() }

/// Split `https://host/path?query` into (host, path, query). Path defaults to
/// "/", query may be empty.
fn split_url(url: &str) -> Result<(String, String, String), String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or("url must be http(s)")?;
    let (host, path_query) = match rest.split_once('/') {
        Some((h, r)) => (h.to_string(), format!("/{}", r)),
        None => (rest.to_string(), "/".to_string()),
    };
    let (path, query) = match path_query.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (path_query, String::new()),
    };
    Ok((host, path, query))
}

/// Build the outbound header set for the requested auth scheme. The secret is
/// consumed here and never returned to the caller.
fn build_headers(input: &ForwardInput, secret: &str) -> Result<Vec<(String, String)>, String> {
    match &input.auth {
        AuthSpec::Bearer => Ok(input
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.replace(SENTINEL, secret)))
            .collect()),

        AuthSpec::Basic { username } => {
            // Drop any client-supplied Authorization; the enclave sets it.
            let mut headers: Vec<(String, String)> = input
                .headers
                .iter()
                .filter(|(k, _)| !k.eq_ignore_ascii_case("authorization"))
                .cloned()
                .collect();
            headers.push(("authorization".into(), crate::auth::basic_auth_header(username, secret)));
            Ok(headers)
        }

        AuthSpec::Sigv4 { access_key_id, region, service, amz_date } => {
            let (host, path, query) = split_url(&input.url)?;
            let payload = input.body.as_deref().unwrap_or("").as_bytes();
            let payload_hash = crate::auth::payload_sha256(payload);

            let signed = vec![
                crate::auth::SignedHeader { name: "host".into(), value: host.clone() },
                crate::auth::SignedHeader { name: "x-amz-date".into(), value: amz_date.clone() },
                crate::auth::SignedHeader { name: "x-amz-content-sha256".into(), value: payload_hash.clone() },
            ];
            let params = crate::auth::SigV4Params {
                access_key_id,
                secret_access_key: secret,
                region,
                service,
                method: &input.method,
                canonical_uri: &path,
                query: &query,
                payload,
                amz_date,
                headers: signed,
            };
            let (authorization, _) = crate::auth::sigv4_authorization(&params);

            // Pass through any non-auth headers the caller set, then add the
            // AWS-required signed headers + Authorization.
            let mut headers: Vec<(String, String)> = input
                .headers
                .iter()
                .filter(|(k, _)| {
                    let k = k.to_ascii_lowercase();
                    k != "authorization" && k != "x-amz-date" && k != "x-amz-content-sha256" && k != "host"
                })
                .cloned()
                .collect();
            headers.push(("x-amz-date".into(), amz_date.clone()));
            headers.push(("x-amz-content-sha256".into(), payload_hash));
            headers.push(("authorization".into(), authorization));
            Ok(headers)
        }
    }
}

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

    // Read the sealed secret from enclave KV and build the outbound headers for
    // the requested provider auth scheme. `secret` is dropped at end of scope.
    let secret = read_secret(&input.secret_key)?;
    let substituted = build_headers(&input, &secret)?;

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
        url: input.url.clone(),
        headers: Some(substituted),
        payload: input.body.clone().map(|b| b.into_bytes()),
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
