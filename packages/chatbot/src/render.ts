/**
 * Terminal renderer — ANSI colours, width-aware wrapping, tables, boxes.
 *
 * No external deps. Designed to look like a dense, technical CLI tool —
 * not a soft chat widget. Matches the Blindfold aesthetic.
 */

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const RESET = `${ESC}0m`;

export const C = {
  // foregrounds
  fg:    (s: string) => `${ESC}38;5;252m${s}${RESET}`,
  dim:   (s: string) => `${ESC}38;5;245m${s}${RESET}`,
  mute:  (s: string) => `${ESC}38;5;240m${s}${RESET}`,
  bold:  (s: string) => `${ESC}1m${s}${RESET}`,
  italic:(s: string) => `${ESC}3m${s}${RESET}`,
  underline: (s: string) => `${ESC}4m${s}${RESET}`,
  // accents
  green: (s: string) => `${ESC}38;5;114m${s}${RESET}`,
  amber: (s: string) => `${ESC}38;5;221m${s}${RESET}`,
  blue:  (s: string) => `${ESC}38;5;111m${s}${RESET}`,
  violet:(s: string) => `${ESC}38;5;183m${s}${RESET}`,
  cyan:  (s: string) => `${ESC}38;5;117m${s}${RESET}`,
  red:   (s: string) => `${ESC}38;5;210m${s}${RESET}`,
  // roles
  user:  (s: string) => `${ESC}38;5;111m${s}${RESET}`,         // blue
  assistant: (s: string) => `${ESC}38;5;114m${s}${RESET}`,     // green
  system:    (s: string) => `${ESC}38;5;221m${s}${RESET}`,     // amber
  // box drawing
  border:    (s: string) => `${ESC}38;5;240m${s}${RESET}`,
  borderBright: (s: string) => `${ESC}38;5;245m${s}${RESET}`,
  accent:    (s: string) => `${ESC}38;5;114m${s}${RESET}`,
};

// ─── Width detection ──────────────────────────────────────────────────────────
function getWidth(): number {
  // Try stdout.columns; fall back to env; fall back to 100.
  const cols = (process.stdout as any).columns;
  if (typeof cols === "number" && cols > 40) return Math.min(cols, 140);
  const envCols = Number(process.env.COLUMNS);
  if (Number.isFinite(envCols) && envCols > 40) return Math.min(envCols, 140);
  return 100;
}

