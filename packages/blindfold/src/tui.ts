/**
 * Tiny, dependency-free terminal UI primitives: responsive width, ANSI-aware
 * wrapping, rounded boxes, and a two-column command table. Used to render a
 * structured `blindfold help` that reflows to the terminal.
 */
import { c } from "./color.ts";

/** Terminal width, clamped to a readable range. */
export function termWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols >= 40) return Math.min(cols, 100);
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env >= 40) return Math.min(env, 100);
  return 80;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** True for code points most terminals render two columns wide (CJK, emoji). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff)
  );
}

/**
 * Display width of a string (ANSI-stripped), accounting for double-width CJK/
 * emoji and zero-width joiners/variation-selectors — so box borders line up.
 */
export function vlen(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, "")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) continue; // zero-width
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}
/** Pad `s` with spaces to display width `w` (ANSI/emoji aware). */
export function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - vlen(s)));
}
const padEnd = pad;

/** Word-wrap `text` to `width` columns (ANSI-aware). */
export function wrapText(text: string, width: number): string[] {
  if (width <= 4) return [text];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let cur = "";
    for (const w of words) {
      if (cur === "") cur = w;
      else if (vlen(cur) + 1 + vlen(w) <= width) cur += " " + w;
      else { out.push(cur); cur = w; }
    }
    out.push(cur);
  }
  return out.length ? out : [""];
}

// Rounded box-drawing set.
const B = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
const dim = (s: string): string => c.gray(s);

/** A banner box with a bold title and a dim subtitle, sized to the terminal. */
export function bannerBox(title: string, subtitle: string): string {
  const w = termWidth();
  const inner = w - 4;
  const top = dim(B.tl + B.h.repeat(w - 2) + B.tr);
  const bot = dim(B.bl + B.h.repeat(w - 2) + B.br);
  const row = (s: string): string => dim(B.v) + " " + padEnd(s, inner) + " " + dim(B.v);
  const lines = [top, row(c.bold(title))];
  for (const sl of wrapText(subtitle, inner)) lines.push(row(dim(sl)));
  lines.push(bot);
  return lines.join("\n");
}

/**
 * A titled box holding a two-column command table: the command in a fixed left
 * column (cyan), the description wrapped in the remaining width. Right border
 * stays aligned regardless of wrapping.
 */
export function commandBox(title: string, rows: Array<[string, string]>): string {
  const w = termWidth();
  const inner = w - 4; // inside "│ " … " │"
  const gap = 2;
  const longest = rows.reduce((m, [cmd]) => Math.max(m, vlen(cmd)), 0);
  const cmdW = Math.min(longest, Math.max(10, Math.floor(inner * 0.34)));
  const descW = Math.max(12, inner - cmdW - gap);

  // Title embedded in the top border: ╭─ Title ─────────╮ (border dim, title bold)
  const prefix = B.tl + B.h + " ";
  const fill = Math.max(0, w - vlen(prefix) - vlen(title) - 1 /* space */ - 1 /* tr */);
  const out: string[] = [dim(prefix) + c.bold(title) + dim(" " + B.h.repeat(fill) + B.tr)];

  for (const [cmd, desc] of rows) {
    const dLines = wrapText(desc, descW);
    const cmdCell = padEnd(c.cyan(cmd), cmdW);
    out.push(dim(B.v) + " " + cmdCell + " ".repeat(gap) + padEnd(dLines[0] ?? "", descW) + " " + dim(B.v));
    for (let i = 1; i < dLines.length; i++) {
      out.push(dim(B.v) + " " + " ".repeat(cmdW + gap) + padEnd(dim(dLines[i] ?? ""), descW) + " " + dim(B.v));
    }
  }
  out.push(dim(B.bl + B.h.repeat(w - 2) + B.br));
  return out.join("\n");
}

/**
 * Wrap pre-rendered content lines in a titled rounded box, padding each line to
 * the inner width so the right border stays aligned. `title` is embedded in the
 * top border. Content lines may already contain ANSI color.
 */
export function boxLines(title: string, lines: string[]): string {
  const w = termWidth();
  const inner = w - 4;
  const prefix = B.tl + B.h + " ";
  const fill = Math.max(0, w - vlen(prefix) - vlen(title) - 2);
  const out: string[] = [dim(prefix) + c.bold(title) + dim(" " + B.h.repeat(fill) + B.tr)];
  for (const l of lines) out.push(dim(B.v) + " " + pad(l, inner) + " " + dim(B.v));
  out.push(dim(B.bl + B.h.repeat(w - 2) + B.br));
  return out.join("\n");
}

/** A plain full-width rule with an optional bold label: "── Label ─────". */
export function rule(label = ""): string {
  const w = termWidth();
  if (!label) return dim(B.h.repeat(w));
  const left = B.h + B.h + " ";
  const fill = Math.max(0, w - vlen(left) - vlen(label) - 1);
  return dim(left) + c.bold(label) + dim(" " + B.h.repeat(fill));
}

/** Nearest command by edit distance, for "did you mean" suggestions. */
export function nearest(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const cand of candidates) {
    const d = editDistance(input, cand);
    if (d < bestD) { bestD = d; best = cand; }
  }
  return bestD <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}
