# Host WIT packages (canonical)

The files under `host-tenant-1.0.0/` and `host-interfaces-2.1.0/` are the
**canonical** WIT packages T3 imports into a tenant contract, provided
verbatim by the T3 dev team (2026-06-25). They replace the earlier
best-effort stubs (`host-tenant/`, `host-interfaces/`), which were inferred
from the public docs and have been deleted.

Packages:

- `host:tenant/tenant-context@1.0.0`
- `host:interfaces/logging@2.1.0`
- `host:interfaces/kv-store@2.1.0`
- `host:interfaces/http@2.1.0`

`wit/world.wit` imports all four (`tenant-context`, `logging`, `kv-store`,
`http`) — the "only four capabilities" least-privilege set documented in the
top-level `README.md`. Unused imports (`http`, `logging` today) are
tree-shaken out of the compiled component and only materialise once
`forward.rs` calls them.

## What changed from the stubs

- **`http.response` has no headers.** Canonical is `{ code: u16, payload:
  list<u8> }`. The stub carried a `headers` field, and that mismatch is what
  caused the contract to fail at instantiation whenever `http` was imported.
- **`http.call` takes a single `request` record** (not positional args); the
  error channel is a bare `string`.
- **`http.verb`** is `{ get, post, put, patch, delete }` (the stub also had
  `head`, in a different order).
- **`tenant-context`** gained `contract-id`, `calling-user-did`,
  `cluster-timestamp-secs`, and `seq-no` alongside `tenant-did`.
- **`kv-store`** gained `put`, `delete`, `set-claims-digest`, and `scan`
  alongside `get`.

## Version pin

Pin `@2.1.0` — that's what the live host links. A `@2.2.0` label may appear
on the canonical file flagging newer additive interfaces; interfaces are
additive, so a `@2.1.0` import resolves against the running host fine. Don't
chase `2.2.0`.

## Runtime note

Tenant HTTP egress is gated by the caller's `agent_auth` grant —
`http.call` returns `Err` unless the target host is authorised for that user
(see `scripts/grant-and-call.ts` / `scripts/grant-egress.ts`). Build +
register succeeding does **not** mean an arbitrary host is reachable; that's
an authorisation outcome, not a stub bug.

`lib.rs` / `forward.rs` did not need to change for this swap.
