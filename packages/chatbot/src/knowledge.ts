/**
 * Knowledge base loader + lookup.
 *
 * The KB lives at packages/chatbot/data/knowledge.json. Each entry is a
 * structured Q&A. The loader is robust to missing files (returns empty KB).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeEntry } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface KnowledgeBase {
  schemaVersion: string;
  generatedAt: string;
  source: string;
  entries: KnowledgeEntry[];
}

/** Per-entry precomputed lookup index, built once at load time. */
interface EntryIndex {
  qTokens: Set<string>;
  aTokens: Set<string>;
  intentLower: string;
}

// Cache the parsed KB per resolved path so the hot request path never re-reads
// or re-parses the (large) knowledge.json. Previously a single `cached` var
// combined with callers always passing an explicit path defeated the cache.
const kbCache = new Map<string, KnowledgeBase>();
// Token index lives out-of-band (keyed by entry object) so KnowledgeEntry keeps
// its JSON shape and the index is never serialised back out.
const indexCache = new WeakMap<KnowledgeEntry, EntryIndex>();

function defaultKbPath(): string {
  return path.resolve(HERE, "..", "data", "knowledge.json");
}

export function loadKB(overridePath?: string): KnowledgeBase {
  const p = path.resolve(overridePath ?? defaultKbPath());
  const hit = kbCache.get(p);
  if (hit) return hit;
  if (!fs.existsSync(p)) {
    return { schemaVersion: "1.0.0", generatedAt: "", source: "(empty)", entries: [] };
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as KnowledgeBase;
  // Normalise entries and build the token index once.
  raw.entries = (raw.entries ?? []).map((e) => {
    const entry: KnowledgeEntry = {
      ...e,
      audience: Array.isArray(e.audience) ? e.audience : ["general"],
      confidence: typeof e.confidence === "number" ? e.confidence : 0.7,
    };
    indexCache.set(entry, {
      qTokens: new Set(tokenise(entry.question)),
      aTokens: new Set(tokenise(entry.shortAnswer + " " + entry.longAnswer)),
      intentLower: entry.intent.toLowerCase(),
    });
    return entry;
  });
  kbCache.set(p, raw);
  return raw;
}

function entryIndex(e: KnowledgeEntry): EntryIndex {
  let idx = indexCache.get(e);
  if (!idx) {
    idx = {
      qTokens: new Set(tokenise(e.question)),
      aTokens: new Set(tokenise(e.shortAnswer + " " + e.longAnswer)),
      intentLower: e.intent.toLowerCase(),
    };
    indexCache.set(e, idx);
  }
  return idx;
}

export function findByIntent(kb: KnowledgeBase, intent: string): KnowledgeEntry[] {
  return kb.entries.filter((e) => e.intent === intent);
}

export function findByQuestionMatch(kb: KnowledgeBase, text: string, limit = 5): KnowledgeEntry[] {
  const queryTokens = tokenise(text.toLowerCase());
  const scored = kb.entries.map((e) => {
    const { qTokens, aTokens, intentLower } = entryIndex(e);
    let score = 0;
    for (const t of queryTokens) {
      if (qTokens.has(t)) score += 2;
      if (aTokens.has(t)) score += 1;
      if (intentLower.includes(t)) score += 3;
    }
    score *= e.confidence;
    return { entry: e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","for","to","of","in","on","at","by",
  "with","from","as","is","are","was","were","be","been","being","do","does","did","doing",
  "have","has","had","having","i","you","he","she","it","we","they","them","this","that",
  "these","those","my","your","our","their","its","can","could","should","would","may",
  "might","must","shall","will","me","him","her","us","so","not","no","yes","just","only",
  "than","also","very","more","less","much","many","some","any","all","every","each",
]);