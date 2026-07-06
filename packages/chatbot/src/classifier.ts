/**
 * Intent classifier — rule-based, deterministic, fast.
 *
 * Strategy: combine 4 signal types, each weighted, into a single intent match.
 *   - regex   : exact pattern match (high precision)
 *   - phrase  : contiguous multi-word match
 *   - keyword : single-token match
 *   - exact   : exact-string match (highest precision)
 *
 * Returns the top intents sorted by total weight. Ties break on specificity.
 */

import type { IntentPattern } from "./types.js";

export interface ClassificationResult {
  intent: string;
  score: number;             // sum of pattern weights (after normalization)
  matchedPatterns: string[]; // human-readable: ["regex:r/foo/i", "keyword:bar"]
}

export function classify(
  input: string,
  patterns: IntentPattern[],
): ClassificationResult[] {
  const normalized = normalize(input);

  const results: Map<string, ClassificationResult> = new Map();

  for (const intent of patterns) {
    let score = 0;
    const matched: string[] = [];

    for (const p of intent.patterns) {
      const w = matchPattern(p, normalized);
      if (w > 0) {
        score += w * p.weight;
        matched.push(`${p.type}:${describePattern(p)}`);
      }
    }

    if (score > 0) {
      const existing = results.get(intent.intent);
      if (!existing || existing.score < score) {
        results.set(intent.intent, {
          intent: intent.intent,
          score,
          matchedPatterns: matched,
        });
      }
    }
  }

  return Array.from(results.values()).sort((a, b) => b.score - a.score);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'") // smart quotes → straight
    .replace(/\s+/g, " ")
    .trim();
}

// Compiled-regex cache so keyword/regex patterns are not recompiled on every
// request (classify runs over the full intent set per query).
const reCache = new Map<string, RegExp>();
function cachedRe(key: string, build: () => RegExp): RegExp {
  let re = reCache.get(key);
  if (!re) {
    re = build();
    reCache.set(key, re);
  }
  return re;
}

function matchPattern(p: IntentPattern["patterns"][number], text: string): number {
  switch (p.type) {
    case "exact":
      return text === p.value ? 1 : 0;
    case "phrase":
      return text.includes(String(p.value).toLowerCase()) ? 1 : 0;
    case "keyword": {
      // Word-boundary match.
      const v = String(p.value).toLowerCase();
      const re = cachedRe(`kw:${v}`, () => new RegExp(`\\b${escapeRegex(v)}\\b`, "i"));
      return re.test(text) ? 1 : 0;
    }
    case "regex": {
      const r = p.value instanceof RegExp
        ? p.value
        : cachedRe(`rx:${String(p.value)}`, () => new RegExp(String(p.value), "i"));
      return r.test(text) ? 1 : 0;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describePattern(p: IntentPattern["patterns"][number]): string {
  if (p.value instanceof RegExp) return p.value.source;
  return String(p.value);
}