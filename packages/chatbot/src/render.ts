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
// A line-oriented renderer that emits width-aware ANSI lines (NOT a fixed-width
// box). Prose reflows to the terminal; code blocks get a left bar; tables and
// lists render cleanly and shrink to fit. The caller applies a left gutter.
// Handles: code fences, inline code, headings, lists, bold/italic, blockquotes,
// horizontal rules, tables, links.

/** Inline formatting: code, bold, italic, links. Applied to non-code text. */
function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, (_m, c) => C.cyan(c))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => C.bold(t))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, t) => pre + C.italic(t))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label) => C.underline(C.blue(label)));
}

function isSpecialLine(l: string): boolean {
  return /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*---+\s*$/.test(l) ||
    /^>\s?/.test(l) || /^(\s*)([-*+]|\d+\.)\s+/.test(l) || /^\s*\|.+\|\s*$/.test(l);
}

function isTableAt(src: string[], i: number): boolean {
  return /^\s*\|.+\|\s*$/.test(src[i] ?? "") && /^\s*\|[\s\-:|]+\|\s*$/.test(src[i + 1] ?? "");
}

function parseRowTerm(row: string): string[] {
  return row.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim());
}

/**
 * Render markdown to an array of display lines, each fitting `width` columns.
 * No gutter/box — the caller indents. Returns reflowed, structured output.
 */
export function renderMarkdownLines(md: string, width: number): string[] {
  const cw = Math.max(24, width);
  const src = (md ?? "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  const pushBlank = (): void => { if (out.length && out[out.length - 1] !== "") out.push(""); };
  let i = 0;
  while (i < src.length) {
    const line = src[i] ?? "";

    // Fenced code block
    if (/^\s*```/.test(line)) {
      i++;
      const code: string[] = [];
      while (i < src.length && !/^\s*```/.test(src[i] ?? "")) { code.push(src[i] ?? ""); i++; }
      i++; // closing fence
      pushBlank();
      const inner = cw - 2;
      for (const cl of code) {
        const shown = cl.length > inner ? cl.slice(0, inner - 1) + "…" : cl;
        out.push(C.border("▌ ") + C.cyan(shown));
      }
      out.push("");
      continue;
    }

    // Table
    if (isTableAt(src, i)) {
      const rows: string[][] = [parseRowTerm(src[i] ?? "")];
      i += 2;
      while (i < src.length && /^\s*\|.+\|\s*$/.test(src[i] ?? "")) { rows.push(parseRowTerm(src[i] ?? "")); i++; }
      pushBlank();
      for (const tl of renderTableLines(rows, cw)) out.push(tl);
      out.push("");
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      pushBlank();
      const t = inline(h[2] ?? "");
      out.push((h[1] ?? "").length <= 2 ? C.bold(C.green(t)) : C.bold(C.fg(t)));
      out.push("");
      i++; continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(line)) { out.push(C.border("─".repeat(cw))); i++; continue; }

    // Blockquote
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      for (const wl of wrap(inline(bq[1] ?? ""), cw - 2)) out.push(C.border("▎ ") + C.dim(wl));
      i++; continue;
    }

    // List item (indent-aware, wraps continuations under the text)
    const li = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (li) {
      const indent = Math.min((li[1] ?? "").length, cw - 8);
      const ordered = /\d+\./.test(li[2] ?? "");
      const marker = ordered ? C.amber(li[2] ?? "") : C.green("•");
      const pad = " ".repeat(indent);
      const markerLen = stripAnsi(ordered ? (li[2] ?? "") : "•").length;
      const wrapped = wrap(inline(li[3] ?? ""), Math.max(8, cw - indent - markerLen - 1));
      out.push(pad + marker + " " + (wrapped[0] ?? ""));
      for (let k = 1; k < wrapped.length; k++) out.push(pad + " ".repeat(markerLen + 1) + wrapped[k]);
      i++; continue;
    }

    // Blank
    if (line.trim() === "") { pushBlank(); i++; continue; }

    // Prose paragraph — gather consecutive plain lines, then reflow
    const para: string[] = [];
    while (i < src.length && (src[i] ?? "").trim() !== "" && !isSpecialLine(src[i] ?? "")) {
      para.push(src[i] ?? ""); i++;
    }
    for (const wl of wrap(inline(para.join(" ")), cw)) out.push(wl);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Render a markdown table to ANSI lines, shrinking columns to fit `maxWidth`. */
function renderTableLines(rows: string[][], maxWidth: number): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => { const c = r.slice(); while (c.length < cols) c.push(""); return c; });
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...norm.map((r) => stripAnsi(inline(r[c] ?? "")).length)));
  const frame = (): number => widths.reduce((a, b) => a + b + 3, 1);
  // Shrink the widest column until the table fits.
  let guard = 0;
  while (frame() > maxWidth && Math.max(...widths) > 5 && guard++ < 500) {
    widths[widths.indexOf(Math.max(...widths))]! -= 1;
  }
  const bar = (l: string, m: string, r: string): string =>
    C.border(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const fmt = (r: string[]): string =>
    C.border("│") + r.map((cell, c) => {
      const w = widths[c] ?? 3;
      let v = inline(cell ?? "");
      if (stripAnsi(v).length > w) v = C.cyan(stripAnsi(v).slice(0, Math.max(1, w - 1)) + "…");
      const padN = Math.max(0, w - stripAnsi(v).length);
      return " " + v + " ".repeat(padN) + " ";
    }).join(C.border("│")) + C.border("│");
  const out = [bar("┌", "┬", "┐"), fmt(norm[0] ?? []), bar("├", "┼", "┤")];
  for (let r = 1; r < norm.length; r++) out.push(fmt(norm[r] ?? []));
  out.push(bar("└", "┴", "┘"));
  return out;
}

/** Responsive section header: "─ LABEL  ·  meta  ·  meta ─────────────". */
function sectionHeader(label: string, meta: string[], w: number): string {
  const left = `─ ${C.bold(label)}${meta.length ? "  ·  " + meta.join("  ·  ") : ""} `;
  const pad = Math.max(0, w - stripAnsi(left).length);
  return C.borderBright(left) + C.border("─".repeat(pad));
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
  const w = getWidth();
  const meta: string[] = [C.green(r.intent)];
  if (r.audience && r.audience !== "general") meta.push(audienceColor(r.audience)(r.audience));
  meta.push(C.mute(`conf ${r.confidence.toFixed(2)}`));
  if (r.usedFallback) meta.push(C.amber("fallback"));

  const out: string[] = [sectionHeader("ASSISTANT", meta, w), ""];
  // The responder appends a "### Sources" footer into the message for the web
  // UI; the CLI renders sources in its own `─ sources` section below, so strip
  // that trailing footer here to avoid showing sources twice.
  const body = r.message.replace(/\n#{2,4}\s*Sources[\s\S]*$/i, "").trimEnd();
  // Render the answer reflowed to the terminal, indented under a 2-col gutter.
  for (const l of renderMarkdownLines(body, w - 2)) out.push(l === "" ? "" : "  " + l);
  const src = renderSources(r.sources);
  const rel = renderRelated(r.related);
  if (src) out.push(src);
  if (rel) out.push(rel);
  return out.join("\n");
}

export function renderUserMessage(msg: string): string {
  const w = getWidth();
  const out: string[] = [sectionHeader("YOU", [], w), ""];
  for (const wl of wrap(C.bold(msg), w - 2)) out.push("  " + wl);
  return out.join("\n");
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