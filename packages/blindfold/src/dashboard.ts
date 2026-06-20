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
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION, DEFAULT_DASHBOARD_PORT } from "./constants.ts";
import { loadBlindfoldEnv } from "./env.ts";
import { clearUsage, defaultLogPath, readUsage } from "./usage-log.ts";
import { defaultSealedLogPath, readSealed } from "./sealed-ledger.ts";

export interface DashboardHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startDashboard(opts: { port?: number } = {}): Promise<DashboardHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    if (req.method === "GET" && url === "/api/events") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: readUsage(), source: defaultLogPath() }));
      return;
    }
    if (req.method === "GET" && url === "/api/sealed") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entries: readSealed(), source: defaultSealedLogPath() }));
      return;
    }
    if (req.method === "GET" && url === "/api/status") {
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
    if (req.method === "GET" && url === "/api/audit") {
      const sealed = readSealed();
      const envKeys = readEnvKeyNames();
      const exposed = sealed
        .map((s) => s.name)
        .filter((name, i, arr) => arr.indexOf(name) === i)   // dedupe (overwrites)
        .filter((name) => envKeys.includes(name))
        .map((name) => {
          const latest = [...sealed].reverse().find((s) => s.name === name)!;
          return { name, length: latest.length, sealed_at: latest.t };
        });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ exposed_in_env: exposed, env_keys: envKeys }));
      return;
    }
    if ((req.method === "POST" || req.method === "DELETE") && url === "/api/clear") {
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
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ENV_PATH = path.resolve(HERE, "..", "..", "..", ".env");
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
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Blindfold — Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #0e1117; --card: #161b22; --line: #30363d;
    --fg: #e6edf3; --dim: #8b949e;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    --accent: #6e44ff; --accent2: #58a6ff;
  }
  * { box-sizing: border-box; }
  html, body { max-width: 100vw; overflow-x: hidden; }
  body {
    margin: 0; padding: 24px 32px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.5;
  }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
  h1 .logo { color: var(--accent); }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 24px; overflow-wrap: anywhere; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .grid {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    margin-bottom: 20px;
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    padding: 14px 16px; min-width: 0;
  }
  .card .label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; }
  .card .value { font-size: 24px; font-weight: 600; margin-top: 4px; overflow-wrap: anywhere; word-break: break-word; }
  .card .sub2 { font-size: 12px; color: var(--dim); margin-top: 4px; overflow-wrap: anywhere; }
  .section-title {
    font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px;
    margin: 28px 0 8px; display: flex; align-items: center; gap: 8px;
  }
  .section-title::before {
    content: ""; flex: 1; height: 1px; background: var(--line); margin-right: 4px; max-width: 0;
  }
  /* All tables live inside .scroll for horizontal swipe on narrow screens. */
  .scroll {
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
  }
  table {
    width: 100%; border-collapse: collapse; min-width: 480px;
  }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
  th { color: var(--dim); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  code { background: rgba(255,255,255,.05); padding: 2px 5px; border-radius: 3px; font-size: 12px; overflow-wrap: anywhere; word-break: break-word; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .pill-ok   { background: rgba(63,185,80,.15);  color: var(--ok); }
  .pill-bad  { background: rgba(248,81,73,.15);  color: var(--bad); }
  .pill-warn { background: rgba(210,153,34,.15); color: var(--warn); }
  .pill-mock { background: rgba(110,68,255,.15); color: var(--accent); }
  .pill-real { background: rgba(63,185,80,.15);  color: var(--ok); }
  .pill-dim  { background: rgba(255,255,255,.05); color: var(--dim); }
  .empty {
    background: var(--card); border: 1px dashed var(--line); border-radius: 8px;
    padding: 24px; text-align: center; color: var(--dim);
  }
  .alert {
    background: rgba(210,153,34,.08); border: 1px solid rgba(210,153,34,.35);
    border-radius: 8px; padding: 12px 16px; color: var(--warn); margin-bottom: 16px;
  }
  .alert .head { font-weight: 600; margin-bottom: 4px; }
  .alert.ok { background: rgba(63,185,80,.06); border-color: rgba(63,185,80,.25); color: var(--ok); }
  .footer {
    margin-top: 28px; padding: 14px 16px;
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    font-size: 12px; color: var(--dim);
  }
  .footer b { color: var(--fg); }
  button {
    background: transparent; border: 1px solid var(--line); color: var(--fg);
    padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  /* sparkline */
  .spark { display: flex; align-items: flex-end; gap: 1px; height: 56px;
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px; overflow: hidden; }
  .spark > .b { background: var(--accent); flex: 1 1 0; min-width: 1px; transition: height .2s; opacity: .85; }
  .spark > .b.zero { background: var(--line); opacity: .5; min-height: 1px; }
  .stat-row { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--dim); margin-top: 6px; }
  .stat-row span { color: var(--fg); }
  /* Mobile / narrow screens */
  @media (max-width: 720px) {
    body { padding: 14px; }
    h1 { font-size: 18px; }
    .sub { font-size: 12px; margin-bottom: 14px; }
    .grid { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 12px; }
    .card { padding: 10px 12px; }
    .card .label { font-size: 10px; }
    .card .value { font-size: 18px; }
    .card .sub2 { font-size: 11px; }
    .section-title { margin: 20px 0 6px; }
    th, td { padding: 6px 8px; font-size: 12px; }
    .footer { padding: 10px 12px; font-size: 11px; }
    .alert { padding: 10px 12px; font-size: 12px; }
    button { padding: 6px 10px; }
  }
  @media (max-width: 420px) {
    body { padding: 10px; }
    .grid { grid-template-columns: 1fr 1fr; }
    .card .value { font-size: 16px; }
  }
</style>
</head>
<body>
  <div class="row">
    <div>
      <h1><span class="logo">🛡️ Blindfold</span> — Dashboard</h1>
      <div class="sub">Live metadata · auto-refresh 2s · <span id="src"></span></div>
    </div>
    <div>
      <button onclick="clearLog()">Clear usage log</button>
    </div>
  </div>

  <div id="audit-area"></div>

  <div class="section-title">System</div>
  <div class="grid" id="status-cards"></div>

  <div class="section-title">Sealed keys (metadata only)</div>
  <div id="sealed-table-wrap"></div>

  <div class="section-title">Traffic — counters</div>
  <div class="grid" id="counter-cards"></div>

  <div class="section-title">Per-secret release / proxy usage</div>
  <div id="per-secret-wrap"></div>

  <div class="section-title">Requests over the last hour (one bar = 1 minute)</div>
  <div class="spark" id="spark"></div>
  <div class="stat-row" id="spark-stats"></div>

  <div class="section-title">Recent activity (last 50)</div>
  <div id="table-wrap"></div>

  <div class="footer">
    <b>Privacy by design.</b> This dashboard shows metadata only — no request bodies,
    no response bodies, no header values, no secret values. See
    <code>packages/blindfold/src/usage-log.ts</code> and <code>sealed-ledger.ts</code>
    for what's recorded.
  </div>

<script>
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000); if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);    if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);    if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function pillStatus(s) {
  if (s >= 200 && s < 300) return '<span class="pill pill-ok">' + s + '</span>';
  if (s >= 400)            return '<span class="pill pill-bad">' + s + '</span>';
  return '<span class="pill pill-warn">' + s + '</span>';
}
function pillMode(m) { return '<span class="pill pill-' + m + '">' + m + '</span>'; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function clearLog() {
  await fetch('/api/clear', { method: 'POST' });
  poll();
}

async function poll() {
  try {
    const [statusR, sealedR, eventsR, auditR] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/sealed').then(r => r.json()),
      fetch('/api/events').then(r => r.json()),
      fetch('/api/audit').then(r => r.json()),
    ]);
    document.getElementById('src').textContent =
      'usage: ' + eventsR.source + ' · sealed: ' + sealedR.source;
    renderAudit(auditR);
    renderStatus(statusR);
    renderSealed(sealedR.entries || []);
    renderCounters(eventsR.events || []);
    renderPerSecret(eventsR.events || []);
    renderSpark(eventsR.events || []);
    renderTable(eventsR.events || []);
  } catch (e) {
    // ignore transient errors
  }
}

