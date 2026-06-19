/**
 * blindfold compat — detects local agent tooling and prints the exact
 * env-var swap that routes each one through Blindfold.
 *
 * Honesty principle: where a tool's auth model is OAuth/session (not a
 * user-supplied API key), Blindfold cannot protect it. Those tools are
 * reported as "not applicable" with a clear explanation.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

const colour = process.stdout.isTTY ? (c: string, s: string) => `\x1b[${c}m${s}\x1b[0m` : (_: string, s: string) => s;
const bold = (s: string) => colour("1", s);
const dim = (s: string) => colour("2", s);
const green = (s: string) => colour("32", s);
const yellow = (s: string) => colour("33", s);
const red = (s: string) => colour("31", s);
const cyan = (s: string) => colour("36", s);

interface Tool {
  name: string;
  // How we detect it
  detect: () => Promise<DetectionResult>;
  /** "applies" → Blindfold can protect it; "oauth" → it uses session/OAuth, not a user key; "needs-base-url" → has hard-coded URL */
  applies: "applies" | "oauth-only" | "depends" | "needs-base-url";
  /** Exact change a user makes to wire it. */
  recipe: { env?: Record<string, string>; note?: string };
  // Optional explanation
  explanation?: string;
}

interface DetectionResult {
  detected: boolean;
  via: string; // "PATH", "node_modules", "config file"
  detail?: string;
}

async function detectBinary(name: string): Promise<DetectionResult> {
  return new Promise((resolve) => {
    const child = spawn("which", [name], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8").trim();
      resolve({ detected: code === 0 && !!out, via: "PATH", detail: out || undefined });
    });
    child.on("error", () => resolve({ detected: false, via: "PATH" }));
  });
}

