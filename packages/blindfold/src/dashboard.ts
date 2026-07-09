/**
 * Blindfold usage dashboard.
 *
 *   blindfold dashboard --port 8799
 *
 * Self-contained HTTP server + inline HTML. Shows:
 *
 *  - System status         (REAL/MOCK, tenant DID, T3 env, contract ver)
 *  - Sealed keys           (metadata only — name, byte-len, where, when)
 *  - Audit warnings        (sealed keys ALSO present in .env = leak surface)
 *  - Traffic counters      (total, by provider, success rate, latency)
 *  - Per-secret usage      (which sealed keys are being released most)
 *  - Recent activity       (last 50 requests with method, path, status)
 *  - Time-series           (requests-per-minute, last 60 min)
 *
 * Inherits the privacy property: it can only render what was logged,
 * and what was logged is metadata only.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION, DEFAULT_DASHBOARD_PORT } from "./constants.ts";
import { defaultEnvPath, loadBlindfoldEnv } from "./env.ts";
import { clearUsage, defaultLogPath, readUsage, readUsageTail } from "./usage-log.ts";
import { defaultSealedLogPath, readSealed, verifyLedgerChain } from "./sealed-ledger.ts";

export interface DashboardHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startDashboard(opts: { port?: number } = {}): Promise<DashboardHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;

  // Optional access token (BLINDFOLD_DASHBOARD_TOKEN). The server binds to
  // 127.0.0.1 regardless; this adds a guard if you tunnel/forward the port.
  const TOKEN = process.env.BLINDFOLD_DASHBOARD_TOKEN || "";
  const tokenEq = (candidate: string): boolean => {
    // Constant-time compare so the token can't be recovered by timing.
    const a = Buffer.from(candidate);
    const b = Buffer.from(TOKEN);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const authed = (req: http.IncomingMessage, url: string): boolean => {
    if (!TOKEN) return true;
    // Prefer the Authorization header (query strings leak into logs/history).
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ") && tokenEq(auth.slice(7))) return true;
    try {
      const t = new URL(url, "http://x").searchParams.get("token");
      if (t && tokenEq(t)) return true;
    } catch { /* ignore */ }
    return false;
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    if (!authed(req, url)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized — append ?token=<BLINDFOLD_DASHBOARD_TOKEN>");
      return;
    }

    if (req.method === "GET" && pathname === "/logo.png") {
      try {
        const HERE = path.dirname(fileURLToPath(import.meta.url));
        const logo = path.resolve(HERE, "..", "..", "..", "assets", "logo.png");
        const buf = fs.readFileSync(logo);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
        res.end(buf);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" }).end("logo not found");
      }
      return;
    }
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    if (req.method === "GET" && pathname === "/api/events") {
      // Serve only a bounded tail (not the whole log) so a polled dashboard
      // never loads a multi-hundred-MB file into memory on every refresh.
      const limit = Math.min(Number(new URL(url, "http://x").searchParams.get("limit")) || 500, 5000);
      const events = readUsageTail(limit);
      const counters: Record<string, number> = {};
      for (const e of events) counters[e.provider] = (counters[e.provider] ?? 0) + 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events, counters, returned: events.length, source: defaultLogPath() }));
      return;
    }
    if (req.method === "GET" && pathname === "/api/sealed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entries: readSealed(), source: defaultSealedLogPath() }));
      return;
    }
    if (req.method === "GET" && pathname === "/api/stream") {
      // Server-Sent Events: push a "change" whenever the logs change, so the
      // UI updates near-instantly instead of only on the poll interval.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      const send = () => { try { res.write("event: change\ndata: {}\n\n"); } catch { /* closed */ } };
      const watchers: fs.FSWatcher[] = [];
      for (const p of [defaultLogPath(), defaultSealedLogPath()]) {
        try { watchers.push(fs.watch(path.dirname(p), () => send())); } catch { /* dir missing */ }
      }
      const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 15000);
      req.on("close", () => { clearInterval(hb); for (const w of watchers) { try { w.close(); } catch { /* ignore */ } } });
      return;
    }
    if (req.method === "GET" && pathname === "/api/audit/full") {
      // Slow path (live T3 calls) — only hit on demand from the UI button.
      const env = loadBlindfoldEnv();
      const sealed = readSealed();
      const latest = new Map<string, (typeof sealed)[number]>();
      for (const s of sealed) latest.set(s.name, s);
      const results: Array<Record<string, unknown>> = [];
      if (!env.mock) {
        try {
          const { openT3Client } = await import("./t3-client.ts");
          const client = await openT3Client(env);
          try {
            for (const e of latest.values()) {
              const v = await client.verifySecret(e.name);
              results.push({ name: e.name, present: v.present, enclave_len: v.length, ledger_len: e.length, fingerprint: v.fingerprint, ok: v.present && v.length === e.length });
            }
          } finally { await client.close(); }
        } catch (err) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ mock: env.mock, error: (err as Error).message, results: [] }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mock: env.mock, results }));
      return;
    }
    if (req.method === "GET" && pathname === "/api/status") {
      const env = loadBlindfoldEnv();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        mode: env.mock ? "mock" : "real",
        tenant_did: env.did || null,
        tenant_did_short: env.did ? shortenDid(env.did) : null,
        t3_env: env.t3Env,
        contract_version: CONTRACT_VERSION,
        proxy_port: env.port,
        sdk_installed: isSdkInstalled(),
      }));
      return;
    }
    if (req.method === "GET" && pathname === "/api/audit") {
      const sealed = readSealed();
      const envKeys = new Set(readEnvKeyNames());
      // Single pass: keep the latest entry per name (entries are append-order).
      const latestByName = new Map<string, typeof sealed[number]>();
      for (const s of sealed) latestByName.set(s.name, s);
      const exposed = Array.from(latestByName.values())
        .filter((latest) => envKeys.has(latest.name))
        .map((latest) => ({ name: latest.name, length: latest.length, sealed_at: latest.t }));
      const uniqueSealed = latestByName.size;
      const chain = verifyLedgerChain();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        exposed_in_env: exposed,
        env_keys: Array.from(envKeys),
        sealed_count: uniqueSealed,
        ledger_chain: chain, // { ok, total, legacy, firstBrokenIndex }
      }));
      return;
    }
    if ((req.method === "POST" || req.method === "DELETE") && pathname === "/api/clear") {
      clearUsage();
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return await new Promise<DashboardHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${bound}`,
        port: bound,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function shortenDid(did: string): string {
  const prefix = "did:t3n:";
  if (!did.startsWith(prefix)) return did;
  const tail = did.slice(prefix.length);
  return tail.length <= 14 ? did : `${prefix}${tail.slice(0, 6)}…${tail.slice(-4)}`;
}

function readEnvKeyNames(): string[] {
  const ENV_PATH = defaultEnvPath();
  if (!fs.existsSync(ENV_PATH)) return [];
  return fs.readFileSync(ENV_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.split("=", 1)[0]?.trim() ?? "")
    .filter(Boolean);
}

function isSdkInstalled(): boolean {
  try {
    require.resolve?.("@terminal3/t3n-sdk");
    return true;
  } catch {
    try {
      const HERE = path.dirname(fileURLToPath(import.meta.url));
      return fs.existsSync(path.resolve(HERE, "..", "..", "..", "node_modules", "@terminal3", "t3n-sdk"));
    } catch {
      return false;
    }
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>Blindfold — Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" href="/logo.png" />
<style>
  :root {
    --bg:#0b0e14; --bg2:#0e1117; --card:#161b22; --card2:#1c2230; --line:#2a313c;
    --fg:#e6edf3; --dim:#8b949e; --dim2:#6b7280;
    --ok:#3fb950; --warn:#d29922; --bad:#f85149; --info:#58a6ff;
    --accent:#8b5cf6; --accent2:#58a6ff;
    --orange:#ff8c2b; --orange2:#ff6a3d; --brand:#ff8c2b;
    --c1:#8b5cf6; --c2:#58a6ff; --c3:#3fb950; --c4:#ff8c2b; --c5:#f85149; --c6:#ff7b72; --c7:#39c5cf; --c8:#f778ba;
    --line:#333b47; --line-strong:#465061;
    --shadow:0 1px 3px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.18);
  }
  [data-theme="light"] {
    --bg:#f6f8fa; --bg2:#fff; --card:#fff; --card2:#f3f4f6; --line:#d8dee4; --line-strong:#c2cad3;
    --fg:#1f2328; --dim:#57606a; --dim2:#8b949e;
    --shadow:0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.06);
  }
  * { box-sizing:border-box; }
  html,body { max-width:100vw; overflow-x:hidden; }
  body {
    margin:0; padding:20px clamp(12px,4vw,40px);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Inter",system-ui,sans-serif;
    background:radial-gradient(1200px 600px at 20% -10%, rgba(139,92,246,.10), transparent 60%), var(--bg);
    color:var(--fg); line-height:1.5; transition:background .2s,color .2s;
  }
  a { color:var(--accent2); }
  .topbar { display:flex; justify-content:space-between; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:18px;
    border:1px solid var(--line-strong); border-radius:16px; padding:16px 20px;
    background:linear-gradient(180deg,var(--card),var(--card2)); box-shadow:var(--shadow); }
  .brandwrap { display:flex; align-items:center; gap:16px; min-width:0; }
  .logo-img { width:clamp(76px,11vw,104px); height:clamp(76px,11vw,104px); border-radius:18px; object-fit:cover; background:var(--card); border:1px solid var(--line-strong); padding:0; box-shadow:var(--shadow); flex:none; animation:logoIn .6s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes logoIn { from{transform:scale(.7) rotate(-8deg);opacity:0;} to{transform:scale(1) rotate(0);opacity:1;} }
  h1 { margin:0; font-size:clamp(24px,4.5vw,34px); font-weight:800; letter-spacing:-.5px; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  /* wordmark: ribbon-wrap animation — pure CSS, no runtime deps */
  .brand { position:relative; display:inline-block; padding-bottom:6px; overflow:hidden; }
  .brand::after { content:""; position:absolute; left:0; bottom:0; height:3px; width:100%; background:linear-gradient(90deg,var(--orange),var(--orange2)); border-radius:3px; transform-origin:left; transform:scaleX(0); opacity:0; animation:underlineIn .5s 2.2s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes underlineIn { from{transform:scaleX(0);opacity:.3;} to{transform:scaleX(1);opacity:1;} }
  .letter { display:inline-block; position:relative; z-index:1; color:var(--fg); text-shadow:none; animation:protectLetter .35s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes protectLetter { to{ color:#bdc7d4; text-shadow:0 1px 4px rgba(139,92,246,.12); transform:translateY(-0.5px); } }
  [data-theme="light"] .letter { animation:protectLetterLight .35s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes protectLetterLight { to{ color:#5a6478; text-shadow:0 1px 4px rgba(139,92,246,.10); transform:translateY(-0.5px); } }
  .brand > .letter:nth-of-type(5) { animation-delay:0.90s; } .brand > .letter:nth-of-type(4) { animation-delay:0.94s; }
  .brand > .letter:nth-of-type(6) { animation-delay:0.98s; } .brand > .letter:nth-of-type(3) { animation-delay:1.02s; }
  .brand > .letter:nth-of-type(7) { animation-delay:1.06s; } .brand > .letter:nth-of-type(2) { animation-delay:1.10s; }
  .brand > .letter:nth-of-type(8) { animation-delay:1.14s; } .brand > .letter:nth-of-type(1) { animation-delay:1.18s; }
  .brand > .letter:nth-of-type(9) { animation-delay:1.22s; }
  .ribbon { position:absolute; top:-25%; height:150%; width:55%; background:linear-gradient(180deg, rgba(50,54,62,0) 0%, rgba(38,42,50,.6) 12%, rgba(28,30,38,.92) 32%, rgba(22,24,30,1) 48%, rgba(28,30,38,.92) 64%, rgba(38,42,50,.6) 84%, rgba(50,54,62,0) 100%); border-radius:4px; z-index:2; pointer-events:none; will-change:transform; transform-origin:left center; animation:ribbonSweep 1.0s .5s cubic-bezier(.65,0,.35,1) both, ribbonSettle .7s 1.5s cubic-bezier(.34,1.56,.64,1) both, ribbonBreeze 3s 2.2s ease-in-out infinite; }
  @keyframes ribbonSweep { 0%{ transform:translateX(100%) scaleX(.01); } 100%{ transform:translateX(22%) scaleX(1); } }
  @keyframes ribbonSettle { 0%{ transform:translateX(22%) scaleX(1); } 100%{ transform:translateX(-6%) scaleX(.65) rotate(-1.5deg); } }
  @keyframes ribbonBreeze { 0%,100%{ transform:translateX(-6%) scaleX(.65) rotate(-1.5deg); } 50%{ transform:translateX(-4%) scaleX(.68) rotate(.8deg); } }
  @keyframes logoSeal { 0%{ filter:brightness(1) saturate(1); } 25%{ filter:brightness(1.06) saturate(1.1); box-shadow:0 0 0 1px rgba(139,92,246,.15); } 60%{ filter:brightness(1.03) saturate(1.05); } 100%{ filter:brightness(1) saturate(1); } }
  .logo-img { animation:logoIn .6s cubic-bezier(.2,.8,.2,1) both, logoSeal 2.2s .6s ease both; }
  .eyebrow { font-size:.42em; font-weight:600; color:var(--dim); text-transform:uppercase; letter-spacing:1.5px; }
  .tagline { font-size:12px; color:var(--dim); margin-top:7px; display:flex; align-items:center; gap:6px; }
  .tagline .lock { color:var(--orange); display:inline-block; animation:clack .5s .45s cubic-bezier(.3,1.4,.5,1) both; }
  @keyframes clack { from{transform:rotate(-35deg) translateY(-2px);opacity:0;} to{transform:rotate(0) translateY(0);opacity:1;} }
  /* --- Distinctive "decrypt → seal" wordmark animation (JS-driven) --- */
  .letter.scrambling { color:var(--accent); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; opacity:.92; }
  .letter.sealed { animation:sealSnap .55s cubic-bezier(.2,1.4,.4,1) both; }
  @keyframes sealSnap {
    0%   { color:var(--accent); text-shadow:0 0 14px rgba(139,92,246,.95),0 0 4px rgba(139,92,246,.8); transform:translateY(-3px) scale(1.18); }
    55%  { color:var(--fg);     text-shadow:0 0 8px rgba(139,92,246,.5);  transform:translateY(1px)  scale(.97);  }
    100% { color:var(--fg);     text-shadow:none; transform:none; }
  }
  /* seal sweep: a vertical light bar that passes across the word once as it seals */
  .sealbar { position:absolute; top:-22%; height:144%; width:16px; left:-8%; z-index:3; pointer-events:none; border-radius:9px; opacity:0;
    background:linear-gradient(90deg,transparent, rgba(139,92,246,.55) 45%, rgba(88,166,255,.35) 60%, transparent); filter:blur(2px); }
  .sealbar.run { animation:sealSweep 1.15s cubic-bezier(.5,0,.3,1) both; }
  @keyframes sealSweep { 0%{ left:-8%; opacity:0;} 12%{opacity:1;} 86%{opacity:1;} 100%{ left:104%; opacity:0;} }
  @media (prefers-reduced-motion:reduce){ .logo-img,.letter,.ribbon,.brand::after,.tagline .lock,.sealbar{ animation:none!important; } .ribbon,.sealbar{ display:none; } .letter{ color:var(--fg)!important; transform:none!important; text-shadow:none!important; } .brand::after{ transform:scaleX(1)!important; opacity:1!important; } }
  .tagline b { color:var(--fg); font-weight:600; }
  .tags { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center; }
  .tag { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--dim); background:var(--card); border:1px solid var(--line); border-radius:20px; padding:3px 10px; max-width:100%; }
  .tag.live { color:var(--ok); border-color:rgba(63,185,80,.45); background:rgba(63,185,80,.08); font-weight:600; }
  .tag.orange { color:var(--orange); border-color:rgba(255,140,43,.45); background:rgba(255,140,43,.08); }
  .tag.path { color:var(--dim); }
  .tag.path code { background:none; padding:0; max-width:min(52vw,420px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-block; vertical-align:bottom; }
  .live-dot { width:7px; height:7px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 0 rgba(63,185,80,.6); animation:pulse 2s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(63,185,80,.5);} 70%{box-shadow:0 0 0 6px rgba(63,185,80,0);} 100%{box-shadow:0 0 0 0 rgba(63,185,80,0);} }
  .controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .controls label { font-size:12px; color:var(--dim); display:flex; align-items:center; gap:4px; }
  select,button { background:var(--card); color:var(--fg); border:1px solid var(--line-strong); border-radius:8px; padding:6px 10px; font-size:12px; cursor:pointer; transition:border-color .15s,background .15s,transform .05s; }
  button:hover,select:hover { border-color:var(--orange); color:var(--orange); }
  button:active { transform:translateY(1px); }
  .copybtn { background:transparent; border:1px solid var(--line); border-radius:6px; padding:2px 9px; font-size:11px; cursor:pointer; color:var(--dim); transition:border-color .15s,color .15s; }
  .copybtn:hover { border-color:var(--orange); color:var(--orange); }
  .copybtn.done { color:var(--ok); border-color:var(--ok); }
  .copybtn.err { color:var(--bad); border-color:var(--bad); }
  .copybtn.ref { color:var(--orange); border-color:rgba(255,140,43,.4); }
  .copybtn.ref:hover { background:rgba(255,140,43,.08); }
  code.sentinel { color:var(--orange); background:rgba(255,140,43,.10); border:1px solid rgba(255,140,43,.22); font-weight:600; }
  .cmdname { color:var(--accent2); font-weight:600; }
  @media (max-width:620px){
    .topbar { flex-direction:column; align-items:stretch; }
    .controls { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .controls label { width:100%; }
    .controls label select { flex:1; width:100%; }
    .controls > button { width:100%; }
  }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); margin-bottom:14px; }
  .two-col { display:grid; gap:12px; grid-template-columns:1fr 1fr; margin-bottom:4px; }
  @media (max-width:860px){ .two-col{ grid-template-columns:1fr; } }
  .card {
    background:linear-gradient(180deg,var(--card),var(--card2)); border:1px solid var(--line);
    border-radius:12px; padding:14px 16px; min-width:0; box-shadow:var(--shadow); position:relative; overflow:hidden;
    transition:transform .18s cubic-bezier(.2,.8,.2,1), border-color .18s, box-shadow .18s;
  }
  .card:hover { transform:translateY(-3px); border-color:var(--line-strong); box-shadow:0 6px 22px rgba(0,0,0,.28), 0 0 0 1px rgba(139,92,246,.08); }
  /* KPI cards get a soft accent glow that brightens on hover */
  .card.kpi::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--kpi,var(--accent)); box-shadow:0 0 12px var(--kpi,var(--accent)); opacity:.55; transition:opacity .18s; }
  .card.kpi:hover::before { opacity:1; }
  .card .label { font-size:10.5px; color:var(--dim); text-transform:uppercase; letter-spacing:.6px; display:flex; align-items:center; gap:5px; }
  .card .value { font-size:clamp(20px,3.5vw,26px); font-weight:700; margin-top:5px; overflow-wrap:anywhere; }
  .card .sub2 { font-size:11.5px; color:var(--dim); margin-top:3px; overflow-wrap:anywhere; }
  .trend { font-size:11px; font-weight:600; padding:1px 6px; border-radius:20px; margin-left:6px; }
  .trend.up { color:var(--ok); background:rgba(63,185,80,.12); }
  .trend.down { color:var(--bad); background:rgba(248,81,73,.12); }
  .trend.flat { color:var(--dim); background:rgba(139,148,158,.12); }
  .section-title { font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:.6px; margin:22px 0 8px; display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
  .section-title .chev { transition:transform .15s; font-size:9px; color:var(--dim2); }
  .section-title.collapsed .chev { transform:rotate(-90deg); }
  .collapsed + * , .collapsed + * + * { display:none !important; }
  .scroll { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow-x:auto; -webkit-overflow-scrolling:touch; box-shadow:var(--shadow); }
  table { width:100%; border-collapse:collapse; min-width:520px; }
  th,td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  th { color:var(--dim); font-weight:600; text-transform:uppercase; font-size:10.5px; letter-spacing:.5px; white-space:nowrap; cursor:pointer; }
  th:hover { color:var(--fg); }
  tr:last-child td { border-bottom:none; }
  tbody tr:hover { background:rgba(139,92,246,.05); }
  code { background:rgba(127,127,127,.12); padding:2px 5px; border-radius:4px; font-size:12px; overflow-wrap:anywhere; }
  .pill { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600; }
  .pill-ok{background:rgba(63,185,80,.15);color:var(--ok);} .pill-bad{background:rgba(248,81,73,.15);color:var(--bad);}
  .pill-warn{background:rgba(210,153,34,.15);color:var(--warn);} .pill-info{background:rgba(88,166,255,.15);color:var(--info);}
  .pill-mock{background:rgba(139,92,246,.15);color:var(--accent);} .pill-real{background:rgba(63,185,80,.15);color:var(--ok);}
  .pill-dim{background:rgba(127,127,127,.12);color:var(--dim);}
  .empty { background:var(--card); border:1px dashed var(--line); border-radius:12px; padding:22px; text-align:center; color:var(--dim); }
  .alert { border-radius:12px; padding:12px 16px; margin-bottom:14px; border:1px solid; box-shadow:var(--shadow); }
  .alert .head { font-weight:700; margin-bottom:4px; }
  .alert.ok { background:rgba(63,185,80,.07); border-color:rgba(63,185,80,.3); color:var(--ok); }
  .footer { margin-top:24px; padding:14px 16px; background:var(--card); border:1px solid var(--line); border-radius:12px; font-size:12px; color:var(--dim); }
  .footer b { color:var(--fg); }
  /* donut + legend */
  .donut-wrap { display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  .legend { display:flex; flex-direction:column; gap:5px; font-size:12px; flex:1; min-width:120px; }
  .legend .li { display:flex; align-items:center; gap:7px; cursor:default; }
  .legend .dot { width:10px; height:10px; border-radius:3px; flex:none; }
  .legend .li .n { margin-left:auto; color:var(--dim); }
  /* segmented bar */
  .segbar { display:flex; height:22px; border-radius:7px; overflow:hidden; background:rgba(127,127,127,.1); }
  .segbar > div { transition:width .3s; }
  /* horizontal bars */
  .bar-row { display:flex; align-items:center; gap:8px; margin:7px 0; font-size:12px; }
  .bar-row .name { width:120px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar-row .track { flex:1; background:rgba(127,127,127,.1); border-radius:5px; height:16px; overflow:hidden; }
  .bar-row .fill { height:100%; border-radius:5px; transition:width .3s; }
  .bar-row .n { width:58px; text-align:right; }
  /* sparkline */
  .spark { display:flex; align-items:flex-end; gap:1px; height:60px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px; box-shadow:var(--shadow); }
  .spark > .b { background:linear-gradient(180deg,var(--c2),var(--c1)); flex:1 1 0; min-width:1px; border-radius:2px 2px 0 0; transition:height .2s; }
  .spark > .b.zero { background:var(--line); min-height:1px; }
  .stat-row { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--dim); margin-top:7px; }
  .stat-row span { color:var(--fg); font-weight:600; }
  .filter { background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:5px 9px; font-size:12px; margin-left:auto; min-width:180px; }
  #tooltip { position:fixed; pointer-events:none; background:var(--bg2); border:1px solid var(--line); border-radius:8px; padding:6px 9px; font-size:12px; box-shadow:var(--shadow); opacity:0; transition:opacity .1s; z-index:50; white-space:nowrap; }
  @media (max-width:560px){ body{padding:12px;} .grid{grid-template-columns:1fr 1fr;gap:8px;} th,td{padding:7px 9px;font-size:12px;} .filter{min-width:120px;} }
</style>
</head>
<body>
  <div class="topbar">
    <div class="brandwrap">
      <img id="logo" class="logo-img" alt="Blindfold" />
      <div>
        <h1><span class="brand"><span class="letter">B</span><span class="letter">l</span><span class="letter">i</span><span class="letter">n</span><span class="letter">d</span><span class="letter">f</span><span class="letter">o</span><span class="letter">l</span><span class="letter">d</span><div class="ribbon" id="brand-ribbon"></div><div class="sealbar" id="brand-sealbar"></div></span><span class="eyebrow">Dashboard</span></h1>
        <div class="tagline"><span class="lock">🔒</span> Secrets sealed in a <b>TEE</b> — keys you can't leak</div>
        <div class="tags" id="tags"></div>
      </div>
    </div>
    <div class="controls">
      <label>range
        <select id="range" onchange="setRange()">
          <option value="15">15m</option><option value="60" selected>1h</option>
          <option value="1440">24h</option><option value="0">all</option>
        </select>
      </label>
      <label>refresh
        <select id="refresh" onchange="setRefresh()">
          <option value="2000">2s</option><option value="5000">5s</option>
          <option value="10000">10s</option><option value="0">paused</option>
        </select>
      </label>
      <button onclick="toggleTheme()" id="themeBtn" title="Toggle theme">🌙</button>
      <button onclick="exportJson()">⬇ Export</button>
      <button onclick="clearLog()">Clear</button>
    </div>
  </div>

  <div id="alert-banner"></div>

  <div class="grid" id="kpis"></div>

  <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Security posture
    <button style="margin-left:auto" onclick="event.stopPropagation();runFullAudit()">🔎 Run full audit (live)</button>
  </div>
  <div class="grid" id="posture-cards"></div>
  <div id="full-audit"></div>

  <div class="two-col">
    <div>
      <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Providers</div>
      <div class="card" id="provider-chart"></div>
    </div>
    <div>
      <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Status codes</div>
      <div class="card" id="status-chart"></div>
    </div>
  </div>

  <div class="two-col">
    <div>
      <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>p95 latency trend</div>
      <div class="card" id="trend-latency"></div>
    </div>
    <div>
      <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Success rate trend</div>
      <div class="card" id="trend-success"></div>
    </div>
  </div>

  <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Requests per minute</div>
  <div class="spark" id="spark"></div>
  <div class="stat-row" id="spark-stats"></div>

  <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>System</div>
  <div class="grid" id="status-cards"></div>

  <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Sealed keys (metadata only)</div>
  <div id="sealed-table-wrap"></div>

  <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Per-secret usage</div>
  <div id="per-secret-wrap"></div>

  <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Blindfold commands</div>
  <div id="commands-wrap"></div>

  <div class="section-title" onclick="toggleSection(this)"><span class="chev">▼</span>Recent activity
    <input id="filter" class="filter" placeholder="filter…" oninput="renderTable(rangeFiltered())" onclick="event.stopPropagation()" />
  </div>
  <div id="table-wrap"></div>

  <div class="footer"><b>Privacy by design.</b> Metadata only — no request/response bodies, no header values, no secret values. See <code>usage-log.ts</code> + <code>sealed-ledger.ts</code>.</div>
  <div id="tooltip"></div>

<script>
/* Distinctive wordmark: each letter scrambles through cipher glyphs, then
   snap-seals into place — mirroring how a real key becomes __BLINDFOLD__.
   Purely decorative; respects prefers-reduced-motion. */
(function sealWordmark(){
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    var letters = Array.prototype.slice.call(document.querySelectorAll('.brand > .letter'));
    if (!letters.length) return;
    var GLYPHS = '▓█▒░#@$%&*/\\<>=+·:';
    var finals = letters.map(function(el){ return el.textContent; });
    letters.forEach(function(el){ el.classList.add('scrambling'); });
    var bar = document.getElementById('brand-sealbar');
    if (bar) { bar.classList.add('run'); }
    var start = performance.now();
    var settleAt = letters.map(function(_, i){ return 260 + i * 95; }); // staggered lock, left→right
    function frame(now){
      var t = now - start, done = 0;
      letters.forEach(function(el, i){
        if (el.dataset.sealed) { done++; return; }
        if (t >= settleAt[i]) {
          el.textContent = finals[i];
          el.classList.remove('scrambling');
          el.classList.add('sealed');
          el.dataset.sealed = '1';
          done++;
        } else if (t % 60 < 20) {
          el.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
      });
      if (done < letters.length) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  } catch (e) { /* animation must never break the dashboard */ }
})();
var PALETTE=['#8b5cf6','#58a6ff','#3fb950','#d29922','#f85149','#ff7b72','#39c5cf','#f778ba'];
function hashIdx(s){var h=0;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h%PALETTE.length;}
function colorFor(name){return PALETTE[hashIdx(String(name||'?'))];}
var TOK=new URLSearchParams(location.search).get('token');
function api(p){return TOK?p+(p.indexOf('?')>=0?'&':'?')+'token='+encodeURIComponent(TOK):p;}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
function timeAgo(iso){var ms=Date.now()-new Date(iso).getTime();if(ms<1000)return'just now';var s=(ms/1000)|0;if(s<60)return s+'s ago';var m=(s/60)|0;if(m<60)return m+'m ago';var h=(m/60)|0;if(h<24)return h+'h ago';return((h/24)|0)+'d ago';}
function pillStatus(s){if(s>=200&&s<300)return'<span class="pill pill-ok">'+s+'</span>';if(s>=400)return'<span class="pill pill-bad">'+s+'</span>';return'<span class="pill pill-warn">'+s+'</span>';}
function pillMode(m){return'<span class="pill pill-'+m+'">'+m+'</span>';}
function pct(arr,p){if(!arr.length)return 0;var s=arr.slice().sort(function(a,b){return a-b;});return s[Math.min(s.length-1,Math.floor(p/100*s.length))];}

// shared tooltip
var TIP=null;
function tip(ev,html){if(!TIP)TIP=document.getElementById('tooltip');TIP.innerHTML=html;TIP.style.opacity='1';TIP.style.left=(ev.clientX+12)+'px';TIP.style.top=(ev.clientY+12)+'px';}
function tipHide(){if(TIP)TIP.style.opacity='0';}

// state
window._events=[]; window._sort={key:'t',dir:-1};
function rangeMin(){return Number(document.getElementById('range').value);}
function rangeFiltered(){var m=rangeMin();if(!m)return window._events;var cut=Date.now()-m*60000;return window._events.filter(function(e){return new Date(e.t).getTime()>=cut;});}

function toggleTheme(){var h=document.documentElement;var d=h.getAttribute('data-theme')==='dark';h.setAttribute('data-theme',d?'light':'dark');document.getElementById('themeBtn').textContent=d?'☀':'🌙';try{localStorage.setItem('bf-theme',d?'light':'dark');}catch(e){}}
(function(){try{var t=localStorage.getItem('bf-theme');if(t){document.documentElement.setAttribute('data-theme',t);document.getElementById('themeBtn').textContent=t==='light'?'☀':'🌙';}}catch(e){}})();
function toggleSection(el){el.classList.toggle('collapsed');}
function setRange(){poll();}
function setRefresh(){var v=Number(document.getElementById('refresh').value);if(window._timer)clearInterval(window._timer);if(v>0)window._timer=setInterval(poll,v);}
function exportJson(){var b=new Blob([JSON.stringify(window._events||[],null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='blindfold-usage-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')+'.json';a.click();}
async function clearLog(){await fetch(api('/api/clear'),{method:'POST'});poll();}

async function poll(){
  try{
    var r=await Promise.all([fetch(api('/api/status')).then(function(x){return x.json();}),fetch(api('/api/sealed')).then(function(x){return x.json();}),fetch(api('/api/events')).then(function(x){return x.json();}),fetch(api('/api/audit')).then(function(x){return x.json();})]);
    var statusR=r[0],sealedR=r[1],eventsR=r[2],auditR=r[3];
    window._events=eventsR.events||[];
    var ev=rangeFiltered();
    document.getElementById('tags').innerHTML=
      '<span class="tag live"><span class="live-dot"></span>live</span>'
      +'<span class="tag orange">'+new Date().toLocaleTimeString()+'</span>'
      +'<span class="tag">'+(statusR.mode==='real'?'REAL · '+esc(statusR.t3_env||''):'MOCK')+'</span>'
      +'<span class="tag path">usage <code title="'+esc(eventsR.source)+'">'+esc(eventsR.source)+'</code></span>';
    renderAlert(auditR,ev);
    renderKpis(ev,auditR,statusR);
    renderPosture(auditR,statusR);
    renderStatus(statusR);
    renderDonut(ev);
    renderStatusBar(ev);
    renderTrends(ev);
    renderSpark(ev);
    renderSealed(sealedR.entries||[]);
    renderPerSecret(ev);
    renderTable(ev);
  }catch(e){}
}

function trendBadge(cur,prev){if(prev===0&&cur===0)return'<span class="trend flat">—</span>';if(prev===0)return'<span class="trend up">new</span>';var d=Math.round((cur-prev)/prev*100);if(Math.abs(d)<2)return'<span class="trend flat">0%</span>';return'<span class="trend '+(d>0?'up':'down')+'">'+(d>0?'▲':'▼')+Math.abs(d)+'%</span>';}

function renderKpis(ev,a,s){
  var half=ev.slice().sort(function(x,y){return new Date(x.t)-new Date(y.t);});
  var mid=Math.floor(half.length/2);var prevHalf=half.slice(0,mid),curHalf=half.slice(mid);
  function ok(arr){return arr.filter(function(e){return e.status>=200&&e.status<300;}).length;}
  var total=ev.length;
  var succ=total?Math.round(ok(ev)/total*100):0;
  var prevSucc=prevHalf.length?Math.round(ok(prevHalf)/prevHalf.length*100):0;
  var curSucc=curHalf.length?Math.round(ok(curHalf)/curHalf.length*100):0;
  var p95=pct(ev.map(function(e){return e.latency_ms||0;}),95);
  var p95p=pct(prevHalf.map(function(e){return e.latency_ms||0;}),95);
  var p95c=pct(curHalf.map(function(e){return e.latency_ms||0;}),95);
  var sealed=(a&&a.sealed_count)||0;
  var posture=postureScore(a,s).score;
  var cards=[
    ['Requests',total,'',trendBadge(curHalf.length,prevHalf.length),'var(--c1)'],
    ['Success rate',succ+'%',ok(ev)+'/'+total+' 2xx',trendBadge(curSucc,prevSucc),succ>=95?'var(--ok)':succ>=80?'var(--warn)':'var(--bad)'],
    ['p95 latency',p95+' ms',ev.length+' samples',trendBadge(p95c,p95p),'var(--c2)'],
    ['Sealed secrets',sealed,'in the enclave','','var(--c7)'],
    ['Posture',posture+'<span style="font-size:13px;color:var(--dim)">/100</span>','security score','',posture>=90?'var(--ok)':posture>=60?'var(--warn)':'var(--bad)']
  ];
  document.getElementById('kpis').innerHTML=cards.map(function(c){return '<div class="card kpi" style="--kpi:'+c[4]+'"><div class="label">'+c[0]+'</div><div class="value">'+c[1]+c[3]+'</div><div class="sub2">'+c[2]+'</div></div>';}).join('');
}

function postureScore(a,s){var exposed=((a&&a.exposed_in_env)||[]).length;var chain=(a&&a.ledger_chain)||{ok:true,total:0};var sealed=(a&&a.sealed_count)||0;var score=100;var notes=[];if(exposed>0){score-=30;notes.push(exposed+' key(s) in .env');}if(chain.total>0&&!chain.ok){score-=40;notes.push('ledger TAMPERED');}if(s&&s.mode!=='real'){score-=10;notes.push('MOCK mode');}if(s&&!s.sdk_installed){score-=10;notes.push('SDK missing');}if(sealed===0){score-=10;notes.push('nothing sealed');}return{score:Math.max(0,score),notes:notes};}

function renderAlert(a,ev){
  var msgs=[];var chain=(a&&a.ledger_chain)||{};
  if(chain.total>0&&!chain.ok)msgs.push(['bad','🔴 Ledger TAMPERED — a sealed-keys line was edited or removed']);
  if(((a&&a.exposed_in_env)||[]).length>0)msgs.push(['warn','🟠 '+a.exposed_in_env.length+' sealed key(s) still in .env — delete them']);
  var recent=(ev||[]).filter(function(e){return Date.now()-new Date(e.t).getTime()<300000;});
  var errs=recent.filter(function(e){return(e.status||0)>=400;}).length;
  if(recent.length>=5&&errs/recent.length>0.3)msgs.push(['warn','🟠 '+Math.round(errs/recent.length*100)+'% errors in the last 5 min ('+errs+'/'+recent.length+')']);
  var el=document.getElementById('alert-banner');
  if(!msgs.length){el.innerHTML='';return;}
  var bad=msgs.some(function(m){return m[0]==='bad';});
  el.innerHTML='<div class="alert" style="background:'+(bad?'rgba(248,81,73,.08)':'rgba(210,153,34,.08)')+';border-color:'+(bad?'rgba(248,81,73,.4)':'rgba(210,153,34,.4)')+';color:'+(bad?'var(--bad)':'var(--warn)')+'"><div class="head">⚠ Attention</div>'+msgs.map(function(m){return esc(m[1]);}).join('<br/>')+'</div>';
}

function renderPosture(a,s){
  var p=postureScore(a,s);var exposed=((a&&a.exposed_in_env)||[]).length;var chain=(a&&a.ledger_chain)||{ok:true,total:0,legacy:0};
  var chainTxt=chain.total===0?'empty':(chain.ok?'intact':'TAMPERED');
  var cards=[
    ['.env leak surface',exposed===0?'0 ✅':exposed+' ⚠','sealed keys still in .env',exposed===0?'var(--ok)':'var(--warn)'],
    ['Ledger integrity',(chainTxt==='TAMPERED'?'✖ ':chainTxt==='intact'?'✅ ':'')+chainTxt,(chain.legacy||0)+' legacy entries',chainTxt==='TAMPERED'?'var(--bad)':'var(--ok)'],
    ['Mode',s&&s.mode==='real'?'REAL':'MOCK',s&&s.mode==='real'?'connected to '+esc(s.t3_env||''):'BLINDFOLD_MOCK=1','var(--c1)'],
    ['Issues',p.notes.length,p.notes.length?esc(p.notes.join(' · ')):'all clear',p.notes.length?'var(--warn)':'var(--ok)']
  ];
  document.getElementById('posture-cards').innerHTML=cards.map(function(c){return '<div class="card kpi" style="--kpi:'+c[3]+'"><div class="label">'+c[0]+'</div><div class="value">'+c[1]+'</div><div class="sub2">'+c[2]+'</div></div>';}).join('');
}

function renderStatus(s){
  var cards=[
    [s.mode==='real'?'REAL':'MOCK','Mode',s.mode==='real'?'T3 '+esc(s.t3_env):'mock'],
    [esc(s.contract_version||'—'),'Contract','blindfold-proxy'],
    [esc(s.tenant_did_short||'(none)'),'Tenant',s.tenant_did?'full in title':'set creds'],
    [s.proxy_port,'Proxy port','127.0.0.1:'+s.proxy_port],
    [s.sdk_installed?'✓':'✗','SDK',s.sdk_installed?'installed':'missing']
  ];
  document.getElementById('status-cards').innerHTML=cards.map(function(c){return '<div class="card"><div class="label">'+esc(c[1])+'</div><div class="value">'+esc(c[0])+'</div><div class="sub2">'+esc(c[2])+'</div></div>';}).join('');
}

function donutSvg(rows,total){
  var r=42,c=2*Math.PI*r,off=0,seg='';
  rows.forEach(function(row){var frac=total?row[1]/total:0;var len=frac*c;var col=colorFor(row[0]);seg+='<circle cx="60" cy="60" r="'+r+'" fill="none" stroke="'+col+'" stroke-width="16" stroke-dasharray="'+len.toFixed(2)+' '+(c-len).toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)+'" transform="rotate(-90 60 60)"><title>'+esc(row[0])+': '+row[1]+'</title></circle>';off+=len;});
  return '<svg viewBox="0 0 120 120" style="width:120px;height:120px;flex:none">'+seg+'<text x="60" y="56" text-anchor="middle" fill="var(--fg)" font-size="22" font-weight="700">'+total+'</text><text x="60" y="74" text-anchor="middle" fill="var(--dim)" font-size="9">requests</text></svg>';
}
function renderDonut(ev){
  var by={};ev.forEach(function(e){var k=e.provider||'(unknown)';by[k]=(by[k]||0)+1;});
  var rows=Object.keys(by).map(function(k){return[k,by[k]];}).sort(function(a,b){return b[1]-a[1];});
  var el=document.getElementById('provider-chart');
  if(!rows.length){el.innerHTML='<div style="color:var(--dim);font-size:13px">No traffic yet.</div>';return;}
  var legend=rows.map(function(row){return '<div class="li"><span class="dot" style="background:'+colorFor(row[0])+'"></span>'+esc(row[0])+'<span class="n">'+row[1]+'</span></div>';}).join('');
  el.innerHTML='<div class="donut-wrap">'+donutSvg(rows,ev.length)+'<div class="legend">'+legend+'</div></div>';
}

function renderStatusBar(ev){
  var b={'2xx':0,'3xx':0,'4xx':0,'5xx':0};ev.forEach(function(e){var k=Math.floor((e.status||0)/100)+'xx';if(b[k]!==undefined)b[k]++;});
  var col={'2xx':'var(--ok)','3xx':'var(--info)','4xx':'var(--warn)','5xx':'var(--bad)'};
  var total=ev.length;var el=document.getElementById('status-chart');
  if(!total){el.innerHTML='<div style="color:var(--dim);font-size:13px">No traffic yet.</div>';return;}
  var segs=Object.keys(b).filter(function(k){return b[k]>0;}).map(function(k){return '<div style="width:'+(b[k]/total*100)+'%;background:'+col[k]+'" title="'+k+': '+b[k]+'"></div>';}).join('');
  var legend=Object.keys(b).map(function(k){return '<div class="li"><span class="dot" style="background:'+col[k]+'"></span>'+k+'<span class="n">'+b[k]+'</span></div>';}).join('');
  el.innerHTML='<div class="segbar">'+segs+'</div><div class="legend" style="flex-direction:row;flex-wrap:wrap;gap:14px;margin-top:12px">'+legend+'</div>';
}

function areaSvg(values,color,maxOpt){
  var w=300,h=70,n=values.length;if(n<2)values=values.concat(values);n=values.length;
  var max=Math.max(maxOpt||0,Math.max.apply(null,values),1);
  var pts=values.map(function(v,i){return (i/(n-1)*w).toFixed(1)+','+(h-(v/max)*h).toFixed(1);});
  var gid='g'+Math.floor(Math.random()*1e6);
  var poly=pts.join(' ');var area='0,'+h+' '+poly+' '+w+','+h;
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" style="width:100%;height:72px;display:block"><defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity="0.35"/><stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs><polygon points="'+area+'" fill="url(#'+gid+')"/><polyline points="'+poly+'" fill="none" stroke="'+color+'" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
}
function renderTrends(ev){
  var now=Date.now();var lat=[],ok=[],tot=[];for(var i=0;i<60;i++){lat.push([]);ok.push(0);tot.push(0);}
  ev.forEach(function(e){var ageMin=Math.floor((now-new Date(e.t).getTime())/60000);if(ageMin>=0&&ageMin<60){var idx=59-ageMin;lat[idx].push(e.latency_ms||0);tot[idx]++;if((e.status||0)>=200&&(e.status||0)<300)ok[idx]++;}});
  var p95=lat.map(function(a){return a.length?pct(a,95):0;});
  var succ=tot.map(function(t,i){return t?Math.round(ok[i]/t*100):0;});
  document.getElementById('trend-latency').innerHTML=areaSvg(p95,'var(--c1)')+'<div class="stat-row">peak p95 <span>'+Math.max.apply(null,p95.concat(0))+' ms</span></div>';
  document.getElementById('trend-success').innerHTML=areaSvg(succ,'var(--ok)',100)+'<div class="stat-row">latest <span>'+(succ[59]||0)+'%</span></div>';
}

function renderSpark(ev){
  var now=Date.now();var b=[];for(var i=0;i<60;i++)b.push(0);
  ev.forEach(function(e){var ageMin=Math.floor((now-new Date(e.t).getTime())/60000);if(ageMin>=0&&ageMin<60)b[59-ageMin]++;});
  var max=Math.max.apply(null,b.concat(1));
  document.getElementById('spark').innerHTML=b.map(function(v,i){var hh=Math.max(1,Math.round(v/max*44));return '<div class="b '+(v===0?'zero':'')+'" style="height:'+hh+'px" title="'+v+' req · '+(59-i)+'m ago"></div>';}).join('');
  var sum=b.reduce(function(a,c){return a+c;},0);
  document.getElementById('spark-stats').innerHTML='last 60 min <span>'+sum+'</span> · peak minute <span>'+max+'</span>';
}

function renderSealed(entries){
  if(!entries.length){document.getElementById('sealed-table-wrap').innerHTML='<div class="empty">No keys sealed yet. <code>blindfold register --name &lt;K&gt;</code></div>';return;}
  var latest={};entries.forEach(function(e){latest[e.name]=e;});
  var rows=Object.keys(latest).map(function(k){return latest[k];}).sort(function(a,b){return a.t<b.t?1:-1;}).map(function(e){return '<tr><td><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:'+colorFor(e.name)+'"></span><code>'+esc(e.name)+'</code></td><td>'+e.length+' B</td><td>'+pillMode(e.mode)+'</td><td title="'+esc(e.t)+'">'+timeAgo(e.t)+'</td><td><code class="sentinel">__BLINDFOLD__</code></td><td style="white-space:nowrap"><button class="copybtn cmd" data-name="'+esc(e.name)+'" title="Copy a ready-to-run verify command">⧉ cmd</button> <button class="copybtn ref" data-name="'+esc(e.name)+'" title="Copy the Blindfold sentinel — put this where the real key would go; the enclave substitutes the sealed value at call time">⧉ sealed token</button></td></tr>';}).join('');
  document.getElementById('sealed-table-wrap').innerHTML='<div class="scroll"><table><thead><tr><th>Name</th><th>Bytes</th><th>Mode</th><th>Sealed</th><th>Sealed token</th><th>Copy</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  function flash(b,txt,cls){var o=b.textContent;b.textContent=txt;b.classList.add(cls||'done');setTimeout(function(){b.textContent=o;b.classList.remove('done','err');},1400);}
  var cmds=document.querySelectorAll('#sealed-table-wrap .copybtn.cmd');
  for(var i=0;i<cmds.length;i++){(function(b){b.onclick=function(){var cmd='npm run blindfold -- use --name '+b.getAttribute('data-name')+' --check';try{navigator.clipboard.writeText(cmd);}catch(e){}flash(b,'✓ copied');};})(cmds[i]);}
  var refs=document.querySelectorAll('#sealed-table-wrap .copybtn.ref');
  for(var j=0;j<refs.length;j++){(function(b){b.onclick=function(){try{navigator.clipboard.writeText('__BLINDFOLD__');}catch(e){}flash(b,'✓ sentinel copied');};})(refs[j]);}
}

function renderPerSecret(ev){
  var by={};ev.forEach(function(e){var k=e.secret_key||'(unknown)';by[k]=(by[k]||0)+1;});
  var rows=Object.keys(by).map(function(k){return[k,by[k]];}).sort(function(a,b){return b[1]-a[1];});
  var el=document.getElementById('per-secret-wrap');
  if(!rows.length){el.innerHTML='<div class="empty">No secret usage yet. Try <code>blindfold use --name &lt;X&gt; -- &lt;cmd&gt;</code> or the proxy.</div>';return;}
  var max=Math.max.apply(null,rows.map(function(r){return r[1];}).concat(1));
  el.innerHTML='<div class="card">'+rows.map(function(r){return '<div class="bar-row"><div class="name" title="'+esc(r[0])+'">'+esc(r[0])+'</div><div class="track"><div class="fill" style="width:'+(r[1]/max*100)+'%;background:'+colorFor(r[0])+'"></div></div><div class="n">'+r[1]+'</div></div>';}).join('')+'</div>';
}

function sortBy(k){if(window._sort.key===k)window._sort.dir*=-1;else window._sort={key:k,dir:-1};renderTable(rangeFiltered());}
function renderTable(ev){
  var q=(document.getElementById('filter').value||'').toLowerCase().trim();
  var list=ev;
  if(q)list=ev.filter(function(e){return(e.provider||'').toLowerCase().indexOf(q)>=0||(e.path||'').toLowerCase().indexOf(q)>=0||(e.via||'').toLowerCase().indexOf(q)>=0||String(e.status||'').indexOf(q)>=0||(e.mode||'').toLowerCase().indexOf(q)>=0;});
  var k=window._sort.key,dir=window._sort.dir;
  list=list.slice().sort(function(a,b){var x=a[k],y=b[k];if(k==='t'){x=new Date(a.t).getTime();y=new Date(b.t).getTime();}return x<y?-dir:x>y?dir:0;}).slice(0,80);
  if(!list.length){document.getElementById('table-wrap').innerHTML='<div class="empty">'+(q?'No requests match "'+esc(q)+'".':'No traffic in range. Use a secret or the proxy.')+'</div>';return;}
  var rows=list.map(function(e){return '<tr><td>'+timeAgo(e.t)+'</td><td><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:'+colorFor(e.provider)+'"></span>'+esc(e.provider)+'</td><td><span class="pill pill-info">'+esc(e.via||'proxy')+'</span></td><td><code>'+esc(e.method)+' '+esc(e.path)+'</code></td><td>'+pillStatus(e.status)+'</td><td>'+e.latency_ms+' ms</td><td>'+pillMode(e.mode)+'</td></tr>';}).join('');
  document.getElementById('table-wrap').innerHTML='<div class="scroll"><table><thead><tr><th data-k="t">When</th><th data-k="provider">Provider</th><th data-k="via">Via</th><th>Request</th><th data-k="status">Status</th><th data-k="latency_ms">Latency</th><th data-k="mode">Mode</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  var ths=document.querySelectorAll('#table-wrap th[data-k]');for(var ti=0;ti<ths.length;ti++){(function(th){th.onclick=function(){sortBy(th.getAttribute('data-k'));};})(ths[ti]);}
}

async function runFullAudit(){
  var el=document.getElementById('full-audit');el.innerHTML='<div class="empty">Running live enclave reconciliation…</div>';
  try{
    var r=await fetch(api('/api/audit/full')).then(function(x){return x.json();});
    if(r.mock){el.innerHTML='<div class="alert ok"><div class="head">MOCK mode</div>Reconciliation only runs in REAL mode.</div>';return;}
    if(r.error){el.innerHTML='<div class="alert" style="border-color:rgba(248,81,73,.4);color:var(--bad)"><div class="head">Audit error</div>'+esc(r.error)+'</div>';return;}
    var rows=(r.results||[]).map(function(x){return '<tr><td><code>'+esc(x.name)+'</code></td><td>'+(x.present?'<span class="pill pill-ok">present</span>':'<span class="pill pill-bad">MISSING</span>')+'</td><td>'+x.enclave_len+' B</td><td>'+x.ledger_len+' B</td><td>'+(x.ok?'<span class="pill pill-ok">ok</span>':'<span class="pill pill-warn">drift</span>')+'</td><td><code>'+esc(x.fingerprint||'')+'</code></td></tr>';}).join('');
    var okN=(r.results||[]).filter(function(x){return x.ok;}).length;
    el.innerHTML='<div class="scroll" style="margin-bottom:6px"><table><thead><tr><th>Secret</th><th>Enclave</th><th>Enc bytes</th><th>Ledger bytes</th><th>Match</th><th>Fingerprint</th></tr></thead><tbody>'+rows+'</tbody></table></div><div class="stat-row">'+okN+'/'+(r.results||[]).length+' verified against the enclave</div>';
  }catch(e){el.innerHTML='<div class="alert" style="border-color:rgba(248,81,73,.4);color:var(--bad)"><div class="head">Audit failed</div>'+esc(String(e))+'</div>';}
}

function startStream(){try{var es=new EventSource(api('/api/stream'));es.addEventListener('change',function(){poll();});es.onerror=function(){};}catch(e){}}

function renderCommands(){
  var C=[
    ['doctor','doctor','Check your key + tenant are healthy'],
    ['status','status','Mode, tenant, and every sealed secret'],
    ['audit','audit','Verify the ledger + reconcile against the enclave'],
    ['migrate','migrate','Seal every secret in .env in one shot'],
    ['register','register --name NAME --from-env NAME','Seal a secret into the enclave'],
    ['use','use --name NAME -- COMMAND','Run any tool with a sealed secret injected'],
    ['use --check','use --name NAME --check','Confirm a sealed secret is usable'],
    ['rotate','rotate --name NAME --from-env NAME','Replace a secret value (rollback-safe)'],
    ['rollback','rollback --name NAME','Restore the previous value'],
    ['versions','versions --name NAME','List rollback snapshots'],
    ['grant','grant --host api.openai.com','Authorize the contract to call a host'],
    ['share','share --to DID --host HOST','Let a teammate agent use your keys'],
    ['revoke','revoke --to DID','Remove a teammate access'],
    ['proxy','proxy','Run the local OpenAI/Anthropic proxy'],
    ['publish','publish','Publish the contract to T3'],
    ['sealed','sealed','List sealed keys (metadata only)'],
    ['dashboard','dashboard','Launch this dashboard'],
    ['export','export --name NAME','CI: inject a sealed secret into the job env']
  ];
  var rows=C.map(function(c){return '<tr><td><span class="cmdname">'+esc(c[0])+'</span></td><td><code>npm run blindfold -- '+esc(c[1])+'</code></td><td>'+esc(c[2])+'</td><td><button class="copybtn" data-cmd="npm run blindfold -- '+esc(c[1])+'">⧉ copy</button></td></tr>';}).join('');
  document.getElementById('commands-wrap').innerHTML='<div class="scroll"><table><thead><tr><th>Command</th><th>Run</th><th>What it does</th><th>Copy</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  var btns=document.querySelectorAll('#commands-wrap .copybtn');
  for(var i=0;i<btns.length;i++){(function(b){b.onclick=function(){try{navigator.clipboard.writeText(b.getAttribute('data-cmd'));}catch(e){}var o=b.textContent;b.textContent='✓ copied';b.classList.add('done');setTimeout(function(){b.textContent=o;b.classList.remove('done');},1300);};})(btns[i]);}
}

document.getElementById('logo').src=api('/logo.png');
renderCommands();
poll();setRefresh();startStream();
</script>
</body>
</html>
`;
