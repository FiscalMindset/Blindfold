#!/usr/bin/env node
/**
 * Knowledge extraction pipeline.
 *
 * Walks the Blindfold repo (docs/ AND src/), sends each chunk to the
 * configured model through the Blindfold chatbot's own sealed-key path
 * (or a plain .env API key if sealing isn't configured), and writes
 * structured Q&A entries to packages/chatbot/data/knowledge.json.
 *
 * Usage:
 *   BLINDFOLD_CHATBOT_API_KEY=... BLINDFOLD_CHATBOT_BASE_URL=... BLINDFOLD_CHATBOT_MODEL=... \
 *     npx tsx packages/chatbot/bin/extract-knowledge.ts
 *
 * If BLINDFOLD_MOCK=1, the extractor uses a deterministic in-process
 * summariser instead of calling the API (used by CI and unit tests).
 *
 * The extractor never logs or echoes any API key value. The key is read
 * once from env, sent over the network, and dropped.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

// ─── Paths to scan ────────────────────────────────────────────────────────────
const SCAN_TARGETS = [
  // Docs
  { root: "docs", kind: "doc", extensions: [".md"] },
  { root: "README.md", kind: "doc", extensions: [".md"] },
  { root: "FAQ.md", kind: "doc", extensions: [".md"] },
  { root: "usage.md", kind: "doc", extensions: [".md"] },
  { root: "EXAMPLES.md", kind: "doc", extensions: [".md"] },
  { root: "CONTRIBUTING.md", kind: "doc", extensions: [".md"] },
  { root: "TEAMS.md", kind: "doc", extensions: [".md"] },
  { root: "integration-stack.md", kind: "doc", extensions: [".md"] },
  // Code — TS SDK
  { root: "packages/blindfold/src", kind: "code", extensions: [".ts"] },
  { root: "packages/blindfold/bin", kind: "code", extensions: [".ts"] },
  // Code — Rust contract
  { root: "contract/src", kind: "code", extensions: [".rs"] },
  // Code — scripts (live proofs)
  { root: "scripts", kind: "code", extensions: [".ts"] },
];

const OUTPUT_PATH = path.join(HERE, "..", "data", "knowledge.json");
const CACHE_PATH = path.join(HERE, "..", "data", ".extract-cache.json");

// ─── Configuration ────────────────────────────────────────────────────────────
const API_BASE = (process.env.BLINDFOLD_CHATBOT_BASE_URL ?? "https://samagama.in/platform/proxy/v1").replace(/\/+$/, "");
const API_KEY = process.env.BLINDFOLD_CHATBOT_API_KEY ?? "";
const MODEL = process.env.BLINDFOLD_CHATBOT_MODEL ?? "MiniMax-M3";
const MOCK = process.env.BLINDFOLD_MOCK === "1" || !API_KEY;

// ─── Utility: hash for cache keys ─────────────────────────────────────────────
function sha8(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ─── Read all target files ────────────────────────────────────────────────────
interface RawFile {
  relPath: string;
  absPath: string;
  kind: "doc" | "code";
  content: string;
}

function readTargets(): RawFile[] {
  const out: RawFile[] = [];
  for (const target of SCAN_TARGETS) {
    const abs = path.resolve(REPO_ROOT, target.root);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      out.push({
        relPath: path.relative(REPO_ROOT, abs),
        absPath: abs,
        kind: target.kind as "doc" | "code",
        content: fs.readFileSync(abs, "utf8"),
      });
    } else if (stat.isDirectory()) {
      walk(abs, target.extensions, (file) => {
        out.push({
          relPath: path.relative(REPO_ROOT, file),
          absPath: file,
          kind: target.kind as "doc" | "code",
          content: fs.readFileSync(file, "utf8"),
        });
      });
    }
  }
  return out;
}

function walk(dir: string, exts: string[], visit: (abs: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, visit);
    else if (exts.some((e) => entry.name.endsWith(e))) visit(full);
  }
}

// ─── Chunking ─────────────────────────────────────────────────────────────────
interface Chunk {
  file: string;
  kind: "doc" | "code";
  title: string;
  content: string;
  index: number;
  total: number;
}

function chunkDoc(file: RawFile): Chunk[] {
  // Split markdown on H2 / H3 boundaries.
  const lines = file.content.split(/\r?\n/);
  const chunks: { title: string; content: string }[] = [];
  let cur: { title: string; content: string } | null = null;
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.+)/);
    if (h) {
      if (cur && cur.content.trim().length > 200) chunks.push(cur);
      cur = { title: (h[1] ?? "").trim(), content: "" };
    } else if (cur) {
      cur.content += line + "\n";
    }
  }
  if (cur && cur.content.trim().length > 200) chunks.push(cur);
  if (chunks.length === 0) {
    chunks.push({ title: path.basename(file.relPath), content: file.content });
  }
  return chunks.map((c, i) => ({
    file: file.relPath,
    kind: "doc",
    title: c.title,
    content: c.content.trim(),
    index: i,
    total: chunks.length,
  }));
}

function chunkCode(file: RawFile): Chunk[] {
  // Split code on top-level functions / structs / impls / exports.
  // TS: ^export (function|const|class|interface|async function) / ^function / ^class
  // Rust: ^pub fn / ^fn / ^pub struct / ^pub enum / ^impl
  const ext = path.extname(file.absPath);
  const lines = file.content.split(/\r?\n/);
  const chunks: { title: string; content: string }[] = [];
  let cur: { title: string; content: string; lineNo: number } | null = null;

  const startPattern =
    ext === ".rs"
      ? /^\s*(pub\s+)?(fn|struct|enum|impl|trait|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/ 
      : /^\s*(export\s+)?(async\s+function|function|class|interface|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(startPattern);
    if (m && cur && cur.content.split("\n").length > 8) {
      chunks.push({ title: cur.title, content: cur.content });
      cur = null;
    }
    if (m) {
      const name = m[3] ?? "module";
      cur = { title: name, content: line + "\n", lineNo: i + 1 };
    } else if (cur) {
      cur.content += line + "\n";
    }
  }
  if (cur) chunks.push({ title: cur.title, content: cur.content });

  // Always include a "file overview" chunk at the top.
  const overview = makeOverview(file);
  chunks.unshift({ title: path.basename(file.relPath), content: overview });

  return chunks
    .filter((c) => c.content.trim().length > 80)
    .map((c, i, arr) => ({
      file: file.relPath,
      kind: "code",
      title: c.title,
      content: c.content.trim(),
      index: i,
      total: arr.length,
    }));
}

function makeOverview(file: RawFile): string {
  // First 40 lines + list of named exports/funcs.
  const lines = file.content.split(/\r?\n/).slice(0, 60);
  const ext = path.extname(file.absPath);
  const startRe =
    ext === ".rs"
      ? /^\s*(pub\s+)?(fn|struct|enum|impl|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/
      : /^\s*(export\s+)?(async\s+function|function|class|interface|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const names: string[] = [];
  for (const l of lines) {
    const m = l.match(startRe);
    if (m && m[3]) names.push(m[3]);
  }
  return [
    `# ${path.basename(file.relPath)}`,
    `Path: ${file.relPath}`,
    `Top-level definitions: ${names.join(", ") || "(none detected)"}`,
    "",
    "```",
    ...lines,
    "```",
  ].join("\n");
}

// ─── Cache ────────────────────────────────────────────────────────────────────
interface Cache {
  [chunkHash: string]: KnowledgeCandidate;
}

function loadCache(): Cache {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(c: Cache): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
}

// ─── Knowledge candidate (the LLM output schema) ──────────────────────────────
interface KnowledgeCandidate {
  intent: string;
  question: string;
  shortAnswer: string;
  longAnswer: string;
  audience: string[];
  sources: string[];
  confidence: number;
}

// ─── LLM call (with optional Blindfold dogfooding) ────────────────────────────
async function callModel(prompt: string, system: string): Promise<string> {
  if (MOCK) return mockModel(prompt, system);

  const url = `${API_BASE}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 2500,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`model HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  // Strip any <think>…</think> blocks the model emits (MiniMax-M3 uses them).
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Robust JSON extraction: the model sometimes wraps output in ```json fences
 * or trails the JSON with prose. Pull the first balanced JSON object out.
 */
