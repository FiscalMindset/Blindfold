/**
 * OS keychain storage for the tenant key (T3N_API_KEY).
 *
 * v0.2 stored the tenant key in ~/.blindfold/config.json (0600). That's a
 * plaintext file a prompt-injected agent could read — the residual risk. v0.3
 * moves it into the OS keychain so it isn't a readable file at all:
 *   - macOS  → `security` (Keychain)
 *   - Linux  → `secret-tool` (libsecret / GNOME Keyring)
 *   - other  → not available; callers fall back to the 0600 file.
 *
 * Dependency-free by design (shells out to the platform tool), matching the
 * rest of Blindfold. The secret is keyed by tenant DID so multiple tenants can
 * coexist. Values are never logged.
 */
import { spawnSync } from "node:child_process";

const SERVICE = "blindfold";

function has(cmd: string): boolean {
  // `which` is an executable on macOS/Linux — avoids shell:true (deprecated).
  const r = spawnSync("which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

/** True if an OS keychain backend is usable on this machine. */
export function keychainAvailable(): boolean {
  if (process.platform === "darwin") return has("security");
  if (process.platform === "linux") return has("secret-tool");
  return false;
}

/** Human-readable name of the active backend (for `whoami`). */
export function keychainBackend(): string {
  if (process.platform === "darwin") return "macOS Keychain";
  if (process.platform === "linux") return "libsecret (secret-tool)";
  return "none";
}

/** Store `secret` under the tenant `account` (DID). Returns true on success. */
export function keychainSet(account: string, secret: string): boolean {
  if (process.platform === "darwin") {
    // -U updates an existing item. Note: -w passes the secret in argv, briefly
    // visible to `ps`; acceptable for a local one-time login, and far better
    // than a persistent plaintext file.
    const r = spawnSync("security", ["add-generic-password", "-a", account, "-s", SERVICE, "-w", secret, "-U"], { stdio: "ignore" });
    return r.status === 0;
  }
  if (process.platform === "linux") {
    // secret-tool reads the secret from stdin — no argv exposure.
    const r = spawnSync("secret-tool", ["store", "--label=blindfold", "service", SERVICE, "account", account], { input: secret, stdio: ["pipe", "ignore", "ignore"] });
    return r.status === 0;
  }
  return false;
}

/** Retrieve the secret for tenant `account` (DID), or null if absent. */
export function keychainGet(account: string): string | null {
  if (process.platform === "darwin") {
    const r = spawnSync("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"], { encoding: "utf8" });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout.replace(/\n$/, "");
    return null;
  }
  if (process.platform === "linux") {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout.replace(/\n$/, "");
    return null;
  }
  return null;
}

/** Remove the stored secret for tenant `account` (DID). */
export function keychainDelete(account: string): boolean {
  if (process.platform === "darwin") {
    const r = spawnSync("security", ["delete-generic-password", "-a", account, "-s", SERVICE], { stdio: "ignore" });
    return r.status === 0;
  }
  if (process.platform === "linux") {
    const r = spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { stdio: "ignore" });
    return r.status === 0;
  }
  return false;
}