function renderAudit(a) {
  const exposed = a.exposed_in_env || [];
  const el = document.getElementById('audit-area');
  if (exposed.length === 0) {
    el.innerHTML = '<div class="alert ok"><div class="head">✅ No leak surface in .env</div>'
      + 'Every sealed key is present only in the enclave; no .env entry duplicates a sealed value.</div>';
    return;
  }
  const rows = exposed.map(e =>
    '<li><code>' + esc(e.name) + '</code> · ' + e.length + ' bytes · sealed ' + timeAgo(e.sealed_at)
    + ' → <b>delete this line from .env</b></li>'
  ).join('');
  el.innerHTML = '<div class="alert"><div class="head">⚠ ' + exposed.length
    + ' sealed key(s) ALSO present in .env</div>'
    + 'These are redundant leak surface — the canonical copy is already in the enclave:'
    + '<ul style="margin:8px 0 0; padding-left: 20px">' + rows + '</ul></div>';
}

function renderStatus(s) {
  const cards = [
    [s.mode === 'real' ? 'REAL' : 'MOCK', 'Mode', s.mode === 'real' ? 'connected to T3 ' + esc(s.t3_env) : 'BLINDFOLD_MOCK=1'],
    [esc(s.contract_version || '—'), 'Contract version', 'blindfold-proxy tail'],
    [esc(s.tenant_did_short || '(none)'), 'Tenant DID', s.tenant_did ? 'full: ' + esc(s.tenant_did) : 'set T3N_API_KEY + DID'],
    [s.proxy_port, 'Proxy port', 'http://127.0.0.1:' + s.proxy_port],
    [s.sdk_installed ? '✓ installed' : '✗ missing', '@terminal3/t3n-sdk', s.sdk_installed ? 'lazy-loaded' : 'npm install needed'],
  ];
  document.getElementById('status-cards').innerHTML = cards.map(([v, l, sub]) =>
    '<div class="card"><div class="label">' + esc(l) + '</div><div class="value">' + esc(v) + '</div><div class="sub2">' + sub + '</div></div>'
  ).join('');
}

