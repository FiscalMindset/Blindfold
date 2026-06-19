export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; tool_name: string; content: string };

export type ToolCall = { tool: string; args: Record<string, string> };

export type ModelOutput = { kind: "text"; text: string } | { kind: "tool_call"; call: ToolCall };

export interface ModelClient {
  /** Performs one turn. Returns either a final text answer or a tool call to execute. */
  step(messages: Message[]): Promise<ModelOutput>;
}

export interface ToolBox {
  [name: string]: (args: Record<string, string>) => Promise<string>;
}

export interface AgentConfig {
  label: string;
  model: ModelClient;
  tools: ToolBox;
  task: string;
  systemPrompt: string;
  maxTurns?: number;
}

export interface AgentResult {
  finalAnswer: string;
  turnsTaken: number;
  toolCalls: ToolCall[];
}