// ─── Strip ANSI for width calculation ─────────────────────────────────────────
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Word wrap (respecting ANSI codes) ───────────────────────────────────────
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") { lines.push(""); continue; }
    const words = para.split(/(\s+)/); // keep spaces
    let current = "";
    let currentLen = 0;
    for (const w of words) {
      const wStripped = stripAnsi(w).length;
      if (currentLen + wStripped > width) {
        if (current) lines.push(current);
        current = w.trimStart();
        currentLen = stripAnsi(current).length;
      } else {
        current += w;
        currentLen += wStripped;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

// ─── Box drawing characters ──────────────────────────────────────────────────
const BOX = {
  tl: "┌", tr: "┐", bl: "└", br: "┘",
  h:  "─", v:  "│",
  // bright corners for headers
  hBright: "━",
};

// ─── Header line ──────────────────────────────────────────────────────────────
export function header(role: "user" | "assistant" | "system", meta: string[] = []): string {
  const w = getWidth();
  const roleText = role.toUpperCase();
  const metaText = meta.filter(Boolean).join("  ·  ");
  // Build: "┌─ ASSISTANT  ·  intent=foo · aud=bar · conf=0.95 ────...──┐"
  const left = `${roleText}${metaText ? "  ·  " + metaText : ""}`;
  const leftVisibleLen = stripAnsi(left).length;
  const innerWidth = w - 2; // subtract the two border chars
  const pad = innerWidth - leftVisibleLen - 4; // 4 = leading "─ " and trailing " "
  const paddedLeft = `─ ${left} ` + "─".repeat(Math.max(0, pad));
  const line = C.border(BOX.tl) + C.borderBright(paddedLeft) + C.border(BOX.tr);
  return line;
}

export function footer(): string {
  const w = getWidth();
  const innerWidth = w - 2;
  return C.border(BOX.bl) + C.border("─".repeat(innerWidth)) + C.border(BOX.br);
}

// ─── Message body wrapper ────────────────────────────────────────────────────
export function box(role: "user" | "assistant" | "system", meta: string[], content: string): string {
  const w = getWidth();
  const innerWidth = w - 4; // "│ " and " │"
  const lines = wrap(content, innerWidth);
  const out: string[] = [];
  out.push(header(role, meta));
  for (const line of lines) {
    out.push(`${C.border(BOX.v)} ${line}${" ".repeat(Math.max(0, innerWidth - stripAnsi(line).length))} ${C.border(BOX.v)}`);
  }
  out.push(footer());
  return out.join("\n");
}

// ─── Single-column header ────────────────────────────────────────────────────
export function thinHeader(title: string): string {
  const w = getWidth();
  const left = `─ ${title} `;
  const pad = w - stripAnsi(left).length;
  return C.borderBright(left) + C.border("─".repeat(Math.max(0, pad)));
}

// ─── Markdown to terminal ────────────────────────────────────────────────────
//
// Same minimal renderer as the web UI, but emits ANSI-coloured text instead
// of HTML. Handles: code fences, inline code, headings, bullets, numbered
// lists, bold/italic, blockquotes, horizontal rules, tables, links.
export function renderMarkdown(md: string): string {
  if (!md) return "";
  let s = md;

  // Code fences ```lang\n…\n```
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const trimmed = code.replace(/\n+$/, "");
    const lines = trimmed.split("\n");
    const w = Math.min(getWidth() - 6, 120);
    const out: string[] = [];
    out.push(C.border("  ┌" + "─".repeat(w + 2) + "┐"));
    for (const line of lines) {
      const visible = stripAnsi(line);
      const padded = visible + " ".repeat(Math.max(0, w - visible.length));
      out.push(`${C.border("  │")} ${C.cyan(padded)} ${C.border("│")}`);
    }
    out.push(C.border("  └" + "─".repeat(w + 2) + "┘"));
    return "\n" + out.join("\n") + "\n";
  });

  // Inline code
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => C.cyan(c));

  // Headings
  s = s.replace(/^######\s+(.+)$/gm, (_m, t) => C.bold(C.cyan(t)));
  s = s.replace(/^#####\s+(.+)$/gm, (_m, t) => C.bold(C.cyan(t)));
  s = s.replace(/^####\s+(.+)$/gm, (_m, t) => C.bold(C.cyan(t)));
  s = s.replace(/^###\s+(.+)$/gm, (_m, t) => C.bold(C.fg(t)));
  s = s.replace(/^##\s+(.+)$/gm, (_m, t) => "\n" + C.bold(C.green(t)) + "\n");
  s = s.replace(/^#\s+(.+)$/gm, (_m, t) => "\n" + C.bold(C.green(t)) + "\n");

  // Blockquotes
  s = s.replace(/^>\s?(.+)$/gm, (_m, t) => C.border("  ▎ ") + C.italic(C.dim(t)));

  // Horizontal rule
  s = s.replace(/^---$/gm, () => C.border("─".repeat(getWidth())));

  // Bold / italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => C.bold(t));
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, t) => pre + C.italic(t));

  // Links [label](url) → just label in colour
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label) => C.underline(C.blue(label)));

  // Tables
  s = renderTablesTerm(s);

  // Lists
  s = renderListsTerm(s);

  return s;
}

function renderTablesTerm(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line && /^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1] ?? "")) {
      // Header row
      const header = parseRowTerm(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i] ?? "")) {
        body.push(parseRowTerm(lines[i]));
        i++;
      }
      // Compute widths.
      const all = [header, ...body];
      const widths = header.map((_, c) => Math.max(...all.map((r) => stripAnsi(r[c] ?? "").length), 3));
      const w = getWidth();
      const totalWidth = widths.reduce((a, b) => a + b + 3, 0); // "| " + cell + " |"
      const truncate = Math.min(totalWidth, w - 2);
      out.push(C.border("  ┌" + "─".repeat(truncate) + "┐"));
      // header
      out.push(formatRowTerm(header, widths, truncate));
      out.push(C.border("  ├" + widths.map((c) => "─".repeat(c + 2)).join("┼") + "┤"));
      for (const r of body) {
        out.push(formatRowTerm(r, widths, truncate));
      }
      out.push(C.border("  └" + widths.map((c) => "─".repeat(c + 2)).join("┴") + "┘"));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

function parseRowTerm(row: string): string[] {
  return row.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim());
}

function formatRowTerm(row: string[], widths: number[], totalWidth: number): string {
  const cells = row.map((c, i) => {
    const v = stripAnsi(c);
    const pad = " ".repeat(Math.max(0, (widths[i] ?? 3) - v.length));
    return " " + c + pad + " ";
  });
  let line = C.border("  │") + cells.join(C.border("│")) + C.border("│");
  // Truncate if necessary.
  if (stripAnsi(line).length > totalWidth + 4) {
    line = stripAnsi(line).slice(0, totalWidth + 4);
  }
  return line;
}

function renderListsTerm(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let inList = false;
  let ordered = false;
  let counter = 0;
  for (const line of lines) {
    const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)/);
    if (m) {
      const isOrdered = /^\d+\./.test(m[2]);
      if (!inList || ordered !== isOrdered) {
        if (inList) out.push("");
        inList = true;
        ordered = isOrdered;
        counter = 0;
      }
      counter++;
      const prefix = isOrdered ? `${C.amber(`${counter}.`)} ` : `${C.green("•")} `;
      out.push(`  ${prefix}${m[3]}`);
    } else {
      if (inList) { out.push(""); inList = false; }
      out.push(line);
    }
  }
  return out.join("\n");
}