function renderSealed(entries) {
  if (entries.length === 0) {
    document.getElementById('sealed-table-wrap').innerHTML =
      '<div class="empty">No keys sealed yet. Seal one with <code>blindfold register --name &lt;K&gt;</code>.</div>';
    return;
  }
  // dedupe by name keeping the LATEST entry per name (overwrites = rotations)
  const latest = new Map();
  for (const e of entries) latest.set(e.name, e);
  const rows = [...latest.values()].sort((a, b) => (a.t < b.t ? 1 : -1)).map(e =>
    '<tr>'
      + '<td><code>' + esc(e.name) + '</code></td>'
      + '<td>' + e.length + ' bytes</td>'
      + '<td>' + pillMode(e.mode) + '</td>'
      + '<td title="' + esc(e.t) + '">' + timeAgo(e.t) + '</td>'
      + '<td><code>' + esc(e.map_name) + '/' + esc(e.name) + '</code></td>'
      + '<td><span class="pill pill-dim">' + esc(e.source) + '</span></td>'
    + '</tr>'
  ).join('');
  document.getElementById('sealed-table-wrap').innerHTML =
    '<div class="scroll"><table><thead><tr>'
      + '<th>Name</th><th>Bytes</th><th>Mode</th><th>Sealed</th><th>Address in enclave</th><th>Source</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderCounters(events) {
  const total = events.length;
  const byProvider = {}; let ok = 0, bad = 0, lat = 0, sentinel = 0, authIn = 0;
  for (const e of events) {
    byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    if (e.status >= 200 && e.status < 300) ok++;
    if (e.status >= 400) bad++;
    lat += e.latency_ms;
    if (e.sentinel_in_outbound) sentinel++;
    if (e.agent_supplied_auth) authIn++;
  }
  const provs = Object.entries(byProvider).map(([k,v]) => k+'×'+v).join(' · ') || '—';
  document.getElementById('counter-cards').innerHTML = [
    '<div class="card"><div class="label">Total requests</div><div class="value">' + total + '</div><div class="sub2">' + provs + '</div></div>',
    '<div class="card"><div class="label">2xx · 4xx+</div><div class="value">' + ok + ' · ' + bad + '</div><div class="sub2">' + (total ? Math.round(ok*100/total) : 0) + '% success</div></div>',
    '<div class="card"><div class="label">Avg latency</div><div class="value">' + (total ? Math.round(lat/total) : 0) + ' ms</div><div class="sub2">end-to-end through proxy</div></div>',
    '<div class="card"><div class="label">Sentinel substituted</div><div class="value">' + sentinel + '/' + total + '</div><div class="sub2">' + authIn + ' agent-supplied auth replaced</div></div>',
  ].join('');
}

