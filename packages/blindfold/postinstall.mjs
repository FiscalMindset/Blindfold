// Convenience: on a Windows GLOBAL install, npm drops the `blindfold` shim in
// %APPDATA%\npm, but that folder isn't always on PATH — so `blindfold` comes up
// "not recognized". This adds it to the user PATH (idempotent, append-only).
// Windows-only, global-only, and never allowed to fail the install.
import { spawnSync } from "node:child_process";

if (process.platform === "win32" && process.env.npm_config_global === "true") {
  try {
    const ps =
      "$np=$env:APPDATA+'\\npm';" +
      "$p=[Environment]::GetEnvironmentVariable('PATH','User'); if($p -eq $null){$p=''};" +
      "if($p -notlike ('*'+$np+'*')){[Environment]::SetEnvironmentVariable('PATH',($p.TrimEnd(';')+';'+$np),'User');[Console]::Out.Write('ADDED')}else{[Console]::Out.Write('PRESENT')}";
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      { input: ps, encoding: "utf8" });
    if (typeof r.stdout === "string" && r.stdout.includes("ADDED")) {
      console.log("blindfold: added %APPDATA%\\npm to your user PATH. Open a NEW terminal, then run `blindfold login`.");
    }
  } catch {
    /* a PATH convenience must never break the install */
  }
}