// ─── Sources / related renderers ─────────────────────────────────────────────
export function renderSources(sources: Array<{ label: string; url?: string; type?: string }>): string {
  if (!sources || sources.length === 0) return "";
  const out: string[] = [];
  out.push("");
  out.push(C.borderBright("─ ") + C.bold("sources"));
  for (const s of sources.slice(0, 8)) {
    const tag = s.type ? C.mute(` (${s.type})`) : "";
    const link = s.url && s.url !== s.label ? C.mute(`  → ${s.url}`) : "";
    out.push(`  ${C.green("▸")} ${C.fg(s.label)}${tag}${link}`);
  }
  return out.join("\n");
}

export function renderRelated(related: Array<{ question: string; intent?: string }>): string {
  if (!related || related.length === 0) return "";
  const out: string[] = [];
  out.push("");
  out.push(C.borderBright("─ ") + C.bold("related"));
  for (const r of related.slice(0, 4)) {
    out.push(`  ${C.cyan("→")} ${r.question}`);
  }
  return out.join("\n");
}

// ─── Public entry: render a full ChatResponse ────────────────────────────────
export interface RenderableResponse {
  intent: string;
  audience?: string;
  confidence: number;
  usedFallback?: boolean;
  message: string;
  sources: Array<{ label: string; url?: string; type?: string }>;
  related: Array<{ question: string; intent?: string }>;
}

export function renderResponse(r: RenderableResponse): string {
  const meta: string[] = [];
  meta.push(C.green(r.intent));
  if (r.audience && r.audience !== "general") {
    meta.push(audienceColor(r.audience)(r.audience));
  }
  meta.push(C.mute(`conf ${r.confidence.toFixed(2)}`));
  if (r.usedFallback) meta.push(C.amber("fallback"));
  const body = renderMarkdown(r.message);
  return box("assistant", meta, body) + renderSources(r.sources) + renderRelated(r.related);
}

export function renderUserMessage(msg: string): string {
  return box("user", [C.mute("you")], C.bold(msg));
}

export function renderWelcome(): string {
  const w = getWidth();
  const inner = w - 4;
  const out: string[] = [];
  const banner = [
    "  ____  _ _               _  __     _           _       ",
    " | __ )| (_)___ ___  ___ |  \\/  __| |_  ___ __| |_ ___ ",
    " |  _ \\| | / __/ _ \\/ _ \\| |\\/| / _` | |/ _ \\/ _` \\/ -_)|",
    " | |_) | | (_| __/ __/ ___ | |  | (_| | | __/ (_| |\\__ \\",
    " |____/|_|\\___\\___|\\___||_|  |_|\\__,_|_|\\___|\\__,_||___/",
  ];
  out.push("");
  for (const line of banner) {
    const pad = " ".repeat(Math.max(0, inner - line.length));
    out.push(C.border(BOX.v) + " " + C.green(line) + C.mute(pad) + " " + C.border(BOX.v));
  }
  out.push(C.border(BOX.v) + " " + " ".repeat(inner) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + C.bold("Rule-based Q&A for the Blindfold project") + " ".repeat(Math.max(0, inner - 41 - 6)) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + C.dim("481 KB entries  ·  audience-aware  ·  source-cited") + " ".repeat(Math.max(0, inner - 54)) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + " ".repeat(inner) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + C.dim("Try:") + " ".repeat(Math.max(0, inner - 5)) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + "  " + C.fg("• what is blindfold?") + " ".repeat(Math.max(0, inner - 24)) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + "  " + C.fg("• how does the proxy work?") + " ".repeat(Math.max(0, inner - 30)) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + "  " + C.fg("• vs vault?") + " ".repeat(Math.max(0, inner - 13)) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + "  " + C.fg("• how do i register a key?") + " ".repeat(Math.max(0, inner - 28)) + C.border(BOX.v));
  out.push(C.border(BOX.v) + " " + C.dim("Type /help for commands. /audience developer|user|founder|enterprise|researcher") + " ".repeat(Math.max(0, inner - 70)) + C.border(BOX.v));
  out.push(C.border(BOX.bl + "─".repeat(inner) + BOX.br));
  return out.join("\n");
}

export function audienceColor(audience: string): (s: string) => string {
  switch (audience) {
    case "user":       return C.fg;
    case "developer":  return C.amber;
    case "founder":    return C.blue;
    case "enterprise": return C.violet;
    case "researcher": return C.cyan;
    default:           return C.dim;
  }
}

// ─── Utility: force colours off if NO_COLOR or dumb terminal ────────────────
export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR === "1") return true;
  return Boolean(process.stdout.isTTY);
}

let colorsEnabled = shouldUseColor();

export function setColors(on: boolean): void {
  colorsEnabled = on;
  if (!on) {
    // Replace all colour helpers with identity.
    for (const k of Object.keys(C) as Array<keyof typeof C>) {
      (C as any)[k] = (s: string) => s;
    }
  }
}