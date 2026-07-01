// Pull the enclave auth module in verbatim so its `#[cfg(test)] mod tests`
// (SigV4 / Basic / base64 vectors) run natively. Keep this crate dependency-
// identical to the pieces of auth.rs it exercises.
#[path = "../../src/auth.rs"]
pub mod auth;
