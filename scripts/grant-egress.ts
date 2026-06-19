/**
 * Try a bunch of plausible control-plane action names + payload shapes
 * to grant tenant-level egress to a specific host. The right shape will
 * succeed; the wrong ones will get a typed error or "unknown action"
 * that tells us what the canonical name is.
 */
import { loadBlindfoldEnv } from "../packages/blindfold/src/env.ts";

async function main(): Promise<void> {
  const env = loadBlindfoldEnv();
  if (env.mock) { console.log("REAL mode needed."); process.exit(1); }

  const sdk = (await import("@terminal3/t3n-sdk")) as Record<string, unknown> & {
    setEnvironment: (e: string) => void;
    NODE_URLS: Record<string, string>;
    loadWasmComponent: () => Promise<unknown>;
    eth_get_address: (k: string) => string;
    metamask_sign: (a: string, _: undefined, k: string) => unknown;
    createEthAuthInput: (a: string) => unknown;
    T3nClient: new (cfg: unknown) => any;
    TenantClient: new (cfg: unknown) => any;
  };
  sdk.setEnvironment(env.t3Env);
  const baseUrl = sdk.NODE_URLS[env.t3Env];
  const t3n = new sdk.T3nClient({ baseUrl, wasmComponent: await sdk.loadWasmComponent(), handlers: { EthSign: sdk.metamask_sign(sdk.eth_get_address(env.t3nApiKey), undefined, env.t3nApiKey) } });
  await t3n.handshake();
  await t3n.authenticate(sdk.createEthAuthInput(sdk.eth_get_address(env.t3nApiKey)));
  const tenant = new sdk.TenantClient({ environment: env.t3Env, baseUrl, tenantDid: env.did, t3n });

  const host = "httpbin.org";
  const attempts: Array<[string, string, unknown]> = [
    ["executeControl", "grant-set",            { hosts: [host] }],
    ["executeControl", "grant-set",            { allowed_hosts: [host] }],
    ["executeControl", "allowed-hosts-set",    { hosts: [host] }],
    ["executeControl", "egress-allow",         { host }],
    ["executeControl", "egress-grant-set",     { hosts: [host] }],
    ["executeControl", "self-grant-set",       { allowed_hosts: [host] }],
    ["executeControl", "tenant.grant-set",     { allowed_hosts: [host] }],
    ["executeControl", "host-grant-add",       { host }],
    ["executeControl", "authorised-hosts-set", { hosts: [host] }],
    ["executeControl", "authorized-hosts-set", { hosts: [host] }],
    ["executeControl", "policy-set",           { allowed_hosts: [host] }],
    ["executeControl", "set-policy",           { allowed_hosts: [host] }],
    ["executeControl", "user.set-grants",      { allowed_hosts: [host] }],
  ];

  for (const [method, action, payload] of attempts) {
    process.stdout.write(`\n→ ${method}(${JSON.stringify(action)}, ${JSON.stringify(payload).slice(0, 60)})\n`);
    try {
      const r = await (tenant as any)[method](action, payload);
      console.log("  ✅", JSON.stringify(r).slice(0, 300));
      return;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      console.log("  ✖", msg);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
