# Host WIT stubs

The files under `host-tenant/` and `host-interfaces/` are **best-effort
reconstructions** of the WIT packages T3 imports into a tenant contract:

- `host:tenant/tenant-context@1.0.0`
- `host:interfaces/logging@2.1.0`
- `host:interfaces/kv-store@2.1.0`
- `host:interfaces/http@2.1.0`

They were authored from the public T3 docs (the verbatim Rust snippets in
the "write your TEE contract" walkthrough plus the http-with-placeholders /
seed-api-key tips). The signatures are inferred from the *usage* shown
there — they have not been published by T3 as a canonical package.

**They are good enough to make `cargo build --target wasm32-wasip2 --release`
succeed locally.** If T3's actual host interface signatures differ from
these stubs, the on-chain `tenant.contracts.register` call will either
fail with a type-mismatch error or the published contract will fail at
execution time with a wit/component-model error.

When T3 publishes the canonical host WIT files (or a cargo/npm package
that vendors them), replace these stubs with the official ones and
rebuild. The contract's `lib.rs` / `forward.rs` will not need to change.

> If you find the canonical source, please open a PR replacing these
> stubs and update this README + `explain.md`'s NEEDS VERIFICATION list.
