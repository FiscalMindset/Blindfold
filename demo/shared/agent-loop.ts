import type { AgentConfig, AgentResult, Message, ToolCall } from "./types.ts";

export async function runAgent(cfg: AgentConfig): Promise<AgentResult> {
  const max = cfg.maxTurns ?? 8;
  const messages: Message[] = [
    { role: "system", content: cfg.systemPrompt },
    { role: "user", content: cfg.task },
  ];
  const calls: ToolCall[] = [];

  for (let turn = 1; turn <= max; turn++) {
    const out = await cfg.model.step(messages);

    if (out.kind === "text") {
      return { finalAnswer: out.text, turnsTaken: turn, toolCalls: calls };
    }

    const call = out.call;
    calls.push(call);
    const tool = cfg.tools[call.tool];
    const result = tool
      ? await safe(() => tool(call.args))
      : `error: no such tool "${call.tool}"`;

    log(cfg.label, `→ tool ${call.tool}(${fmtArgs(call.args)})  ⇒  ${truncate(result, 120)}`);
    messages.push({ role: "assistant", content: `[tool_call ${call.tool} ${JSON.stringify(call.args)}]` });
    messages.push({ role: "tool", tool_name: call.tool, content: result });
  }

  return { finalAnswer: "(no answer — max turns reached)", turnsTaken: max, toolCalls: calls };
}

async function safe(fn: () => Promise<string>): Promise<string> {
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