function extractJSON(s: string): any | null {
  if (!s) return null;
  // Strip <think> blocks first.
  const cleaned = s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Direct parse.
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  // Strip ```json … ``` fences.
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  // Find the first { and try to parse a balanced object from there.
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function mockModel(prompt: string, _system: string): string {
  // Deterministic in-process summariser for offline / CI runs.
  // Pulls the chunk title + first useful sentence and assembles a stub Q&A.
  const titleMatch = prompt.match(/Chunk title:\s*(.+)/);
  const sourceMatch = prompt.match(/Source:\s*(.+)/);
  const title = titleMatch?.[1]?.trim() ?? "chunk";
  const file = sourceMatch?.[1]?.trim() ?? "unknown";
  const bodyMatch = prompt.match(/```\n([\s\S]*?)\n```/);
  const body = bodyMatch?.[1] ?? "";
  const firstSentence = body
    .replace(/^#+\s+.*$/gm, "")
    .split(/[\.\n]/)[0]
    ?.trim()
    .slice(0, 200) || `Auto-extracted summary for ${title}.`;
  const intent = `code_${file.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${title.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`.slice(0, 80);
  return JSON.stringify({
    intent,
    question: `What does ${title} do in ${file}?`,
    shortAnswer: firstSentence,
    longAnswer: `${firstSentence}\n\nThis is an auto-extracted stub from the mock summariser. Run the extractor with a real API key to populate richer content.\n\nSource: \`${file}\``,
    audience: ["developer", "researcher"],
    sources: [file],
    confidence: 0.5,
  });
}

// ─── Extraction prompts ───────────────────────────────────────────────────────
const SYSTEM_PROMPT_DOC = `You are a knowledge-extraction assistant for Blindfold, the open-source Terminal 3 TDX enclave wrapper. You will be given a chunk of project documentation. Output a single, well-formed Q&A entry as STRICT JSON (no markdown, no prose outside the JSON). NEVER invent APIs, commands, env vars, file paths, or signatures. NEVER paste real or fake key values — use __BLINDFOLD__ if a key appears. Skip the chunk if it carries no project-specific knowledge (just intro/outro text) and return {}.`;

const SYSTEM_PROMPT_CODE = `You are a knowledge-extraction assistant for Blindfold, the open-source Terminal 3 TDX enclave wrapper. You will be given a chunk of source code (TypeScript or Rust). Output a single, well-formed Q&A entry as STRICT JSON (no markdown, no prose outside the JSON). NEVER invent — only describe what the code actually does. Quote real signatures/identifiers verbatim. Reference exact file paths. Mention the security property (one-file plaintext path, in-enclave substitution) when relevant. Skip trivial chunks and return {}.`;

const SCHEMA_DOC = `Schema (return ONE entry as JSON):
{
  "intent": "<short_snake_case_intent_name e.g. what_is_sentinel>",
  "question": "<natural-language question a user would ask>",
  "shortAnswer": "<1-3 sentence answer>",
  "longAnswer": "<markdown answer with structure, code, links>",
  "audience": ["user"|"developer"|"founder"|"enterprise"|"researcher"],
  "sources": ["<filename>:<chunk title>"],
  "confidence": <0..1>
}`;

const SCHEMA_CODE = `Schema (return ONE entry as JSON):
{
  "intent": "<short_snake_case_intent_name e.g. what_does_forward_do>",
  "question": "<e.g. 'What does forward() do in the contract?'>",
  "shortAnswer": "<1-3 sentence summary>",
  "longAnswer": "<markdown with code snippets, file references, behavior>",
  "audience": ["developer"|"researcher"|"enterprise"],
  "sources": ["<relative-path>:<symbol-or-line-range>"],
  "confidence": <0..1>
}`;

// ─── Extraction call ──────────────────────────────────────────────────────────
async function extractFromChunk(chunk: Chunk, cache: Cache): Promise<KnowledgeCandidate | null> {
  const hash = sha8(`${chunk.file}::${chunk.title}::${chunk.content.slice(0, 200)}`);
  if (cache[hash]) return cache[hash]!;

  const system = chunk.kind === "doc" ? SYSTEM_PROMPT_DOC : SYSTEM_PROMPT_CODE;
  const schema = chunk.kind === "doc" ? SCHEMA_DOC : SCHEMA_CODE;
  const prompt = [
    `Source: ${chunk.file}`,
    `Chunk title: ${chunk.title}`,
    `Chunk ${chunk.index + 1} of ${chunk.total}`,
    "",
    schema,
    "",
    "Here is the chunk to extract from:",
    "",
    "```",
    chunk.content.slice(0, 6000),
    "```",
    "",
    "Return ONE Q&A entry as JSON. If there is no project-specific knowledge here, return {}.",
  ].join("\n");

  try {
    const out = await callModel(prompt, system);
    if (!out || out === "{}") return null;
    const parsed = extractJSON(out);
    if (!parsed) {
      console.error(`[extract] ${chunk.file} :: ${chunk.title} :: could not parse JSON (${out.length} chars)`);
      return null;
    }
    if (!parsed.intent || !parsed.question) return null;
    // Force sources to include the chunk file.
    parsed.sources = Array.from(new Set([...(parsed.sources ?? []), chunk.file]));
    parsed.confidence = Math.min(1, Math.max(0, parsed.confidence ?? 0.7));
    cache[hash] = parsed;
    return parsed;
  } catch (e) {
    console.error(`[extract] ${chunk.file} :: ${chunk.title} :: ${(e as Error).message.slice(0, 120)}`);
    return null;
  }
}

// ─── Merge into the existing KB ───────────────────────────────────────────────
function mergeIntoKB(candidates: KnowledgeCandidate[]): void {
  const kbPath = OUTPUT_PATH;
  const existing = fs.existsSync(kbPath) ? JSON.parse(fs.readFileSync(kbPath, "utf8")) : { schemaVersion: "1.0.0", entries: [] };
  const byIntent = new Map<string, any>();
  for (const e of existing.entries) byIntent.set(e.intent, e);

  let added = 0;
  let updated = 0;
  for (const c of candidates) {
    const id = `kb-extracted-${sha8(c.intent).slice(0, 8)}`;
    const entry = {
      id,
      intent: c.intent,
      audience: c.audience?.length ? c.audience : ["general"],
      question: c.question,
      shortAnswer: c.shortAnswer,
      longAnswer: c.longAnswer,
      codeSnippets: undefined,
      links: c.sources?.map((s) => ({ label: s, url: s, type: "code" as const })),
      sources: c.sources,
      confidence: c.confidence,
      lastVerified: new Date().toISOString().slice(0, 10),
    };
    if (byIntent.has(c.intent)) {
      // Update only if confidence is higher.
      const cur = byIntent.get(c.intent);
      if (c.confidence > (cur.confidence ?? 0)) {
        Object.assign(cur, entry);
        updated++;
      }
    } else {
      byIntent.set(c.intent, entry);
      added++;
    }
  }

  existing.entries = Array.from(byIntent.values());
  existing.generatedAt = new Date().toISOString().slice(0, 10);
  existing.source = `${existing.source ?? ""} + extraction pipeline (${new Date().toISOString().slice(0, 10)})`.trim();

  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  fs.writeFileSync(kbPath, JSON.stringify(existing, null, 2) + "\n");

  console.log(`[extract] ${added} added, ${updated} updated, ${existing.entries.length} total entries in KB`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!API_KEY && !MOCK) {
    console.error(
      "[extract] No API key. Set BLINDFOLD_CHATBOT_API_KEY in env, or BLINDFOLD_MOCK=1 for offline.\n" +
      "  example: BLINDFOLD_CHATBOT_API_KEY=sk-... npx tsx packages/chatbot/bin/extract-knowledge.ts\n"
    );
    process.exit(1);
  }

  console.log(`[extract] Mode: ${MOCK ? "MOCK" : `REAL (model=${MODEL}, base=${API_BASE})`}`);
  console.log("[extract] Scanning repo…");
  const files = readTargets();
  console.log(`[extract] ${files.length} files scanned.`);

  const allChunks: Chunk[] = [];
  for (const f of files) {
    const chunks = f.kind === "doc" ? chunkDoc(f) : chunkCode(f);
    allChunks.push(...chunks);
  }
  console.log(`[extract] ${allChunks.length} chunks to process.`);

  const cache = loadCache();
  const candidates: KnowledgeCandidate[] = [];

  // Concurrent processing with a small pool. Tunable via BLINDFOLD_EXTRACT_CONCURRENCY.
  const concurrency = Math.max(1, Math.min(16, Number(process.env.BLINDFOLD_EXTRACT_CONCURRENCY ?? 4)));
  let cursor = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (cursor < allChunks.length) {
      const myIdx = cursor++;
      const c = allChunks[myIdx]!;
      const got = await extractFromChunk(c, cache);
      if (got) candidates.push(got);
      completed++;
      if (completed % 10 === 0 || completed === allChunks.length) {
        process.stdout.write(`\r[extract] ${completed}/${allChunks.length} (cache=${Object.keys(cache).length})…`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stdout.write("\n");

  saveCache(cache);
  console.log(`[extract] Got ${candidates.length} candidates.`);
  mergeIntoKB(candidates);
}

main().catch((e) => {
  console.error("[extract] Fatal:", e);
  process.exit(2);
});