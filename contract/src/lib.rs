// Blindfold proxy contract — entrypoint and Guest impl.
//
// SECURITY INVARIANT: the plaintext secret is read from KV inside this
// process (TDX enclave memory), substituted into headers on the stack,
// passed to host::interfaces::http::call, and then dropped. It is never
// returned to the caller, logged, or stored anywhere outside the
// outbound HTTPS request payload.

wit_bindgen::generate!({
    world: "blindfold-proxy",
    path: "wit",
    additional_derives: [serde::Deserialize, serde::Serialize],
    generate_all,
});

mod auth;
mod forward;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::blindfold::contracts::Guest for Component {
    fn forward(req: exports::z::blindfold::contracts::GenericInput) -> Result<Vec<u8>, String> {
        let input = req.input.ok_or("forward: missing input")?;
        forward::forward(&input)
    }
    fn release_to_tenant(req: exports::z::blindfold::contracts::GenericInput) -> Result<Vec<u8>, String> {
        let input = req.input.ok_or("release_to_tenant: missing input")?;
        forward::release_to_tenant(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);
