/**
 * Blindfold test runner.
 *
 *   npm run test:report
 *
 * Runs the full test battery and APPENDS a timestamped block to
 * output_analysis.md. Never overwrites — every run lives in history.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPORT = path.join(ROOT, "output_analysis.md");
const HEAD_MARK = "<!-- TEST_RUNS_BELOW -->";

interface TestResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function record(id: string, title: string, passed: boolean, detail: string): void {
  results.push({ id, title, passed, detail });
  const mark = passed ? "✅" : "🚨";
  process.stdout.write(`  ${mark}  ${id}  ${title}\n`);
}

async function step(id: string, title: string, fn: () => Promise<{ passed: boolean; detail: string }>): Promise<void> {
  try {
    const r = await fn();
    record(id, title, r.passed, r.detail);
  } catch (e) {
    record(id, title, false, `threw: ${(e as Error).message.slice(0, 200)}`);
  }
}

async function waitForPort(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await httpGet(`http://127.0.0.1:${port}/health`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

function run(cmd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c) => outChunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    const t = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (t) clearTimeout(t);
      resolve({
        code: code ?? -1,
        out: Buffer.concat(outChunks).toString("utf8"),
        err: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

function httpPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main(): Promise<void> {
  process.stdout.write("\n═══ Blindfold test battery ═══\n\n");

  await step("T1", "Side-by-side demo (A leaks real key, B leaks only sentinel)", async () => {
    const r = await run("npx", ["tsx", "demo/run-demo.ts"], { timeoutMs: 30000 });
    const leakedReal = r.out.includes("sk-live-DEMO-abc123XYZ") && r.out.includes("LEAK CONFIRMED");
    const sentinelOnly = r.out.includes('"__BLINDFOLD__"') && r.out.includes("NO USEFUL LEAK");
    return {
      passed: leakedReal && sentinelOnly && r.code === 0,
      detail: `exit=${r.code}; A_leaked_real=${leakedReal}; B_sentinel_only=${sentinelOnly}`,
    };
  });

  await step("T2", "CLI doctor runs and reports mode + credential status", async () => {
    // Force mock so this is deterministic in CI (no .env). Asserts doctor runs,
    // reports MOCK mode, and prints both credential-status lines.
    const r = await run("npx", ["tsx", "packages/blindfold/bin/blindfold.ts", "doctor"], {
      env: { BLINDFOLD_MOCK: "1" },
      timeoutMs: 10000,
    });
    return {
      passed: r.code === 0
        && /mode:\s*MOCK/.test(r.out)
        && /T3N_API_KEY set:/.test(r.out)
        && /DID set:/.test(r.out),
      detail: r.out.trim().split("\n").slice(0, 2).join(" | "),
    };
  });

  await step("T3", "register never logs the plaintext secret", async () => {
    const secret = `sk-test-DO-NOT-LEAK-${Date.now()}`;
    const r = await run(
      "npx",
      ["tsx", "packages/blindfold/bin/blindfold.ts", "register", "--name", "openai_api_key", "--from-env", "OPENAI_API_KEY"],
      // Use a throwaway ledger so the test doesn't pollute the user's real .blindfold/sealed.jsonl.
      { env: { BLINDFOLD_MOCK: "1", OPENAI_API_KEY: secret, BLINDFOLD_SEALED_LOG: `${os.tmpdir()}/blindfold-test-sealed-${Date.now()}.jsonl` }, timeoutMs: 10000 },
    );
    const valueAppeared = (r.out + r.err).includes(secret);
    return {
      passed: r.code === 0 && !valueAppeared,
      detail: valueAppeared ? "VALUE LEAKED" : "value never appeared in stdout/stderr",
    };
  });

  // Single shared proxy for T4, T5, T6 to keep startup cost down.
  const proxy = spawn("npx", ["tsx", "packages/blindfold/bin/blindfold.ts", "proxy", "--port", "8821"], {
    cwd: ROOT,
    env: { ...process.env, BLINDFOLD_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proxyErr: Buffer[] = [];
  proxy.stderr.on("data", (c) => proxyErr.push(c));
  const ready = await waitForPort(8821, 15000);

  try {
    await step("T4", "proxy /health responds", async () => {
      if (!ready) return { passed: false, detail: "proxy did not bind within 15s" };
      const h = await httpGet("http://127.0.0.1:8821/health");
      return {
        passed: h.status === 200 && h.body.includes('"ok":true'),
        detail: `status=${h.status} body=${h.body.trim()}`,
      };
    });

    const agentBearer = `sk-FAKE-AGENT-BEARER-${Date.now()}`;
    await step("T5", "proxy forwards and returns a response", async () => {
      if (!ready) return { passed: false, detail: "proxy did not bind" };
      const f = await httpPost(
        "http://127.0.0.1:8821/v1/chat/completions",
        { authorization: `Bearer ${agentBearer}`, "content-type": "application/json" },
        JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
      );
      return { passed: f.status === 200, detail: `status=${f.status} body~=${f.body.slice(0, 80)}` };
    });

    await step("T6", "proxy logs do NOT contain agent-supplied Authorization", async () => {
      if (!ready) return { passed: false, detail: "proxy did not bind" };
      await new Promise((r) => setTimeout(r, 300));
      const logText = Buffer.concat(proxyErr).toString("utf8");
      const leaked = logText.includes(agentBearer);
      return {
        passed: !leaked,
        detail: leaked ? "BEARER FOUND IN LOGS" : `no bearer in ${logText.length} log bytes`,
      };
    });
  } finally {
    proxy.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }

  await step("T7", "wrap() mutates client: real key → sentinel", async () => {
    const probe = [
      'import { wrap, SENTINEL, DEFAULT_PORT } from "./packages/blindfold/src/index.ts";',
      'const c = { baseURL: "https://api.openai.com/v1", apiKey: "sk-REAL" };',
      'const w = wrap(c);',
      'const ok = w.baseURL === "http://127.0.0.1:" + DEFAULT_PORT + "/v1" && w.apiKey === SENTINEL && w === c;',
      'console.log(JSON.stringify({ ok, baseURL: w.baseURL, apiKey: w.apiKey }));',
    ].join("\n");
    const probePath = path.join(ROOT, ".test-wrap.tmp.ts");
    fs.writeFileSync(probePath, probe);
    const r = await run("npx", ["tsx", probePath], { timeoutMs: 10000 });
    fs.unlinkSync(probePath);
    const last = r.out.trim().split("\n").pop() ?? "{}";
    const parsed = (() => { try { return JSON.parse(last); } catch { return {}; } })() as { ok?: boolean };
    return { passed: parsed.ok === true, detail: `output=${last}` };
  });

  await step("T8", "redact() strips authorization / x-api-key / cookie", async () => {
    const probe = [
      'import { redact } from "./packages/blindfold/src/log.ts";',
      'const out = JSON.stringify({',
      '  a: redact({ headers: { authorization: "Bearer sk-LEAK-A" } }),',
      '  b: redact({ headers: [["Authorization", "Bearer sk-LEAK-B"], ["X-API-Key", "sk-LEAK-C"]] }),',
      '  c: redact({ cookie: "s=sk-LEAK-D" }),',
      '});',
      'const leaked = ["sk-LEAK-A","sk-LEAK-B","sk-LEAK-C","sk-LEAK-D"].some(s => out.includes(s));',
      'console.log(JSON.stringify({ ok: !leaked, sample: out }));',
    ].join("\n");
    const probePath = path.join(ROOT, ".test-log.tmp.ts");
    fs.writeFileSync(probePath, probe);
    const r = await run("npx", ["tsx", probePath], { timeoutMs: 10000 });
    fs.unlinkSync(probePath);
    const last = r.out.trim().split("\n").pop() ?? "{}";
    const parsed = (() => { try { return JSON.parse(last); } catch { return {}; } })() as { ok?: boolean };
    return { passed: parsed.ok === true, detail: `output=${last.slice(0, 200)}` };
  });

  await step("T9", "usage log records the request (metadata only)", async () => {
    const usagePath = path.join(ROOT, ".blindfold", "test-usage.jsonl");
    if (fs.existsSync(usagePath)) fs.unlinkSync(usagePath);
    const child = spawn("npx", ["tsx", "packages/blindfold/bin/blindfold.ts", "proxy", "--port", "8822"], {
      cwd: ROOT,
      env: { ...process.env, BLINDFOLD_MOCK: "1", BLINDFOLD_USAGE_LOG: usagePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const isUp = await waitForPort(8822, 15000);
      if (!isUp) return { passed: false, detail: "proxy did not bind" };
      await httpPost("http://127.0.0.1:8822/v1/chat/completions", { authorization: "Bearer X", "content-type": "application/json" }, "{}");
      await new Promise((r) => setTimeout(r, 300));
      const lines = fs.existsSync(usagePath) ? fs.readFileSync(usagePath, "utf8").trim().split("\n") : [];
      const event = lines[0] ? JSON.parse(lines[0]) : null;
      return {
        passed: !!event && event.provider === "openai" && event.path === "/v1/chat/completions" && event.sentinel_in_outbound === true,
        detail: `event=${JSON.stringify(event)}`,
      };
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (fs.existsSync(usagePath)) fs.unlinkSync(usagePath);
    }
  });

  // ─── append to output_analysis.md ───────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const date = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const verdict = passed === total ? "✅ ALL PASS" : `🚨 ${total - passed} FAILED`;

  const block = [
    "",
    `### Run ${date}`,
    "",
    `**${verdict}** — ${passed}/${total} tests passed.`,
    "",
    "| # | Test | Status | Detail |",
    "|---|------|--------|--------|",
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.passed ? "✅" : "🚨"} | ${r.detail.replace(/\|/g, "\\|").slice(0, 160)} |`),
    "",
  ].join("\n");

  if (!fs.existsSync(REPORT)) {
    fs.writeFileSync(REPORT, INITIAL_HEAD);
  }
  let report = fs.readFileSync(REPORT, "utf8");
  if (!report.includes(HEAD_MARK)) {
    report += "\n" + HEAD_MARK + "\n";
  }
  report = report.replace(HEAD_MARK, HEAD_MARK + block);
  fs.writeFileSync(REPORT, report);

  process.stdout.write(`\n${verdict} (${passed}/${total}). Appended run block to ${path.relative(ROOT, REPORT)}.\n`);
  process.exit(passed === total ? 0 : 1);
}

const INITIAL_HEAD = `# Blindfold — Output & Test Analysis

> A living analysis of what Blindfold does, run-by-run. Every \`npm run test:report\` appends a new run block at the **top** of the "Test runs" section below — nothing here gets overwritten.

## How this file is updated

\`\`\`bash
npm run test:report      # runs the full battery, appends a timestamped block
\`\`\`

The script lives at \`scripts/run-tests.ts\` and exits non-zero if any check fails.

## What each test analyses

### T1 — Side-by-side demo (the headline claim)

- **Without Blindfold (Agent A):** \`OPENAI_API_KEY=sk-live-…\` is in the agent's env. The agent fetches an injected page, the model takes the bait, calls \`get_env("OPENAI_API_KEY")\`, exfiltrates the value to the attacker URL.
- **With Blindfold (Agent B):** \`OPENAI_API_KEY=__BLINDFOLD__\`; the real key lives only in T3. The same code, same model, same injection — but \`get_env\` returns the sentinel, so the only thing that reaches the attacker is the sentinel.
- **What happens:** A leaks the real key; B leaks only the sentinel; both complete the legitimate summarisation task. Exit code asserted = 0.

### T2 — CLI doctor

- **Without it:** there's no way to confirm whether the wrapper actually has T3 credentials before you try to use it.
- **With it:** \`blindfold doctor\` reports REAL vs MOCK mode + which env keys are set. Catches misconfiguration at the cheapest possible point.
- **What happens:** runs \`doctor\` in MOCK mode and asserts it exits 0, reports \`mode: MOCK\`, and prints the \`T3N_API_KEY set:\` and \`DID set:\` status lines (CI-safe — no real \`.env\` required).

### T3 — register never logs the secret

- **Without it:** every line in the wrapper is a potential leak surface for the developer's plaintext key.
- **With it:** the value enters one function (\`registerSecret\`), is passed straight to T3's \`executeControl("map-entry-set", …)\`, and goes out of scope. Audit-critical.
- **What happens:** runs register with a fake secret \`sk-test-DO-NOT-LEAK-<ts>\` and greps every byte of stdout + stderr. If the secret appears anywhere, the test fails loudly.

### T4 — proxy /health

- **Without it:** can't tell from inside an agent whether the proxy is up before sending real traffic.
- **With it:** \`GET /health\` → \`{ok:true, mock:…}\` is the trivial readiness probe.

### T5 — proxy forward

- **Without it:** the wrapper isn't useful — there's no plumbing.
- **With it:** the proxy accepts an OpenAI-shaped request (with a fake bearer the agent sent), routes it to \`invokeForward\`, returns a response.
- **What happens:** in MOCK mode this returns the local stub; in REAL mode it would route through T3 → OpenAI.

### T6 — proxy log scrubbing (auditor-critical)

- **Without it:** even if the proxy *substitutes* the sentinel, accidental log lines could still echo the agent-supplied header value.
- **With it:** \`safeLog\` scrubs known sensitive headers; the test sends a unique bearer like \`sk-FAKE-AGENT-BEARER-<ts>\` and \`grep\`s the full stderr log for that exact string.
- **What happens:** the bearer must not appear anywhere. If it does, the test fails.

### T7 — wrap() removes the real key

- **Without it:** developers using \`wrap(new OpenAI())\` might wrongly assume the SDK still holds their real key.
- **With it:** \`wrap()\` overwrites both \`baseURL\` (→ proxy) and \`apiKey\` (→ sentinel) on the SDK object. The original key field is gone.
- **What happens:** asserts \`apiKey === "__BLINDFOLD__"\` and \`baseURL === "http://127.0.0.1:8787/v1"\` after wrapping.

### T8 — log helper scrubs sensitive headers

- **Without it:** any future logging change could accidentally include header values.
- **With it:** \`redact()\` handles both object and tuple-array header shapes, plus top-level fields named \`cookie\`/\`set-cookie\`/etc.
- **What happens:** runs four planted secrets through \`redact()\` and asserts none survive in the JSON output.

### T9 — usage log smoke test

- **Without it:** we'd have no visibility into how the proxy is being used.
- **With it:** every forwarded request appends a JSON line to \`.blindfold/usage.jsonl\` — metadata only (provider, path, status, latency, sentinel_in_outbound). The dashboard and \`blindfold stats\` read from this file.
- **What happens:** spawns a proxy with \`BLINDFOLD_USAGE_LOG\` pointed at a temp file, fires one request, reads the file, asserts the event has the right shape and \`sentinel_in_outbound === true\`.

## Test runs

${HEAD_MARK}
`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