async function detectPackage(pkg: string): Promise<DetectionResult> {
  const candidates = [
    path.join(REPO_ROOT, "node_modules", pkg),
    path.join(REPO_ROOT, "node_modules", pkg, "package.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { detected: true, via: "node_modules", detail: c };
  }
  return { detected: false, via: "node_modules" };
}

const TOOLS: Tool[] = [
  {
    name: "Claude Code (claude)",
    detect: () => detectBinary("claude"),
    applies: "depends",
    recipe: {
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/anthropic", ANTHROPIC_API_KEY: "__BLINDFOLD__" },
      note: "Only applies if you authenticate Claude Code with an Anthropic API key (enterprise/proxy mode). Default Claude Code uses claude.ai OAuth — there is no exposed key to protect.",
    },
    explanation:
      "Claude Code respects ANTHROPIC_BASE_URL when ANTHROPIC_API_KEY is set; in the default subscription/OAuth flow it does not, and Blindfold has nothing to protect.",
  },
  {
    name: "OpenCode (sst.dev/opencode)",
    detect: () => detectBinary("opencode"),
    applies: "applies",
    recipe: {
      env: { OPENAI_BASE_URL: "http://127.0.0.1:8787/v1", OPENAI_API_KEY: "__BLINDFOLD__" },
      note: "Configure your provider in ~/.config/opencode/config.json to use the proxy URL.",
    },
  },
  {
    name: "Aider",
    detect: () => detectBinary("aider"),
    applies: "applies",
    recipe: {
      env: { OPENAI_API_BASE: "http://127.0.0.1:8787/v1", OPENAI_API_KEY: "__BLINDFOLD__" },
      note: "Aider reads OPENAI_API_BASE (the older name). Same idea.",
    },
  },
  {
    name: "Continue.dev (continue)",
    detect: () => detectBinary("continue"),
    applies: "applies",
    recipe: {
      note: "Edit ~/.continue/config.json — set apiBase to http://127.0.0.1:8787/v1 and apiKey to __BLINDFOLD__ on each OpenAI-flavoured model.",
    },
  },
  {
    name: "Cline (VS Code extension)",
    detect: () => detectBinary("code"),
    applies: "applies",
    recipe: {
      note: "In Cline settings → API Provider → set baseURL to http://127.0.0.1:8787/v1 and api key to __BLINDFOLD__. (Detection here just checks for VS Code; Cline itself is a VS Code extension.)",
    },
  },
  {
    name: "OpenAI Codex CLI (codex)",
    detect: () => detectBinary("codex"),
    applies: "applies",
    recipe: { env: { OPENAI_BASE_URL: "http://127.0.0.1:8787/v1", OPENAI_API_KEY: "__BLINDFOLD__" } },
  },
  {
    name: "Cursor (desktop app)",
    detect: () => detectBinary("cursor"),
    applies: "needs-base-url",
    recipe: {
      note: "Cursor does not expose a per-request base-URL setting in current builds. If you self-host an Anthropic/OpenAI-compatible gateway, point Cursor at that, then at Blindfold from there.",
    },
  },
  {
    name: "openai (Node SDK)",
    detect: () => detectPackage("openai"),
    applies: "applies",
    recipe: { env: { OPENAI_BASE_URL: "http://127.0.0.1:8787/v1", OPENAI_API_KEY: "__BLINDFOLD__" } },
  },
  {
    name: "@anthropic-ai/sdk (Node SDK)",
    detect: () => detectPackage("@anthropic-ai/sdk"),
    applies: "applies",
    recipe: { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/anthropic", ANTHROPIC_API_KEY: "__BLINDFOLD__" } },
  },
  {
    name: "@langchain/openai (LangChain JS)",
    detect: () => detectPackage("@langchain/openai"),
    applies: "applies",
    recipe: { note: "Use `new ChatOpenAI({ apiKey: '__BLINDFOLD__', configuration: { baseURL: 'http://127.0.0.1:8787/v1' } })`." },
  },
  {
    name: "ollama (local model runner)",
    detect: () => detectBinary("ollama"),
    applies: "oauth-only",
    recipe: { note: "Ollama runs models locally with no external API key — there's no secret for Blindfold to protect. Skip." },
  },
];

export async function runCompat(opts: { json?: boolean } = {}): Promise<void> {
  const results = await Promise.all(
    TOOLS.map(async (t) => ({ tool: t, detection: await t.detect() })),
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify(results.map((r) => ({
      tool: r.tool.name,
      detected: r.detection.detected,
      detected_at: r.detection.detail,
      applies: r.tool.applies,
      env: r.tool.recipe.env,
      note: r.tool.recipe.note,
      explanation: r.tool.explanation,
    })), null, 2));
    return;
  }

  process.stdout.write(`\n${bold("🛡️  Blindfold — compatibility scan")}\n${dim("Probing local box for agent tools and SDKs Blindfold can protect.")}\n\n`);

  const detected = results.filter((r) => r.detection.detected);
  const notFound = results.filter((r) => !r.detection.detected);

  process.stdout.write(`${bold(`Detected (${detected.length}):`)}\n`);
  if (detected.length === 0) process.stdout.write(`  ${dim("(none — install one of the tools below, or just use the OpenAI/Anthropic SDK in your own code)")}\n`);
  for (const r of detected) {
    renderTool(r.tool, r.detection, true);
  }

  process.stdout.write(`\n${bold(`Not found on this machine (${notFound.length}):`)}\n`);
  for (const r of notFound) {
    renderTool(r.tool, r.detection, false);
  }

  process.stdout.write(`\n${dim("For a longer-form compatibility writeup see docs/05-compatibility.md.")}\n`);
}

function renderTool(tool: Tool, detection: DetectionResult, detected: boolean): void {
  const mark = !detected
    ? dim("·")
    : tool.applies === "applies"
      ? green("✓")
      : tool.applies === "depends"
        ? yellow("?")
        : tool.applies === "needs-base-url"
          ? yellow("!")
          : red("✖");
  const status = !detected
    ? dim("(not installed)")
    : tool.applies === "applies"
      ? green("Blindfold protects this")
      : tool.applies === "depends"
        ? yellow("Depends on how you authenticate")
        : tool.applies === "needs-base-url"
          ? yellow("No base-URL hook — needs upstream support")
          : red("Doesn't apply (no user-supplied key)");
  process.stdout.write(`  ${mark} ${bold(tool.name)}  ${dim("·")}  ${status}\n`);
  if (detected && detection.detail) process.stdout.write(`    ${dim("at " + detection.detail)}\n`);
  if (detected && tool.recipe.env) {
    const envLine = Object.entries(tool.recipe.env).map(([k, v]) => `${k}=${v}`).join("  ");
    process.stdout.write(`    ${cyan(envLine)}\n`);
  }
  if (detected && tool.recipe.note) process.stdout.write(`    ${dim(tool.recipe.note)}\n`);
  if (detected && tool.explanation) process.stdout.write(`    ${dim(tool.explanation)}\n`);
}
