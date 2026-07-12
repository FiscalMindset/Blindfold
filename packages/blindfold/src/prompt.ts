/**
 * Tiny stdlib-only helper for reading a secret from stdin with no echo.
 * Like `npm login` / `gh auth login --with-token` — the value passes
 * terminal → SDK → enclave and never touches the filesystem or shell
 * history.
 *
 * Behaviour:
 *   - prompts via stderr (so stdout stays clean for scripting)
 *   - puts the TTY into raw mode and reads char-by-char
 *   - handles Enter (commit), Backspace, Ctrl+C (abort)
 *   - never prints the typed characters
 *
 * If stdin isn't a TTY (e.g. CI), we read a line normally without raw
 * mode so piping still works (`echo $KEY | blindfold register …`).
 */

export async function readSecretLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;

  // Non-TTY path: just read one line. Useful for piped input.
  if (!stdin.isTTY) {
    return await readOneLine(stdin);
  }

  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: string | Buffer): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          cleanup();
          process.stderr.write("\n");
          reject(new Error("aborted by user"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        // Ignore other control chars
        if (ch >= " " || ch === "\t") buf += ch;
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Read one visible line from stdin (echo on). For non-secret prompts like an
 * emailed OTP code, where hiding the input would just confuse the user.
 */
export async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) return await readOneLine(stdin);
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.pause();
    };
    const onData = (chunk: string | Buffer): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          process.stderr.write("\n");
          cleanup();
          resolve(buf);
          return;
        }
        if (ch === "") { // Ctrl+C
          cleanup();
          reject(new Error("aborted"));
          return;
        }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function readOneLine(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (d) => {
      buf += d;
    });
    stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    stdin.on("error", reject);
  });
}