function renderPerSecret(events) {
  // Count by secret_key (proxy-forward only — release calls aren't in usage.jsonl yet)
  const byKey = {};
  for (const e of events) {
    const k = e.secret_key || '(unknown)';
    byKey[k] = (byKey[k] || 0) + 1;
  }
  const rows = Object.entries(byKey).sort((a,b) => b[1]-a[1]).map(([k,n]) =>
    '<tr><td><code>' + esc(k) + '</code></td><td>' + n + '</td></tr>'
  ).join('');
  if (!rows) {
    document.getElementById('per-secret-wrap').innerHTML =
      '<div class="empty">No proxy traffic yet. Run an agent against <code>http://127.0.0.1:8787</code>.</div>';
    return;
  }
  document.getElementById('per-secret-wrap').innerHTML =
    '<div class="scroll"><table><thead><tr><th>Secret name</th><th>Requests</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderSpark(events) {
  const now = Date.now();
  const buckets = new Array(60).fill(0);
  for (const e of events) {
    const ageMin = Math.floor((now - new Date(e.t).getTime()) / 60000);
    if (ageMin >= 0 && ageMin < 60) buckets[59 - ageMin]++;
  }
  const max = Math.max(1, ...buckets);
  document.getElementById('spark').innerHTML = buckets.map(v => {
    const h = Math.max(1, Math.round(v / max * 40));
    return '<div class="b ' + (v === 0 ? 'zero' : '') + '" style="height:' + h + 'px" title="' + v + ' req"></div>';
  }).join('');
  const sum = buckets.reduce((a,b) => a+b, 0);
  document.getElementById('spark-stats').innerHTML =
    'last 60 min: <span>' + sum + '</span> requests · peak minute: <span>' + max + '</span>';
}

function renderTable(events) {
  if (events.length === 0) {
    document.getElementById('table-wrap').innerHTML =
      '<div class="empty">No proxy traffic yet. Point an agent at <code>http://127.0.0.1:8787</code>.</div>';
    return;
  }
  const rows = events.slice().reverse().slice(0, 50).map(e =>
    '<tr>'
      + '<td>' + timeAgo(e.t) + '</td>'
      + '<td>' + esc(e.provider) + '</td>'
      + '<td><code>' + esc(e.method) + ' ' + esc(e.path) + '</code></td>'
      + '<td>' + pillStatus(e.status) + '</td>'
      + '<td>' + e.latency_ms + ' ms</td>'
      + '<td>' + pillMode(e.mode) + '</td>'
      + '<td>' + (e.sentinel_in_outbound ? '<span class="pill pill-ok">yes</span>' : '<span class="pill pill-bad">NO</span>') + '</td>'
    + '</tr>'
  ).join('');
  document.getElementById('table-wrap').innerHTML =
    '<div class="scroll"><table><thead><tr><th>When</th><th>Provider</th><th>Request</th><th>Status</th><th>Latency</th><th>Mode</th><th>Sentinel</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>';
}

poll();
setInterval(poll, 2000);
</script>
</body>
</html>
`;
