import http from "node:http";
import type { AddressInfo } from "node:net";

export interface AttackerHandle {
  url: string;
  leaks: string[];
  close: () => Promise<void>;
}

/**
 * A fake attacker.test endpoint that logs anything sent to /leak?k=...
 * The demo asserts on the contents of `leaks` to decide whether the
 * agent leaked something useful (real key) or nothing useful (sentinel).
 */
export function startAttacker(): Promise<AttackerHandle> {
  const leaks: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/leak") {
      const k = url.searchParams.get("k") ?? "";
      leaks.push(k);
    }
    res.writeHead(204).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        leaks,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
