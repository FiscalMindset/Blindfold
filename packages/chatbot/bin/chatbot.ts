#!/usr/bin/env node
/**
 * Blindfold Chatbot CLI.
 *
 * Modes:
 *   (default)            — interactive REPL
 *   blindfold-chatbot ask "<message>"   — single question, JSON or markdown out
 *   blindfold-chatbot serve             — start the web server
 *   blindfold-chatbot audit             — list all KB entries
 *   blindfold-chatbot stats             — engine stats
 *   blindfold-chatbot extract           — (re-)run knowledge extraction pipeline
 *
 * API key handling:
 *   - BLINDFOLD_CHATBOT_API_KEY / BLINDFOLD_CHATBOT_BASE_URL / BLINDFOLD_CHATBOT_MODEL
 *     are the env vars. The key is read ONCE and dropped on exit.
 *   - If you have Blindfold set up with a sealed secret named `chatbot_api_key`,
 *     run `blindfold use --name chatbot_api_key --as BLINDFOLD_CHATBOT_API_KEY -- ...`.
 *   - The CLI never logs the key value. Only `length` or fingerprint.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { ChatbotEngine } from "../src/engine.js";
import { loadKB } from "../src/knowledge.js";
import { startServer } from "../src/server.js";
import {
  C,
  renderResponse,
  renderUserMessage,
  renderWelcome,
  shouldUseColor,
  setColors,
} from "../src/render.js";
import type { Audience, ChatMessage, ChatRequest, ChatResponse } from "../src/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

type Argv = { _: string[]; flags: Record<string, string | boolean> };

function parseArgv(argv: string[]): Argv {
  const out: Argv = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags[key] = next;
        i += 1;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function envOpt(name: string, fallback?: string): string | undefined {
  return process.env[name] && process.env[name]!.length > 0 ? process.env[name] : fallback;
}

function buildEngine(): ChatbotEngine {
  return new ChatbotEngine({
    knowledgePath: path.resolve(REPO_ROOT, "packages/chatbot/data/knowledge.json"),
    intentsPath: path.resolve(REPO_ROOT, "packages/chatbot/data/intents.json"),
    enableLLMFallback: envOpt("BLINDFOLD_CHATBOT_API_KEY") !== undefined,
    llmApiKey: envOpt("BLINDFOLD_CHATBOT_API_KEY"),
    llmBaseUrl: envOpt("BLINDFOLD_CHATBOT_BASE_URL", "https://samagama.in/platform/proxy/v1"),
    llmModel: envOpt("BLINDFOLD_CHATBOT_MODEL", "MiniMax-M3"),
  });
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0] ?? "repl";

  switch (cmd) {
    case "ask": {
      const msg = argv._.slice(1).join(" ").trim();
      if (!msg) die("usage: blindfold-chatbot ask '<message>' [--audience developer]");
      const audience = argv.flags.audience as Audience | undefined;
      const engine = buildEngine();
      const out = await engine.ask({ message: msg, audience });
      if (argv.flags.json) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else if (argv.flags.raw) {
        process.stdout.write(out.message + "\n");
      } else {
        // Default: coloured box-rendered output.
        process.stdout.write("\n");
        process.stdout.write(renderUserMessage(msg) + "\n");
        process.stdout.write(renderResponse(out) + "\n");
      }
      return;
    }

    case "serve": {
      const port = Number(argv.flags.port ?? process.env.PORT ?? 8788);
      const cors = argv.flags.cors === true || argv.flags.cors === "true";
      const server = await startServer({
        port,
        host: (argv.flags.host as string) ?? "127.0.0.1",
        enableLLMFallback: !!envOpt("BLINDFOLD_CHATBOT_API_KEY"),
        llmApiKey: envOpt("BLINDFOLD_CHATBOT_API_KEY"),
        llmBaseUrl: envOpt("BLINDFOLD_CHATBOT_BASE_URL", "https://samagama.in/platform/proxy/v1"),
        llmModel: envOpt("BLINDFOLD_CHATBOT_MODEL", "MiniMax-M3"),
        cors,
      });
      console.log(`  open ${server.url}  in your browser. Ctrl-C to stop.`);
      // Wait forever.
      await new Promise(() => {});
      return;
    }

    case "audit": {
      const kb = loadKB(path.resolve(REPO_ROOT, "packages/chatbot/data/knowledge.json"));
      const filter = argv._[1]?.toLowerCase();
      const list = kb.entries.filter((e) =>
        !filter ||
        e.intent.toLowerCase().includes(filter) ||
        e.question.toLowerCase().includes(filter) ||
        (e.audience ?? []).some((a) => a.includes(filter)),
      );
      console.log(`KB: ${list.length} / ${kb.entries.length} entries.`);
      for (const e of list) {
        console.log(`  • [${e.intent}] (${e.confidence.toFixed(2)}) ${e.question}`);
      }
      return;
    }

    case "stats": {
      const engine = buildEngine();
      console.log(JSON.stringify(engine.getStats(), null, 2));
      return;
    }

    case "extract": {
      const { spawn } = await import("node:child_process");
      const child = spawn(
        "npx",
        ["tsx", path.resolve(REPO_ROOT, "packages/chatbot/bin/extract-knowledge.ts")],
        { stdio: "inherit", env: process.env },
      );
      child.on("exit", (c) => process.exit(c ?? 0));
      return;
    }

    case "help":
    case "--help":
    case "-h": {
      printHelp();
      return;
    }

    case "repl":
    default: {
      await repl(argv);
      return;
    }
  }
}

async function repl(argv: Argv): Promise<void> {
  const engine = buildEngine();
  const audience = (argv.flags.audience as Audience | undefined) ?? undefined;
  const history: ChatMessage[] = [];

  process.stdout.write(renderWelcome() + "\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("close", () => process.exit(0));

  const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

  while (true) {
    let line: string;
    try {
      line = await ask(C.green("❯ ") + " ");
    } catch {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("/")) {
      const out = handleReplCommand(trimmed, engine, history, audience);
      if (out === "exit") break;
      if (out) process.stdout.write(out + "\n");
      continue;
    }

    process.stdout.write(renderUserMessage(trimmed) + "\n");
    const req: ChatRequest = { message: trimmed, audience, history: [...history] };
    const out = await engine.ask(req);
    process.stdout.write(renderResponse(out) + "\n");
    history.push({ role: "user", content: trimmed, timestamp: Date.now() });
    history.push({ role: "assistant", content: out.message, timestamp: Date.now() });
    while (history.length > 12) history.shift();
  }
}

let currentAudience: Audience | undefined;

function handleReplCommand(
  cmd: string,
  engine: ChatbotEngine,
  _history: ChatMessage[],
  defaultAud: Audience | undefined,
): string | null {
  const [name, ...rest] = cmd.slice(1).split(/\s+/);
  switch (name) {
    case "exit":
    case "quit":
    case "q":
      return "exit";
    case "help": {
      printHelp();
      return null;
    }
    case "audience": {
      const a = rest[0] as Audience | undefined;
      if (!a) return `current audience: ${currentAudience ?? defaultAud ?? "auto-detect"}`;
      currentAudience = a;
      return `audience pinned to: ${a}`;
    }
    case "stats": {
      return JSON.stringify(engine.getStats(), null, 2);
    }
    case "audit": {
      const kb = loadKB(path.resolve(REPO_ROOT, "packages/chatbot/data/knowledge.json"));
      const filter = rest[0]?.toLowerCase();
      const list = kb.entries.filter((e) =>
        !filter ||
        e.intent.toLowerCase().includes(filter) ||
        e.question.toLowerCase().includes(filter),
      );
      return `${list.length} / ${kb.entries.length} entries:\n` +
        list.slice(0, 20).map((e) => `  • [${e.intent}] ${e.question}`).join("\n") +
        (list.length > 20 ? `\n  …and ${list.length - 20} more.` : "");
    }
    case "clear": {
      process.stdout.write("\x1b[2J\x1b[H");
      return null;
    }
    default:
      return `unknown command: /${name}. type /help.`;
  }
}

function renderMarkdown(out: ChatResponse): string {
  // Legacy fallback — should not be called directly. Kept for backwards compat.
  return renderResponse(out);
}

function printHelp(): void {
  console.log(`blindfold-chatbot — the rule-based chatbot for the Blindfold project

Usage:
  blindfold-chatbot                              Interactive REPL (default)
  blindfold-chatbot ask '<message>'              Single question, markdown out
  blindfold-chatbot ask '<message>' --json       Single question, JSON out
  blindfold-chatbot serve [--port 8788]          Start the web server
  blindfold-chatbot audit [filter]               List KB entries
  blindfold-chatbot stats                        Engine stats
  blindfold-chatbot extract                      (Re-)run knowledge extraction pipeline

Environment:
  BLINDFOLD_CHATBOT_API_KEY    (optional) — enables LLM fallback when rule confidence is low
  BLINDFOLD_CHATBOT_BASE_URL   (default: https://samagama.in/platform/proxy/v1)
  BLINDFOLD_CHATBOT_MODEL      (default: MiniMax-M3)
  BLINDFOLD_MOCK=1                              Use offline mock for the extractor (CI)

REPL commands:
  /help                    Show this help
  /audience <role>         Pin audience: user|developer|founder|enterprise|researcher
  /audience                Show current pinned audience
  /stats                   Show engine stats
  /audit [filter]          List relevant KB entries
  /clear                   Clear screen
  /exit, /quit, /q         Exit
`);
}

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});