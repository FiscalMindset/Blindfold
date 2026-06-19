/**
 * Blindfold usage dashboard.
 *
 *   blindfold dashboard --port 8799
 *
 * A tiny standalone HTTP server that serves a self-contained HTML page
 * showing live traffic through the proxy. Data source: the JSONL written
 * by `usage-log.ts`. The dashboard inherits its safety property: it can
 * only render what was logged, and what was logged is metadata only.
 *
 *   GET /             → the HTML page
 *   GET /api/events   → JSON array of UsageEvent
 *   GET /api/clear    → POST-style clear (DELETE method too); admin use
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_DASHBOARD_PORT } from "./constants.ts";
import { clearUsage, defaultLogPath, readUsage } from "./usage-log.ts";

export interface DashboardHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startDashboard(opts: { port?: number } = {}): Promise<DashboardHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }
    if (req.method === "GET" && req.url === "/api/events") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: readUsage(), source: defaultLogPath() }));
      return;
    }
    if ((req.method === "POST" || req.method === "DELETE") && req.url === "/api/clear") {
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

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Blindfold — Usage Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #0e1117; --card: #161b22; --line: #30363d;
    --fg: #e6edf3; --dim: #8b949e;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    --accent: #6e44ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
    background: var(--bg); color: var(--fg);
    line-height: 1.5;
  }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
  h1 .logo { color: var(--accent); }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 24px; }
  .grid {
    display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    margin-bottom: 24px;
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    padding: 16px;
  }
  .card .label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; }
  .card .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
  .card .sub2 { font-size: 12px; color: var(--dim); margin-top: 4px; }
  .section-title { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; margin: 24px 0 8px; }
  table {
    width: 100%; border-collapse: collapse;
    background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
  }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { color: var(--dim); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .pill-ok    { background: rgba(63,185,80,.15);  color: var(--ok); }
  .pill-bad   { background: rgba(248,81,73,.15);  color: var(--bad); }
  .pill-warn  { background: rgba(210,153,34,.15); color: var(--warn); }
  .pill-mock  { background: rgba(110,68,255,.15); color: var(--accent); }
  .pill-real  { background: rgba(63,185,80,.15);  color: var(--ok); }
  .empty {
    background: var(--card); border: 1px dashed var(--line); border-radius: 8px;
    padding: 32px; text-align: center; color: var(--dim);
  }
  .footer {
    margin-top: 24px; padding: 16px;
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    font-size: 12px; color: var(--dim);
  }
  .footer b { color: var(--fg); }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  button {
    background: transparent; border: 1px solid var(--line); color: var(--fg);
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  code { background: rgba(255,255,255,.05); padding: 2px 5px; border-radius: 3px; font-size: 12px; }
</style>
</head>
<body>
  <div class="row">
    <div>
      <h1><span class="logo">🛡️ Blindfold</span> — Usage Dashboard</h1>
      <div class="sub">Live metadata from the local proxy · refreshing every 2s · <span id="src"></span></div>
    </div>
    <div>
      <button onclick="clearLog()">Clear log</button>
    </div>
  </div>

  <div class="grid" id="cards"></div>

  <div class="section-title">Recent activity</div>
  <div id="table-wrap"></div>

  <div class="footer">
    <b>Privacy by design.</b> This dashboard shows metadata only —
    no request bodies, no response bodies, no header values.
    The Blindfold proxy itself never sees your real API key
    (it lives inside the Terminal 3 enclave). See
    <code>packages/blindfold/src/usage-log.ts</code> for what's recorded.
  </div>

<script>
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function pillStatus(s) {
  if (s >= 200 && s < 300) return '<span class="pill pill-ok">' + s + '</span>';
  if (s >= 400)            return '<span class="pill pill-bad">' + s + '</span>';
  return '<span class="pill pill-warn">' + s + '</span>';
}
function pillMode(m) {
  return '<span class="pill pill-' + m + '">' + m + '</span>';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function clearLog() {
  await fetch('/api/clear', { method: 'POST' });
  render([]);
}
function summarize(events) {
  const total = events.length;
  const byProvider = {};
  let ok = 0, bad = 0, totalLatency = 0;
  let withAuth = 0, sentinelOk = 0;
  for (const e of events) {
    byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    if (e.status >= 200 && e.status < 300) ok++;
    if (e.status >= 400) bad++;
    totalLatency += e.latency_ms;
    if (e.agent_supplied_auth) withAuth++;
    if (e.sentinel_in_outbound) sentinelOk++;
  }
  return {
    total, byProvider, ok, bad,
    avgLatency: total ? Math.round(totalLatency / total) : 0,
    withAuth, sentinelOk,
  };
}
function render(events) {
  const s = summarize(events);
  const providers = Object.entries(s.byProvider).map(([k, v]) => k + '×' + v).join(' · ') || '—';
  document.getElementById('cards').innerHTML = [
    '<div class="card"><div class="label">Total requests</div><div class="value">' + s.total + '</div><div class="sub2">' + providers + '</div></div>',
    '<div class="card"><div class="label">2xx success</div><div class="value">' + s.ok + '</div><div class="sub2">' + s.bad + ' errors</div></div>',
    '<div class="card"><div class="label">Avg latency</div><div class="value">' + s.avgLatency + ' ms</div><div class="sub2">end-to-end through proxy</div></div>',
    '<div class="card"><div class="label">Sentinel substituted</div><div class="value">' + s.sentinelOk + '/' + s.total + '</div><div class="sub2">' + s.withAuth + ' agent-supplied auth replaced</div></div>',
  ].join('');

  if (events.length === 0) {
    document.getElementById('table-wrap').innerHTML =
      '<div class="empty">No traffic yet. Point an agent at the proxy and refresh.</div>';
    return;
  }

  const rows = events.slice().reverse().slice(0, 50).map(e => (
    '<tr>' +
      '<td>' + timeAgo(e.t) + '</td>' +
      '<td>' + escapeHtml(e.provider) + '</td>' +
      '<td><code>' + escapeHtml(e.method) + ' ' + escapeHtml(e.path) + '</code></td>' +
      '<td>' + pillStatus(e.status) + '</td>' +
      '<td>' + e.latency_ms + ' ms</td>' +
      '<td>' + pillMode(e.mode) + '</td>' +
      '<td>' + (e.sentinel_in_outbound ? '<span class="pill pill-ok">yes</span>' : '<span class="pill pill-bad">NO</span>') + '</td>' +
    '</tr>'
  )).join('');

  document.getElementById('table-wrap').innerHTML =
    '<table><thead><tr>' +
      '<th>When</th><th>Provider</th><th>Request</th><th>Status</th><th>Latency</th><th>Mode</th><th>Sentinel</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}
async function poll() {
  try {
    const r = await fetch('/api/events');
    const data = await r.json();
    document.getElementById('src').textContent = 'source: ' + data.source;
    render(data.events || []);
  } catch (e) {
    // ignore transient errors
  }
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>
`;
