/**
 * OS keychain storage for the tenant key (T3N_API_KEY).
 *
 * v0.2 stored the tenant key in ~/.blindfold/config.json (0600). That's a
 * plaintext file a prompt-injected agent could read — the residual risk. v0.3+
 * moves it into the OS credential store so it isn't a readable file at all:
 *   - macOS   → `security` (Keychain)
 *   - Linux   → `secret-tool` (libsecret / GNOME Keyring)
 *   - Windows → PowerShell + Win32 Credential Manager (advapi32 Cred*)
 *   - other   → not available; callers fall back to the 0600 file.
 *
 * Dependency-free by design (shells out to the platform tool), matching the
 * rest of Blindfold. The secret is keyed by tenant DID so multiple tenants can
 * coexist. Values are never logged, and are passed to child processes via env
 * or stdin (never argv) wherever the platform tool allows.
 */
import { spawnSync } from "node:child_process";

const SERVICE = "blindfold";
const isWin = process.platform === "win32";

function has(cmd: string): boolean {
  const finder = isWin ? "where" : "which";
  const r = spawnSync(finder, [cmd], { stdio: "ignore" });
  return r.status === 0;
}

/* -------------------- Windows Credential Manager (advapi32) --------------- */
// A tiny C# shim compiled by Add-Type, calling CredWriteW/CredReadW/CredDeleteW.
// The secret + target are passed via environment (BF_SECRET/BF_TARGET), never
// on the command line.
const WIN_CS = `
using System;
using System.Runtime.InteropServices;
public static class BFCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWriteW(ref CREDENTIAL c, UInt32 f);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredReadW(string t, UInt32 ty, UInt32 f, out IntPtr c);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDeleteW(string t, UInt32 ty, UInt32 f);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
}
`;

const PS_HEADER = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @"\n${WIN_CS}\n"@\n`;

function winPS(op: "set" | "get" | "delete", target: string, secret?: string): { status: number | null; stdout: string } {
  let body: string;
  if (op === "set") {
    body =
      `$b=[System.Text.Encoding]::UTF8.GetBytes($env:BF_SECRET);` +
      `$p=[Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length);` +
      `[Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length);` +
      `$c=New-Object BFCred+CREDENTIAL;$c.Type=1;$c.TargetName=$env:BF_TARGET;$c.UserName=$env:BF_TARGET;` +
      `$c.CredentialBlobSize=$b.Length;$c.CredentialBlob=$p;$c.Persist=2;` +
      `$ok=[BFCred]::CredWriteW([ref]$c,0);[Runtime.InteropServices.Marshal]::FreeHGlobal($p);if($ok){[Console]::Out.Write('BFOK')}`;
  } else if (op === "get") {
    body =
      `$ptr=[IntPtr]::Zero;` +
      `if([BFCred]::CredReadW($env:BF_TARGET,1,0,[ref]$ptr)){` +
      `$c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[BFCred+CREDENTIAL]);` +
      `$n=[int]$c.CredentialBlobSize;$b=New-Object byte[] $n;` +
      `[Runtime.InteropServices.Marshal]::Copy([IntPtr]$c.CredentialBlob,$b,0,$n);[BFCred]::CredFree($ptr);` +
      `[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))}else{exit 1}`;
  } else {
    body = `if([BFCred]::CredDeleteW($env:BF_TARGET,1,0)){[Console]::Out.Write('BFOK')}`;
  }
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BF_TARGET: target };
  if (secret !== undefined) env.BF_SECRET = secret;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
    { input: PS_HEADER + body, env, encoding: "utf8" });
  return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "" };
}

function winTarget(account: string): string {
  return `${SERVICE}:${account}`;
}

/* ------------------------------------------------------------------------- */

/** True if an OS credential store is usable on this machine. */
export function keychainAvailable(): boolean {
  if (process.platform === "darwin") return has("security");
  if (process.platform === "linux") return has("secret-tool");
  if (isWin) return has("powershell");
  return false;
}

/** Human-readable name of the active backend (for `whoami`). */
export function keychainBackend(): string {
  if (process.platform === "darwin") return "macOS Keychain";
  if (process.platform === "linux") return "libsecret (secret-tool)";
  if (isWin) return "Windows Credential Manager";
  return "none";
}

/** Store `secret` under the tenant `account` (DID). Returns true on success. */
export function keychainSet(account: string, secret: string): boolean {
  if (process.platform === "darwin") {
    const r = spawnSync("security", ["add-generic-password", "-a", account, "-s", SERVICE, "-w", secret, "-U"], { stdio: "ignore" });
    return r.status === 0;
  }
  if (process.platform === "linux") {
    const r = spawnSync("secret-tool", ["store", "--label=blindfold", "service", SERVICE, "account", account], { input: secret, stdio: ["pipe", "ignore", "ignore"] });
    return r.status === 0;
  }
  // Status codes over piped PowerShell are unreliable; use an explicit stdout
  // marker. (Fails with err 1312 in a non-interactive session — e.g. over SSH —
  // where the Credential Manager isn't available; caller falls back to a file.)
  if (isWin) return winPS("set", winTarget(account), secret).stdout.includes("BFOK");
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
  if (isWin) {
    const r = winPS("get", winTarget(account));
    if (r.status === 0 && r.stdout) return r.stdout.replace(/\r?\n$/, "");
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
  if (isWin) return winPS("delete", winTarget(account)).stdout.includes("BFOK");
  return false;
}
