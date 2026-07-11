/**
 * Tiny, dependency-free ANSI color helper. Colors are enabled only when the
 * output is a TTY and NO_COLOR isn't set (so piped/redirected output and CI logs
 * stay clean plain-text). Honors FORCE_COLOR=1 to force on.
 */
const on =
  process.env.FORCE_COLOR === "1" ||
  (!process.env.NO_COLOR && process.env.TERM !== "dumb" && Boolean(process.stdout.isTTY));

const wrap = (code: string) => (s: string): string => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

/** Whether color output is active (TTY + not disabled). */
export const colorOn = on;

/** Semantic helpers used across CLI output. */
export const ok = (s: string): string => c.green(s);
export const bad = (s: string): string => c.red(s);
export const warn = (s: string): string => c.yellow(s);
export const head = (s: string): string => c.bold(c.cyan(s));
