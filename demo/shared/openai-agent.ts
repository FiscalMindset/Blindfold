/**
 * A real agent loop that uses the OpenAI Node SDK.
 *
 * Unlike the original mock-llm + agent-loop pattern, this makes genuine
 * HTTP calls to whatever baseURL the OpenAI client is pointed at. For
 * Agent A that's the mock OpenAI server directly. For Agent B that's the
 * Blindfold demo proxy, which intercepts, substitutes, and forwards.
 *
 * The tool definitions match the shared makeTools() box (http_get, get_env).
 */
import OpenAI from "openai";
import type { ToolBox } from "./types.ts";

export interface OpenAIAgentConfig {
  label: string;
  openai: OpenAI;
  tools: ToolBox;
  task: string;
  systemPrompt: string;
  maxTurns?: number;
}

export interface OpenAIAgentResult {
  finalAnswer: string;
  turnsTaken: number;
}

const TOOL_DEFS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "http_get",
      description: "Fetch a URL and return its text content.",
      parameters: {
        type: "object" as const,
        properties: { url: { type: "string", description: "URL to GET" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_env",
      description: "Read an environment variable by name.",
      parameters: {
        type: "object" as const,
        properties: { name: { type: "string", description: "Variable name" } },
        required: ["name"],
      },
    },
  },
];

export async function runOpenAIAgent(cfg: OpenAIAgentConfig): Promise<OpenAIAgentResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: cfg.systemPrompt },
    { role: "user", content: cfg.task },
  ];

  const max = cfg.maxTurns ?? 8;

  for (let turn = 1; turn <= max; turn++) {
    const resp = await cfg.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools: TOOL_DEFS,
      tool_choice: "auto",
    });

    const choice = resp.choices[0];
    messages.push(choice.message as OpenAI.Chat.ChatCompletionMessageParam);

    if (choice.finish_reason === "stop" || !choice.message.tool_calls?.length) {
      return { finalAnswer: choice.message.content ?? "(no answer)", turnsTaken: turn };
    }

    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as Record<string, string>;
      log(cfg.label, `→ tool ${tc.function.name}(${fmtArgs(args)})`);

      const toolFn = cfg.tools[tc.function.name];
      const result = toolFn
        ? await safeCall(() => toolFn(args))
        : `error: unknown tool "${tc.function.name}"`;

      log(cfg.label, `  ⇒ ${truncate(result, 120)}`);

      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  return { finalAnswer: "(max turns reached)", turnsTaken: max };
}

async function safeCall(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

function fmtArgs(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(truncate(v, 60))}`)
    .join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function log(label: string, line: string): void {
  process.stdout.write(`  [${label}] ${line}\n`);
}
