// Blindfold — provider auth schemes computed INSIDE the enclave.
//
// The point of this module: for many real-world APIs the secret is not simply
// pasted into a header — it is *consumed by a computation* (base64 of a
// credential pair, or an HMAC signature chain). Those computations happen here,
// on the stack inside TDX memory, so the raw secret is never placed in any
// value that leaves the enclave. A generic "swap the sentinel" proxy cannot do
// this; it can only handle `Authorization: Bearer <token>`.
//
// This module is deliberately free of any wit/host imports so it compiles and
// unit-tests natively (see contract/auth-tests). Correctness of the SigV4 path
// is proven against AWS's published "get-vanilla" test vector.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/* --------------------------------- base64 -------------------------------- */

/// Standard (RFC 4648) base64, no line breaks. Used for HTTP Basic auth.
pub fn base64_std(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(T[(b0 >> 2) as usize] as char);
        out.push(T[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { T[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(b2 & 0x3f) as usize] as char } else { '=' });
    }
    out
}

/* ----------------------------- HTTP Basic auth --------------------------- */

/// `Authorization: Basic base64(username:secret)`. The username (e.g. a Twilio
/// Account SID) is not secret and travels in as a plain param; only the secret
/// half is sealed. The base64 is computed here so the secret is never sent as a
/// standalone header value.
pub fn basic_auth_header(username: &str, secret: &str) -> String {
    let mut pair = String::with_capacity(username.len() + 1 + secret.len());
    pair.push_str(username);
    pair.push(':');
    pair.push_str(secret);
    format!("Basic {}", base64_std(pair.as_bytes()))
}

/* --------------------------------- SigV4 --------------------------------- */

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

/// SHA-256 hex of a request payload — used to set `x-amz-content-sha256`.
pub fn payload_sha256(data: &[u8]) -> String {
    sha256_hex(data)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// AWS Signature Version 4 derived signing key:
/// kDate=HMAC("AWS4"+secret, date) → kRegion → kService → kSigning.
fn sigv4_signing_key(secret: &str, datestamp: &str, region: &str, service: &str) -> Vec<u8> {
    let k_secret = format!("AWS4{}", secret);
    let k_date = hmac_sha256(k_secret.as_bytes(), datestamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

/// A header to include in the signature. `name` must be lowercase.
pub struct SignedHeader {
    pub name: String,
    pub value: String,
}

pub struct SigV4Params<'a> {
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    pub method: &'a str,
    /// Path portion of the URL, already URI-encoded (e.g. "/" or "/bucket/key").
    pub canonical_uri: &'a str,
    /// Raw query string (without '?'); may be empty. Canonicalised (sorted) here.
    pub query: &'a str,
    pub payload: &'a [u8],
    /// ISO8601 basic, e.g. "20150830T123600Z". Supplied by the caller because
    /// the enclave has no wall clock; the timestamp is not secret.
    pub amz_date: &'a str,
    /// Headers to sign; must include host. Names lowercase.
    pub headers: Vec<SignedHeader>,
}

/// Compute the SigV4 `Authorization` header value. Returns
/// (authorization, payload_sha256_hex). The payload hash is returned so the
/// caller can also set `x-amz-content-sha256` on the outbound request.
pub fn sigv4_authorization(p: &SigV4Params) -> (String, String) {
    let datestamp = &p.amz_date[..8]; // YYYYMMDD

    // 1) Canonical query string: split, sort by encoded key, rejoin.
    let canonical_query = canonicalize_query(p.query);

    // 2) Canonical + signed headers (sorted by lowercase name).
    let mut hdrs: Vec<&SignedHeader> = p.headers.iter().collect();
    hdrs.sort_by(|a, b| a.name.cmp(&b.name));
    let mut canonical_headers = String::new();
    let mut signed_headers = String::new();
    for (i, h) in hdrs.iter().enumerate() {
        canonical_headers.push_str(&h.name);
        canonical_headers.push(':');
        canonical_headers.push_str(h.value.trim());
        canonical_headers.push('\n');
        if i > 0 {
            signed_headers.push(';');
        }
        signed_headers.push_str(&h.name);
    }

    // 3) Payload hash.
    let payload_hash = sha256_hex(p.payload);

    // 4) Canonical request.
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        p.method, p.canonical_uri, canonical_query, canonical_headers, signed_headers, payload_hash
    );

    // 5) String to sign.
    let scope = format!("{}/{}/{}/aws4_request", datestamp, p.region, p.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        p.amz_date,
        scope,
        sha256_hex(canonical_request.as_bytes())
    );

    // 6) Signature.
    let signing_key = sigv4_signing_key(p.secret_access_key, datestamp, p.region, p.service);
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        p.access_key_id, scope, signed_headers, signature
    );
    (authorization, payload_hash)
}

/// Sort query params by key (then value), preserving AWS canonical form. Assumes
/// keys/values are already percent-encoded by the caller.
fn canonicalize_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    let mut pairs: Vec<(&str, &str)> = query
        .split('&')
        .map(|kv| match kv.split_once('=') {
            Some((k, v)) => (k, v),
            None => (kv, ""),
        })
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64_std(b""), "");
        assert_eq!(base64_std(b"f"), "Zg==");
        assert_eq!(base64_std(b"fo"), "Zm8=");
        assert_eq!(base64_std(b"foo"), "Zm9v");
        assert_eq!(base64_std(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn basic_auth_twilio_shape() {
        // AC…SID : token  ->  Basic base64("AC123:tok")
        let h = basic_auth_header("AC123", "tok");
        assert_eq!(h, format!("Basic {}", base64_std(b"AC123:tok")));
        assert!(h.starts_with("Basic "));
    }

    // AWS's published signing-key derivation example.
    // https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
    #[test]
    fn sigv4_signing_key_derivation_vector() {
        let key = sigv4_signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20120215",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            hex::encode(&key),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }

    // AWS SigV4 test suite "get-vanilla": full end-to-end signature.
    // GET / , Host:example.amazonaws.com , X-Amz-Date:20150830T123600Z
    // Credentials AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
    // region us-east-1, service "service".
    #[test]
    fn sigv4_get_vanilla_vector() {
        let p = SigV4Params {
            access_key_id: "AKIDEXAMPLE",
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            region: "us-east-1",
            service: "service",
            method: "GET",
            canonical_uri: "/",
            query: "",
            payload: b"",
            amz_date: "20150830T123600Z",
            headers: vec![
                SignedHeader { name: "host".into(), value: "example.amazonaws.com".into() },
                SignedHeader { name: "x-amz-date".into(), value: "20150830T123600Z".into() },
            ],
        };
        let (auth, payload_hash) = sigv4_authorization(&p);
        assert_eq!(
            payload_hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
SignedHeaders=host;x-amz-date, \
Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }
}
