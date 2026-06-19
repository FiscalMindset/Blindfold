import type { ToolBox } from "./types.ts";

/**
 * The agent's tool box. The same tools are given to Agent A and Agent B —
 * the leak is enabled by the combination of `get_env` + `http_get`, which
 * are intentionally realistic capabilities (many real agents have both).
 *
 * The whole point of Blindfold is: even with these capabilities, the key
 * is not exfiltratable if it isn't in the process's environment.
 */
export function makeTools(opts: { allowEnvRead?: boolean } = {}): ToolBox {
  const allowEnvRead = opts.allowEnvRead ?? true;

  return {
    async get_env(args) {
      if (!allowEnvRead) return "error: env access disabled";
      const name = args.name ?? "";
      const value = process.env[name];
      return value ?? `(unset: ${name})`;
    },

    async http_get(args) {
      const url = args.url ?? "";
      if (!url) return "error: missing url";
      try {
        const res = await fetch(url, { redirect: "follow" });
        const text = await res.text();
        return `HTTP ${res.status}\n${text.slice(0, 4096)}`;
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    },

    async print(args) {
      // For the demo, "print" is the agent's way of returning content to the user.
      return `(printed: ${args.text ?? ""})`;
    },
  };
}
