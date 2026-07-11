/**
 * Security-feature regression tests (dependency-free, node:test).
 * Covers the layers added in the hardening pass so they can't silently regress:
 *   - per-session proxy token (401 without / 200 with; /health open)
 *   - unix-domain socket mode (0600 perms, routes, cleaned up on close)
 *   - wrap() token-header injection
 *   - attestation gate (opt-in, mock-refuse-when-required, loud bypass)
 *
 * Runs in mock mode (no real Terminal 3 node needed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startProxy } from "../src/proxy.ts";
import { wrap } from "../src/wrap.ts";
import { attestationGate } from "../src/attest.ts";
import { openT3Client } from "../src/t3-client.ts";
import { loadBlindfoldEnv } from "../src/env.ts";

process.env.BLINDFOLD_MOCK = "1";

/** GET over a unix socket, resolving the status code. */
function getOverSocket(socketPath: string, reqPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: reqPath, method: "GET" }, (r) => {
      r.resume();
      resolve(r.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("proxy per-session token: /health open, provider path gated", async () => {
  const h = await startProxy({ port: 0, token: "SECRET_TOK" });
  try {
    assert.equal((await fetch(`${h.url}/health`)).status, 200, "/health is always open");
    assert.equal((await fetch(`${h.url}/v1/models`)).status, 401, "no token → 401");
    assert.equal(
      (await fetch(`${h.url}/v1/models`, { headers: { "x-blindfold-token": "wrong" } })).status,
      401,
      "wrong token → 401",
    );
    assert.equal(
      (await fetch(`${h.url}/v1/models`, { headers: { "x-blindfold-token": "SECRET_TOK" } })).status,
      200,
      "correct token → 200",
    );
  } finally {
    await h.close();
  }
});

test("proxy without --auth stays open (back-compat)", async () => {
  const h = await startProxy({ port: 0 });
  try {
    assert.equal((await fetch(`${h.url}/v1/models`)).status, 200, "no auth configured → open");
  } finally {
    await h.close();
  }
});

test("proxy unix socket: born 0600, routes, no TCP port, cleaned up on close", async () => {
  const sock = path.join(os.tmpdir(), `bf-sec-test-${process.pid}.sock`);
  fs.rmSync(sock, { force: true });
  const h = await startProxy({ socket: sock, token: "STOK" });
  try {
    assert.equal(h.port, 0, "no TCP port bound in socket mode");
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600, "socket file is 0600");
    assert.equal(await getOverSocket(sock, "/health"), 200, "/health over socket");
    assert.equal(await getOverSocket(sock, "/v1/models"), 401, "no token over socket → 401");
  } finally {
    await h.close();
  }
  assert.equal(fs.existsSync(sock), false, "socket removed on close");
});

test("wrap() injects the per-session token header on every request", async () => {
  let seen: string | null = null;
  const client: { fetch?: typeof fetch; baseURL?: string; apiKey?: string } = {
    fetch: (async (_url: unknown, init: { headers?: Record<string, string> } = {}) => {
      seen = new Headers(init.headers).get("x-blindfold-token");
      return new Response("ok");
    }) as unknown as typeof fetch,
  };
  wrap(client, { token: "WRAP_TOK" });
  await client.fetch!("http://localhost/v1/models", {} as RequestInit);
  assert.equal(seen, "WRAP_TOK");
});

test("attestation gate: opt-in, refuses mock when required, loud bypass", async () => {
  delete process.env.BLINDFOLD_REQUIRE_ATTEST;
  // No pin, no REQUIRE → not enforced (back-compat).
  let g = await attestationGate({});
  assert.equal(g.enforced, false);
  assert.equal(g.ok, true);

  // REQUIRE=1 in mock mode → refuse (don't silently no-op).
  process.env.BLINDFOLD_REQUIRE_ATTEST = "1";
  g = await attestationGate({});
  assert.equal(g.enforced, true);
  assert.equal(g.ok, false);

  // --no-attest bypasses, but loudly (warning set) when a gate was in force.
  g = await attestationGate({ skip: true });
  assert.equal(g.enforced, false);
  assert.equal(g.ok, true);
  assert.ok(g.warning && g.warning.length > 0, "bypass emits a warning");

  delete process.env.BLINDFOLD_REQUIRE_ATTEST;
});

test("getBalance returns a well-formed credit balance (mock)", async () => {
  const client = await openT3Client(loadBlindfoldEnv());
  try {
    const b = await client.getBalance();
    assert.equal(typeof b.available, "number");
    assert.equal(typeof b.reserved, "number");
    assert.equal(typeof b.creditExhausted, "boolean");
  } finally {
    await client.close();
  }
});
